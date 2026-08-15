import { writeDebugArtifact } from "./debug";
import { mergeProviderHeaders } from "./provider-headers";
import type { NativeCompactionRuntime } from "./runtime";
import type { NativeCompactionRequestBody, ResponsesInputItem } from "./serializer";
import type { ArtifactContext, ExtensionConfig } from "./types";

const JSON_CONTENT_TYPE = "application/json";
const SSE_CONTENT_TYPE = "text/event-stream";

export type RemoteV2CompactionItem = Record<string, unknown> & {
	type: "compaction";
	encrypted_content: string;
};

export type RemoteV2ResponseUsage = {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	[key: string]: unknown;
};

export type RemoteV2ResponseEnvelope = Record<string, unknown> & {
	id?: string;
	created_at?: number | string;
	status: "completed";
	output: RemoteV2CompactionItem[];
	usage?: RemoteV2ResponseUsage;
};

export type RemoteV2CompactionClientFailureReason =
	| "aborted"
	| "network-error"
	| "non-2xx"
	| "empty-body"
	| "invalid-sse"
	| "error-event"
	| "missing-completed-event"
	| "incomplete-response"
	| "invalid-compaction-count"
	| "malformed-compaction-item";

export type RemoteV2CompactionClientSuccess = {
	ok: true;
	status: number;
	compactedWindow: [RemoteV2CompactionItem];
	compactResponseId?: string;
	createdAt?: string;
	usage?: RemoteV2ResponseUsage;
	response: RemoteV2ResponseEnvelope;
};

export type RemoteV2CompactionClientFailure = {
	ok: false;
	reason: RemoteV2CompactionClientFailureReason;
	status?: number;
	errorMessage?: string;
	responseText?: string;
	responseJson?: unknown;
};

export type RemoteV2CompactionClientResult = RemoteV2CompactionClientSuccess | RemoteV2CompactionClientFailure;

export type RemoteV2CompactionRequestBody = Omit<NativeCompactionRequestBody, "input"> & {
	input: [...ResponsesInputItem[], { type: "compaction_trigger" }];
	store: false;
	stream: true;
};

export type ExecuteRemoteV2CompactionOptions = {
	runtime: NativeCompactionRuntime;
	request: NativeCompactionRequestBody;
	signal?: AbortSignal;
	settings?: ExtensionConfig;
	context?: ArtifactContext;
};

type ParsedSseEvent = {
	event?: string;
	dataText: string;
	data?: unknown;
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

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
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

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return undefined;
	}

	try {
		const payloadText = Buffer.from(parts[1]!, "base64url").toString("utf8");
		const payload = JSON.parse(payloadText);
		return isRecord(payload) ? payload : undefined;
	} catch {
		return undefined;
	}
}

function extractCodexAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const authClaims = payload?.["https://api.openai.com/auth"];
	if (!isRecord(authClaims)) {
		return undefined;
	}

	const accountId = authClaims.chatgpt_account_id;
	return isNonEmptyString(accountId) ? accountId.trim() : undefined;
}

function buildCodexUserAgent(): string {
	const platform = typeof process !== "undefined" ? process.platform : "browser";
	const arch = typeof process !== "undefined" ? process.arch : "unknown";
	return `pi (${platform}; ${arch})`;
}

function toHeaders(runtime: NativeCompactionRuntime): Record<string, string> {
	const headers = new Headers(mergeProviderHeaders(runtime.currentModel.headers, runtime.headers));
	headers.set("accept", SSE_CONTENT_TYPE);
	headers.set("content-type", JSON_CONTENT_TYPE);
	if (!headers.has("authorization")) {
		headers.set("authorization", `Bearer ${runtime.apiKey}`);
	}

	if (runtime.api === "openai-codex-responses") {
		const accountId = extractCodexAccountId(runtime.apiKey);
		if (accountId) {
			headers.set("chatgpt-account-id", accountId);
		}
		headers.set("originator", "pi");
		headers.set("user-agent", buildCodexUserAgent());
		headers.set("openai-beta", "responses=experimental");
	}

	return Object.fromEntries(headers.entries());
}

export function buildRemoteV2CompactionRequest(
	request: NativeCompactionRequestBody,
): RemoteV2CompactionRequestBody {
	return {
		...structuredClone(request),
		input: [...structuredClone(request.input), { type: "compaction_trigger" }],
		store: false,
		stream: true,
	};
}

