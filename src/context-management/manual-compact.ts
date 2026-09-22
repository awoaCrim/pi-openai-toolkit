import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { buildSessionContext, estimateTokens, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveToolkitConfig, type ResolvedToolkitConfig } from "../config";
import { isAutoModeEligible } from "../auto-mode/policy";
import { protectAutoModeSelection } from "../auto-mode/model-selection-guard";
import { parseModelSpec } from "../runtime";
import { resolveCodexContextProvider } from "./codex-provider";
import { findLatestNotesCheckpointSinceBoundary, findLatestWindowBoundaryEntry, type CodexContextWindowManager } from "./window-manager";
import { isNonEmptyString, isRecord, type CodexContextProvider, type ContextWindowIdentity } from "./types";
import type { ContextRolloverHandoff } from "./tools";

export const MANUAL_COMPACT_ENTRY_TYPE = "pi-openai-toolkit:manual-compact";
const PHASES = ["requested", "switching", "checkpointing", "rollover-scheduled", "restoring", "restore-needed", "completed", "failed", "cancelled", "superseded"] as const;
type Phase = typeof PHASES[number];
const TERMINAL = new Set<Phase>(["completed", "failed", "cancelled", "superseded"]);
const THINKING = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const REQUIRED_TOOLS = ["notes", "history", "new_context", "get_context_remaining"];

/** Non-LLM recovery state. No auth, model object, transcript or note text belongs here. */
export type ManualCompactRecord = {
	version: 1;
	operationId: string;
	sessionId: string;
	sourceWindowId: string;
	anchorId: string;
	originalModel: string;
	targetModel: string;
	originalThinking: ThinkingLevel;
	phase: Phase;
	targetWindowId?: string;
};

export function decodeManualCompactRecord(value: unknown): ManualCompactRecord | undefined {
	if (!isRecord(value) || value.version !== 1
		|| ![value.operationId, value.sessionId, value.sourceWindowId, value.anchorId].every(isNonEmptyString)
		|| typeof value.originalModel !== "string" || !parseModelSpec(value.originalModel)
		|| typeof value.targetModel !== "string" || !parseModelSpec(value.targetModel)
		|| typeof value.originalThinking !== "string" || !THINKING.has(value.originalThinking)
		|| !PHASES.includes(value.phase as Phase)
		|| (value.targetWindowId !== undefined && !isNonEmptyString(value.targetWindowId))) return undefined;
	return value as ManualCompactRecord;
}

/** Same gateway credential/affinity domain, or the same native backend/account. Never log this comparison. */
export function sameContextScope(left: CodexContextProvider, right: CodexContextProvider): boolean {
	if (left.kind !== right.kind || left.baseUrl !== right.baseUrl || left.provider !== right.provider) return false;
	if (left.kind === "native-codex" && right.kind === "native-codex") return left.accountId === right.accountId;
	return left.kind === "codex-gateway" && right.kind === "codex-gateway" && left.apiKey === right.apiKey
		&& JSON.stringify(Object.entries(left.headers).sort()) === JSON.stringify(Object.entries(right.headers).sort());
}

async function preflightDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	let onAbort!: () => void;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new Error("cancelled before switching models"));
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => reject(new Error("checkpoint-model authentication preflight timed out")), 10_000);
	});
	try { return await Promise.race([work, cancelled]); }
	finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
}

function modelKey(model: ExtensionContext["model"]): string | undefined {
	return model && `${model.provider}/${model.id}`;
}
function requestEntry(entries: readonly SessionEntry[], record: ManualCompactRecord): SessionEntry | undefined {
	return entries.find((entry) => entry.type === "custom" && entry.customType === MANUAL_COMPACT_ENTRY_TYPE
		&& decodeManualCompactRecord(entry.data)?.operationId === record.operationId);
}
function freshCheckpoint(entries: readonly SessionEntry[], record: ManualCompactRecord) {
	const request = requestEntry(entries, record);
	if (!request) return undefined;
	let afterId = request.id;
	// Queued user input delivered after a checkpoint must also be checkpointed.
	for (const entry of entries.slice(entries.indexOf(request) + 1)) {
		if (entry.type === "message" && entry.message.role === "user") afterId = entry.id;
	}
	return findLatestNotesCheckpointSinceBoundary(entries, record.sessionId, afterId);
}

