import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { resolveToolkitConfig } from "../config";
import { v2Fixture } from "../config/test-helpers";
import { listenForProtectedSelection } from "../auto-mode/model-selection-guard";
import { ManagedManualCompact, MANUAL_COMPACT_ENTRY_TYPE, decodeManualCompactRecord, sameContextScope } from "./manual-compact";
import { CodexContextWindowManager } from "./window-manager";
import { createContextManagementTools } from "./tools";

function harness(options: { target?: string | null; capacity?: number; deliveryTimeout?: number } = {}) {
	const sm = SessionManager.inMemory("/managed-test");
	const models = ["original", "checkpoint", "user-choice"].map((id) => ({
		id, provider: "managed", api: "openai-responses", name: id, reasoning: id !== "checkpoint", input: ["text"],
		baseUrl: "https://managed.invalid/v1", contextWindow: id === "checkpoint" ? options.capacity ?? 64000 : 64000, maxTokens: 2048,
	}));
	let selected = models[0];
	let thinking: ThinkingLevel = "high";
	let activeTools = ["history", "notes", "new_context", "get_context_remaining"];
	let persistMarkers = true;
	let deliver = true;
	let aborted = false;
	let selection: ((id: string) => boolean | Promise<boolean>) | undefined;
	let auth: ((id: string) => unknown | Promise<unknown>) | undefined;
	const notices: string[] = [];
	const prompts: string[] = [];
	const changes: string[] = [];
	const messages: Array<{ customType: string; content: string; display: boolean; details?: unknown }> = [];
	const emitter = new EventEmitter();
	const events = { emit: (key: string, data: unknown) => { emitter.emit(key, data); }, on: (key: string, listener: (data: unknown) => void) => {
		emitter.on(key, listener); return () => { emitter.off(key, listener); };
	} };
	let manual: ManagedManualCompact;
	const ctx = {
		get model() { return selected; }, sessionManager: sm, hasUI: true, ui: { notify: (text: string) => notices.push(text) },
		modelRegistry: { find: (provider: string, id: string) => provider === "managed" ? models.find((model) => model.id === id) : undefined,
			getApiKeyAndHeaders: async (model: typeof selected) => auth ? await auth(model.id) : { ok: true, apiKey: "test-key", headers: {} } },
		isIdle: () => true, abort: () => { aborted = true; }, getContextUsage: () => undefined,
	} as unknown as ExtensionContext;
	const pi = {
		events, getActiveTools: () => activeTools, getAllTools: () => activeTools.map((name) => ({ name })),
		appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, structuredClone(data)),
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: ThinkingLevel) => { thinking = level; manual.thinkingSelected(level, ctx); },
		setModel: async (model: typeof selected) => {
			if (selection && !(await selection(model.id))) return false;
			selected = model;
			thinking = model.reasoning ? thinking : "off";
			changes.push(model.id);
			sm.appendModelChange(model.provider, model.id);
			manual.modelSelected(model as never, ctx);
			return true;
		},
		sendUserMessage: (content: string) => {
			prompts.push(content);
			if (!deliver) return;
			manual.messageStarted({ role: "user", content });
			sm.appendMessage({ role: "user", content, timestamp: Date.now() });
		},
		sendMessage: (message: typeof messages[number]) => {
			messages.push(message);
			if (persistMarkers) sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
	} as unknown as ExtensionAPI;
	const windows = new CodexContextWindowManager(async () => undefined);
	manual = new ManagedManualCompact(pi, windows, options.deliveryTimeout ?? 10000);
	sm.appendMessage({ role: "user", content: "Original task", timestamp: 1 });
	windows.ensureInitialized(pi, ctx, true);
	sm.appendMessage(fauxAssistantMessage("Working"));
	const raw = {
		defaults: { context: { mode: "remote-windows", remoteCompaction: { model: options.target === undefined ? "managed/checkpoint" : options.target } } },
		models: Object.fromEntries(models.map((model) => [`managed/${model.id}`, { compatibility: { transport: "codex-gateway" } }])),
	};
	const policy = () => resolveToolkitConfig(v2Fixture(raw), models[0]);
	const signal = new AbortController();
	const request = () => manual.request({ signal: signal.signal, reason: "manual", customInstructions: "Keep restrictions" } as never, ctx, policy());
	const begin = async () => { await request(); await manual.compactFailed(ctx); };
	const notes = (id = "write", success = true, persist = true) => {
		sm.appendMessage(fauxAssistantMessage(fauxToolCall("notes", { action: "write_file", path: "/root/notes/work.md", text: "checkpoint" }, { id })));
		if (persist) sm.appendMessage({ role: "toolResult", toolName: "notes", toolCallId: id, content: [{ type: "text", text: "write result" }],
			isError: !success, details: { codexHistoryNotes: { success } }, timestamp: 2 });
	};
	const rollover = () => createContextManagementTools(pi, windows, () => true, () => [], manual).newContext.execute("roll", {}, undefined, undefined, ctx);
	const records = () => sm.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === MANUAL_COMPACT_ENTRY_TYPE ? [decodeManualCompactRecord(entry.data)!] : []);
	return {
		ctx, pi, sm, windows, manual, models, raw, policy, signal, request, begin, notes, rollover, records, prompts, changes, notices, messages,
		get selected() { return selected; }, get thinking() { return thinking; }, get aborted() { return aborted; },
		setActive: (names: string[]) => { activeTools = names; }, setPersist: (value: boolean) => { persistMarkers = value; },
		setDelivery: (value: boolean) => { deliver = value; }, setSelection: (value: typeof selection) => { selection = value; },
		setAuth: (value: typeof auth) => { auth = value; },
		userSelect(id: string) { selected = models.find((model) => model.id === id)!; thinking = "medium"; sm.appendModelChange("managed", id); manual.modelSelected(selected as never, ctx); },
		reload: () => { manual = new ManagedManualCompact(pi, windows); return manual.recover(ctx); },
	};
}