export function parseSseEvents(raw: string): ParsedSseEvent[] | undefined {
	const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const events: ParsedSseEvent[] = [];

	for (const block of normalized.split(/\n\n+/)) {
		if (!block.trim()) continue;

		let event: string | undefined;
		const dataLines: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith(":")) continue;
			if (line.startsWith("event:")) {
				event = line.slice("event:".length).trim();
				continue;
			}
			if (line.startsWith("data:")) {
				dataLines.push(line.slice("data:".length).replace(/^ /, ""));
			}
		}

		if (dataLines.length === 0) continue;
		const dataText = dataLines.join("\n");
		if (dataText === "[DONE]") {
			events.push({ event, dataText });
			continue;
		}

		try {
			events.push({ event, dataText, data: JSON.parse(dataText) });
		} catch {
			return undefined;
		}
	}

	return events.length > 0 ? events : undefined;
}

function isRemoteV2CompactionItem(value: unknown): value is RemoteV2CompactionItem {
	return isRecord(value) && value.type === "compaction" && isNonEmptyString(value.encrypted_content);
}

function getEventType(event: ParsedSseEvent): string | undefined {
	return isRecord(event.data) && isNonEmptyString(event.data.type) ? event.data.type : event.event;
}

function getErrorMessage(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	if (isNonEmptyString(value.message)) return value.message;
	if (isRecord(value.error) && isNonEmptyString(value.error.message)) return value.error.message;
	if (isNonEmptyString(value.error)) return value.error;
	return undefined;
}

function writeCompactArtifact(
	data: unknown,
	settings: ExtensionConfig | undefined,
	context: ArtifactContext | undefined,
): void {
	if (!settings || !context) {
		return;
	}

	writeDebugArtifact("compact-response", data, settings, context);
}

function summarizeEvents(events: readonly ParsedSseEvent[]): unknown[] {
	return events.map((event) => {
		const data = isRecord(event.data) ? event.data : undefined;
		const response = data && isRecord(data.response) ? data.response : undefined;
		const item = data && isRecord(data.item) ? data.item : undefined;
		return {
			event: event.event,
			type: data?.type,
			responseStatus: response?.status,
			responseId: response?.id,
			itemType: item?.type,
		};
	});
}

