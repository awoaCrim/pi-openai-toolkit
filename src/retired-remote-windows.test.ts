import { describe, expect, test } from "bun:test";
import registerExtension from "./extension-runtime";
import {
	detectRetiredRemoteWindows,
	RETIRED_MANUAL_COMPACT_TYPE,
	RETIRED_REMOTE_WINDOW_SUMMARY,
	RETIRED_REMOTE_WINDOW_TYPE,
} from "./retired-remote-windows";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_TOOLKIT_CONFIG } from "./types";

type Entry = Record<string, unknown>;
type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
const evidence: Array<[string, Entry]> = [
	["window-message", { type: "custom_message", customType: RETIRED_REMOTE_WINDOW_TYPE, details: null }],
	["window-message", { type: "custom_message", customType: RETIRED_REMOTE_WINDOW_TYPE, details: "malformed" }],
	["window-compaction", { type: "compaction", details: { strategy: RETIRED_REMOTE_WINDOW_TYPE, protocol: "malformed" } }],
	["window-summary", { type: "compaction", summary: RETIRED_REMOTE_WINDOW_SUMMARY, details: null }],
	["manual-compact-record", { type: "custom", customType: RETIRED_MANUAL_COMPACT_TYPE, data: null }],
	...["checkpointing", "completed", "failed", "abandoned"].map((phase): [string, Entry] => ["manual-compact-record", { type: "custom", customType: RETIRED_MANUAL_COMPACT_TYPE, data: { phase, sessionId: "foreign", originalModel: "do-not-restore/model" } }]),
];
function harness(mode = "remote-compaction", enabled = true, gateway = false) {
	const handlers = new Map<string, Handler>();
	let branch: Entry[] = [];
	let sessionId: string | undefined = "retirement-unit-session";
	let loads = 0, authCalls = 0, aborts = 0, compactCalls = 0, fallbackCalls = 0, mutations = 0;
	const notices: string[] = [];
	const model = { provider: "retired-fixture", id: "current", api: "openai-responses", baseUrl: "https://retirement.invalid/v1", contextWindow: 64000, input: ["text"], reasoning: false };
	const ctx = {
		model, thinkingLevel: "off", hasUI: true,
		ui: { notify: (message: string) => notices.push(message) },
		abort: () => { aborts++; },
		getSystemPrompt: () => "retirement fixture",
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => branch, getSessionId: () => sessionId },
		modelRegistry: { find: () => { mutations++; throw new Error("must not select a producer"); }, getApiKeyAndHeaders: async () => { authCalls++; return { ok: true, apiKey: "synthetic-key" }; } },
	};
	registerExtension({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: () => { mutations++; }, registerCommand: () => undefined,
		sendMessage: () => { mutations++; }, setModel: () => { mutations++; }, setThinkingLevel: () => { mutations++; },
	} as never, {
		loadConfig: () => {
			loads++;
			return { config: { ...DEFAULT_TOOLKIT_CONFIG, compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled } }, warnings: [], document: {
				format: "v2", configPath: "retirement-fixture.json", issues: [], raw: { schemaVersion: 2, defaults: { context: { mode: !enabled || mode === "pi" ? "pi" : "remote-compaction", ...(mode === "intentional-default" ? { remoteCompaction: { apis: [] }, nativeFallback: { enabled: false } } : {}) } }, models: gateway ? { "retired-fixture/current": { compatibility: { transport: "codex-gateway" } } } : {} },
			} };
		},
		remoteCompact: async () => { compactCalls++; throw new Error("must not compact retired history"); },
		standaloneCompact: async () => { compactCalls++; throw new Error("must not compact retired history"); },
		nativeFallback: async () => { fallbackCalls++; return { ok: false, reason: "no-model-configured" }; },
	} as never);
	return { ctx, handlers, notices, setBranch: (entries: Entry[]) => { branch = entries; }, setSessionId: (id: string | undefined) => { sessionId = id; }, counts: () => ({ loads, authCalls, aborts, compactCalls, fallbackCalls, mutations }) };
}

describe("Reserved Remote Windows evidence", () => {
	for (const [index, [reason, entry]] of evidence.entries()) {
		test(`malformed/terminal evidence ${index} remains reserved after newer entries`, () => {
			expect(detectRetiredRemoteWindows([null, 42, [], entry, { type: "compaction", summary: "new ordinary summary" }])).toBe(reason);
		});
	}
	test("ordinary summaries, tools and similar non-reserved values do not claim a branch", () => {
		expect(detectRetiredRemoteWindows([{ type: "custom", customType: "unrelated" }, { type: "message", message: { role: "user", content: RETIRED_REMOTE_WINDOW_SUMMARY } }, { type: "compaction", summary: "[OpenAI standalone opaque compaction window]" }, { type: "custom_message", customType: "codex-context-window-extra" }])).toBeUndefined();
	});
});

