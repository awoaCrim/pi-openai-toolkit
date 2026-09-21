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
import type { WindowBulkReport } from "./window-bulk";
import {
	rewriteEncryptedToolOutputs,
	rewriteWindowHeaders,
	rewriteWindowPayload,
} from "./window-request";
import {
	CONTEXT_WINDOW_COMPACTION_STRATEGY,
	CONTEXT_WINDOW_COMPACTION_SUMMARY,
	isContextWindowBoundary,
	preserveSystemHead,
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
	type NotesCheckpointReceipt,
} from "./types";
import {
	encodeEncryptedOutputForContext,
	isSuccessfulHistoryNotesToolResult,
	loadHistoryNotesThreadHint,
} from "./history-notes";
import { rewriteContextNamespaceTools } from "./namespace-tools";

interface StartContextWindowOptions {
	triggerTurn: boolean;
	signal?: AbortSignal;
	trimPreviousWindow: boolean;
	/** Captured with the tool activation policy, before any awaited backend work. */
	gatewayModels?: readonly string[];
}

type ThreadHintLoader = (
	ctx: ExtensionContext,
	signal?: AbortSignal,
	gatewayModels?: readonly string[],
) => Promise<string | undefined>;

type WindowBoundaryEntry = Extract<SessionEntry, { type: "custom_message" }> & {
	details: CodexContextManagementMessageDetails;
};

/**
 * In-process duplicate guard for one scheduled rollover. It is anchored to the
 * session that scheduled it and to the exact target window id, so it can never
 * be satisfied by an older or foreign marker. It is not checkpoint evidence:
 * only a persisted notes result unlocks the gate.
 */
type PendingRollover = {
	sessionId?: string;
	targetWindowId: string;
};

export class CodexContextWindowManager {
	private identity: ContextWindowIdentity | undefined;
	private sessionId: string | undefined;
	private restoredMarkerId: string | undefined;
	private readonly budget = new ContextWindowBudget();
	private pendingRollover: PendingRollover | undefined;
	private trimPendingWindowId: string | undefined;
	private readonly projectionDiagnostics = new Set<string>();
	private lastKnownSystemHead: AgentMessage | undefined;
	private bulkReport: WindowBulkReport | undefined;
	private bulkSurfacedKey: string | undefined;
	private readonly loadThreadHint: ThreadHintLoader;

	constructor(loadThreadHint?: ThreadHintLoader) {
		this.loadThreadHint = loadThreadHint ?? ((ctx, signal, gatewayModels) => loadHistoryNotesThreadHint(ctx, signal, gatewayModels));
	}

	reset(): void {
		this.resetWindowState();
		this.pendingRollover = undefined;
		this.projectionDiagnostics.clear();
		this.lastKnownSystemHead = undefined;
		this.bulkReport = undefined;
		this.bulkSurfacedKey = undefined;
	}

	currentIdentity(): ContextWindowIdentity | undefined {
		return this.identity ? { ...this.identity } : undefined;
	}
	/**
	 * Whether a rollover trim is queued for the next eligible compaction. A turn-end bulk
	 * close-out is only worth a model call while that trim is still outstanding.
	 */
	hasPendingTrim(): boolean {
		return this.trimPendingWindowId !== undefined;
	}

	/** Remember the latest measurement for this window; see `takeBulkCliff`. */
	noteWindowBulk(report: WindowBulkReport | undefined, modelKey: string): void {
		if (report) this.bulkReport = report;
		else if (this.bulkKey(modelKey) === undefined) this.bulkReport = undefined;
	}

	/**
	 * Drain the pending bulk-cliff notice for this window and model. The decision what to
	 * do about it (warn, or compact before the next request) belongs to the runtime; this
	 * only guarantees the same window and model is never surfaced twice.
	 */
	takeBulkCliff(modelKey: string): WindowBulkReport | undefined {
		const report = this.bulkReport;
		if (!report || !report.expanded) return undefined;
		const key = this.bulkKey(modelKey);
		if (key === undefined || this.bulkSurfacedKey === key) return undefined;
		this.bulkSurfacedKey = key;
		return report;
	}

	private bulkKey(modelKey: string): string | undefined {
		// The report's own window id is authoritative: this notice exists precisely for the
		// models that never open the window lifecycle, where `identity` stays undefined.
		const windowId = this.bulkReport?.windowId ?? this.identity?.currentWindowId;
		return windowId ? `${windowId}|${modelKey}` : undefined;
	}



	private resetWindowState(): void {
		this.identity = undefined;
		this.sessionId = undefined;
		this.restoredMarkerId = undefined;
		this.budget.reset();
		this.trimPendingWindowId = undefined;
	}

