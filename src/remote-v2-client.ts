import { isDeepStrictEqual } from "node:util";
import { writeDebugArtifact } from "./debug";
import { buildResponsesRequestHeaders } from "./responses-headers";
import type { NativeCompactionRuntime } from "./runtime";
import type { NativeCompactionRequestBody, ResponsesInputItem } from "./serializer";
import type { ArtifactContext, CompactionConfig } from "./types";

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
	/** Normalized output always includes the reconciled checkpoint. */
	output: unknown[];
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
	| "malformed-compaction-item"
	| "conflicting-compaction-item"
	| "invalid-compaction-metadata"
	| "invalid-event-order"
	| "duplicate-completed-event";

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
	settings?: CompactionConfig;
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

function toHeaders(runtime: NativeCompactionRuntime): Record<string, string> {
	return Object.fromEntries(
		buildResponsesRequestHeaders(runtime, {
			accept: SSE_CONTENT_TYPE,
			contentType: JSON_CONTENT_TYPE,
			sessionId: runtime.sessionId,
		}).entries(),
	);
}

/**
 * Codex `/responses` rejects histories that mix this Astra-only item into a
 * compaction request (verified upstream in Oh My Pi: the compaction path is
 * deliberately built outside the effort planner). The host never emits the
 * item into a payload we would replay today, but the item is transparently
 * carried by our opaque-window replay, so strip it defensively on every
 * remote v2 request regardless of API family.
 */
export function stripConfigurationUpdateItems(input: readonly unknown[]): unknown[] {
	return input.filter((item) => !isRecord(item) || item["type"] !== "configuration_update");
}

