import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	BranchSummaryEntry,
	CustomMessageEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { ResponsesCompatibleRequestPayload } from "./runtime";
import { rewritePayloadWithDeferredToolCarryover } from "./deferred-tool-carryover";
import type { NativeCompactionEntry } from "./types";
import {
	compareResponsesInputParity,
	serializeMessagesToResponsesInput,
	type ResponsesInputContentItem,
	type ResponsesInputItem,
	type ResponsesInputMessageItem,
} from "./serializer";

export type SerializedReplaySlice = {
	entries: SessionEntry[];
	messages: AgentMessage[];
	input: ResponsesInputItem[];
};

export type NativeReplaySegments = {
	boundaryIndex: number;
	firstKeptEntryIndex: number;
	instructions?: string;
	freshPreamble: ResponsesInputMessageItem[];
	trailingPreamble: ResponsesInputMessageItem[];
	compactionSummary: ResponsesInputItem[];
	preCompactionKeptWindow: SerializedReplaySlice;
	compactedWindow: unknown[];
	postCompactionTail: SerializedReplaySlice;
	originalPiReplayInput: ResponsesInputItem[];
	replayInput: unknown[];
};

export type NativeReplayPayloadRewrite = {
	ok: true;
	segments: NativeReplaySegments;
	rewrittenPayload: ResponsesCompatibleRequestPayload;
};

export type NativeReplayPayloadRewriteFailureReason =
	| "compaction-boundary-not-found"
	| "first-kept-entry-not-found"
	| "invalid-compacted-window"
	| "unexpected-compaction-after-boundary"
	| "expected-pi-replay-mismatch"
	| "compaction-summary-not-found";

export type NativeReplayPayloadRewriteFailure = {
	ok: false;
	reason: NativeReplayPayloadRewriteFailureReason;
	parity?: {
		actual: string[];
		expected: string[];
		mismatches: string[];
	};
};

export type NativeReplayPayloadRewriteResult =
	| NativeReplayPayloadRewrite
	| NativeReplayPayloadRewriteFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isResponsesInputContentItem(value: unknown): value is ResponsesInputContentItem {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}

	if (value.type === "input_text") {
		return typeof value.text === "string";
	}

	if (value.type === "input_image") {
		return value.detail === "auto" && typeof value.image_url === "string";
	}

	return false;
}

function isResponsesInputMessageRole(value: unknown): value is ResponsesInputMessageItem["role"] {
	return value === "user" || value === "developer" || value === "system";
}

function isPreambleRole(value: ResponsesInputMessageItem["role"]): value is "developer" | "system" {
	return value === "developer" || value === "system";
}

function isResponsesInputMessageItem(value: unknown): value is ResponsesInputMessageItem {
	if (!isRecord(value) || !isResponsesInputMessageRole(value.role)) {
		return false;
	}

	const { content } = value;
	return typeof content === "string" || (Array.isArray(content) && content.every(isResponsesInputContentItem));
}

function cloneResponsesInputContentItem(item: ResponsesInputContentItem): ResponsesInputContentItem {
	return item.type === "input_text"
		? {
			type: "input_text",
			text: item.text,
		}
		: {
			type: "input_image",
			detail: "auto",
			image_url: item.image_url,
		};
}

function cloneResponsesInputMessageItem(item: ResponsesInputMessageItem): ResponsesInputMessageItem {
	return {
		role: item.role,
		content: typeof item.content === "string" ? item.content : item.content.map(cloneResponsesInputContentItem),
	};
}

function cloneStructuredValue(value: unknown): unknown {
	if (
		value === undefined ||
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map(cloneStructuredValue);
	}

	if (isRecord(value)) {
		const clone: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			clone[key] = cloneStructuredValue(nested);
		}
		return clone;
	}

	throw new Error(`Unsupported structured value: ${typeof value}`);
}

function cloneOpaqueCompactedWindow(compactedWindow: readonly unknown[]): unknown[] | undefined {
	const cloned: unknown[] = [];

	for (const item of compactedWindow) {
		if (!isRecord(item)) {
			return undefined;
		}

		try {
			cloned.push(cloneStructuredValue(item));
		} catch {
			return undefined;
		}
	}

	return cloned;
}