/** Owns only manual managed handoffs, not normal window rollovers or Remote V2. */
export class ManagedManualCompact implements ContextRolloverHandoff {
	private record: ManualCompactRecord | undefined;
	private generation = 0;
	private sourcePolicy: ResolvedToolkitConfig | undefined;
	private instructions = "";
	private attemptSignal: AbortSignal | undefined;
	private releaseApproval: (() => void) | undefined;
	private selecting: string | undefined;
	private selectionPromise: Promise<boolean> | undefined;
	private expectedThinking: ThinkingLevel | undefined;
	private newerSelection: { model: NonNullable<ExtensionContext["model"]>; thinking: ThinkingLevel } | undefined;
	private deliveryTimer: ReturnType<typeof setTimeout> | undefined;
	private delivered = false;
	private resumeAllowed = true;
	private checkpointStopped = false;
	private maintenance = 0;

	constructor(private readonly pi: ExtensionAPI, private readonly windows: CodexContextWindowManager, private readonly deliveryTimeoutMs = 10_000) {}

	get busy(): boolean { return !!this.record && !TERMINAL.has(this.record.phase); }
	get snapshot() { return this.busy ? this.sourcePolicy?.snapshot : undefined; }
	get isMaintenance(): boolean { return this.maintenance > 0; }
	beginMaintenance(): () => void {
		this.maintenance++;
		let done = false;
		return () => { if (!done) { done = true; this.maintenance--; } };
	}

	private notify(ctx: ExtensionContext, text: string, error = false): void {
		const content = `Managed /compact: ${text}`;
		if (ctx.hasUI) ctx.ui.notify(content, error ? "warning" : "info");
		else this.pi.sendMessage({ customType: `${MANUAL_COMPACT_ENTRY_TYPE}:status`, content, display: true }, { triggerTurn: false });
	}
	private write(phase: Phase): void {
		if (!this.record) return;
		this.record = { ...this.record, phase };
		this.pi.appendEntry(MANUAL_COMPACT_ENTRY_TYPE, this.record);
	}
	private clearActivity(): void {
		clearTimeout(this.deliveryTimer);
		this.deliveryTimer = undefined;
		this.releaseApproval?.();
		this.releaseApproval = undefined;
		this.sourcePolicy = undefined;
	}
	private belongs(ctx: ExtensionContext, record = this.record): boolean {
		if (!record || ctx.sessionManager.getSessionId() !== record.sessionId) return false;
		const branch = ctx.sessionManager.getBranch();
		return branch.some((entry) => entry.id === record.anchorId) && !!requestEntry(branch, record);
	}
	private current(ctx: ExtensionContext, generation: number): boolean {
		return generation === this.generation && this.busy && this.belongs(ctx);
	}
	private toolsAvailable(): boolean {
		const active = new Set(this.pi.getActiveTools());
		const published = new Set(this.pi.getAllTools().map((tool) => tool.name));
		return REQUIRED_TOOLS.every((tool) => active.has(tool) && published.has(tool));
	}

