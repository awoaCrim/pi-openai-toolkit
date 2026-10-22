import { expect, test } from "bun:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { THINKING_LEVELS } from "../types";
import { ManagedManualCompact, MANUAL_COMPACT_ENTRY_TYPE, decodeManualCompactRecord, type ManualCompactRecord } from "./manual-compact";

function harness(phase: ManualCompactRecord["phase"] = "checkpointing") {
	const sm = SessionManager.inMemory("/legacy-recovery-test");
	const models = ["original", "checkpoint", "user-choice"].map((id) => ({ id, provider: "managed", api: "openai-responses", name: id,
		reasoning: true, input: ["text"], baseUrl: "https://managed.invalid/v1", contextWindow: 64000, maxTokens: 2048 }));
	let selected = models[1]!;
	let thinking: ThinkingLevel = "off";
	let idle = true;
	let aborted = false;
	let selection: ((id: string) => boolean | Promise<boolean>) | undefined;
	const changes: string[] = [], prompts: string[] = [], notices: string[] = [];
	let manual: ManagedManualCompact;
	const ctx = {
		get model() { return selected; }, sessionManager: sm, hasUI: true, ui: { notify: (text: string) => notices.push(text) },
		modelRegistry: { find: (provider: string, id: string) => provider === "managed" ? models.find((model) => model.id === id) : undefined },
		isIdle: () => idle, abort: () => { aborted = true; },
	} as unknown as ExtensionContext;
	const pi = {
		appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, structuredClone(data)),
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: ThinkingLevel) => { thinking = level; manual.thinkingSelected(level, ctx); },
		setModel: async (model: typeof selected) => {
			if (selection && !(await selection(model.id))) return false;
			selected = model;
			changes.push(model.id);
			sm.appendModelChange(model.provider, model.id);
			manual.modelSelected(model as never, ctx);
			return true;
		},
		sendUserMessage: (text: string) => { prompts.push(text); },
	} as unknown as ExtensionAPI;
	const anchorId = sm.appendMessage({ role: "user", content: "Original task", timestamp: 1 });
	const record: ManualCompactRecord = { version: 1, operationId: "old-operation", sessionId: sm.getSessionId(), sourceWindowId: "w1",
		anchorId, originalModel: "managed/original", targetModel: "managed/checkpoint", originalThinking: "high", phase };
	sm.appendCustomEntry(MANUAL_COMPACT_ENTRY_TYPE, record);
	manual = new ManagedManualCompact(pi);
	return {
		ctx, pi, sm, record, models, anchorId, prompts, changes, notices,
		get manual() { return manual; }, get selected() { return selected; }, get thinking() { return thinking; }, get aborted() { return aborted; },
		records: () => sm.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === MANUAL_COMPACT_ENTRY_TYPE ? [decodeManualCompactRecord(entry.data)!] : []),
		setIdle: (value: boolean) => { idle = value; }, setSelection: (value: typeof selection) => { selection = value; },
		userSelect: () => { selected = models[2]!; thinking = "medium"; sm.appendModelChange("managed", selected.id); manual.modelSelected(selected as never, ctx); },
		reload: () => { manual = new ManagedManualCompact(pi); return manual.recover(ctx); },
	};
}

for (const phase of ["requested", "switching", "checkpointing", "rollover-scheduled", "restoring", "restore-needed"] as const) {
	test(`legacy ${phase} record restores selection only, without notes duty or continuation`, async () => {
		const h = harness(phase);
		await h.manual.recover(h.ctx);
		expect(h.selected.id).toBe("original");
		expect(h.thinking).toBe("high");
		expect(h.prompts).toEqual([]);
		expect(h.changes).toEqual(["original"]);
		expect(h.records().at(-1)?.phase).toBe("failed");
		expect(h.manual.busy).toBe(false);
		expect(h.manual.prepare(h.ctx)).toBeUndefined();
		expect("request" in h.manual).toBe(false);
		await h.manual.settled(h.ctx);
		expect(h.prompts).toEqual([]);
	});
}

test("legacy restoration failure remains durable and blocks even context tools until explicit recovery", async () => {
	const h = harness();
	h.setSelection(() => false);
	await h.manual.recover(h.ctx);
	expect(h.records().at(-1)?.phase).toBe("restore-needed");
	expect(h.selected.id).toBe("checkpoint");
	expect(() => h.manual.guardRequest(h.ctx)).toThrow("restoring");
	expect(h.aborted).toBe(true);
	for (const tool of ["bash", "notes", "new_context"]) expect(h.manual.guardTool(tool)).toMatchObject({ block: true, terminate: true });
	expect(() => h.manual.prepare(h.ctx)).toThrow("recovery is pending");
	await h.manual.settled(h.ctx);
	expect(h.changes).toEqual([]);
	h.setSelection(() => true);
	await h.reload();
	expect(h.selected.id).toBe("original");
	expect(h.thinking).toBe("high");
	expect(h.manual.guardTool("notes")).toBeUndefined();
	expect(h.prompts).toEqual([]);
});