	restore(entries: readonly SessionEntry[], sessionId?: string): void {
		// A rebuild of derived state must not drop an outstanding rollover guard;
		// only a changed session or an observed target marker retires it below.
		this.resetWindowState();
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
		this.retireSatisfiedOrStalePending(entries, sessionId);
	}

	/** Rebuild state when Pi navigates to a different session/branch. */
	synchronize(ctx: Pick<ExtensionContext, "sessionManager">): void {
		const entries = ctx.sessionManager.getBranch();
		const sessionId = ctx.sessionManager.getSessionId();
		this.retireSatisfiedOrStalePending(entries, sessionId);
		const latestMarkerId = findLatestContextMarkerId(entries, sessionId);
		if (this.sessionId !== sessionId || this.restoredMarkerId !== latestMarkerId) {
			this.restore(entries, sessionId);
		}
	}

	/**
	 * Drop a pending rollover only for durable reasons: the target window marker
	 * is now persisted in this session, or the session changed. A queued marker
	 * visible in an in-memory message list is not durable evidence.
	 */
	private retireSatisfiedOrStalePending(
		entries: readonly SessionEntry[],
		sessionId: string | undefined,
	): void {
		const pending = this.pendingRollover;
		if (!pending) return;
		if (pending.sessionId !== undefined && pending.sessionId !== sessionId) {
			this.pendingRollover = undefined;
			return;
		}
		if (hasPersistedWindowBoundary(entries, sessionId, pending.targetWindowId)) {
			this.pendingRollover = undefined;
		}
	}

	ensureInitialized(pi: ExtensionAPI, ctx: ExtensionContext, active: boolean): void {
		if (!active) return;
		this.synchronize(ctx);
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
		// Projection observes the request view, never durable session state. A
		// queued rollover marker must not clear the duplicate guard here.
		const trimmed = boundaryIndex < 0 ? [...messages] : this.trimToWindow(messages, boundaryIndex);
		return mode === "remote" ? projectEncryptedToolResults(trimmed) : trimmed;
	}

	/**
	 * Trim everything before the window boundary while keeping Pi's prompt/tool head.
	 *
	 * When the head cannot be preserved the trim is refused and the full message list is
	 * sent, because a window without tools silently degrades into a chat the model can
	 * only narrate. Each refusal is reported once per window and reason.
	 */
	private trimToWindow(messages: readonly AgentMessage[], boundaryIndex: number): AgentMessage[] {
		const repair = preserveSystemHead({ messages, boundaryIndex, fallbackHead: this.lastKnownSystemHead });
		if (repair.head) this.lastKnownSystemHead = repair.head;
		if (repair.shrinkRejected) {
			this.recordProjectionDiagnostic(repair.lostToolNames);
		}
		return [...repair.messages];
	}

	private recordProjectionDiagnostic(lostToolNames: readonly string[]): void {
		const key = `${this.identity?.currentWindowId ?? "unknown"}|${[...lostToolNames].sort().join(",")}`;
		this.projectionDiagnostics.add(key);
	}

	/**
	 * Drain the pending `tool-loadout-shrink` reports. Returns one entry per window and
	 * lost-tool set, so a caller can surface the incident without flooding the UI.
	 */
	takeProjectionDiagnostics(): string[] {
		if (this.projectionDiagnostics.size === 0) return [];
		const pending = [...this.projectionDiagnostics];
		this.projectionDiagnostics.clear();
		return pending;
	}

