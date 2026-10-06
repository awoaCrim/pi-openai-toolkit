import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerCompactionExtension from "./extension-runtime";
import { buildStandaloneCompactionRequest, executeNativeCompaction } from "./compact-client";
import { executeRemoteV2Compaction } from "./remote-v2-client";
import { clearRequestContextCache } from "./request-context-cache";
import { createNativeCompactionDetails, createNativeCompactionResult, DEFAULT_TOOLKIT_CONFIG, LEGACY_NATIVE_COMPACTION_STRATEGY, LEGACY_REMOTE_V2_INPUT_PROVENANCE, NATIVE_COMPACTION_STRATEGY, STANDALONE_COMPACTION_FALLBACK_SUMMARY } from "./types";
import type { NativeCompactionRuntime } from "./runtime";
import type { NativeCompactionRequestBody } from "./serializer";

const originalFetch = globalThis.fetch;
const roots: string[] = [];
afterEach(() => { globalThis.fetch = originalFetch; clearRequestContextCache(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const model = { provider: "official-alias", api: "openai-responses", id: "test", baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 1024 };
const runtime = {
	provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl, authMode: "non-oauth", apiKey: "synthetic-key",
	compactPath: "responses/compact", compactUrl: "https://api.openai.com/v1/responses/compact", responsesPath: "responses", responsesUrl: "https://api.openai.com/v1/responses", currentModel: model,
} as NativeCompactionRuntime;
const window = [
	{ type: "message", role: "user", content: [{ type: "input_text", text: "retained user" }], metadata: { future: [1, null, { flag: true }] } },
	{ type: "compaction", encrypted_content: "opaque-one", unknown: { nested: ["field"] } },
	{ type: "message", role: "assistant", content: [{ type: "output_text", text: "retained assistant, not a summary" }] },
	{ type: "compaction", encrypted_content: "opaque-two" },
];
function sse(output: unknown[] = [{ type: "compaction", encrypted_content: "opaque-v2" }]): Response {
	return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, id: "response-test" } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
}
function protocolFailure(): Response { return Response.json({ error: { code: "unsupported_parameter", param: "input", message: "raw-secret" } }, { status: 400 }); }
function standaloneSuccess(): Response { return Response.json({ id: "compact-test", output: window }); }

test("standalone wire allowlist, redirect policy, complete window and strategy are immutable", async () => {
	const request = {
		model: "test", instructions: "compact", input: [{ type: "configuration_update" }, { role: "user", content: "hello" }],
		tools: [{ type: "function", name: "read" }], stream: true, store: true, previous_response_id: "old", compaction_trigger: true,
		reasoning: { effort: "high" }, text: { verbosity: "low" }, service_tier: "fast", prompt_cache_key: "cache",
		prompt_cache_options: { mode: "explicit", ttl: "30m" }, prompt_cache_retention: "24h",
	} as unknown as NativeCompactionRequestBody;
	const before = structuredClone(request);
	let wire: unknown;
	globalThis.fetch = (async (url, init) => {
		expect(String(url)).toBe(runtime.compactUrl);
		expect(init?.redirect).toBe("error");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-key");
		expect(new Headers(init?.headers).get("accept")).toBe("application/json");
		wire = JSON.parse(String(init?.body));
		return standaloneSuccess();
	}) as typeof fetch;
	const result = await executeNativeCompaction({ runtime, request });
	expect(wire).toEqual({ model: "test", instructions: "compact", input: [{ role: "user", content: "hello" }], service_tier: "fast", prompt_cache_key: "cache", prompt_cache_options: { mode: "explicit", ttl: "30m" }, prompt_cache_retention: "24h" });
	expect(request).toEqual(before);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.compactedWindow).toEqual(window);
	const details = createNativeCompactionDetails({ provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl, inputProvenance: LEGACY_REMOTE_V2_INPUT_PROVENANCE, strategy: LEGACY_NATIVE_COMPACTION_STRATEGY, compactedWindow: result.compactedWindow });
	(result.compactedWindow[1] as { unknown: { nested: string[] } }).unknown.nested.push("mutation");
	expect(details.compactedWindow).toEqual(window);
	expect(createNativeCompactionResult({ firstKeptEntryId: "keep", tokensBefore: 777, details }).summary).toBe(STANDALONE_COMPACTION_FALLBACK_SUMMARY);
	expect(createNativeCompactionDetails({ provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl, inputProvenance: LEGACY_REMOTE_V2_INPUT_PROVENANCE, compactedWindow: window }).strategy).toBe(NATIVE_COMPACTION_STRATEGY);
	expect(buildStandaloneCompactionRequest({ ...request, service_tier: "bad", prompt_cache_options: { ttl: "1m", injected: true }, prompt_cache_retention: "invalid" } as never)).not.toHaveProperty("prompt_cache_options");
	const protoItem = JSON.parse('{"type":"compaction","encrypted_content":"opaque","__proto__":{"future":true}}');
	expect(createNativeCompactionDetails({ provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl, inputProvenance: LEGACY_REMOTE_V2_INPUT_PROVENANCE, compactedWindow: [protoItem] }).compactedWindow).toEqual([protoItem]);
});

for (const [output, reason] of [
	[[], "empty-output"], [[{ type: "message", role: "assistant", content: [] }], "missing-compaction"],
	[[{ type: "compaction", encrypted_content: " " }], "malformed-compaction-item"],
	[[{ type: "compaction", encrypted_content: "valid" }, { type: "compaction" }], "malformed-compaction-item"],
	[[null], "malformed-response"],
] as const) test(`standalone rejects ${reason} (${JSON.stringify(output)})`, async () => {
	globalThis.fetch = (async () => Response.json({ output })) as typeof fetch;
	expect(await executeNativeCompaction({ runtime, request: { model: "test", input: [], instructions: "compact" } })).toMatchObject({ ok: false, reason });
});

test("standalone rejects non-persistable JSON numbers, invalid JSON and redirects", async () => {
	for (const response of [new Response('{"output":[{"type":"compaction","encrypted_content":"opaque","number":1e999}]}'), new Response("secret-invalid-json")]) {
		globalThis.fetch = (async () => response) as typeof fetch;
		const result = await executeNativeCompaction({ runtime, request: { model: "test", input: [], instructions: "compact" } });
		expect(result.ok).toBe(false); if (!result.ok) expect(result.errorMessage ?? "").not.toContain("secret-invalid-json");
	}
	globalThis.fetch = (async (_url, init) => { expect(init?.redirect).toBe("error"); throw new TypeError("redirect to secret URL refused"); }) as typeof fetch;
	expect(await executeNativeCompaction({ runtime, request: { model: "test", input: [], instructions: "compact" } })).toMatchObject({ ok: false, reason: "network-error" });
});

test("standalone cancellation before send and while collecting a stalled body wins", async () => {
	const before = new AbortController(); before.abort();
	globalThis.fetch = (async () => { throw new Error("must not send"); }) as typeof fetch;
	expect(await executeNativeCompaction({ runtime, request: { model: "test", input: [], instructions: "compact" }, signal: before.signal })).toMatchObject({ ok: false, reason: "aborted" });
	const during = new AbortController();
	let cancellations = 0;
	const body = new ReadableStream<Uint8Array>({ pull() { during.abort(); }, cancel() { cancellations++; return new Promise(() => {}); } }, { highWaterMark: 0 });
	globalThis.fetch = (async () => new Response(body)) as typeof fetch;
	expect(await executeNativeCompaction({ runtime, request: { model: "test", input: [], instructions: "compact" }, signal: during.signal })).toMatchObject({ ok: false, reason: "aborted" });
	expect(cancellations).toBe(1);
	expect(body.locked).toBe(false);
});

function hookHarness(options: {
	oauth?: unknown; configured?: unknown; headers?: Record<string, string | null>; baseUrl?: string; api?: string;
	producer?: boolean; source?: "legacy" | "pi-context-hook"; fallbackFailure?: string; hasUI?: boolean;
	remoteCompact?: typeof executeRemoteV2Compaction; standaloneCompact?: typeof executeNativeCompaction;
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "toolkit-standalone-hooks-")); roots.push(root);
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const notifications: string[] = [], fallbackCalls: Array<Record<string, unknown>> = [];
	let projections = 0, authCalls = 0;
	const consumer = { ...model, baseUrl: options.baseUrl ?? model.baseUrl, api: options.api ?? model.api };
	const producer = { ...consumer, id: "producer" };
	const ctx = {
		cwd: root, model: consumer, hasUI: options.hasUI !== false, ui: { notify: (message: string) => notifications.push(message) },
		getSystemPrompt: () => "SYSTEM", sessionManager: {
			getSessionId: () => "standalone-hooks", getSessionFile: () => join(root, "session.jsonl"), getSessionDir: () => root, getBranch: () => [],
			buildSessionProjection: () => ({ messages: [{ role: "user", content: "prepared history", timestamp: 1 }] }),
		}, modelRegistry: {
			find: () => producer,
			getApiKeyAndHeaders: async () => { authCalls++; return { ok: true, apiKey: "synthetic-key", headers: options.headers }; },
			isUsingOAuth: () => options.oauth ?? false, hasConfiguredAuth: () => options.configured ?? true,
		},
	};
	registerCompactionExtension({ on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler), registerTool() {}, getAllTools: () => [], getActiveTools: () => [] } as never, {
		loadConfig: () => ({ config: { ...DEFAULT_TOOLKIT_CONFIG, compaction: { ...DEFAULT_TOOLKIT_CONFIG.compaction,
			remoteV2ContextSource: options.source ?? "pi-context-hook", remoteCompactModel: options.producer ? `${producer.provider}/${producer.id}` : undefined,
			artifactRoot: root, debug: true, logCompactResponses: true,
		} }, warnings: [] }),
		projectCompactionContext: (messages) => { projections++; return messages; },
		nativeFallback: async (args) => { fallbackCalls.push(args as unknown as Record<string, unknown>); return { ok: false, reason: options.fallbackFailure ?? "no-model-configured", modelSpec: "official-alias/producer" } as never; },
		...(options.remoteCompact ? { remoteCompact: options.remoteCompact } : {}),
		...(options.standaloneCompact ? { standaloneCompact: options.standaloneCompact } : {}),
	});
	return { ctx, consumer, notifications, fallbackCalls, root, get projections() { return projections; }, get authCalls() { return authCalls; },
		run: (reason = "manual", signal = new AbortController().signal) => handlers.get("session_before_compact")!({ reason, signal, preparation: { firstKeptEntryId: "keep", tokensBefore: 777, messagesToSummarize: [], turnPrefixMessages: [] } }, ctx),
	};
}

