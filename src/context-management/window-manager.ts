import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { ContextWindowBudget, type ContextRemaining } from "./window-budget";
import {
	rewriteEncryptedToolOutputs,
	rewriteWindowHeaders,
	rewriteWindowPayload,
} from "./window-request";
import {
	CONTEXT_WINDOW_COMPACTION_STRATEGY,
	CONTEXT_WINDOW_COMPACTION_SUMMARY,
	isContextWindowBoundary,
	renderContextWindowMessage,
	sendContextWindowMessage,
} from "./messages";
import {
	CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
	CONTEXT_MANAGEMENT_PROTOCOL,
	type CodexContextManagementMessageDetails,
	type ContextWindowCompactionDetails,
	type ContextWindowIdentity,
	isCodexContextManagementMessageDetails,
	isNonEmptyString,
	isRecord,
	isContextWindowCompactionDetails,
} from "./types";
import { encodeEncryptedOutputForContext, loadHistoryNotesThreadHint } from "./history-notes";
import { rewriteContextNamespaceTools } from "./namespace-tools";

interface StartContextWindowOptions {
	triggerTurn: boolean;
	signal?: AbortSignal;
	trimPreviousWindow: boolean;
}

type ThreadHintLoader = (
	ctx: ExtensionContext,
	signal?: AbortSignal,
) => Promise<string | undefined>;

type WindowBoundaryEntry = Extract<SessionEntry, { type: "custom_message" }> & {
	details: CodexContextManagementMessageDetails;
};

export class CodexContextWindowManager {
	private identity: ContextWindowIdentity | undefined;
	private sessionId: string | undefined;
	private restoredMarkerId: string | undefined;
	private readonly budget = new ContextWindowBudget();
	private rolloverPending = false;
	private trimPendingWindowId: string | undefined;
	private readonly loadThreadHint: ThreadHintLoader;
	private readonly getGatewayAllowlist: () => readonly string[];

	constructor(
		loadThreadHint?: ThreadHintLoader,
		gatewayAllowlist: readonly string[] | (() => readonly string[]) = [],
	) {
		this.getGatewayAllowlist = typeof gatewayAllowlist === "function" ? gatewayAllowlist : () => gatewayAllowlist;
		this.loadThreadHint = loadThreadHint ?? ((ctx, signal) =>
			loadHistoryNotesThreadHint(ctx, signal, this.getGatewayAllowlist()));
	}

	reset(): void {
		this.identity = undefined;
		this.sessionId = undefined;
		this.restoredMarkerId = undefined;
		this.budget.reset();
		this.rolloverPending = false;
		this.trimPendingWindowId = undefined;
	}

	currentIdentity(): ContextWindowIdentity | undefined {
		return this.identity ? { ...this.identity } : undefined;
	}

	restore(entries: readonly SessionEntry[], sessionId?: string): void {
		this.reset();
		this.sessionId = sessionId;
		for (const entry of entries) {
			if (entry.type === "compaction") {
				this.recordCompaction(entry.details);
				continue;
			}
			if (entry.type !== "custom_message" || entry.customType !== CODEX_CONTEXT_WINDOW_MESSAGE_TYPE) continue;
			if (!couldBelongToSession(entry.details, sessionId)) continue;
			if (!isCodexContextManagementMessageDetails(entry.details)) {
				throw new Error("Malformed persisted Codex context-window message");
			}
			if (!matchesSession(entry.details.sessionId, sessionId)) continue;
			const details = entry.details.contextManagement;
			this.restoredMarkerId = entry.id;
			if (details.kind === "window") {
				this.identity = identityFromDetails(entry.details);
				this.trimPendingWindowId = details.trimPreviousWindow ? details.currentWindowId : undefined;
			}
			this.budget.restore(details.kind, details.currentWindowId);
		}
	}

