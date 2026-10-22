import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	estimateTokens,
	findCutPoint,
	type FileOperations,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "./types";
import type { RemoteWindowCompactionInput } from "./window-manager";

function addFileOperation(name: string, args: unknown, files: FileOperations): void {
	if (!isRecord(args) || typeof args.path !== "string") return;
	if (name === "read") files.read.add(args.path);
	else if (name === "write") files.written.add(args.path);
	else if (name === "edit") files.edited.add(args.path);
}

/** Only canonical, current-window operations may contribute summary file metadata. */
function collectFileOperations(messages: readonly AgentMessage[], scope: RemoteWindowCompactionInput): FileOperations {
	const files: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
	const previous = scope.owningCompaction;
	if (previous && isRecord(previous.details)) {
		for (const path of Array.isArray(previous.details.readFiles) ? previous.details.readFiles : []) {
			if (typeof path === "string") files.read.add(path);
		}
		for (const path of Array.isArray(previous.details.modifiedFiles) ? previous.details.modifiedFiles : []) {
			if (typeof path === "string") files.edited.add(path);
		}
	}
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") addFileOperation(block.name, block.arguments, files);
		} else if (message.role === "toolResult") {
			for (const call of message.nestedCalls?.calls ?? []) addFileOperation(call.name, call.arguments, files);
		}
	}
	return files;
}

/**
 * Adapt canonical contributions to the public cut-point primitive. These are
 * detached in-memory views with REAL source IDs, never entries to persist.
 * Omitted entries contribute nothing; edited messages replace their raw values.
 */
export function prepareScopedNativeCompaction(
	event: SessionBeforeCompactEvent,
	scope: RemoteWindowCompactionInput,
): SessionBeforeCompactEvent {
	const entries: SessionEntry[] = [];
	for (const projected of scope.entries) {
		if (projected.sourceEntry.type === "compaction") continue;
		const messages = projected.messages.filter((message) => message.role !== "system");
		if (!messages.length) continue;
		// A single retained ID cannot safely identify a split within one source.
		if (messages.length !== 1) throw new Error("compaction-source-projection-unavailable");
		entries.push({ type: "message", id: projected.sourceEntry.id, parentId: projected.sourceEntry.parentId,
			timestamp: projected.sourceEntry.timestamp, message: structuredClone(messages[0]!) });
	}
	if (!entries.length) throw new Error("unsafe-compaction-retained-start");
	const settings = event.preparation.settings;
	if (!settings || !Number.isFinite(settings.keepRecentTokens) || !Number.isFinite(settings.reserveTokens)) {
		throw new Error("compaction-settings-unavailable");
	}
	const owner = scope.owningCompaction;
	const ownerIndex = owner ? event.branchEntries.findIndex((entry) => entry.id === owner.id) : -1;
	if (owner && ownerIndex < scope.windowBoundaryIndex) throw new Error("compaction-owner-mismatch");
	const lowerIndex = Math.max(scope.windowBoundaryIndex, ownerIndex);
	const minimumKeptIndex = entries.findIndex((entry) => event.branchEntries.findIndex((raw) => raw.id === entry.id) >= lowerIndex);
	if (minimumKeptIndex < 0) throw new Error("compaction-current-window-too-small");
	const cut = findCutPoint(entries, minimumKeptIndex, entries.length, settings.keepRecentTokens);
	const kept = entries[cut.firstKeptEntryIndex];
	if (kept?.type !== "message" || kept.message.role === "toolResult") throw new Error("unsafe-compaction-retained-start");
	const firstKeptEntryId = kept.id;
	if (!firstKeptEntryId) throw new Error("unsafe-compaction-retained-start");
	const messages = (start: number, end: number) => entries.slice(start, end).flatMap((entry) => entry.type === "message" ? [entry.message] : []);
	const messagesToSummarize = messages(0, cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex);
	const turnPrefixMessages = cut.isSplitTurn ? messages(cut.turnStartIndex, cut.firstKeptEntryIndex) : [];
	return {
		...event,
		preparation: {
			firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn: cut.isSplitTurn,
			tokensBefore: scope.messages.reduce((tokens, message) => tokens + estimateTokens(message), 0),
			previousSummary: scope.owningCompaction?.summary,
			fileOps: collectFileOperations([...messagesToSummarize, ...turnPrefixMessages], scope),
			settings: { ...settings },
		},
	};
}