	async request(event: SessionBeforeCompactEvent, ctx: ExtensionContext, source: ResolvedToolkitConfig): Promise<void> {
		if (this.busy) { this.notify(ctx, "a handoff is already active; no second window was scheduled."); return; }
		this.windows.synchronize(ctx);
		const boundary = findLatestWindowBoundaryEntry(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId());
		if (!ctx.model || !boundary || event.signal.aborted || !this.toolsAvailable()) {
			this.notify(ctx, "requires a live managed window and all four permitted context tools.", true); return;
		}
		if (this.windows.hasPendingRollover(ctx) || !this.windows.canRolloverFromCurrentWindow(ctx)) {
			this.notify(ctx, "this window is already switching or has not produced substantive tool activity since its last switch.", true); return;
		}
		const targetKey = source.config.compaction.remoteCompactModel ?? modelKey(ctx.model)!;
		const spec = parseModelSpec(targetKey);
		const target = spec && ctx.modelRegistry.find(spec.provider, spec.modelId);
		if (!target) { this.notify(ctx, `configured checkpoint model ${targetKey} is unavailable.`, true); return; }
		const targetPolicy = resolveToolkitConfig(source.snapshot, target);
		if (targetPolicy.invalidFeatures.some((feature) => ["context", "compatibility", "diagnostics"].includes(feature))
			|| !targetPolicy.config.compaction.enabled || targetPolicy.config.compaction.contextManagement !== "remote") {
			this.notify(ctx, "the checkpoint model must have valid Remote Context policy.", true); return;
		}
		const projected = this.windows.project(buildSessionContext(ctx.sessionManager.getBranch()).messages, "remote");
		const tokens = projected.reduce((total, message) => total + estimateTokens(message), 0);
		const guidanceTokens = Math.ceil((event.customInstructions?.length ?? 0) / 4);
		if (!Number.isFinite(target.contextWindow) || !Number.isFinite(target.maxTokens) || target.maxTokens <= 0
			|| tokens + target.maxTokens + guidanceTokens + 2048 >= target.contextWindow) {
			this.notify(ctx, "the checkpoint model cannot fit this window plus checkpoint output; no history was truncated.", true); return;
		}
		this.newerSelection = undefined;
		this.delivered = false;
		this.resumeAllowed = true;
		this.checkpointStopped = false;
		this.sourcePolicy = source;
		this.attemptSignal = event.signal;
		this.instructions = event.customInstructions?.trim() ?? "";
		this.record = {
			version: 1, operationId: randomUUID(), sessionId: ctx.sessionManager.getSessionId(),
			sourceWindowId: boundary.details.contextManagement.currentWindowId,
			anchorId: ctx.sessionManager.getLeafId() ?? boundary.id,
			originalModel: modelKey(ctx.model)!, targetModel: targetKey,
			originalThinking: this.pi.getThinkingLevel(), phase: "requested",
		};
		this.write("requested");
		const generation = ++this.generation;
		try {
			const [originalProvider, targetProvider] = await preflightDeadline(Promise.all([
				resolveCodexContextProvider(ctx, ctx.model, source.gatewayModelKeys),
				resolveCodexContextProvider(ctx, target, targetPolicy.gatewayModelKeys),
			]), event.signal);
			if (!this.current(ctx, generation)) return;
			if (event.signal.aborted) throw new Error("cancelled before switching models");
			if (!originalProvider.ok || !targetProvider.ok || !sameContextScope(originalProvider.provider, targetProvider.provider)) {
				throw new Error("checkpoint model must authenticate to the same context backend/account");
			}
			const protection = protectAutoModeSelection(this.pi, {
				sessionId: this.record!.sessionId, operationId: this.record!.operationId, target,
				eligible: !targetPolicy.invalidFeatures.includes("autoMode") && isAutoModeEligible(target, targetPolicy.config.autoMode),
			});
			this.releaseApproval = protection.release;
			if (!protection.allowed) throw new Error("checkpoint model would disable the engaged approval gate; allowlist it or choose another model");
			this.notify(ctx, `checkpoint handoff requested (${this.record!.originalModel} → ${targetKey}); native compaction is intentionally cancelled.`);
		} catch (error) {
			if (!this.current(ctx, generation)) return;
			this.write(event.signal.aborted ? "cancelled" : "failed"); this.clearActivity();
			this.notify(ctx, error instanceof Error ? error.message : "preflight failed", true);
		}
	}

