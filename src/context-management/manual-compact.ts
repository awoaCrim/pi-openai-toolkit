import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseModelSpec } from "../runtime";
import { THINKING_LEVELS } from "../types";
import { findLatestNotesCheckpointSinceBoundary, findLatestWindowBoundaryEntry } from "./window-manager";
import { isNonEmptyString, isRecord } from "./types";
import type { ContextRolloverHandoff } from "./tools";

export const MANUAL_COMPACT_ENTRY_TYPE = "pi-openai-toolkit:manual-compact";
const PHASES = ["requested", "switching", "checkpointing", "rollover-scheduled", "restoring", "restore-needed", "completed", "failed", "cancelled", "superseded"] as const;
type Phase = typeof PHASES[number];
const TERMINAL = new Set<Phase>(["completed", "failed", "cancelled", "superseded"]);

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
		|| typeof value.originalThinking !== "string" || !(THINKING_LEVELS as readonly string[]).includes(value.originalThinking)
		|| !PHASES.includes(value.phase as Phase)
		|| (value.targetWindowId !== undefined && !isNonEmptyString(value.targetWindowId))) return undefined;
	return value as ManualCompactRecord;
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

/** Restore already-persisted legacy selections only; never start duty or inference. */
export class ManagedManualCompact implements ContextRolloverHandoff {
	private record: ManualCompactRecord | undefined;
	private generation = 0;
	private selecting: string | undefined;
	private selectionPromise: Promise<boolean> | undefined;
	private expectedThinking: ThinkingLevel | undefined;
	private newerSelection: { model: NonNullable<ExtensionContext["model"]>; thinking: ThinkingLevel } | undefined;
	private maintenance = 0;

	constructor(private readonly pi: ExtensionAPI) {}

	get busy(): boolean { return !!this.record && !TERMINAL.has(this.record.phase); }
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
	private belongs(ctx: ExtensionContext, record = this.record): boolean {
		if (!record || ctx.sessionManager.getSessionId() !== record.sessionId) return false;
		const branch = ctx.sessionManager.getBranch();
		return branch.some((entry) => entry.id === record.anchorId) && !!requestEntry(branch, record);
	}
	private current(ctx: ExtensionContext, generation: number): boolean {
		return generation === this.generation && this.busy && this.belongs(ctx);
	}

	/** Legacy recovery may block a rollover, but never initiate a handoff. */
	prepare(_ctx: ExtensionContext): undefined {
		if (this.busy) throw new Error("Legacy /compact selection recovery is pending; wait for restoration.");
		return undefined;
	}

	/** Abort without waiting: a queued/mixed continuation must not send the captured temporary model. */
	turnEnded(ctx: ExtensionContext): void {
		if (this.busy) ctx.abort();
	}
	guardRequest(ctx: ExtensionContext): void {
		if (ctx.signal?.aborted) return;
		if (this.selectionPromise && this.newerSelection) {
			ctx.abort();
			throw new Error("Managed /compact is preserving your newer model selection; this provider request was cancelled.");
		}
		if (!this.busy) return;
		ctx.abort();
		throw new Error("Managed /compact is restoring the original model; this provider request was cancelled.");
	}
	guardTool(_name: string): { block: true; terminate: true; reason: string } | undefined {
		if (!this.busy && !this.selectionPromise) return;
		return { block: true, terminate: true, reason: "Legacy /compact selection recovery is pending. Wait for restoration before ordinary work." };
	}

	modelSelected(model: NonNullable<ExtensionContext["model"]>, ctx: ExtensionContext): void {
		if ((!this.busy && !this.selectionPromise) || modelKey(model) === this.selecting) return;
		this.newerSelection = { model, thinking: this.pi.getThinkingLevel() };
		++this.generation;
		if (this.belongs(ctx)) this.write("superseded");
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
		if (this.record?.phase === "restore-needed" || this.record?.phase === "restoring") return true;
		await this.finish(ctx, true);
		return true;
	}

	private async finish(ctx: ExtensionContext, inspectMarker: boolean): Promise<void> {
		const record = this.record;
		if (!record || !ctx.isIdle()) return;
		const generation = this.generation;
		if (!this.belongs(ctx)) { this.record = undefined; ++this.generation; return; }
		const branch = ctx.sessionManager.getBranch();
		const marker = findLatestWindowBoundaryEntry(branch, record.sessionId);
		const switched = inspectMarker && !!record.targetWindowId && marker?.details.contextManagement.currentWindowId === record.targetWindowId
			&& marker.details.contextManagement.previousWindowId === record.sourceWindowId;
		const receipt = switched ? freshCheckpoint(branch.slice(0, branch.indexOf(marker!)), record) : undefined;
		if (modelKey(ctx.model) !== record.targetModel && modelKey(ctx.model) !== record.originalModel) {
			this.write("superseded"); return;
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
		this.notify(ctx, switched && receipt ? `new window persisted; restored ${record.originalModel}.` : "legacy checkpoint duty stopped; original model restored.", !receipt);
	}

	/** Reload/navigation recovers selection only. It never retries inference or writes notes. */
	async recover(ctx: ExtensionContext): Promise<void> {
		const previous = this.busy ? this.record : undefined;
		++this.generation;
		await this.selectionPromise?.catch(() => false);
		if (previous && ctx.isIdle() && previous.sessionId === ctx.sessionManager.getSessionId()
			&& modelKey(ctx.model) === previous.targetModel && !this.belongs(ctx, previous)) {
			// Tree navigation can leave the owned temporary selection on a sibling
			// without its request anchor. Re-anchor recovery only; never resume work.
			const anchorId = ctx.sessionManager.getLeafId();
			if (anchorId) {
				this.record = { ...previous, operationId: randomUUID(), anchorId, targetWindowId: undefined };
				this.write("restoring");
				await this.finish(ctx, false);
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
		await this.finish(ctx, true);
	}
	async shutdown(ctx: ExtensionContext): Promise<void> {
		++this.generation;
		await this.selectionPromise?.catch(() => false);
		if (this.busy) await this.finish(ctx, true);
		this.record = undefined;
	}
}