for (const source of ["legacy", "pi-context-hook"] as const) for (const reason of ["manual", "threshold", "overflow"]) {
	test(`${source}/${reason}: actual wire V2 -> one standalone preserves input/runtime/model and never summarizes`, async () => {
		const harness = hookHarness({ source, producer: true });
		const wires: Array<{ url: string; body: { input: unknown[]; model: string } }> = [];
		globalThis.fetch = (async (url, init) => { wires.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return wires.length === 1 ? protocolFailure() : standaloneSuccess(); }) as typeof fetch;
		const result = await harness.run(reason) as { compaction: { summary: string; tokensBefore: number; details: { strategy: string; compactedWindow: unknown[]; compactionModel: { model: string }; requestMeta: { tokensBefore: number } } } };
		expect(wires.map((wire) => wire.url)).toEqual([runtime.responsesUrl, runtime.compactUrl]);
		expect(wires[1].body.input).toEqual(wires[0].body.input.slice(0, -1));
		expect(wires.map((wire) => wire.body.model)).toEqual(["producer", "producer"]);
		expect(result.compaction.details).toMatchObject({ strategy: LEGACY_NATIVE_COMPACTION_STRATEGY, compactedWindow: window, compactionModel: { model: "producer" }, requestMeta: { tokensBefore: 777 } });
		expect(result.compaction.summary).toBe(STANDALONE_COMPACTION_FALLBACK_SUMMARY);
		expect(result.compaction.tokensBefore).toBe(777);
		expect(harness.fallbackCalls).toHaveLength(0); expect(harness.notifications).toHaveLength(0);
		expect(harness.ctx.model).toBe(harness.consumer); expect(harness.authCalls).toBe(2); expect(harness.projections).toBe(source === "legacy" ? 0 : 1);
	});
}

