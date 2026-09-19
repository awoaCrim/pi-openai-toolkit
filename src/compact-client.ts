import { writeDebugArtifact } from "./debug";
import { buildResponsesRequestHeaders } from "./responses-headers";
import { stripConfigurationUpdateItems } from "./remote-v2-client";
import type { NativeCompactionRuntime } from "./runtime";
import type { NativeCompactionRequestBody } from "./serializer";
import type { ArtifactContext, CompactionConfig } from "./types";

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
	| "empty-output";

export type NativeCompactionClientSuccess = {
	ok: true;
	status: number;
	compactedWindow: unknown[];
	compactResponseId?: string;
	createdAt?: string;
	/** Assistant summary text extracted from the compact output, for CompactionEntry.summary. */
	summaryText?: string;
	response: CompactResponseEnvelope;
};

export type NativeCompactionClientFailure = {
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

function isCompactOutputItem(value: unknown): value is Record<string, unknown> {
	return isRecord(value);
}

function isCompactResponseEnvelope(value: unknown): value is CompactResponseEnvelope {
	return isRecord(value) && Array.isArray(value.output) && value.output.every(isCompactOutputItem);
}

/**
 * Some Responses-compatible gateways (including CPA's Codex route) expose remote
 * compaction through the normal streaming /responses endpoint. Codex signals this
 * with a compaction_trigger input item instead of using /responses/compact.
 */
function parseSseEvents(responseText: string): unknown[] {
	const events: unknown[] = [];
	for (const block of responseText.split(/\r?\n\r?\n/)) {
		const data = block
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trimStart())
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") continue;
		try {
			events.push(JSON.parse(data) as unknown);
		} catch {
			// Ignore comments, keep-alive frames, and non-JSON SSE data.
		}
	}
	return events;
}

function parseStreamedCompactionEnvelope(
	responseText: string,
	status: number,
): CompactResponseEnvelope | NativeCompactionClientFailure {
	const events = parseSseEvents(responseText);
	const outputByIndex = new Map<number, Record<string, unknown>>();
	const outputFallback: Record<string, unknown>[] = [];
	let completed: Record<string, unknown> | undefined;

	for (const event of events) {
		if (!isRecord(event) || typeof event.type !== "string") continue;
		if (event.type === "response.output_item.done" && isRecord(event.item)) {
			if (typeof event.output_index === "number" && Number.isInteger(event.output_index)) {
				outputByIndex.set(event.output_index, event.item);
			} else {
				outputFallback.push(event.item);
			}
			continue;
		}
		if (event.type === "response.completed") {
			completed = isRecord(event.response) ? event.response : event;
		}
	}

	if (!completed) {
		return {
			ok: false,
			reason: "malformed-response",
			status,
			errorMessage: "Responses stream ended without response.completed.",
			responseText: responseText || undefined,
		};
	}

	const output = outputByIndex.size > 0
		? [...outputByIndex.entries()].sort(([left], [right]) => left - right).map(([, item]) => item)
		: outputFallback.length > 0
			? outputFallback
			: Array.isArray(completed.output)
				? completed.output.filter(isCompactOutputItem)
				: [];
	if (completed.status !== undefined && completed.status !== "completed") {
		return {
			ok: false,
			reason: "malformed-response",
			status,
			errorMessage: `Responses compaction ended with status ${String(completed.status)}.`,
			responseJson: completed,
		};
	}
	if (output.length === 0) {
		return {
			ok: false,
			reason: "empty-output",
			status,
			responseJson: completed,
		};
	}
	if (!output.some((item) => item.type === "compaction")) {
		return {
			ok: false,
			reason: "malformed-response",
			status,
			errorMessage: "Responses stream completed without a compaction output item.",
			responseJson: { ...completed, output },
		};
	}

	return { ...completed, output };
}

