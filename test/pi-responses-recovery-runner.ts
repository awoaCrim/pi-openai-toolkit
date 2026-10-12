import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const scenario = process.argv[2];
assert(["recover", "failed", "disabled", "exhausted", "cancel", "compacted", "bootstrap"].includes(scenario));
const env = await createSmokeEnvironment();
const originalWebSocket = globalThis.WebSocket;
let session: AgentSession | undefined;
try {
	const { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { fauxAssistantMessage, InMemoryCredentialStore, InMemoryModelsStore, Type } = await import("@earendil-works/pi-ai");
	const { getApiProvider } = await import("@earendil-works/pi-ai/compat");
	const { createNativeCompactionDetails, LEGACY_REMOTE_V2_INPUT_PROVENANCE, NATIVE_COMPACTION_FALLBACK_SUMMARY } = await import("../src/types");
	const { closeResponsesWebSocketSessions } = await import("../src/responses-websocket/transport");
	const baseUrl = "https://recovery.invalid/v1";
	const configDir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify({ schemaVersion: 2, defaults: {
		responsesWebSocket: { enabled: true },
		context: { mode: "remote-compaction", nativeFallback: { enabled: false } },
	} }));
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	// The fixture uses the public custom-stream boundary so the SDK and extension
	// share an adapter even when npm installs a second pi-ai beneath the SDK.
	// The actual native encoder/parser, AgentSession and retry loop are unchanged.
	runtime.registerProvider("recovery", { api: "openai-responses", apiKey: "synthetic-recovery-key", baseUrl,
		streamSimple: (model, context, options) => getApiProvider("openai-responses")!.streamSimple(model, context, options),
		models: [{ id: "gpt-recovery", name: "Recovery fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1024 }] });
	const model = runtime.getModel("recovery", "gpt-recovery")!;
	assert(model);
	const sm = SessionManager.create(env.cwd, join(env.cwd, "sessions"));
	if (scenario === "compacted") {
		sm.appendMessage({ role: "user", content: "RETIRED-HISTORY-MUST-NOT-RETURN", timestamp: 1 });
		sm.appendMessage(fauxAssistantMessage("RETIRED-ANSWER", { timestamp: 2 }));
		const details = createNativeCompactionDetails({ provider: model.provider, api: model.api, model: model.id, baseUrl,
			inputProvenance: LEGACY_REMOTE_V2_INPUT_PROVENANCE,
			compactedWindow: [{ type: "compaction", encrypted_content: "opaque-active-window" }] });
		sm.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, null, 100, details, true);
		sm.appendMessage({ role: "user", content: "CURRENT-TAIL", timestamp: 3 });
	}
	const settings = SettingsManager.inMemory({ transport: "auto", retry: { enabled: scenario !== "disabled",
		maxRetries: 1, baseDelayMs: 5, provider: { maxRetries: 0, timeoutMs: 2000 } },
		compaction: { enabled: false } }, { projectTrusted: true });
	const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings,
		additionalExtensionPaths: [
			...(scenario === "compacted" ? [resolve(import.meta.dir, "../src/extension-runtime.ts")] : []),
			resolve(import.meta.dir, "../src/responses-websocket/extension.ts"),
		], noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		systemPromptOverride: () => "Run the deterministic count_tool once, preserve its result and finish.",
	});
	const originalProvider = getApiProvider("openai-responses");
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.notEqual(getApiProvider("openai-responses"), originalProvider, "loader did not install WS in the fixture registry");
	let toolExecutions = 0;
	const tool = defineTool({ name: "count_tool", label: "count", description: "Count one execution.",
		parameters: Type.Object({ value: Type.String() }), execute: async (_id, params) => {
			toolExecutions++;
			assert.equal(params.value, "once", "a failed generation executed a tool");
			return { content: [{ type: "text", text: "RESULT-ONCE" }], details: {} };
		} });
	({ session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model,
		settingsManager: settings, resourceLoader: loader, sessionManager: sm, tools: [tool.name], customTools: [tool] }));
	const events: AgentSessionEvent[] = [];
	let cancellation: Promise<void> | undefined;
	session.subscribe((event) => {
		events.push(event);
		if (scenario === "cancel" && event.type === "auto_retry_start") {
			// Let the host establish its backoff controller before cancellation.
			cancellation = Promise.resolve().then(() => session!.abort());
		}
	});
	const errors: string[] = [];
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
	assert.deepEqual(errors, []);
	const bodies: Array<Record<string, unknown>> = [];
	let sockets = 0, httpCalls = 0;
	let failure: unknown;
	const once = { type: "function_call", id: "fc_once", call_id: "call_once", name: tool.name, arguments: JSON.stringify({ value: "once" }) };
	function completed(output: Array<Record<string, unknown>>, id: string): Array<Record<string, unknown>> {
		return [
			{ type: "response.created", response: { id, status: "in_progress", output: [] } },
			...output.flatMap((item, output_index) => [
				{ type: "response.output_item.added", output_index, item },
				{ type: "response.output_item.done", output_index, item },
			]),
			{ type: "response.completed", response: { id, status: "completed", output,
				usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
		];
	}
	const interrupted = scenario === "failed"
		? { type: "response.failed", response: { id: "resp_failed", status: "failed", error: { code: "stream_error", message: "stream closed before response.completed" } } }
		: { type: "error", code: "stream_error", message: "stream closed before response.completed" };
	function failedFrames(): Array<Record<string, unknown>> {
		const completedCall = { type: "function_call", id: "fc_failed", call_id: "call_failed", name: tool.name, arguments: JSON.stringify({ value: "must-not-execute" }) };
		return [
			{ type: "response.created", response: { id: "resp_failed", status: "in_progress", output: [] } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_failed", role: "assistant", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "FAILED-PARTIAL" },
			{ type: "response.output_item.added", output_index: 1, item: completedCall },
			{ type: "response.output_item.done", output_index: 1, item: completedCall },
			{ type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_partial", call_id: "call_partial", name: tool.name, arguments: "" } },
			{ type: "response.function_call_arguments.delta", output_index: 2, delta: '{"value":' },
			interrupted,
		];
	}
	type SocketEvent = { data?: string; code?: number; reason?: string };
	class FakeSocket {
		readyState = 0;
		listeners = new Map<string, Set<(event: SocketEvent) => void>>();
		constructor(url: string) {
			assert.equal(url, "wss://recovery.invalid/v1/responses?model=gpt-recovery");
			sockets++;
			queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); });
		}
		addEventListener(type: string, fn: (event: SocketEvent) => void) {
			if (!this.listeners.has(type)) this.listeners.set(type, new Set());
			this.listeners.get(type)!.add(fn);
		}
		removeEventListener(type: string, fn: (event: SocketEvent) => void) { this.listeners.get(type)?.delete(fn); }
		emit(type: string, event: SocketEvent) { for (const fn of [...this.listeners.get(type) ?? []]) fn(event); }
		close() { this.readyState = 3; this.emit("close", { code: 1000, reason: "done" }); }
		send(data: string) {
			try {
				const body = JSON.parse(data) as Record<string, unknown>;
				assert.equal(body.model, model.id);
				bodies.push(body);
				assert(bodies.length <= 3, "native retry exceeded its budget");
				let frames: Array<Record<string, unknown>>;
				if (bodies.length === 1) frames = scenario === "bootstrap" ? [interrupted] : completed([once], "resp_once");
				else if (bodies.length === 2 || scenario === "exhausted") frames = failedFrames();
				else frames = completed([{ type: "message", id: "msg_ok", role: "assistant", content: [{ type: "output_text", text: "RECOVERED", annotations: [] }] }], "resp_ok");
				for (const event of frames) queueMicrotask(() => this.emit("message", { data: JSON.stringify(event) }));
			} catch (error) { failure ??= error; throw error; }
		}
	}
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const request = new Request(input, init);
		if (scenario !== "bootstrap" || request.url !== `${baseUrl}/responses`) return deniedFetch(input, init);
		httpCalls++;
		assert.equal(httpCalls, 1, "transparent fallback repeated");
		const body = await request.json() as Record<string, unknown>;
		assert.equal(body.previous_response_id, undefined);
		assert(JSON.stringify(body.input).includes("Run count_tool"));
		return new Response(completed([once], "resp_once").map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	try {
		await session.prompt("Run count_tool once and finish.");
		if (cancellation) await cancellation;
		if (failure) throw failure;
		assert.deepEqual(errors, []);
		assert.equal(toolExecutions, 1, JSON.stringify({ sockets, wsCalls: bodies.length, httpCalls, last: session.messages.at(-1) }));
		assert.equal(httpCalls, scenario === "bootstrap" ? 1 : 0);
		const stopsEarly = scenario === "disabled" || scenario === "cancel";
		assert.equal(bodies.length, stopsEarly ? 2 : 3);
		assert.equal(events.filter((event) => event.type === "auto_retry_start").length, scenario === "disabled" ? 0 : 1);
		const succeeds = !stopsEarly && scenario !== "exhausted";
		assert.equal(session.getLastAssistantText(), succeeds ? "RECOVERED" : scenario === "cancel" ? undefined : "FAILED-PARTIAL");
		if (scenario !== "cancel") {
			const last = session.messages.at(-1)!;
			assert.equal(last.role, "assistant");
			if (last.role === "assistant") {
				assert.equal(last.stopReason, succeeds ? "stop" : "error");
				if (succeeds) assert.equal(last.usage.totalTokens, 25);
			}
		}
		if (!stopsEarly) {
			const retry = bodies[2]!;
			assert.equal(retry.previous_response_id, undefined, "retry reused the failed socket continuation");
			const items = retry.input as Array<Record<string, unknown>>;
			assert.equal(items.filter((item) => item.type === "function_call" && item.call_id === "call_once").length, 1);
			assert.equal(items.filter((item) => item.type === "function_call_output" && item.call_id === "call_once").length, 1);
			const input = JSON.stringify(items);
			assert(input.includes("RESULT-ONCE"));
			assert(!input.includes("FAILED-PARTIAL") && !input.includes("call_failed") && !input.includes("call_partial"));
			if (scenario === "compacted") {
				assert(input.includes("opaque-active-window") && input.includes("CURRENT-TAIL"));
				assert(!input.includes("RETIRED-") && !input.includes("opaque compaction window"));
			}
			assert(sockets >= 2, "failed cached socket was not evicted");
		}
		const raw = sm.getBranch();
		const failures = raw.filter((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error");
		assert.equal(failures.length, scenario === "exhausted" ? 2 : 1, "failed attempt disappeared from raw history");
		assert.equal(raw.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").length, 1);
		assert(JSON.stringify(failures).includes("call_failed") && JSON.stringify(failures).includes("call_partial"));
		assert(JSON.stringify(failures).includes("WebSocket error: stream closed before response.completed"));
		const stats = session.getSessionStats();
		assert.equal(stats.toolResults, 1);
		assert.equal(stats.tokens.total, succeeds ? 50 : 25, "recovery corrupted native usage accounting");
		assert.equal(stats.cost, 0, "synthetic zero-cost fixture acquired unexpected usage");
		const reopened = SessionManager.open(sm.getSessionFile()!);
		// JSON persistence intentionally omits undefined optional fields (e.g. tool usage).
		assert.deepEqual(reopened.buildSessionProjection().messages, JSON.parse(JSON.stringify(sm.buildSessionProjection().messages)));
		assert((await readFile(sm.getSessionFile()!, "utf8")).includes("FAILED-PARTIAL"));
		env.assertNoNetwork();
		process.stdout.write("OK\n");
	} finally { closeResponsesWebSocketSessions(); }
} finally {
	session?.dispose();
	globalThis.WebSocket = originalWebSocket;
	await env.dispose();
}