export async function executeRemoteV2Compaction(
	options: ExecuteRemoteV2CompactionOptions,
): Promise<RemoteV2CompactionClientResult> {
	const { runtime, signal, settings, context } = options;
	const request = buildRemoteV2CompactionRequest(options.request);
	const headers = toHeaders(runtime);

	if (signal?.aborted) {
		const aborted: RemoteV2CompactionClientFailure = { ok: false, reason: "aborted" };
		writeCompactArtifact(
			{
				protocol: "remote_compaction_v2",
				request: { url: runtime.responsesUrl, headers, body: request },
				outcome: aborted,
			},
			settings,
			context,
		);
		return aborted;
	}

	try {
		const response = await fetch(runtime.responsesUrl, {
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

		if (!response.ok) {
			let responseJson: unknown;
			if (responseText.trim()) {
				try {
					responseJson = JSON.parse(responseText);
				} catch {
					responseJson = undefined;
				}
			}
			const failure: RemoteV2CompactionClientFailure = {
				ok: false,
				reason: "non-2xx",
				status: response.status,
				responseText: responseText || undefined,
				responseJson,
			};
			writeCompactArtifact(
				{
					protocol: "remote_compaction_v2",
					request: { url: runtime.responsesUrl, headers, body: request },
					response: { status: response.status, headers: responseHeaders, body: responseJson ?? responseText },
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		if (!responseText.trim()) {
			const failure: RemoteV2CompactionClientFailure = {
				ok: false,
				reason: "empty-body",
				status: response.status,
			};
			writeCompactArtifact(
				{
					protocol: "remote_compaction_v2",
					request: { url: runtime.responsesUrl, headers, body: request },
					response: { status: response.status, headers: responseHeaders },
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		const events = parseSseEvents(responseText);
		if (!events) {
			const failure: RemoteV2CompactionClientFailure = {
				ok: false,
				reason: "invalid-sse",
				status: response.status,
				responseText,
			};
			writeCompactArtifact(
				{
					protocol: "remote_compaction_v2",
					request: { url: runtime.responsesUrl, headers, body: request },
					response: { status: response.status, headers: responseHeaders, body: responseText },
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		const errorEvent = events.find((event) => {
			const type = getEventType(event);
			return type === "error" || type === "response.failed" || type === "response.incomplete";
		});
		if (errorEvent) {
			const failure: RemoteV2CompactionClientFailure = {
				ok: false,
				reason: "error-event",
				status: response.status,
				errorMessage: getErrorMessage(errorEvent.data),
				responseJson: errorEvent.data,
			};
			writeCompactArtifact(
				{
					protocol: "remote_compaction_v2",
					request: { url: runtime.responsesUrl, headers, body: request },
					response: { status: response.status, headers: responseHeaders, events: summarizeEvents(events) },
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		const completedEvent = events.find((event) => getEventType(event) === "response.completed");
		const completedData = completedEvent && isRecord(completedEvent.data) ? completedEvent.data : undefined;
		const completedResponse = completedData && isRecord(completedData.response) ? completedData.response : undefined;
		if (!completedResponse) {
			const failure: RemoteV2CompactionClientFailure = {
				ok: false,
				reason: "missing-completed-event",
				status: response.status,
			};
			writeCompactArtifact(
				{
					protocol: "remote_compaction_v2",
					request: { url: runtime.responsesUrl, headers, body: request },
					response: { status: response.status, headers: responseHeaders, events: summarizeEvents(events) },
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		if (completedResponse.status !== "completed" || !Array.isArray(completedResponse.output)) {
			const failure: RemoteV2CompactionClientFailure = {
				ok: false,
				reason: "incomplete-response",
				status: response.status,
				responseJson: completedResponse,
			};
			writeCompactArtifact(
				{
					protocol: "remote_compaction_v2",
					request: { url: runtime.responsesUrl, headers, body: request },
					response: { status: response.status, headers: responseHeaders, events: summarizeEvents(events) },
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		const compactionItems = completedResponse.output.filter(
			(item): item is Record<string, unknown> => isRecord(item) && item.type === "compaction",
		);
		if (compactionItems.length !== 1) {
			const failure: RemoteV2CompactionClientFailure = {
				ok: false,
				reason: "invalid-compaction-count",
				status: response.status,
				responseJson: completedResponse,
			};
			writeCompactArtifact(
				{
					protocol: "remote_compaction_v2",
					request: { url: runtime.responsesUrl, headers, body: request },
					response: { status: response.status, headers: responseHeaders, events: summarizeEvents(events) },
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		const compactionItem = compactionItems[0];
		if (!isRemoteV2CompactionItem(compactionItem)) {
			const failure: RemoteV2CompactionClientFailure = {
				ok: false,
				reason: "malformed-compaction-item",
				status: response.status,
				responseJson: compactionItem,
			};
			writeCompactArtifact(
				{
					protocol: "remote_compaction_v2",
					request: { url: runtime.responsesUrl, headers, body: request },
					response: { status: response.status, headers: responseHeaders, events: summarizeEvents(events) },
					outcome: failure,
				},
				settings,
				context,
			);
			return failure;
		}

		const responseEnvelope = completedResponse as RemoteV2ResponseEnvelope;
		const success: RemoteV2CompactionClientSuccess = {
			ok: true,
			status: response.status,
			compactedWindow: [structuredClone(compactionItem)],
			compactResponseId: isNonEmptyString(responseEnvelope.id) ? responseEnvelope.id.trim() : undefined,
			createdAt: normalizeResponseTimestamp(responseEnvelope.created_at),
			usage: isRecord(responseEnvelope.usage) ? (structuredClone(responseEnvelope.usage) as RemoteV2ResponseUsage) : undefined,
			response: structuredClone(responseEnvelope),
		};
		writeCompactArtifact(
			{
				protocol: "remote_compaction_v2",
				request: { url: runtime.responsesUrl, headers, body: request },
				response: {
					status: response.status,
					headers: responseHeaders,
					events: summarizeEvents(events),
					completed: responseEnvelope,
				},
				outcome: {
					ok: true,
					status: success.status,
					compactResponseId: success.compactResponseId,
					createdAt: success.createdAt,
					compactedItems: 1,
				},
			},
			settings,
			context,
		);
		return success;
	} catch (error) {
		const failure: RemoteV2CompactionClientFailure = isAbortError(error)
			? { ok: false, reason: "aborted" }
			: {
					ok: false,
					reason: "network-error",
					errorMessage: error instanceof Error ? error.message : String(error),
				};
		writeCompactArtifact(
			{
				protocol: "remote_compaction_v2",
				request: { url: runtime.responsesUrl, headers, body: request },
				outcome: failure,
			},
			settings,
			context,
		);
		return failure;
	}
}