	/** Rebuild state when Pi navigates to a different session/branch. */
	synchronize(ctx: Pick<ExtensionContext, "sessionManager">): void {
		const entries = ctx.sessionManager.getBranch();
		const sessionId = ctx.sessionManager.getSessionId();
		const latestMarkerId = findLatestContextMarkerId(entries, sessionId);
		if (this.sessionId !== sessionId || this.restoredMarkerId !== latestMarkerId) {
			this.restore(entries, sessionId);
		}
	}

	ensureInitialized(pi: ExtensionAPI, ctx: ExtensionContext, active: boolean): void {
		if (!active) return;
		this.restore(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId());
		if (this.identity) return;
		const windowId = randomUUID();
		this.sendWindowMessage(
			pi,
			ctx,
			{ firstWindowId: windowId, currentWindowId: windowId, windowNumber: 0 },
			{ triggerTurn: false, trimPreviousWindow: false },
		);
	}

	project(
		messages: readonly AgentMessage[],
		mode: "off" | "remote",
	): AgentMessage[] {
		if (mode === "off") {
			return messages.filter(
				(message) => message.role !== "custom" || message.customType !== CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
			);
		}
		let boundaryIndex = -1;
		for (let index = 0; index < messages.length; index += 1) {
			const message = messages[index]!;
			if (
				message.role === "custom" &&
				message.customType === CODEX_CONTEXT_WINDOW_MESSAGE_TYPE
			) {
				if (!couldBelongToSession(message.details, this.sessionId)) continue;
				if (!isCodexContextManagementMessageDetails(message.details)) {
					throw new Error("Malformed persisted Codex context-window message");
				}
				if (!matchesSession(message.details.sessionId, this.sessionId)) continue;
			}
			if (!isContextWindowBoundary(message)) continue;
			boundaryIndex = index;
			this.identity = identityFromDetails(message.details);
		}
		if (boundaryIndex < 0) {
			this.identity = undefined;
			this.restoredMarkerId = undefined;
			this.budget.reset();
			this.trimPendingWindowId = undefined;
		}
		this.rolloverPending = false;
		const projected = boundaryIndex < 0 ? [...messages] : [...messages.slice(boundaryIndex)];
		return mode === "remote" ? projectEncryptedToolResults(projected) : projected;
	}

	async startNewWindow(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		options: StartContextWindowOptions,
	): Promise<boolean> {
		this.synchronize(ctx);
		if (this.rolloverPending) return false;
		if (options.signal?.aborted) throw new Error("Remote context rollover was aborted");
		this.rolloverPending = true;
		try {
			const current = this.identity;
			let threadHint: string | undefined;
			if (current) {
				try {
					threadHint = await this.loadThreadHint(ctx, options.signal);
				} catch (error) {
					if (options.signal?.aborted) throw error;
				}
			}
			if (options.signal?.aborted) throw new Error("Remote context rollover was aborted");
			const currentWindowId = randomUUID();
			const next: ContextWindowIdentity = current
				? {
					firstWindowId: current.firstWindowId,
					currentWindowId,
					previousWindowId: current.currentWindowId,
					windowNumber: current.windowNumber + 1,
				}
				: { firstWindowId: currentWindowId, currentWindowId, windowNumber: 0 };
			this.sendWindowMessage(pi, ctx, next, options, threadHint);
			return true;
		} catch (error) {
			this.rolloverPending = false;
			throw error;
		}
	}

	recordBudget(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		active: boolean,
		contextReminderThresholdPercent: number,
		contextTokens?: number,
	): void {
		if (!active || !this.identity || contextReminderThresholdPercent <= 0) return;
		const reminder = this.budget.record(ctx, this.identity, contextTokens, contextReminderThresholdPercent);
		if (!reminder) return;
		sendContextWindowMessage(
			pi,
			reminder.content,
			reminder.kind,
			this.identity,
			{ triggerTurn: reminder.kind === "fallback", sessionId: ctx.sessionManager.getSessionId() },
		);
	}