test("a newer explicit selection wins while legacy restoration awaits its owned setter", async () => {
	const h = harness(); let release!: () => void, entered!: () => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	h.setSelection(async (id) => { if (id === "original") { entered(); await new Promise<void>((resolve) => { release = resolve; }); } return true; });
	const recovering = h.manual.recover(h.ctx);
	await ready; h.userSelect(); release(); await recovering;
	expect(h.selected.id).toBe("user-choice");
	expect(h.thinking).toBe("medium");
	expect(h.records().at(-1)?.phase).toBe("superseded");
	expect(h.prompts).toEqual([]);
});

test("failure to reapply a newer choice stays blocked and recoverable without inference", async () => {
	const h = harness(); let release!: () => void, entered!: () => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	h.setSelection(async (id) => { if (id === "original") { entered(); await new Promise<void>((resolve) => { release = resolve; }); } return id !== "user-choice"; });
	const recovering = h.manual.recover(h.ctx);
	await ready; h.userSelect(); release(); await recovering;
	expect(h.records().at(-1)?.phase).toBe("restore-needed");
	expect(() => h.manual.guardRequest(h.ctx)).toThrow();
	h.setSelection(() => true); await h.reload();
	expect(h.selected.id).toBe("user-choice");
	expect(h.thinking).toBe("medium");
	expect(h.prompts).toEqual([]);
});

test("reload honors a newer persisted choice and terminal or foreign records", async () => {
	const user = harness(); user.userSelect(); await user.reload();
	expect(user.changes).toEqual([]); expect(user.selected.id).toBe("user-choice");
	for (const phase of ["completed", "failed", "cancelled", "superseded"] as const) {
		const h = harness(phase); await h.manual.recover(h.ctx);
		expect(h.changes).toEqual([]); expect(h.prompts).toEqual([]);
	}
	const foreign = harness();
	foreign.sm.appendCustomEntry(MANUAL_COMPACT_ENTRY_TYPE, { ...foreign.record, sessionId: "foreign-session" });
	await foreign.manual.recover(foreign.ctx);
	expect(foreign.changes).toEqual([]);
});

test("legacy recovery deferred until public idle never starts a delayed handoff", async () => {
	const h = harness("requested"); h.setIdle(false);
	await h.manual.recover(h.ctx);
	expect(h.manual.busy).toBe(true); expect(h.changes).toEqual([]);
	h.setIdle(true); await h.manual.settled(h.ctx);
	expect(h.selected.id).toBe("original"); expect(h.thinking).toBe("high");
	expect(h.prompts).toEqual([]);
});

test("tree navigation away from the owned request can restore its still-selected temporary model", async () => {
	const h = harness(); h.setIdle(false); await h.manual.recover(h.ctx);
	h.sm.branch(h.anchorId); h.setIdle(true); await h.manual.recover(h.ctx);
	expect(h.selected.id).toBe("original"); expect(h.thinking).toBe("high"); expect(h.prompts).toEqual([]);
});

test("shutdown waits for an owned restoration setter and never schedules a continuation", async () => {
	const h = harness(); let release!: () => void, entered!: () => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	h.setSelection(async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return true; });
	const recovering = h.manual.recover(h.ctx); await ready;
	const shutdown = h.manual.shutdown(h.ctx);
	release(); await Promise.all([recovering, shutdown]);
	expect(h.selected.id).toBe("original"); expect(h.thinking).toBe("high"); expect(h.prompts).toEqual([]);
});

test("recovery restores the canonical max thinking level and decoder rejects malformed records", async () => {
	const h = harness();
	for (const thinking of THINKING_LEVELS) expect(decodeManualCompactRecord({ ...h.record, originalThinking: thinking })?.originalThinking).toBe(thinking);
	for (const change of [{ originalThinking: "maximum" }, { version: 2 }, { phase: "unknown" }, { targetModel: "bad" }, { anchorId: "" }]) {
		expect(decodeManualCompactRecord({ ...h.record, ...change })).toBeUndefined();
	}
	h.sm.appendCustomEntry(MANUAL_COMPACT_ENTRY_TYPE, { ...h.record, originalThinking: "max" });
	await h.manual.recover(h.ctx); expect(h.thinking).toBe("max"); expect(h.prompts).toEqual([]);
});

test("maintenance ownership stays explicit, nested and idempotent without creating recovery work", () => {
	const h = harness("completed");
	const done = h.manual.beginMaintenance(), nested = h.manual.beginMaintenance();
	expect(h.manual.isMaintenance).toBe(true); done(); done(); expect(h.manual.isMaintenance).toBe(true);
	nested(); expect(h.manual.isMaintenance).toBe(false); expect(h.changes).toEqual([]); expect(h.prompts).toEqual([]);
});