	/** Called only after the native manual operation has exposed idle state. */
	async compactFailed(ctx: ExtensionContext): Promise<void> {
		if (this.record?.phase !== "requested") return;
		if (!ctx.isIdle() || this.attemptSignal?.aborted) {
			this.write("cancelled"); this.clearActivity(); this.notify(ctx, "cancelled before checkpoint duty began.", true); return;
		}
		const generation = this.generation;
		// Fence a second terminal callback while public selection awaits auth.
		this.write("switching");
		try {
			if (!this.belongs(ctx) || !this.toolsAvailable()) throw new Error("session or context-tool availability changed");
			if (!(await this.select(this.record.targetModel, ctx))) throw new Error("checkpoint model selection failed");
			if (!this.current(ctx, generation)) { await this.honorNewerSelection(ctx); return; }
			if (this.attemptSignal?.aborted) throw new Error("cancelled during model selection");
			if (!this.toolsAvailable()) throw new Error("required context tools became unavailable");
			this.write("checkpointing");
			const prompt = `[Managed /compact ${this.record.operationId}]\n`
				+ "Checkpoint duty only. Preserve the real active user request, restrictions, decisions, progress, learnings, known history IDs/references and next steps in notes. Do not perform unrelated work or answer the task. "
				+ "Use the existing notes tool to write or append a NEW checkpoint, wait for its successful persisted result, then call new_context exactly once in a later tool turn. An older checkpoint cannot authorize this handoff. "
				+ "After scheduling the window, stop; the extension will restore the original model before resuming. No conversation summary carries over."
				+ (this.instructions ? `\nAdditional user guidance for this checkpoint: ${this.instructions}` : "");
			this.deliveryTimer = setTimeout(() => {
				if (this.current(ctx, generation) && !this.delivered && ctx.isIdle()) void this.finish(ctx, false, false);
			}, this.deliveryTimeoutMs);
			this.deliveryTimer.unref?.();
			this.pi.sendUserMessage(prompt);
		} catch {
			if (this.current(ctx, generation)) await this.finish(ctx, false, false);
		}
	}

	messageStarted(message: { role: string; content?: unknown }): void {
		if (this.record?.phase !== "checkpointing" || message.role !== "user") return;
		const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		if (!text?.includes(`[Managed /compact ${this.record.operationId}]`)) return;
		this.delivered = true;
		clearTimeout(this.deliveryTimer);
	}

	prepare(ctx: ExtensionContext): { triggerTurn: false; beforeSchedule: (identity: ContextWindowIdentity) => void } | undefined {
		if (!this.busy) return undefined;
		const record = this.record!;
		if (!this.belongs(ctx) || record.phase !== "checkpointing" || !this.delivered
			|| modelKey(ctx.model) !== record.targetModel || this.windows.currentIdentity()?.currentWindowId !== record.sourceWindowId) {
			throw new Error("Managed /compact is not ready for a rollover; do not retry while restoration is pending.");
		}
		if (!freshCheckpoint(ctx.sessionManager.getBranch(), record)) {
			throw new Error("Managed /compact requires a new persisted successful notes write/append after this operation and the latest delivered user message.");
		}
		const generation = this.generation;
		return {
			triggerTurn: false,
			beforeSchedule: (identity) => {
				const boundary = findLatestWindowBoundaryEntry(ctx.sessionManager.getBranch(), record.sessionId);
				if (!this.current(ctx, generation) || modelKey(ctx.model) !== record.targetModel
					|| boundary?.details.contextManagement.currentWindowId !== record.sourceWindowId
					|| !freshCheckpoint(ctx.sessionManager.getBranch(), record)) throw new Error("Managed /compact was interrupted before rollover.");
				this.record = { ...record, targetWindowId: identity.currentWindowId };
				this.write("rollover-scheduled");
			},
		};
	}