test("V2 success never calls standalone; a validated terminal wins over cleanup cancellation", async () => {
	const controller = new AbortController();
	const harness = hookHarness();
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		const bytes = new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "compaction", encrypted_content: "opaque" }] } })}\n\n`);
		return new Response(new ReadableStream({ start(stream) { stream.enqueue(bytes); }, cancel() { controller.abort(); } }));
	}) as typeof fetch;
	const result = await harness.run("manual", controller.signal);
	expect(result).toHaveProperty("compaction"); expect(calls).toBe(1); expect(harness.fallbackCalls).toHaveLength(0); expect(harness.notifications).toHaveLength(0);
});

for (const options of [{ oauth: true }, { oauth: "unknown" }, { configured: false }, { headers: { Authorization: "Bearer unrelated-key" } }, { baseUrl: "https://gateway.invalid/v1" }, { api: "openai-codex-responses" }, { api: "azure-openai-responses" }]) {
	test(`ineligible auth/endpoint keeps one V2 attempt: ${JSON.stringify(options)}`, async () => {
		const harness = hookHarness(options); let calls = 0;
		globalThis.fetch = (async () => { calls++; return protocolFailure(); }) as typeof fetch;
		expect(await harness.run()).toBeUndefined(); expect(calls).toBe(1); expect(harness.fallbackCalls).toHaveLength(1); expect(harness.notifications.filter((message) => message.includes("No encrypted remote checkpoint"))).toHaveLength(1);
	});
}

for (const fixture of [
	{ status: 400, code: "subscription_sharing_unsupported_capability" }, { status: 400, code: "insufficient_quota" },
	{ status: 401, code: "hardened_oauth_rule_missing" }, { status: 403 }, { status: 429 }, { status: 500 }, { status: 503 }, { status: 0 },
]) test(`excluded V2 failure never probes standalone: ${JSON.stringify(fixture)}`, async () => {
	const harness = hookHarness(); let calls = 0;
	globalThis.fetch = (async () => { calls++; if (!fixture.status) throw new Error("secret URL"); return Response.json({ error: { code: fixture.code, message: "raw-secret" } }, { status: fixture.status }); }) as typeof fetch;
	expect(await harness.run()).toBeUndefined(); expect(calls).toBe(1); expect(harness.fallbackCalls).toHaveLength(1);
	expect(harness.notifications.join()).not.toContain("raw-secret");
});

for (const reason of ["manual", "threshold", "overflow"]) test(`${reason}: exhausted remote attempts warn once then preserve explicit producer summary failure cancellation`, async () => {
	const harness = hookHarness({ producer: true, fallbackFailure: "compact-failed" }); let calls = 0;
	globalThis.fetch = (async () => { calls++; return protocolFailure(); }) as typeof fetch;
	expect(await harness.run(reason)).toEqual({ cancel: true }); expect(calls).toBe(2);
	expect(harness.notifications.filter((message) => message.includes("No encrypted remote checkpoint"))).toHaveLength(1);
	expect(harness.fallbackCalls[0].modelSpec).toBe("official-alias/producer"); expect(harness.ctx.model).toBe(harness.consumer);
});

test("headless exhausted attempts record a safe transition before Pi-default summary", async () => {
	const harness = hookHarness({ hasUI: false }); let calls = 0;
	globalThis.fetch = (async () => { calls++; return protocolFailure(); }) as typeof fetch;
	expect(await harness.run()).toBeUndefined(); expect(calls).toBe(2); expect(harness.notifications).toHaveLength(0);
	const text = readdirSync(harness.root, { recursive: true }).filter((file) => typeof file === "string" && file.endsWith(".json")).map((file) => readFileSync(join(harness.root, String(file)), "utf8")).join("\n");
	expect(text).toContain("remote-to-native-summary"); expect(text).toContain('"nextStep": "native-summary"'); expect(text).not.toContain("raw-secret");
});

for (const phase of ["before", "between", "standalone"] as const) test(`abort ${phase} preserves cancellation without native-summary warning`, async () => {
	const controller = new AbortController(); let calls = 0;
	const harness = hookHarness({ remoteCompact: phase === "between" ? async () => { calls++; controller.abort(); return { ok: false, reason: "non-2xx", status: 400 }; } : undefined });
	if (phase === "before") controller.abort();
	globalThis.fetch = (async () => { calls++; if (calls === 1) return protocolFailure(); controller.abort(); return standaloneSuccess(); }) as typeof fetch;
	expect(await harness.run("manual", controller.signal)).toEqual({ cancel: true }); expect(calls).toBe(phase === "before" ? 0 : phase === "between" ? 1 : 2); expect(harness.fallbackCalls).toHaveLength(0); expect(harness.notifications).toHaveLength(0);
});