export function buildRemoteV2CompactionRequest(
	request: NativeCompactionRequestBody,
): RemoteV2CompactionRequestBody {
	return {
		...structuredClone(request),
		input: [
			...(stripConfigurationUpdateItems(structuredClone(request.input)) as ResponsesInputItem[]),
			{ type: "compaction_trigger" },
		],
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
	settings: CompactionConfig | undefined,
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

type OptionalMetadata<T> =
	| { valid: true; value?: T }
	| { valid: false };

type CompactionCheckpointCandidate = {
	item: RemoteV2CompactionItem;
	responseId?: string;
	outputIndex?: number;
	outputPosition?: number;
};

type CheckpointReconciliation =
	| {
			ok: true;
			response: RemoteV2ResponseEnvelope;
			compactedWindow: [RemoteV2CompactionItem];
	  }
	| {
			ok: false;
			reason:
				| "error-event"
				| "missing-completed-event"
				| "incomplete-response"
				| "invalid-compaction-count"
				| "malformed-compaction-item"
				| "conflicting-compaction-item"
				| "invalid-compaction-metadata"
				| "invalid-event-order"
				| "duplicate-completed-event";
			responseJson?: unknown;
			errorMessage?: string;
	  };

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function readOptionalNonEmptyString(value: Record<string, unknown>, key: string): OptionalMetadata<string> {
	if (!hasOwn(value, key)) {
		return { valid: true };
	}
	return isNonEmptyString(value[key]) ? { valid: true, value: value[key] } : { valid: false };
}

function readOptionalOutputIndex(value: Record<string, unknown>): OptionalMetadata<number> {
	if (!hasOwn(value, "output_index")) {
		return { valid: true };
	}

	const outputIndex = value.output_index;
	return typeof outputIndex === "number" && Number.isSafeInteger(outputIndex) && outputIndex >= 0
		? { valid: true, value: outputIndex }
		: { valid: false };
}

function mergeCompactionItems(
	itemDone: RemoteV2CompactionItem,
	terminalOutput: RemoteV2CompactionItem,
): RemoteV2CompactionItem | undefined {
	for (const [key, value] of Object.entries(itemDone)) {
		if (hasOwn(terminalOutput, key) && !isDeepStrictEqual(value, terminalOutput[key])) return undefined;
	}
	return structuredClone({ ...itemDone, ...terminalOutput });
}

function readResponseId(value: Record<string, unknown>): OptionalMetadata<string> {
	const direct = readOptionalNonEmptyString(value, "response_id");
	if (!direct.valid) {
		return direct;
	}

	const nestedResponse: OptionalMetadata<string> = isRecord(value.response) ? readOptionalNonEmptyString(value.response, "id") : { valid: true };
	if (!nestedResponse.valid) {
		return nestedResponse;
	}
	if (direct.value !== undefined && nestedResponse.value !== undefined && direct.value !== nestedResponse.value) {
		return { valid: false };
	}
	return { valid: true, value: direct.value ?? nestedResponse.value };
}

function readCheckpointCandidate(
	item: Record<string, unknown>,
	metadataSource: Record<string, unknown> | undefined,
	outputPosition?: number,
): { ok: true; candidate: CompactionCheckpointCandidate } | { ok: false; reason: "malformed-compaction-item" | "invalid-compaction-metadata" } {
	if (!isRemoteV2CompactionItem(item)) {
		return { ok: false, reason: "malformed-compaction-item" };
	}

	const itemId = readOptionalNonEmptyString(item, "id");
	const itemResponseId = readResponseId(item);
	const itemOutputIndex = readOptionalOutputIndex(item);
	if (!itemId.valid || !itemResponseId.valid || !itemOutputIndex.valid) {
		return { ok: false, reason: "invalid-compaction-metadata" };
	}

	const sourceResponseId: OptionalMetadata<string> = metadataSource ? readResponseId(metadataSource) : { valid: true };
	const sourceOutputIndex: OptionalMetadata<number> = metadataSource ? readOptionalOutputIndex(metadataSource) : { valid: true };
	if (!sourceResponseId.valid || !sourceOutputIndex.valid) {
		return { ok: false, reason: "invalid-compaction-metadata" };
	}
	if (
		itemResponseId.value !== undefined &&
		sourceResponseId.value !== undefined &&
		itemResponseId.value !== sourceResponseId.value
	) {
		return { ok: false, reason: "invalid-compaction-metadata" };
	}
	if (
		itemOutputIndex.value !== undefined &&
		sourceOutputIndex.value !== undefined &&
		itemOutputIndex.value !== sourceOutputIndex.value
	) {
		return { ok: false, reason: "invalid-compaction-metadata" };
	}

	const outputIndex = sourceOutputIndex.value ?? itemOutputIndex.value;
	if (outputPosition !== undefined && outputIndex !== undefined && outputIndex !== outputPosition) {
		return { ok: false, reason: "invalid-compaction-metadata" };
	}
	return {
		ok: true,
		candidate: {
			item: structuredClone(item),
			responseId: sourceResponseId.value ?? itemResponseId.value,
			outputIndex,
			outputPosition,
		},
	};
}

function isPostTerminalEvent(event: ParsedSseEvent): boolean {
	if (event.dataText === "[DONE]") {
		return true;
	}
	return getEventType(event) === "keepalive";
}

function reconcileSseCheckpoint(events: readonly ParsedSseEvent[]): CheckpointReconciliation {
	const errorEvent = events.find((event) => {
		const type = getEventType(event);
		return type === "error" || type === "response.failed" || type === "response.incomplete";
	});
	if (errorEvent) {
		return {
			ok: false,
			reason: "error-event",
			responseJson: errorEvent.data,
			errorMessage: getErrorMessage(errorEvent.data),
		};
	}

	const completedIndexes = events.flatMap((event, index) => (getEventType(event) === "response.completed" ? [index] : []));
	if (completedIndexes.length === 0) {
		return { ok: false, reason: "missing-completed-event" };
	}
	if (completedIndexes.length > 1) {
		return { ok: false, reason: "duplicate-completed-event" };
	}
	const terminalIndex = completedIndexes[0]!;

	for (let index = 0; index < events.length; index += 1) {
		const event = events[index]!;
		if (index < terminalIndex && event.dataText === "[DONE]") {
			return { ok: false, reason: "invalid-event-order", responseJson: event.dataText };
		}
		if (index > terminalIndex && !isPostTerminalEvent(event)) {
			return { ok: false, reason: "invalid-event-order", responseJson: event.data };
		}
	}

	const completedEvent = events[terminalIndex]!;
	const completedData = isRecord(completedEvent.data) ? completedEvent.data : undefined;
	const completedResponse = completedData && isRecord(completedData.response) ? completedData.response : undefined;
	if (!completedResponse) {
		return { ok: false, reason: "incomplete-response" };
	}

	if (completedResponse.status !== "completed") {
		return { ok: false, reason: "incomplete-response", responseJson: completedResponse };
	}
	const hasOutput = hasOwn(completedResponse, "output");
	if (hasOutput && !Array.isArray(completedResponse.output)) {
		return { ok: false, reason: "incomplete-response", responseJson: completedResponse };
	}
	const terminalOutput: unknown[] | undefined = Array.isArray(completedResponse.output) ? completedResponse.output : undefined;

	const terminalResponseId = readOptionalNonEmptyString(completedResponse, "id");
	const completedEventResponseId: OptionalMetadata<string> = completedData ? readResponseId(completedData) : { valid: true };
	if (!terminalResponseId.valid || !completedEventResponseId.valid) {
		return { ok: false, reason: "invalid-compaction-metadata", responseJson: completedResponse };
	}
	if (
		terminalResponseId.value !== undefined &&
		completedEventResponseId.value !== undefined &&
		terminalResponseId.value !== completedEventResponseId.value
	) {
		return { ok: false, reason: "invalid-compaction-metadata", responseJson: completedResponse };
	}
	let responseId = terminalResponseId.value ?? completedEventResponseId.value;
	for (const event of events.slice(0, terminalIndex)) {
		if (getEventType(event) !== "response.created" || !isRecord(event.data)) continue;
		const createdId = readResponseId(event.data);
		if (!createdId.valid || (createdId.value !== undefined && responseId !== undefined && createdId.value !== responseId)) {
			return { ok: false, reason: "invalid-compaction-metadata", responseJson: event.data };
		}
		responseId ??= createdId.value;
	}

	let itemDoneCandidate: CompactionCheckpointCandidate | undefined;
	for (let index = 0; index < terminalIndex; index += 1) {
		const event = events[index]!;
		if (getEventType(event) !== "response.output_item.done") {
			continue;
		}
		if (!isRecord(event.data) || !isRecord(event.data.item)) {
			return { ok: false, reason: "malformed-compaction-item", responseJson: event.data };
		}
		if (event.data.item.type !== "compaction") {
			continue;
		}
		if (itemDoneCandidate) {
			return { ok: false, reason: "invalid-compaction-count", responseJson: event.data.item };
		}
		const candidate = readCheckpointCandidate(event.data.item, event.data);
		if (!candidate.ok) {
			return { ok: false, reason: candidate.reason, responseJson: event.data.item };
		}
		itemDoneCandidate = candidate.candidate;
	}

	let terminalCandidate: CompactionCheckpointCandidate | undefined;
	let terminalPosition: number | undefined;
	if (terminalOutput) {
		const compactionPositions = terminalOutput.flatMap((item, index) =>
			isRecord(item) && item.type === "compaction" ? [index] : [],
		);
		if (compactionPositions.length > 1) {
			return { ok: false, reason: "invalid-compaction-count", responseJson: completedResponse };
		}
		if (compactionPositions.length === 1) {
			terminalPosition = compactionPositions[0]!;
			const outputItem = terminalOutput[terminalPosition];
			if (!isRecord(outputItem)) {
				return { ok: false, reason: "malformed-compaction-item", responseJson: outputItem };
			}
			const candidate = readCheckpointCandidate(outputItem, undefined, terminalPosition);
			if (!candidate.ok) {
				return { ok: false, reason: candidate.reason, responseJson: outputItem };
			}
			terminalCandidate = candidate.candidate;
		}
	}

	if (!itemDoneCandidate && !terminalCandidate) {
		return { ok: false, reason: "invalid-compaction-count", responseJson: completedResponse };
	}

	for (const candidate of [itemDoneCandidate, terminalCandidate]) {
		if (
			candidate?.responseId !== undefined &&
			responseId !== undefined &&
			candidate.responseId !== responseId
		) {
			return { ok: false, reason: "invalid-compaction-metadata", responseJson: candidate.item };
		}
	}
	if (
		itemDoneCandidate?.responseId !== undefined &&
		terminalCandidate?.responseId !== undefined &&
		itemDoneCandidate.responseId !== terminalCandidate.responseId
	) {
		return { ok: false, reason: "invalid-compaction-metadata", responseJson: terminalCandidate.item };
	}
	if (
		itemDoneCandidate?.outputIndex !== undefined &&
		terminalCandidate?.outputPosition !== undefined &&
		itemDoneCandidate.outputIndex !== terminalCandidate.outputPosition
	) {
		return { ok: false, reason: "invalid-compaction-metadata", responseJson: terminalCandidate.item };
	}
	if (
		itemDoneCandidate?.outputIndex !== undefined &&
		terminalOutput !== undefined &&
		terminalOutput.length > 0 &&
		terminalCandidate === undefined &&
		itemDoneCandidate.outputIndex > terminalOutput.length
	) {
		return { ok: false, reason: "invalid-compaction-metadata", responseJson: completedResponse };
	}

	let canonicalItem: RemoteV2CompactionItem;
	if (itemDoneCandidate && terminalCandidate) {
		const merged = mergeCompactionItems(itemDoneCandidate.item, terminalCandidate.item);
		if (!merged) {
			return { ok: false, reason: "conflicting-compaction-item", responseJson: terminalCandidate.item };
		}
		canonicalItem = merged;
	} else {
		canonicalItem = structuredClone((itemDoneCandidate ?? terminalCandidate)!.item);
	}

	const responseEnvelope = structuredClone(completedResponse) as RemoteV2ResponseEnvelope;
	if (terminalOutput) {
		const output = structuredClone(terminalOutput);
		if (terminalPosition !== undefined) {
			output[terminalPosition] = structuredClone(canonicalItem);
		} else {
			const insertionIndex = itemDoneCandidate?.outputIndex ?? output.length;
			output.splice(insertionIndex, 0, structuredClone(canonicalItem));
		}
		responseEnvelope.output = output;
	} else {
		responseEnvelope.output = [structuredClone(canonicalItem)];
	}

	return {
		ok: true,
		response: responseEnvelope,
		compactedWindow: [structuredClone(canonicalItem)],
	};
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

		const reconciliation = reconcileSseCheckpoint(events);
		if (!reconciliation.ok) {
			const failure: RemoteV2CompactionClientFailure = {
				ok: false,
				reason: reconciliation.reason,
				status: response.status,
				errorMessage: reconciliation.errorMessage,
				responseJson: reconciliation.responseJson,
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

		const responseEnvelope = reconciliation.response;
		const success: RemoteV2CompactionClientSuccess = {
			ok: true,
			status: response.status,
			compactedWindow: reconciliation.compactedWindow,
			compactResponseId: isNonEmptyString(responseEnvelope.id) ? responseEnvelope.id.trim() : undefined,
			createdAt: normalizeResponseTimestamp(responseEnvelope.created_at),
			usage: isRecord(responseEnvelope.usage) ? (structuredClone(responseEnvelope.usage) as RemoteV2ResponseUsage) : undefined,
			response: responseEnvelope,
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