	remaining(ctx: ExtensionContext, contextTokens?: number): ContextRemaining {
		return this.budget.remaining(ctx, this.identity, contextTokens);
	}

	/** True when a notes checkpoint succeeded in the current window (after the latest boundary). */
	hasNotesCheckpointSinceBoundary(
		ctx: Pick<ExtensionContext, "sessionManager">,
	): boolean {
		return findNotesCheckpointSinceBoundary(ctx.sessionManager.getBranch(), this.sessionId);
	}

	prepareCompaction(
		event: SessionBeforeCompactEvent,
	): { cancel: true } | { compaction: CompactionResult<ContextWindowCompactionDetails> } {
		if (event.reason === "threshold") {
			const boundary = findLatestWindowBoundaryEntry(event.branchEntries, this.sessionId);
			if (!boundary || boundary.details.contextManagement.currentWindowId !== this.trimPendingWindowId) {
				return { cancel: true };
			}
		}
		return { compaction: this.createCompaction(event) };
	}

	recordCompaction(details: unknown): void {
		if (!isContextWindowCompactionDetails(details)) return;
		if (details.windowId === this.trimPendingWindowId) this.trimPendingWindowId = undefined;
	}

	createCompaction(event: SessionBeforeCompactEvent): CompactionResult<ContextWindowCompactionDetails> {
		const boundary = findLatestWindowBoundaryEntry(event.branchEntries, this.sessionId);
		return {
			summary: CONTEXT_WINDOW_COMPACTION_SUMMARY,
			firstKeptEntryId: boundary?.id ?? event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details: {
				protocol: CONTEXT_MANAGEMENT_PROTOCOL,
				strategy: CONTEXT_WINDOW_COMPACTION_STRATEGY,
				...(this.identity ? { windowId: this.identity.currentWindowId } : {}),
			},
		};
	}

	rewritePayload(payload: unknown, ctx: ExtensionContext): unknown {
		const withMetadata = rewriteWindowPayload(payload, ctx, this.identity);
		return rewriteContextNamespaceTools(withMetadata, { encrypted: true });
	}

	rewriteHeaders(headers: ProviderHeaders, ctx: ExtensionContext): void {
		rewriteWindowHeaders(headers, ctx, this.identity);
	}

	private sendWindowMessage(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		identity: ContextWindowIdentity,
		options: StartContextWindowOptions,
		threadHint?: string,
	): void {
		sendContextWindowMessage(
			pi,
			renderContextWindowMessage(identity, threadHint),
			"window",
			identity,
			{ triggerTurn: options.triggerTurn, sessionId: ctx.sessionManager.getSessionId() },
			options.trimPreviousWindow,
		);
		this.identity = identity;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.restoredMarkerId = undefined;
		this.trimPendingWindowId = options.trimPreviousWindow ? identity.currentWindowId : undefined;
		// sendMessage has accepted the marker synchronously; clear only the
		// in-flight guard so a later turn can roll over again.
		this.rolloverPending = false;
	}
}

function identityFromDetails(details: CodexContextManagementMessageDetails): ContextWindowIdentity {
	const context = details.contextManagement;
	return {
		firstWindowId: context.firstWindowId,
		currentWindowId: context.currentWindowId,
		...(context.previousWindowId ? { previousWindowId: context.previousWindowId } : {}),
		windowNumber: context.windowNumber,
	};
}

const NOTES_CHECKPOINT_ACTIONS: ReadonlySet<string> = new Set(["append_to_file", "write_file"]);

/**
 * Whether the branch contains a successful notes append/write result after the
 * latest window boundary. Reads and failed writes never count as checkpoints.
 */