	/** Abort without waiting: a queued/mixed continuation must not send the captured temporary model. */
	turnEnded(ctx: ExtensionContext): void {
		if (this.busy && this.record?.phase !== "checkpointing" && this.record?.phase !== "requested") {
			if (!this.checkpointStopped) {
				this.resumeAllowed = !ctx.signal?.aborted;
				this.checkpointStopped = true;
			}
			ctx.abort();
		}
	}
	guardRequest(ctx: ExtensionContext): void {
		if (ctx.signal?.aborted) return;
		if (this.selectionPromise && this.newerSelection) {
			ctx.abort();
			throw new Error("Managed /compact is preserving your newer model selection; this provider request was cancelled.");
		}
		if (!this.busy) return;
		if (this.record?.phase === "checkpointing" && this.belongs(ctx) && this.toolsAvailable() && modelKey(ctx.model) === this.record.targetModel
			&& this.windows.currentIdentity()?.currentWindowId === this.record.sourceWindowId) return;
		ctx.abort();
		throw new Error("Managed /compact is restoring the original model; this provider request was cancelled.");
	}
	guardTool(name: string): { block: true; terminate: true; reason: string } | undefined {
		if (!this.busy && !this.selectionPromise) return;
		if (this.record?.phase === "checkpointing" && REQUIRED_TOOLS.includes(name)) return;
		return { block: true, terminate: true, reason: "Managed /compact owns this checkpoint-only turn. Wait for the original-model continuation before ordinary work." };
	}

	modelSelected(model: NonNullable<ExtensionContext["model"]>, ctx: ExtensionContext): void {
		if ((!this.busy && !this.selectionPromise) || modelKey(model) === this.selecting) return;
		this.newerSelection = { model, thinking: this.pi.getThinkingLevel() };
		++this.generation;
		if (this.belongs(ctx)) this.write("superseded");
		this.clearActivity();
		if (!ctx.isIdle()) ctx.abort();
		this.notify(ctx, "stopped; your newer model selection takes priority.");
	}
	thinkingSelected(level: ThinkingLevel, ctx: ExtensionContext): void {
		if (!this.busy || this.selecting || level === this.expectedThinking) return;
		if (ctx.model) this.modelSelected(ctx.model, ctx);
	}
	private async honorNewerSelection(ctx: ExtensionContext): Promise<void> {
		const choice = this.newerSelection;
		if (!choice || ctx.sessionManager.getSessionId() !== this.record?.sessionId) return;
		const key = modelKey(choice.model)!;
		try {
			const selected = await this.select(key, ctx);
			if (choice !== this.newerSelection) { await this.honorNewerSelection(ctx); return; }
			if (!selected || modelKey(ctx.model) !== key) throw new Error("selection refused");
			this.setThinking(choice.thinking);
		} catch {
			if (choice !== this.newerSelection) { await this.honorNewerSelection(ctx); return; }
			if (!this.belongs(ctx) || !this.record) return;
			this.record = { ...this.record, originalModel: key, originalThinking: choice.thinking, targetModel: modelKey(ctx.model) ?? this.record.targetModel };
			this.write("restore-needed");
			this.notify(ctx, `could not preserve your newer selection ${key}; restore its authentication and reload, or select a model explicitly.`, true);
		}
	}
	private setThinking(level: ThinkingLevel): void {
		this.expectedThinking = level;
		this.pi.setThinkingLevel(level);
		// Pi emits this event without awaiting earlier extension handlers. Keep
		// the owned value so a delayed echo is not mistaken for a user selection.
		this.expectedThinking = this.pi.getThinkingLevel();
	}
	private async select(key: string, ctx: ExtensionContext): Promise<boolean> {
		if (this.selectionPromise) await this.selectionPromise.catch(() => false);
		if (modelKey(ctx.model) === key) return true;
		const spec = parseModelSpec(key)!;
		const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
		if (!model) return false;
		this.selecting = key;
		const pending = this.pi.setModel(model);
		this.selectionPromise = pending;
		try {
			const selected = await pending;
			this.expectedThinking = this.pi.getThinkingLevel();
			return selected;
		} finally {
			if (this.selectionPromise === pending) { this.selecting = undefined; this.selectionPromise = undefined; }
		}
	}

	async settled(ctx: ExtensionContext): Promise<boolean> {
		if (!this.busy) return false;
		if (this.record?.phase === "requested" || this.record?.phase === "switching" || this.record?.phase === "restore-needed" || this.record?.phase === "restoring") return true;
		await this.finish(ctx, this.resumeAllowed, true);
		return true;
	}