function cloneResponsesInputSlice(items: readonly unknown[]): ResponsesInputItem[] | undefined {
	const cloned: ResponsesInputItem[] = [];

	for (const item of items) {
		try {
			cloned.push(cloneStructuredValue(item) as ResponsesInputItem);
		} catch {
			return undefined;
		}
	}

	return cloned;
}

function areEquivalentValues(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}

	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
			return false;
		}

		for (let index = 0; index < left.length; index++) {
			if (!areEquivalentValues(left[index], right[index])) {
				return false;
			}
		}

		return true;
	}

	if (isRecord(left) || isRecord(right)) {
		if (!isRecord(left) || !isRecord(right)) {
			return false;
		}

		const leftKeys = Object.keys(left).sort();
		const rightKeys = Object.keys(right).sort();
		if (!areEquivalentValues(leftKeys, rightKeys)) {
			return false;
		}

		for (const key of leftKeys) {
			if (!areEquivalentValues(left[key], right[key])) {
				return false;
			}
		}

		return true;
	}

	return false;
}

function toBranchSummaryMessage(entry: BranchSummaryEntry): AgentMessage {
	return {
		role: "branchSummary",
		summary: entry.summary,
		fromId: entry.fromId,
		timestamp: new Date(entry.timestamp).getTime(),
	} as AgentMessage;
}

function toCustomMessage(entry: CustomMessageEntry): AgentMessage {
	return {
		role: "custom",
		customType: entry.customType,
		content: entry.content,
		display: entry.display,
		details: entry.details,
		timestamp: new Date(entry.timestamp).getTime(),
	} as AgentMessage;
}

function toSessionMessage(entry: SessionMessageEntry): AgentMessage {
	return entry.message;
}

function toReplayAgentMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return toSessionMessage(entry);
	}

	if (entry.type === "custom_message") {
		return toCustomMessage(entry);
	}

	if (entry.type === "branch_summary") {
		return toBranchSummaryMessage(entry);
	}

	return undefined;
}

function extractUserItemText(item: Record<string, unknown>): unknown {
	const { content } = item;
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		const first = content[0];
		if (isRecord(first) && first.type === "input_text" && typeof first.text === "string") {
			return first.text;
		}
	}

	return undefined;
}

/**
 * Locate the Pi-authored compaction summary item. The marker text is unique to
 * this compaction entry, so a content match on the user item is a reliable
 * single anchor; nothing else in the payload needs to be prefixed or counted.
 */
function findCompactionSummaryIndex(input: readonly unknown[], summaryMarker: string): number {
	return input.findIndex((item) => {
		if (!isRecord(item) || item.role !== "user") {
			return false;
		}

		const text = extractUserItemText(item);
		return typeof text === "string" && text.includes("<summary>") && text.includes(summaryMarker);
	});
}

/** Count consecutive provider-authored developer/system items at the end of the input. */
function countTrailingPreambleItems(items: readonly unknown[]): number {
	let count = 0;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (isResponsesInputMessageItem(item) && isPreambleRole(item.role)) {
			count += 1;
			continue;
		}
		break;
	}
	return count;
}

function collectReplayMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = [];

	for (const entry of entries) {
		const message = toReplayAgentMessage(entry);
		if (message) {
			messages.push(message);
		}
	}

	return messages;
}

function createCompactionSummaryAgentMessage(entry: NativeCompactionEntry): AgentMessage {
	return {
		role: "compactionSummary",
		summary: entry.summary,
		tokensBefore: entry.tokensBefore,
		timestamp: new Date(entry.timestamp).getTime(),
	} as AgentMessage;
}

function createReplaySlice(
	entries: readonly SessionEntry[],
	messages: readonly AgentMessage[],
	input: readonly ResponsesInputItem[],
): SerializedReplaySlice {
	return {
		entries: [...entries],
		messages: [...messages],
		input: [...input],
	};
}

function findEntryIndexByIdBeforeBoundary(
	entries: readonly SessionEntry[],
	entryId: string,
	boundaryIndex: number,
): number | undefined {
	const index = entries.findIndex((entry, candidateIndex) => candidateIndex < boundaryIndex && entry.id === entryId);
	return index >= 0 ? index : undefined;
}