export function findNotesCheckpointSinceBoundary(
	entries: readonly SessionEntry[],
	sessionId?: string,
): boolean {
	let boundaryIndex = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type !== "custom_message" || entry.customType !== CODEX_CONTEXT_WINDOW_MESSAGE_TYPE) continue;
		if (!couldBelongToSession(entry.details, sessionId)) continue;
		if (!isCodexContextManagementMessageDetails(entry.details)) {
			throw new Error("Malformed persisted Codex context-window message");
		}
		if (!matchesSession(entry.details.sessionId, sessionId)) continue;
		if (entry.details.contextManagement.kind === "window") {
			boundaryIndex = index;
			break;
		}
	}
	if (boundaryIndex < 0) return false;
	const checkpointCalls = new Set<string>();
	for (let index = boundaryIndex + 1; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			const parts = Array.isArray(message.content) ? message.content : [];
			for (const part of parts) {
				if (!isRecord(part) || part.type !== "toolCall") continue;
				// Match by call id only; the provider-side namespace rewrite never
				// affects the names persisted in the Pi session branch.
				if (part.name !== "notes") continue;
				const args = isRecord(part.arguments) ? part.arguments : undefined;
				const action = typeof args?.action === "string" ? args.action : "";
				if (typeof part.id === "string" && NOTES_CHECKPOINT_ACTIONS.has(action)) {
					checkpointCalls.add(part.id);
				}
			}
			continue;
		}
		if (message.role === "toolResult" && checkpointCalls.has(message.toolCallId)) {
			if (message.isError) {
				checkpointCalls.delete(message.toolCallId);
				continue;
			}
			const details = message.details;
			if (isRecord(details) && isRecord(details.codexHistoryNotes)) return true;
		}
	}
	return false;
}

export function findLatestWindowBoundaryEntry(
	entries: readonly SessionEntry[],
	sessionId?: string,
): WindowBoundaryEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type !== "custom_message" || entry.customType !== CODEX_CONTEXT_WINDOW_MESSAGE_TYPE) continue;
		if (!couldBelongToSession(entry.details, sessionId)) continue;
		if (!isCodexContextManagementMessageDetails(entry.details)) {
			throw new Error("Malformed persisted Codex context-window message");
		}
		if (!matchesSession(entry.details.sessionId, sessionId)) continue;
		if (entry.details.contextManagement.kind === "window") return entry as WindowBoundaryEntry;
	}
	return undefined;
}

function findLatestContextMarkerId(
	entries: readonly SessionEntry[],
	sessionId?: string,
): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type !== "custom_message" || entry.customType !== CODEX_CONTEXT_WINDOW_MESSAGE_TYPE) continue;
		if (!couldBelongToSession(entry.details, sessionId)) continue;
		if (!isCodexContextManagementMessageDetails(entry.details)) {
			throw new Error("Malformed persisted Codex context-window message");
		}
		if (matchesSession(entry.details.sessionId, sessionId)) return entry.id;
	}
	return undefined;
}

function couldBelongToSession(details: unknown, sessionId: string | undefined): boolean {
	if (sessionId === undefined || !isRecord(details)) return true;
	const markerSessionId = details.sessionId;
	return !isNonEmptyString(markerSessionId) || markerSessionId === sessionId;
}

function matchesSession(markerSessionId: string | undefined, sessionId: string | undefined): boolean {
	return sessionId === undefined || markerSessionId === sessionId;
}

function projectEncryptedToolResults(messages: readonly AgentMessage[]): AgentMessage[] {
	let changed = false;
	const projected = messages.map((message) => {
		if (message.role !== "toolResult" || !isRecord(message.details)) return message;
		const historyNotes = message.details.codexHistoryNotes;
		if (!isRecord(historyNotes) || typeof historyNotes.encrypted_output !== "string") return message;
		changed = true;
		return {
			...message,
			content: [
				{ type: "text" as const, text: encodeEncryptedOutputForContext(historyNotes.encrypted_output) },
				...message.content.filter((item) => item.type === "image"),
			],
		};
	});
	return changed ? projected : [...messages];
}