	private async finish(ctx: ExtensionContext, mayResume: boolean, inspectMarker: boolean): Promise<void> {
		const record = this.record;
		if (!record || !ctx.isIdle()) return;
		const generation = this.generation;
		if (!this.belongs(ctx)) { this.clearActivity(); this.record = undefined; ++this.generation; return; }
		const branch = ctx.sessionManager.getBranch();
		const marker = findLatestWindowBoundaryEntry(branch, record.sessionId);
		const switched = inspectMarker && !!record.targetWindowId && marker?.details.contextManagement.currentWindowId === record.targetWindowId
			&& marker.details.contextManagement.previousWindowId === record.sourceWindowId;
		const receipt = switched ? freshCheckpoint(branch.slice(0, branch.indexOf(marker!)), record) : undefined;
		if (modelKey(ctx.model) !== record.targetModel && modelKey(ctx.model) !== record.originalModel) {
			this.write("superseded"); this.clearActivity(); return;
		}
		this.write("restoring");
		try {
			if (!(await this.select(record.originalModel, ctx))) throw new Error("selection refused");
			if (!this.current(ctx, generation)) { await this.honorNewerSelection(ctx); return; }
			this.setThinking(record.originalThinking);
			if (modelKey(ctx.model) !== record.originalModel || this.pi.getThinkingLevel() !== record.originalThinking) throw new Error("restoration did not match");
		} catch {
			if (!this.current(ctx, generation)) return;
			this.write("restore-needed");
			this.notify(ctx, `could not restore ${record.originalModel}; no continuation was started. Restore model/auth, then reload or select a model explicitly.`, true);
			return;
		}
		this.write(switched && receipt ? "completed" : "failed");
		this.clearActivity();
		this.notify(ctx, switched && receipt ? `new window persisted; restored ${record.originalModel}.` : "checkpoint handoff did not complete; original model restored.", !receipt);
		if (mayResume && receipt) {
			this.pi.sendUserMessage(`Managed /compact completed. Read the persisted checkpoint first with notes action "read_file", path ${JSON.stringify(receipt.path)}, then resume the active user task and any queued user requests in order. Do not checkpoint or call new_context again as part of this handoff.`);
		}
	}

	/** Reload/navigation recovers selection only. It never retries inference or writes notes. */
	async recover(ctx: ExtensionContext): Promise<void> {
		const previous = this.busy ? this.record : undefined;
		++this.generation;
		await this.selectionPromise?.catch(() => false);
		this.clearActivity();
		if (previous && ctx.isIdle() && previous.sessionId === ctx.sessionManager.getSessionId()
			&& modelKey(ctx.model) === previous.targetModel && !this.belongs(ctx, previous)) {
			// Tree navigation can leave the owned temporary selection on a sibling
			// without its request anchor. Re-anchor recovery only; never resume work.
			const anchorId = ctx.sessionManager.getLeafId();
			if (anchorId) {
				this.record = { ...previous, operationId: randomUUID(), anchorId, targetWindowId: undefined };
				this.write("restoring");
				await this.finish(ctx, false, false);
				return;
			}
		}
		this.record = undefined;
		this.newerSelection = undefined;
		const branch = ctx.sessionManager.getBranch();
		const latest = [...branch].reverse().find((entry) => entry.type === "custom" && entry.customType === MANUAL_COMPACT_ENTRY_TYPE);
		if (!latest || latest.type !== "custom") return;
		const record = decodeManualCompactRecord(latest.data);
		if (!record || TERMINAL.has(record.phase) || record.sessionId !== ctx.sessionManager.getSessionId()) return;
		// A newer explicit model change on the branch wins over the saved operation.
		if (branch.slice(branch.indexOf(latest) + 1).some((entry) => entry.type === "model_change" && `${entry.provider}/${entry.modelId}` !== record.targetModel && `${entry.provider}/${entry.modelId}` !== record.originalModel)) return;
		this.record = record;
		await this.finish(ctx, false, true);
	}
	async shutdown(ctx: ExtensionContext): Promise<void> {
		++this.generation;
		await this.selectionPromise?.catch(() => false);
		if (this.busy) await this.finish(ctx, false, true);
		this.clearActivity();
		this.record = undefined;
	}
}
