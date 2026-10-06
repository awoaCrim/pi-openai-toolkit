import { writeDebugArtifact } from "./debug";
import { decodeCompactionError, readCompactionResponseText, type CompactionErrorInfo } from "./compaction-errors";
import { buildResponsesRequestHeaders } from "./responses-headers";
import { stripConfigurationUpdateItems } from "./remote-v2-client";
import type { NativeCompactionRuntime } from "./runtime";
import type { NativeCompactionRequestBody } from "./serializer";
import { isCompactedWindowItem, type ArtifactContext, type CompactionConfig } from "./types";

const JSON_CONTENT_TYPE = "application/json";

type CompactResponseEnvelope = {
	id?: string;
	created_at?: number | string;
	output: unknown[];
	[key: string]: unknown;
};

export type NativeCompactionClientFailureReason =
	| "aborted"
	| "network-error"
	| "non-2xx"
	| "empty-body"
	| "invalid-json"
	| "malformed-response"
	| "empty-output"
	| "missing-compaction"
	| "malformed-compaction-item";

export type NativeCompactionClientSuccess = {
	ok: true;
	status: number;
	compactedWindow: unknown[];
	compactResponseId?: string;
	createdAt?: string;
	/** Retained assistant text only; not a portable summary of the opaque window. */
	summaryText?: string;
	response: CompactResponseEnvelope;
};

export type NativeCompactionClientFailure = CompactionErrorInfo & {
	ok: false;
	reason: NativeCompactionClientFailureReason;
	status?: number;
	errorMessage?: string;
	responseText?: string;
	responseJson?: unknown;
};

export type NativeCompactionClientResult = NativeCompactionClientSuccess | NativeCompactionClientFailure;

export type ExecuteNativeCompactionOptions = {
	runtime: NativeCompactionRuntime;
	request: NativeCompactionRequestBody;
	signal?: AbortSignal;
	settings?: CompactionConfig;
	context?: ArtifactContext;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR"))
	);
}

function normalizeResponseTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
		return new Date(milliseconds).toISOString();
	}

	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	const parsed = Date.parse(trimmed);
	return Number.isNaN(parsed) ? trimmed : new Date(parsed).toISOString();
}

function isCompactResponseEnvelope(value: unknown): value is CompactResponseEnvelope {
	return isRecord(value) && Array.isArray(value.output) && value.output.every(isCompactedWindowItem);
}

/** Extract retained assistant text. It must not be used as an opaque-window summary. */
export function extractCompactedSummaryText(output: readonly unknown[]): string | undefined {
	const texts: string[] = [];
	for (const item of output) {
		if (!isRecord(item) || item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) {
			continue;
		}
		for (const block of item.content) {
			if (isRecord(block) && block.type === "output_text" && typeof block.text === "string" && block.text.trim()) {
				texts.push(block.text.trim());
			}
		}
	}

	const joined = texts.join("\n\n").trim();
	return joined.length > 0 ? joined : undefined;
}

function toHeaders(runtime: NativeCompactionRuntime): Record<string, string> {
	return Object.fromEntries(
		buildResponsesRequestHeaders(runtime, {
			accept: JSON_CONTENT_TYPE,
			sessionId: runtime.sessionId,
		}).entries(),
	);
}

function writeCompactArtifact(
	data: unknown,
	settings: CompactionConfig | undefined,
	context: ArtifactContext | undefined,
): void {
	if (!settings || !context) {
		return;
	}

	writeDebugArtifact("compact-response", isRecord(data) ? { ...data, protocol: "standalone-compact" } : { protocol: "standalone-compact", data }, settings, context);
}

/** Installed SDK CompactParams allowlist; complete input makes previous_response_id unnecessary. */
export function buildStandaloneCompactionRequest(request: NativeCompactionRequestBody): NativeCompactionRequestBody {
	const body: NativeCompactionRequestBody = {
		model: request.model,
		input: structuredClone(stripConfigurationUpdateItems(request.input)) as NativeCompactionRequestBody["input"],
		instructions: request.instructions,
	};
	if (["auto", "default", "fast", "flex", "priority"].includes(request.service_tier ?? "")) body.service_tier = request.service_tier;
	if (typeof request.prompt_cache_key === "string") body.prompt_cache_key = request.prompt_cache_key;
	if (request.prompt_cache_retention === "in_memory" || request.prompt_cache_retention === "24h") body.prompt_cache_retention = request.prompt_cache_retention;
	const cache = request.prompt_cache_options;
	if (isRecord(cache) && Object.keys(cache).every((key) => key === "mode" || key === "ttl") &&
		(cache.mode === undefined || cache.mode === "implicit" || cache.mode === "explicit") &&
		(cache.ttl === undefined || cache.ttl === "30m")) body.prompt_cache_options = structuredClone(cache);
	return body;
}

