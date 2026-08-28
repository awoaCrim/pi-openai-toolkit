import { buildResponsesRequestHeaders } from "../responses-headers";
import type { ResponsesRuntime } from "../runtime";
import {
	extractProviderErrorMessage,
	parseImageGenerationResponse,
	type ImageGenerationRequestBody,
} from "./protocol";
import {
	IMAGE_REQUEST_TIMEOUT_MS,
	MAX_IMAGE_ERROR_BYTES,
	MAX_IMAGE_RESPONSE_BYTES,
	sanitizeImageDiagnostic,
	type ParsedGeneratedImage,
} from "./types";

export type ImageGenerationClientFailureReason =
	| "aborted"
	| "timeout"
	| "authentication"
	| "rate-limit"
	| "request-rejected"
	| "backend-unavailable"
	| "network"
	| "oversized-response"
	| "malformed-response"
	| "no-image";

export type ImageGenerationClientResult =
	| { ok: true; image: ParsedGeneratedImage; status: number }
	| {
			ok: false;
			reason: ImageGenerationClientFailureReason;
			status?: number;
			errorMessage: string;
	  };

export type ImageGenerationFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

function buildRequestHeaders(runtime: ResponsesRuntime): Headers {
	return buildResponsesRequestHeaders(runtime, { accept: "application/json" });
}

async function readBoundedBody(
	response: Response,
	maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		const parsed = Number(contentLength);
		if (Number.isFinite(parsed) && parsed > maxBytes) return { ok: false };
	}

	if (!response.body) return { ok: true, bytes: new Uint8Array() };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			if (!next.value) continue;
			total += next.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return { ok: false };
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, bytes };
}

function parseJson(bytes: Uint8Array): unknown {
	const text = new TextDecoder().decode(bytes);
	return JSON.parse(text) as unknown;
}

function providerFailureText(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	const candidate = value as Record<string, unknown>;
	const error = candidate.error && typeof candidate.error === "object" && !Array.isArray(candidate.error)
		? candidate.error as Record<string, unknown>
		: candidate;
	return [error.code, error.type, error.message]
		.filter((item): item is string => typeof item === "string")
		.join(" ")
		.toLowerCase();
}

function mapHttpFailure(status: number, payload?: unknown): ImageGenerationClientFailureReason {
	if (status === 401 || status === 403) return "authentication";
	const providerFailure = providerFailureText(payload);
	if (
		status === 429 ||
		/(?:rate|usage|billing)[-_ ]?limit|quota|insufficient[-_ ]?(?:quota|credit)/.test(providerFailure)
	) {
		return "rate-limit";
	}
	if (status === 400 || status === 404 || status === 409 || status === 422) {
		return "request-rejected";
	}
	if (status >= 500) return "backend-unavailable";
	return "request-rejected";
}

function defaultHttpMessage(status: number, reason = mapHttpFailure(status)): string {
	switch (reason) {
		case "authentication":
			return "Image generation authentication failed for the current model provider.";
		case "rate-limit":
			return "Image generation was rate-limited or the provider image quota was exhausted.";
		case "backend-unavailable":
			return "Image generation is temporarily unavailable at the configured gateway or upstream provider.";
		default:
			return `Image generation request was rejected (HTTP ${status}).`;
	}
}

export async function requestGeneratedImage(args: {
	runtime: ResponsesRuntime;
	body: ImageGenerationRequestBody;
	signal?: AbortSignal;
	fetchFn?: ImageGenerationFetch;
	timeoutMs?: number;
}): Promise<ImageGenerationClientResult> {
	const fetchFn = args.fetchFn ?? globalThis.fetch;
	const timeoutSignal = AbortSignal.timeout(args.timeoutMs ?? IMAGE_REQUEST_TIMEOUT_MS);
	const signal = args.signal
		? AbortSignal.any([args.signal, timeoutSignal])
		: timeoutSignal;

	let response: Response;
	try {
		response = await fetchFn(args.runtime.responsesUrl, {
			method: "POST",
			headers: buildRequestHeaders(args.runtime),
			body: JSON.stringify(args.body),
			signal,
		});
	} catch (error) {
		if (args.signal?.aborted) {
			return { ok: false, reason: "aborted", errorMessage: "Image generation was cancelled." };
		}
		if (timeoutSignal.aborted) {
			return {
				ok: false,
				reason: "timeout",
				errorMessage: "Image generation timed out. The request was not retried automatically.",
			};
		}
		return {
			ok: false,
			reason: "network",
			errorMessage: sanitizeImageDiagnostic(
				error instanceof Error ? error.message : error,
				"Image generation network request failed. The request was not retried automatically.",
			),
		};
	}

	let bounded: Awaited<ReturnType<typeof readBoundedBody>>;
	try {
		bounded = await readBoundedBody(
			response,
			response.ok ? MAX_IMAGE_RESPONSE_BYTES : MAX_IMAGE_ERROR_BYTES,
		);
	} catch (error) {
		if (args.signal?.aborted) {
			return { ok: false, reason: "aborted", errorMessage: "Image generation was cancelled." };
		}
		if (timeoutSignal.aborted) {
			return {
				ok: false,
				reason: "timeout",
				errorMessage: "Image generation timed out. The request was not retried automatically.",
			};
		}
		return {
			ok: false,
			reason: "network",
			status: response.status,
			errorMessage: sanitizeImageDiagnostic(
				error instanceof Error ? error.message : error,
				"Image generation response could not be read. The request was not retried automatically.",
			),
		};
	}
	if (!bounded.ok) {
		return {
			ok: false,
			reason: "oversized-response",
			status: response.status,
			errorMessage: "Image generation response exceeded the configured size limit.",
		};
	}

	let payload: unknown;
	try {
		payload = parseJson(bounded.bytes);
	} catch {
		return {
			ok: false,
			reason: "malformed-response",
			status: response.status,
			errorMessage: response.ok
				? "Image generation returned invalid JSON."
				: defaultHttpMessage(response.status),
		};
	}

	if (!response.ok) {
		const reason = mapHttpFailure(response.status, payload);
		return {
			ok: false,
			reason,
			status: response.status,
			errorMessage: extractProviderErrorMessage(payload, defaultHttpMessage(response.status, reason)),
		};
	}

	const parsed = parseImageGenerationResponse(payload);
	if (!parsed.ok) {
		return {
			ok: false,
			reason: parsed.reason,
			status: response.status,
			errorMessage: parsed.errorMessage,
		};
	}
	return { ok: true, image: parsed.image, status: response.status };
}

export const _clientTest = {
	buildRequestHeaders,
	readBoundedBody,
};