for (const mode of ["remote-compaction", "pi", "disabled"]) {
	for (const reason of ["manual", "threshold", "overflow"]) {
		test(`${mode}/${reason}: every retired branch cancels before config, auth or any fallback`, async () => {
			const h = harness(mode, mode !== "disabled");
			for (const [, entry] of evidence) {
				h.setBranch([structuredClone(entry), { type: "compaction", summary: "newer summary" }]);
				const before = structuredClone(h.ctx.sessionManager.getBranch());
				const result = await h.handlers.get("session_before_compact")!({ reason, branchEntries: [], preparation: {}, signal: new AbortController().signal }, h.ctx);
				expect(result).toEqual({ cancel: true });
				expect(h.ctx.sessionManager.getBranch()).toEqual(before);
			}
			expect(h.counts()).toEqual({ loads: 0, authCalls: 0, aborts: 0, compactCalls: 0, fallbackCalls: 0, mutations: 0 });
		});
	}
	test(`${mode}: startup/request guards are fresh, bounded and never restore a model`, async () => {
		const h = harness(mode, mode !== "disabled");
		h.setBranch([evidence[0][1]]);
		await h.handlers.get("session_start")!({}, h.ctx);
		for (const hook of ["context_with_system", "before_provider_request", "before_provider_headers"]) {
			await h.handlers.get(hook)!({ messages: [], payload: { input: [] }, headers: {} }, h.ctx);
		}
		expect(h.notices).toHaveLength(1);
		expect(h.notices[0]).toMatch(/Remote Windows.*removed.*new session/i);
		expect(h.counts()).toMatchObject({ loads: 0, authCalls: 0, aborts: 3, compactCalls: 0, fallbackCalls: 0, mutations: 0 });
		// Neither prior evidence in another branch nor a cached refusal owns this branch.
		h.setBranch([]);
		await h.handlers.get("session_tree")!({}, h.ctx);
		h.setBranch([evidence[0][1]]);
		await h.handlers.get("session_tree")!({}, h.ctx);
		expect(h.notices).toHaveLength(2);
	});
	for (const hasUI of [true, false]) {
		test(`${mode}: UI failure or headless operation cannot bypass refusal (hasUI=${hasUI})`, async () => {
			for (const hook of ["session_before_compact", "session_start", "session_tree", "context_with_system", "before_provider_request", "before_provider_headers"]) {
				const h = harness(mode, mode !== "disabled");
				h.ctx.hasUI = hasUI;
				h.ctx.ui.notify = () => { throw new Error("detached UI"); };
				h.setBranch([evidence[0][1]]);
				const result = await h.handlers.get(hook)!({ reason: "manual", messages: [], payload: { input: [] }, headers: {} }, h.ctx);
				if (hook === "session_before_compact") expect(result).toEqual({ cancel: true });
				expect(h.counts()).toEqual({ loads: 0, authCalls: 0, aborts: ["context_with_system", "before_provider_request", "before_provider_headers"].includes(hook) ? 1 : 0, compactCalls: 0, fallbackCalls: 0, mutations: 0 });
			}
		});
	}
}

for (const mode of ["pi", "disabled", "intentional-default"]) {
	test(`${mode}: default handoff remains revocable after later observers`, async () => {
		const h = harness(mode, mode !== "disabled");
		const result = await h.handlers.get("session_before_compact")!({ reason: "manual", preparation: { messagesToSummarize: [], turnPrefixMessages: [] }, signal: new AbortController().signal }, h.ctx) as { cancel: boolean } | undefined;
		expect(result?.cancel).toBe(false);
		h.setBranch([evidence[0][1]]);
		expect(result?.cancel).toBe(true);
		expect(h.counts()).toMatchObject({ authCalls: 0, compactCalls: 0, fallbackCalls: mode === "intentional-default" ? 1 : 0, mutations: 0 });
	});
}

test("independent gateway transport remains available without window tools or context mode", async () => {
	const h = harness("pi", false, true);
	const headers: Record<string, string> = { authorization: "old-token", "x-private-header": "do-not-forward" };
	await h.handlers.get("before_provider_headers")!({ headers }, h.ctx);
	expect(h.counts()).toMatchObject({ authCalls: 1, aborts: 0, mutations: 0 });
	expect(headers.authorization).toBe("Bearer synthetic-key");
	expect(headers["session-id"]).toBe("retirement-unit-session");
	expect(headers["x-codex-model"]).toBe("current");
	expect(headers).not.toHaveProperty("x-private-header");
	expect(headers).not.toHaveProperty("x-codex-window-id");
	expect(headers).not.toHaveProperty("x-codex-turn-metadata");
	h.setSessionId(undefined);
	await h.handlers.get("before_provider_headers")!({ headers: {} }, h.ctx);
	expect(h.counts().aborts).toBe(1);
});