test("managed compact requires a fresh persisted notes pair and restores before visible continuation", async () => {
	const h = harness(); h.notes("old"); await h.begin();
	expect(h.selected.id).toBe("checkpoint"); expect(h.thinking).toBe("off");
	await expect(h.rollover()).rejects.toThrow("new persisted successful");
	h.notes("inflight", true, false); await expect(h.rollover()).rejects.toThrow("new persisted successful");
	h.notes("failed", false); await expect(h.rollover()).rejects.toThrow("new persisted successful");
	h.notes("fresh");
	const scheduled = await h.rollover(); expect(scheduled).toMatchObject({ details: { started: true }, terminate: true });
	expect(h.selected.id).toBe("checkpoint");
	h.manual.turnEnded(h.ctx); expect(h.aborted).toBe(true);
	await h.manual.settled(h.ctx);
	expect(h.selected.id).toBe("original"); expect(h.thinking).toBe("high");
	expect(h.records().at(-1)?.phase).toBe("completed");
	expect(h.prompts).toHaveLength(2); expect(h.prompts[1]).toContain('"read_file"');
	expect(h.prompts[1]).toContain("/root/notes/work.md");
	expect(h.changes).toEqual(["checkpoint", "original"]);
});

test("a later delivered user message also needs a fresh checkpoint", async () => {
	const h = harness(); await h.begin(); h.notes();
	h.sm.appendMessage({ role: "user", content: "New restriction", timestamp: 3 });
	await expect(h.rollover()).rejects.toThrow("latest delivered user message");
	h.notes("after-user"); expect((await h.rollover()).details.started).toBe(true);
	await h.manual.settled(h.ctx);
});

test("accepted but unpersisted target marker cannot complete a handoff", async () => {
	const h = harness(); await h.begin(); h.notes(); h.setPersist(false);
	await h.rollover();
	expect((await h.rollover()).details.started).toBe(false);
	await h.manual.settled(h.ctx);
	expect(h.selected.id).toBe("original"); expect(h.records().at(-1)?.phase).toBe("failed"); expect(h.prompts).toHaveLength(1);
});

for (const target of [null, "managed/original"]) {
	test(`same/unset target (${target}) does not make unnecessary selection changes`, async () => {
		const h = harness({ target }); await h.begin(); h.notes(); await h.rollover(); await h.manual.settled(h.ctx);
		expect(h.changes).toEqual([]); expect(h.records().at(-1)?.phase).toBe("completed");
	});
}

for (const rejection of ["missing", "capacity", "excluded", "target-policy", "backend", "account", "auth", "approval"] as const) {
	test(`preflight ${rejection} refusal never switches or starts inference`, async () => {
		const h = harness({ ...(rejection === "missing" ? { target: "managed/missing" } : {}), ...(rejection === "capacity" ? { capacity: 100 } : {}) });
		if (rejection === "excluded") h.setActive(["history", "new_context"]);
		if (rejection === "target-policy") Object.assign(h.raw.models["managed/checkpoint"], { context: { mode: "pi" } });
		if (["backend", "account", "auth"].includes(rejection)) h.setAuth((id) => id === "checkpoint"
			? rejection === "auth" ? { ok: false } : { ok: true, apiKey: rejection === "account" ? "another-key" : "test-key", baseUrl: rejection === "backend" ? "https://elsewhere.invalid/v1" : undefined }
			: { ok: true, apiKey: "test-key" });
		const stop = rejection === "approval" ? listenForProtectedSelection(h.pi, () => "deny", () => {}) : undefined;
		await h.begin(); stop?.();
		expect(h.changes).toEqual([]); expect(h.prompts).toEqual([]); expect(h.notices.length).toBeGreaterThan(0);
		expect(h.manual.busy).toBe(false);
	});
}