export async function executeNativeCompaction(
	options: ExecuteNativeCompactionOptions,
): Promise<NativeCompactionClientResult> {
	const { runtime, signal, settings, context } = options;
	// Same Astra-history rejection as remote v2: `/responses/compact` rejects
	// `configuration_update` items, so a replayed history never carries one.
	const request = buildStandaloneCompactionRequest(options.request);
	const headers = toHeaders(runtime);

	if (signal?.aborted) {
		const aborted: NativeCompactionClientFailure = {
			ok: false,
			reason: "aborted",
		};
		writeCompactArtifact(
			{
				request: {
					url: runtime.compactUrl,
					headers,
					body: request,
				},
				outcome: aborted,
			},
			settings,
			context,
		);
		return aborted;
	}

	try {
		const response = await fetch(runtime.compactUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(request),
			redirect: "error",
			signal,
		});
		const responseText = await readCompactionResponseText(response, signal);
		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});

		if (!response.ok) {
			let responseJson: unknown;
			if (responseText.trim().length > 0) {
				try {
					responseJson = JSON.parse(responseText);
				} catch {
					responseJson = undefined;
				}
			}

			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "non-2xx",
				status: response.status,
				...decodeCompactionError(responseJson),
				responseText: responseText || undefined,
				responseJson,
			};
			writeCompactArtifact(
				{
					request: {
						url: runtime.compactUrl,
						headers,
						body: request,
					},
					response: {
						status: response.status,
						headers: responseHeaders,
						body: responseJson ?? responseText,
					},
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		if (!responseText.trim()) {
			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "empty-body",
				status: response.status,
			};
			writeCompactArtifact(
				{
					request: {
						url: runtime.compactUrl,
						headers,
						body: request,
					},
					response: {
						status: response.status,
						headers: responseHeaders,
						body: responseText,
					},
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(responseText);
		} catch {
			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "invalid-json",
				status: response.status,
				errorMessage: "The compact endpoint returned invalid JSON.",
				responseText,
			};
			writeCompactArtifact(
				{
					request: {
						url: runtime.compactUrl,
						headers,
						body: request,
					},
					response: {
						status: response.status,
						headers: responseHeaders,
						body: responseText,
					},
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		if (!isCompactResponseEnvelope(parsed)) {
			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "malformed-response",
				status: response.status,
				responseJson: parsed,
			};
			writeCompactArtifact(
				{
					request: {
						url: runtime.compactUrl,
						headers,
						body: request,
					},
					response: {
						status: response.status,
						headers: responseHeaders,
						body: parsed,
					},
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		if (parsed.output.length === 0) {
			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "empty-output",
				status: response.status,
				responseJson: parsed,
			};
			writeCompactArtifact(
				{
					request: {
						url: runtime.compactUrl,
						headers,
						body: request,
					},
					response: {
						status: response.status,
						headers: responseHeaders,
						body: parsed,
					},
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		const checkpoints = parsed.output.filter((item) => isRecord(item) && item.type === "compaction");
		const malformed = checkpoints.some((item) => !isRecord(item) || typeof item.encrypted_content !== "string" || !item.encrypted_content.trim());
		if (!checkpoints.length || malformed) {
			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: malformed ? "malformed-compaction-item" : "missing-compaction",
				status: response.status,
			};
			writeCompactArtifact({ protocol: "standalone-compact", outcome: failure }, settings, context);
			return failure;
		}
		if (signal?.aborted) return { ok: false, reason: "aborted" };
		const success: NativeCompactionClientSuccess = {
			ok: true,
			status: response.status,
			compactedWindow: structuredClone(parsed.output),
			compactResponseId: typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : undefined,
			createdAt: normalizeResponseTimestamp(parsed.created_at),
			summaryText: extractCompactedSummaryText(parsed.output),
			response: parsed,
		};
		writeCompactArtifact(
			{
				request: {
					url: runtime.compactUrl,
					headers,
					body: request,
				},
				response: {
					status: response.status,
					headers: responseHeaders,
					body: parsed,
				},
				outcome: {
					ok: true,
					status: success.status,
					compactResponseId: success.compactResponseId,
					createdAt: success.createdAt,
					compactedItems: success.compactedWindow.length,
				},
			},
			settings,
			context,
		);
		return success;
	} catch (error) {
		const failure: NativeCompactionClientFailure = signal?.aborted || isAbortError(error)
			? {
				ok: false,
				reason: "aborted",
			}
			: {
				ok: false,
				reason: "network-error",
				errorMessage: "Compaction transport failed; no remote checkpoint was produced.",
			};

		writeCompactArtifact(
			{
				request: {
					url: runtime.compactUrl,
					headers,
					body: request,
				},
				outcome: failure,
			},
			settings,
			context,
		);
		return failure;
	}
}