export function findCompactionBoundaryIndex(
	entries: readonly SessionEntry[],
	compactionEntryId: string,
): number | undefined {
	const boundaryIndex = entries.findIndex((entry) => entry.id === compactionEntryId);
	return boundaryIndex >= 0 ? boundaryIndex : undefined;
}

export function findEntriesStrictlyAfterCompactionBoundary(
	entries: readonly SessionEntry[],
	compactionEntryId: string,
): SessionEntry[] | undefined {
	const boundaryIndex = findCompactionBoundaryIndex(entries, compactionEntryId);
	if (boundaryIndex === undefined) {
		return undefined;
	}

	return entries.slice(boundaryIndex + 1);
}

export function collectLiveTailMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	return collectReplayMessages(entries);
}

export function serializeLiveTailToResponsesInput<TApi extends Api>(args: {
	model: Model<TApi>;
	entries: readonly SessionEntry[];
}): ResponsesInputItem[] {
	return serializeMessagesToResponsesInput(args.model, collectReplayMessages(args.entries));
}

function buildNativeReplaySegmentsInternal<TApi extends Api>(args: {
	model: Model<TApi>;
	payload: ResponsesCompatibleRequestPayload;
	branchEntries: readonly SessionEntry[];
	compactionEntry: NativeCompactionEntry;
}): NativeReplayPayloadRewriteResult {
	const boundaryIndex = findCompactionBoundaryIndex(args.branchEntries, args.compactionEntry.id);
	if (boundaryIndex === undefined) {
		return {
			ok: false,
			reason: "compaction-boundary-not-found",
		};
	}

	const firstKeptEntryIndex = findEntryIndexByIdBeforeBoundary(
		args.branchEntries,
		args.compactionEntry.firstKeptEntryId,
		boundaryIndex,
	);
	if (firstKeptEntryIndex === undefined) {
		return {
			ok: false,
			reason: "first-kept-entry-not-found",
		};
	}

	const newerCompactionEntry = args.branchEntries
		.slice(boundaryIndex + 1)
		.some((entry) => entry.type === "compaction");
	if (newerCompactionEntry) {
		return {
			ok: false,
			reason: "unexpected-compaction-after-boundary",
		};
	}

	const details = args.compactionEntry.details;
	if (!details) {
		return {
			ok: false,
			reason: "invalid-compacted-window",
		};
	}

	const compactedWindow = cloneOpaqueCompactedWindow(details.compactedWindow);
	if (!compactedWindow) {
		return {
			ok: false,
			reason: "invalid-compacted-window",
		};
	}

	const preCompactionEntries = args.branchEntries.slice(firstKeptEntryIndex, boundaryIndex);
	const postCompactionEntries = args.branchEntries.slice(boundaryIndex + 1);
	const preCompactionKeptMessages = collectReplayMessages(preCompactionEntries);
	const postCompactionTailMessages = collectReplayMessages(postCompactionEntries);
	const compactionSummaryMessage = createCompactionSummaryAgentMessage(args.compactionEntry);
	const keptWindowSerialized = serializeMessagesToResponsesInput(args.model, preCompactionKeptMessages);

	// Pi-authored compaction summary item. Everything outside the replaced region
	// is preserved verbatim, so this content anchor is the only location probe
	// needed; the marker text is unique to this compaction entry.
	const summaryIndex = findCompactionSummaryIndex(args.payload.input, args.compactionEntry.summary);
	if (summaryIndex < 0) {
		return {
			ok: false,
			reason: "compaction-summary-not-found",
		};
	}

	const keptStart = summaryIndex + 1;
	const keptEnd = keptStart + keptWindowSerialized.length;
	const actualKeptWindow = cloneResponsesInputSlice(args.payload.input.slice(keptStart, keptEnd));
	if (!actualKeptWindow) {
		return {
			ok: false,
			reason: "expected-pi-replay-mismatch",
		};
	}

	// The only hard verification: the region immediately after the sentinel must be
	// exactly the kept pre-compaction window derived from session entries. Content
	// after this region is preserved as-is, so transient messages injected by other
	// extensions (which have no session entries) no longer break replay.
	if (!areEquivalentValues(actualKeptWindow, keptWindowSerialized)) {
		const parity = compareResponsesInputParity(
			args.payload.input.slice(keptStart, keptEnd),
			keptWindowSerialized,
		);
		return {
			ok: false,
			reason: "expected-pi-replay-mismatch",
			parity: {
				actual: parity.actual,
				expected: parity.expected,
				mismatches: parity.mismatches,
			},
		};
	}

	const actualCompactionSummary = cloneResponsesInputSlice([args.payload.input[summaryIndex]]);
	const actualPostCompactionTail = cloneResponsesInputSlice(args.payload.input.slice(keptEnd));
	if (!actualCompactionSummary || !actualPostCompactionTail) {
		return {
			ok: false,
			reason: "expected-pi-replay-mismatch",
		};
	}

	// Keep provider-authored trailing developer/system prompts in place.
	const trailingCount = countTrailingPreambleItems(actualPostCompactionTail);
	const trailingPreamble = actualPostCompactionTail.slice(actualPostCompactionTail.length - trailingCount);
	const liveTail = actualPostCompactionTail.slice(0, actualPostCompactionTail.length - trailingCount);

	const leadingInput = cloneResponsesInputSlice(args.payload.input.slice(0, summaryIndex));
	if (!leadingInput) {
		return {
			ok: false,
			reason: "expected-pi-replay-mismatch",
		};
	}

	const baseRewrittenPayload: ResponsesCompatibleRequestPayload = {
		...args.payload,
		input: [
			...leadingInput,
			...compactedWindow,
			...liveTail,
			...trailingPreamble,
		],
	};
	const carryoverRewrite = rewritePayloadWithDeferredToolCarryover({
		payload: baseRewrittenPayload,
		carryover: details.deferredToolCarryover,
		compactionEntryId: args.compactionEntry.id,
		checkpointEndIndex: leadingInput.length + compactedWindow.length,
		compat: args.model.compat as
			| { supportsAdditionalTools?: boolean; supportsToolSearch?: boolean }
			| undefined,
	});

	const sentinelSerialized = serializeMessagesToResponsesInput(args.model, [compactionSummaryMessage]);
	const serializedTailInput = serializeMessagesToResponsesInput(args.model, postCompactionTailMessages);
	const originalPiReplayInput: ResponsesInputItem[] = [
		...leadingInput,
		...sentinelSerialized,
		...keptWindowSerialized,
		...serializedTailInput,
		...trailingPreamble,
	];

	return {
		ok: true,
		segments: {
			boundaryIndex,
			firstKeptEntryIndex,
			instructions: typeof args.payload.instructions === "string" ? args.payload.instructions : undefined,
			freshPreamble: leadingInput as ResponsesInputMessageItem[],
			trailingPreamble: trailingPreamble as ResponsesInputMessageItem[],
			compactionSummary: actualCompactionSummary,
			preCompactionKeptWindow: createReplaySlice(
				preCompactionEntries,
				preCompactionKeptMessages,
				actualKeptWindow,
			),
			compactedWindow,
			postCompactionTail: createReplaySlice(postCompactionEntries, postCompactionTailMessages, liveTail),
			originalPiReplayInput,
			replayInput: carryoverRewrite.payload.input,
		},
		rewrittenPayload: carryoverRewrite.payload,
	};
}

export function buildNativeReplaySegments<TApi extends Api>(args: {
	model: Model<TApi>;
	payload: ResponsesCompatibleRequestPayload;
	branchEntries: readonly SessionEntry[];
	compactionEntry: NativeCompactionEntry;
}): NativeReplayPayloadRewriteResult {
	return buildNativeReplaySegmentsInternal(args);
}

export function rewriteResponsesPayloadWithNativeReplay<TApi extends Api>(args: {
	model: Model<TApi>;
	payload: ResponsesCompatibleRequestPayload;
	branchEntries: readonly SessionEntry[];
	compactionEntry: NativeCompactionEntry;
}): NativeReplayPayloadRewriteResult {
	return buildNativeReplaySegmentsInternal(args);
}