test("configuration snapshot stays fixed during a handoff and releases after restoration", async () => {
	const h = harness(); await h.request();
	h.raw.defaults.context.mode = "pi";
	expect(resolveToolkitConfig(h.manual.snapshot!, h.models[1]).config.compaction.contextManagement).toBe("remote");
	await h.manual.compactFailed(h.ctx); await h.manual.settled(h.ctx);
	expect(h.manual.snapshot).toBeUndefined(); expect(h.records().at(-1)?.phase).toBe("failed");
});

test("no rollover, cancellation before switch, and failed target selection restore safely", async () => {
	const early = harness(); await early.request(); early.signal.abort(); await early.manual.compactFailed(early.ctx);
	expect(early.changes).toEqual([]); expect(early.records().at(-1)?.phase).toBe("cancelled");
	const failed = harness(); failed.setSelection(() => false); await failed.begin();
	expect(failed.selected.id).toBe("original"); expect(failed.prompts).toHaveLength(0); expect(failed.records().at(-1)?.phase).toBe("failed");
	const ended = harness(); await ended.begin(); await ended.manual.settled(ended.ctx);
	expect(ended.selected.id).toBe("original"); expect(ended.prompts).toHaveLength(1); expect(ended.records().at(-1)?.phase).toBe("failed");
});

test("duplicate compact does not start another operation and fresh windows retain cooldown", async () => {
	const h = harness(); await h.begin(); await h.request(); expect(h.prompts).toHaveLength(1);
	h.notes(); await h.rollover(); await h.manual.settled(h.ctx);
	await h.request(); expect(h.records().filter((record) => record.phase === "requested")).toHaveLength(1);
	expect(h.prompts).toHaveLength(2);
});

test("ordinary tools cannot run during checkpoint duty; pending restoration blocks inference", async () => {
	const h = harness(); await h.begin();
	expect(h.manual.guardTool("bash")).toMatchObject({ block: true, terminate: true });
	expect(h.manual.guardTool("notes")).toBeUndefined();
	h.notes(); await h.rollover();
	expect(() => h.manual.guardRequest(h.ctx)).toThrow("restoring"); expect(h.aborted).toBe(true);
	await h.manual.settled(h.ctx); expect(h.manual.guardTool("bash")).toBeUndefined();
});

test("restoration failure stays durable and blocks requests; reload recovers without inference", async () => {
	const h = harness(); await h.begin(); h.notes(); await h.rollover(); h.setSelection((id) => id !== "original");
	await h.manual.settled(h.ctx); expect(h.records().at(-1)?.phase).toBe("restore-needed"); expect(h.selected.id).toBe("checkpoint");
	expect(() => h.manual.guardRequest(h.ctx)).toThrow();
	h.setSelection(() => true); await h.reload();
	expect(h.selected.id).toBe("original"); expect(h.thinking).toBe("high"); expect(h.prompts).toHaveLength(1);
	expect(h.records().at(-1)?.phase).toBe("completed");
});

test("a newer explicit user model selection wins even while the temporary setter is awaiting auth", async () => {
	const h = harness(); let release!: () => void;
	h.setSelection(async (id) => { if (id === "checkpoint") await new Promise<void>((resolve) => { release = resolve; }); return true; });
	await h.request(); const switching = h.manual.compactFailed(h.ctx);
	h.userSelect("user-choice"); release(); await switching;
	expect(h.selected.id).toBe("user-choice"); expect(h.thinking).toBe("medium"); expect(h.prompts).toHaveLength(0);
	expect(h.records().at(-1)?.phase).toBe("superseded");
});

test("reload honors a newer persisted explicit model selection", async () => {
	const h = harness(); await h.begin(); h.userSelect("user-choice"); await h.reload();
	expect(h.selected.id).toBe("user-choice"); expect(h.prompts).toHaveLength(1);
});

test("tree navigation restores an owned temporary selection without launching inference", async () => {
	const h = harness(); const oldLeaf = h.sm.getLeafId()!; await h.begin(); h.sm.branch(oldLeaf); await h.manual.recover(h.ctx);
	expect(h.selected.id).toBe("original"); expect(h.thinking).toBe("high"); expect(h.prompts).toHaveLength(1);
});