	async startNewWindow(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		options: StartContextWindowOptions,
	): Promise<boolean> {
		this.synchronize(ctx);
		// A same-session rollover whose target marker is not persisted yet is
		// still in flight: report it instead of scheduling a second window.
		if (this.hasPendingRollover(ctx)) return false;
		if (options.signal?.aborted) throw new Error("Remote context rollover was aborted");
		const current = this.identity;
		const liveSessionId = ctx.sessionManager.getSessionId();
		const currentWindowId = randomUUID();
		const next: ContextWindowIdentity = current
			? {
				firstWindowId: current.firstWindowId,
				currentWindowId,
				previousWindowId: current.currentWindowId,
				windowNumber: current.windowNumber + 1,
			}
			: { firstWindowId: currentWindowId, currentWindowId, windowNumber: 0 };
		this.pendingRollover = { sessionId: liveSessionId, targetWindowId: currentWindowId };
		try {
			const checkpoint = current
				? findLatestNotesCheckpointSinceBoundary(ctx.sessionManager.getBranch(), liveSessionId)
				: undefined;
			let threadHint: string | undefined;
			if (current) {
				try {
					threadHint = await this.loadThreadHint(ctx, options.signal, options.gatewayModels);
				} catch (error) {
					if (options.signal?.aborted) throw error;
				}
			}
			if (options.signal?.aborted) throw new Error("Remote context rollover was aborted");
			this.sendWindowMessage(pi, ctx, next, options, threadHint, checkpoint);
			return true;
		} catch (error) {
			this.pendingRollover = undefined;
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
		// Right after a rollover, Pi's usage anchor still reports the previous
		// window's last request until the new window's first request completes.
		// Budget decisions taken in that gap act on stale numbers: they burn the
		// once-per-window reminder on a false alarm seconds after a successful
		// rollover, leaving the window silent for the rest of its life.
		if (!hasAssistantUsageSinceWindowBoundary(ctx.sessionManager.getBranch(), this.sessionId)) return;
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

	/**
	 * True when a notes checkpoint succeeded in the current window (after the
	 * latest boundary). The scan always uses the live session id: a cached id can
	 * belong to a session Pi already navigated away from, which would filter the
	 * current window's marker and result out as foreign.
	 */
	hasNotesCheckpointSinceBoundary(
		ctx: Pick<ExtensionContext, "sessionManager">,
	): boolean {
		return findNotesCheckpointSinceBoundary(
			ctx.sessionManager.getBranch(),
			ctx.sessionManager.getSessionId(),
		);
	}

	/**
	 * True while a rollover scheduled for the current session is awaiting its
	 * persisted target marker. Call `synchronize()` first so a marker that has
	 * already been persisted or a session switch retires the guard.
	 */
	hasPendingRollover(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
		const pending = this.pendingRollover;
		if (!pending) return false;
		return pending.sessionId === undefined || pending.sessionId === ctx.sessionManager.getSessionId();
	}

	/**
	 * Whether a rollover may be scheduled from the current window.
	 *
	 * A window that was entered by a context switch has to do real work before it switches
	 * again: without this guard a model can checkpoint and roll over on its very first turn,
	 * which is how long sessions start looping between notes and new_context.
	 */
	canRolloverFromCurrentWindow(ctx: ExtensionContext): boolean {
		if (!this.identity || this.identity.windowNumber === 0) return true;
		// An exhausted window must always be able to escape: the budget fallback tells the
		// model to checkpoint and switch, and refusing that would strand the session. An
		// unmeasurable window keeps the guard, since nothing there is pushing for a switch.
		const { remainingTokens } = this.remaining(ctx);
		if (remainingTokens !== undefined && remainingTokens <= 0) return true;
		return hasSubstantiveToolResultSinceBoundary(ctx.sessionManager.getBranch(), this.sessionId);
	}

	prepareCompaction(
		event: SessionBeforeCompactEvent,
	): { cancel: true } | { compaction: CompactionResult<ContextWindowCompactionDetails> } {
		// Only the compaction that consumes a scheduled rollover may write a
		// boundary. Every other path — threshold, manual /compact, overflow —
		// stays cancelled: a boundary written without a pending trim does not
		// shrink anything, becomes Pi's latest-compaction anchor, and blinds
		// getContextUsage (null tokens) until the next assistant usage lands —
		// which is exactly how the exhausted-window fallback can go silent.
		const boundary = findLatestWindowBoundaryEntry(event.branchEntries, this.sessionId);
		if (!boundary || boundary.details.contextManagement.currentWindowId !== this.trimPendingWindowId) {
			return { cancel: true };
		}
		const compaction = this.createCompaction(event);
		// Consume the trim synchronously. Pi does not re-fire session_compact
		// for hook-written entries, so relying on that event leaks the pending
		// id and lets every later compaction pass this gate again, writing an
		// endless run of no-op boundaries for the same window.
		this.trimPendingWindowId = undefined;
		return { compaction };
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
		checkpoint?: NotesCheckpointReceipt,
	): void {
		sendContextWindowMessage(
			pi,
			renderContextWindowMessage(identity, threadHint, checkpoint),
			"window",
			identity,
			{ triggerTurn: options.triggerTurn, sessionId: ctx.sessionManager.getSessionId() },
			options.trimPreviousWindow,
		);
		this.identity = identity;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.restoredMarkerId = undefined;
		this.trimPendingWindowId = options.trimPreviousWindow ? identity.currentWindowId : undefined;
		// sendMessage() acceptance is not persistence. The pending rollover stays
		// armed until synchronize() observes this target window in the persisted
		// branch (or the session changes).
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

/** Tools that only move context around; they never count as work done in a window. */
const CONTEXT_MANAGEMENT_TOOL_NAMES: ReadonlySet<string> = new Set([
	"new_context",
	"get_context_remaining",
	"history",
	"notes",
]);

/**
 * Whether the current window produced a tool result from anything other than the
 * context-handoff tools. Derived from persisted entries so it survives restarts.
 */
export function hasSubstantiveToolResultSinceBoundary(
	entries: readonly SessionEntry[],
	sessionId?: string,
): boolean {
	const boundaryIndex = findLatestWindowBoundaryIndex(entries, sessionId);
	if (boundaryIndex < 0) return true;
	for (let index = boundaryIndex + 1; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as { role?: string; toolName?: string };
		if (message.role !== "toolResult" || typeof message.toolName !== "string") continue;
		if (!CONTEXT_MANAGEMENT_TOOL_NAMES.has(message.toolName)) return true;
	}
	return false;
}

/**
 * Whether the branch contains a successful assistant usage after the latest
 * window boundary. Before that first usage lands, any context measurement is
 * still anchored to the previous window's last request.
 */
export function hasAssistantUsageSinceWindowBoundary(
	entries: readonly SessionEntry[],
	sessionId?: string,
): boolean {
	const boundaryIndex = findLatestWindowBoundaryIndex(entries, sessionId);
	if (boundaryIndex < 0) return false;
	for (let index = boundaryIndex + 1; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		const candidate = message as unknown as {
			stopReason?: string;
			usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
		};
		if (candidate.stopReason === "aborted" || candidate.stopReason === "error") continue;
		const usage = candidate.usage;
		if (!usage) continue;
		const tokens = usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		if (tokens > 0) return true;
	}
	return false;
}

/**
 * Return the most recent successful notes write after the latest window
 * boundary. The receipt is derived from persisted session entries so it
 * survives restarts and can be used for an explicit rollover handoff.
 */
export function findLatestNotesCheckpointSinceBoundary(
	entries: readonly SessionEntry[],
	sessionId?: string,
): NotesCheckpointReceipt | undefined {
	const boundaryIndex = findLatestWindowBoundaryIndex(entries, sessionId);
	if (boundaryIndex < 0) return undefined;
	const checkpointCalls = new Map<string, NotesCheckpointReceipt>();
	let latest: NotesCheckpointReceipt | undefined;
	for (let index = boundaryIndex + 1; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			const parts = Array.isArray(message.content) ? message.content : [];
			for (const part of parts) {
				if (!isRecord(part) || part.type !== "toolCall" || part.name !== "notes") continue;
				const args = isRecord(part.arguments) ? part.arguments : undefined;
				const action = typeof args?.action === "string" ? args.action : "";
				const path = isNonEmptyString(args?.path) ? args.path : undefined;
				if (isNonEmptyString(part.id) && path !== undefined && NOTES_CHECKPOINT_ACTIONS.has(action)) {
					checkpointCalls.set(part.id, { path, toolCallId: part.id });
				}
			}
			continue;
		}
		if (message.role !== "toolResult" || message.toolName !== "notes") continue;
		const receipt = checkpointCalls.get(message.toolCallId);
		if (!receipt) continue;
		checkpointCalls.delete(message.toolCallId);
		if (message.isError !== false || !isSuccessfulHistoryNotesToolResult(message.details)) continue;
		latest = receipt;
	}
	return latest;
}

/**
 * Whether the branch contains a successful notes append/write result after the
 * latest window boundary. Reads and failed writes never count as checkpoints.
 */
export function findNotesCheckpointSinceBoundary(
	entries: readonly SessionEntry[],
	sessionId?: string,
): boolean {
	return findLatestNotesCheckpointSinceBoundary(entries, sessionId) !== undefined;
}

function findLatestWindowBoundaryIndex(
	entries: readonly SessionEntry[],
	sessionId?: string,
): number {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type !== "custom_message" || entry.customType !== CODEX_CONTEXT_WINDOW_MESSAGE_TYPE) continue;
		if (!couldBelongToSession(entry.details, sessionId)) continue;
		if (!isCodexContextManagementMessageDetails(entry.details)) {
			throw new Error("Malformed persisted Codex context-window message");
		}
		if (!matchesSession(entry.details.sessionId, sessionId)) continue;
		if (entry.details.contextManagement.kind === "window") return index;
	}
	return -1;
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

/**
 * Whether this exact window boundary is already persisted for the session.
 * Only durable entries count; a queued/visible marker does not.
 */
function hasPersistedWindowBoundary(
	entries: readonly SessionEntry[],
	sessionId: string | undefined,
	windowId: string,
): boolean {
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== CODEX_CONTEXT_WINDOW_MESSAGE_TYPE) continue;
		if (!couldBelongToSession(entry.details, sessionId)) continue;
		if (!isCodexContextManagementMessageDetails(entry.details)) continue;
		if (!matchesSession(entry.details.sessionId, sessionId)) continue;
		const details = entry.details.contextManagement;
		if (details.kind === "window" && details.currentWindowId === windowId) return true;
	}
	return false;
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