async function executeResponsesTriggerCompaction(options: ExecuteNativeCompactionOptions): Promise<NativeCompactionClientResult> {
	const { runtime, request, signal, settings, context } = options;
	const headers = Object.fromEntries(
		buildResponsesRequestHeaders(runtime, {
			accept: "text/event-stream",
			sessionId: runtime.sessionId,
		}).entries(),
	);
	const triggerRequest = {
		...request,
		input: [...request.input, { type: "compaction_trigger" }],
		store: false,
		stream: true,
		parallel_tool_calls: request.parallel_tool_calls ?? true,
		include: ["reasoning.encrypted_content"],
		client_metadata: { request_kind: "compaction" },
	};

	try {
		const response = await fetch(runtime.responsesUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(triggerRequest),
			signal,
		});
		const responseText = await response.text();
		if (!response.ok) {
			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "non-2xx",
				status: response.status,
				responseText: responseText || undefined,
			};
			writeCompactArtifact(
				{
					request: { url: runtime.responsesUrl, headers, body: triggerRequest },
					response: { status: response.status, body: responseText },
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		const parsed = parseStreamedCompactionEnvelope(responseText, response.status);
		if (!isCompactResponseEnvelope(parsed)) {
			writeCompactArtifact(
				{
					request: { url: runtime.responsesUrl, headers, body: triggerRequest },
					response: { status: response.status, body: parsed.responseJson ?? responseText },
					outcome: parsed,
				},
				settings,
				context,
			);
			return parsed;
		}

		const success: NativeCompactionClientSuccess = {
			ok: true,
			status: response.status,
			compactedWindow: [...parsed.output],
			compactResponseId: typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : undefined,
			createdAt: normalizeResponseTimestamp(parsed.created_at),
			summaryText: extractCompactedSummaryText(parsed.output),
			response: parsed,
		};
		writeCompactArtifact(
			{
				request: { url: runtime.responsesUrl, headers, body: triggerRequest },
				response: { status: response.status, body: parsed },
				outcome: {
					ok: true,
					transport: "responses-compaction-trigger",
					status: success.status,
					compactResponseId: success.compactResponseId,
					compactedItems: success.compactedWindow.length,
				},
			},
			settings,
			context,
		);
		return success;
	} catch (error) {
		const failure: NativeCompactionClientFailure = isAbortError(error)
			? { ok: false, reason: "aborted" }
			: { ok: false, reason: "network-error", errorMessage: error instanceof Error ? error.message : String(error) };
		writeCompactArtifact(
			{
				request: { url: runtime.responsesUrl, headers, body: triggerRequest },
				outcome: failure,
			},
			settings,
			context,
		);
		return failure;
	}
}

/**
 * Extract the assistant-authored summary text from the compacted window so the
 * persisted CompactionEntry.summary carries real context. Without this, switching
 * to a non-Responses model later would replay a meaningless placeholder.
 */
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

	writeDebugArtifact("compact-response", data, settings, context);
}

export async function executeNativeCompaction(
	options: ExecuteNativeCompactionOptions,
): Promise<NativeCompactionClientResult> {
	const { runtime, signal, settings, context } = options;
	// Same Astra-history rejection as remote v2: `/responses/compact` rejects
	// `configuration_update` items, so a replayed history never carries one.
	const request: NativeCompactionRequestBody = {
		...options.request,
		input: stripConfigurationUpdateItems(options.request.input) as NativeCompactionRequestBody["input"],
	};
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
			signal,
		});
		const responseText = await response.text();
		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});

		// CPA and Codex-compatible gateways may support remote compaction through
		// the normal streaming Responses route rather than /responses/compact.
		if (response.status === 404) {
			return executeResponsesTriggerCompaction({
				runtime,
				request,
				signal,
				settings,
				context,
			});
		}

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
		} catch (error) {
			const failure: NativeCompactionClientFailure = {
				ok: false,
				reason: "invalid-json",
				status: response.status,
				errorMessage: error instanceof Error ? error.message : String(error),
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

		const success: NativeCompactionClientSuccess = {
			ok: true,
			status: response.status,
			compactedWindow: [...parsed.output],
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
		const failure: NativeCompactionClientFailure = isAbortError(error)
			? {
				ok: false,
				reason: "aborted",
			}
			: {
				ok: false,
				reason: "network-error",
				errorMessage: error instanceof Error ? error.message : String(error),
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