test("reload of checkpoint duty does not retry notes or inference", async () => {
	const h = harness(); await h.begin(); await h.reload();
	expect(h.selected.id).toBe("original"); expect(h.prompts).toHaveLength(1);
	expect(h.records().at(-1)?.phase).toBe("failed");
});

test("a failed fire-and-forget kickoff is not delivery evidence", async () => {
	const h = harness({ deliveryTimeout: 5 }); h.setDelivery(false); await h.begin();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(h.selected.id).toBe("original"); expect(h.records().at(-1)?.phase).toBe("failed");
});

test("maintenance ownership is explicit and its cleanup is idempotent", () => {
	const h = harness(); const done = h.manual.beginMaintenance(); expect(h.manual.isMaintenance).toBe(true);
	done(); done(); expect(h.manual.isMaintenance).toBe(false);
});

test("durable decoder validates identities and backend/account comparison fails closed", async () => {
	const h = harness(); await h.request(); const record = h.records()[0];
	expect(decodeManualCompactRecord(record)).toEqual(record);
	for (const change of [{ version: 2 }, { phase: "unknown" }, { targetModel: "bad" }, { originalThinking: "maximum" }, { anchorId: "" }]) {
		expect(decodeManualCompactRecord({ ...record, ...change })).toBeUndefined();
	}
	const native = { kind: "native-codex", provider: "openai-codex", route: "openai-codex", api: "openai-codex-responses", model: "original", baseUrl: "https://codex.invalid", token: "first", accountId: "account", headers: {} } as const;
	expect(sameContextScope(native, { ...native, model: "checkpoint", token: "refreshed" })).toBe(true);
	expect(sameContextScope(native, { ...native, accountId: "another" })).toBe(false);
	await h.manual.shutdown(h.ctx);
});

test("caller cancellation bounds non-cooperative authentication preflight", async () => {
	const h = harness(); h.setAuth(() => new Promise(() => {}));
	const pending = h.request(); h.signal.abort(); await pending;
	expect(h.records().at(-1)?.phase).toBe("cancelled"); expect(h.changes).toEqual([]);
});

test("tools excluded during model selection cancel before kickoff", async () => {
	const h = harness(); h.setSelection(() => { h.setActive([]); return true; }); await h.begin();
	expect(h.selected.id).toBe("original"); expect(h.prompts).toHaveLength(0); expect(h.records().at(-1)?.phase).toBe("failed");
});

test("a sibling branch cannot use a handoff checkpoint when the async thread hint completes", async () => {
	const h = harness(); const anchor = h.sm.getLeafId()!; await h.begin(); h.notes();
	const scheduling = h.manual.prepare(h.ctx)!; h.sm.branch(anchor);
	expect(() => scheduling.beforeSchedule({ firstWindowId: "w1", currentWindowId: "w2", windowNumber: 1 })).toThrow("interrupted");
	await h.manual.recover(h.ctx); expect(h.selected.id).toBe("original");
});

test("duplicate terminal callbacks share one in-flight selection and kickoff", async () => {
	const h = harness(); let release!: () => void;
	h.setSelection(async (id) => { if (id === "checkpoint") await new Promise<void>((resolve) => { release = resolve; }); return true; });
	await h.request(); const first = h.manual.compactFailed(h.ctx);
	await h.manual.compactFailed(h.ctx); release(); await first;
	expect(h.changes).toEqual(["checkpoint"]); expect(h.prompts).toHaveLength(1);
	await h.manual.shutdown(h.ctx);
});

test("shutdown waits for an owned setter before restoring, and never starts the stale kickoff", async () => {
	const h = harness(); let release!: () => void;
	h.setSelection(async (id) => { if (id === "checkpoint") await new Promise<void>((resolve) => { release = resolve; }); return true; });
	await h.request(); const starting = h.manual.compactFailed(h.ctx); const shutdown = h.manual.shutdown(h.ctx);
	release(); await Promise.all([starting, shutdown]);
	expect(h.selected.id).toBe("original"); expect(h.thinking).toBe("high"); expect(h.prompts).toHaveLength(0);
});

test("failure to reapply a newer user choice stays blocked and recoverable", async () => {
	const h = harness(); let release!: () => void;
	h.setSelection(async (id) => {
		if (id === "checkpoint") await new Promise<void>((resolve) => { release = resolve; });
		return id !== "user-choice";
	});
	await h.request(); const starting = h.manual.compactFailed(h.ctx);
	h.userSelect("user-choice"); release(); await starting;
	expect(h.records().at(-1)?.phase).toBe("restore-needed");
	expect(() => h.manual.guardRequest(h.ctx)).toThrow(); expect(h.prompts).toHaveLength(0);
	h.setSelection(() => true); await h.reload(); expect(h.selected.id).toBe("user-choice"); expect(h.thinking).toBe("medium");
});
