import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const scenario = process.argv[2];
assert(["native-http", "native-ws", "gateway-http", "gateway-ws"].includes(scenario));
const uiMode = process.argv[3];
assert(uiMode === "tui" || uiMode === "rpc");
const native = scenario.startsWith("native");
const websocket = scenario.endsWith("ws");
const env = await createSmokeEnvironment();
const originalSocket = globalThis.WebSocket;
let session: AgentSession | undefined;
let closeGatewaySockets = () => {};
let closeNativeSockets = () => {};
const socketInstances: Array<{ close(): void }> = [];
try {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { InMemoryCredentialStore, InMemoryModelsStore } = await import("@earendil-works/pi-ai");
	const { getApiProvider } = await import("@earendil-works/pi-ai/compat");
	const { closeOpenAICodexWebSocketSessions } = await import("@earendil-works/pi-ai/api/openai-codex-responses");
	closeNativeSockets = closeOpenAICodexWebSocketSessions;
	const { CODEX_FAST_ENTRY_TYPE, readCodexFastState } = await import("../src/codex-fast/state");
	const { closeResponsesWebSocketSessions } = await import("../src/responses-websocket/transport");
	closeGatewaySockets = closeResponsesWebSocketSessions;
	const api = native ? "openai-codex-responses" : "openai-responses";
	const baseUrl = native ? "https://fast-native.invalid/backend-api" : "https://fast-gateway.invalid/v1";
	const token = ["fixture", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url"), "fixture"].join(".");
	const configDir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(configDir, { recursive: true });
	const configPath = join(configDir, "config.json");
	const configBytes = JSON.stringify({ schemaVersion: 2, defaults: { responsesWebSocket: { enabled: true }, context: { mode: "pi" } } });
	await writeFile(configPath, configBytes);
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerProvider("fast-fixture", { api, apiKey: native ? token : "synthetic-key", baseUrl,
		streamSimple: (model, context, options) => getApiProvider(api)!.streamSimple(model, context, options),
		models: [{ id: "gpt-fast-fixture", name: "Fast fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1024 }] });
	const model = runtime.getModel("fast-fixture", "gpt-fast-fixture")!;
	const settings = SettingsManager.inMemory({ transport: websocket ? "websocket-cached" : "sse",
		retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 2000 } }, compaction: { enabled: false } }, { projectTrusted: true });
	const bodies: Array<Record<string, unknown>> = [];
	const statuses = new Map<string, string | undefined>();
	const notices: string[] = [], errors: string[] = [];
	let mockFailure: unknown;
	function frames(body: Record<string, unknown>): Array<Record<string, unknown>> {
		assert.equal(body.model, model.id);
		bodies.push(body);
		assert(bodies.length <= 6, "unexpected extra request/probe/retry");
		assert(!JSON.stringify(body.input).includes(CODEX_FAST_ENTRY_TYPE), "session preference leaked into model input");
		const id = "resp_fast_" + bodies.length;
		const item = { type: "message", id: "msg_fast_" + bodies.length, role: "assistant", status: "completed",
			content: [{ type: "output_text", text: "OK", annotations: [] }] };
		return [
			{ type: "response.created", response: { id, status: "in_progress", output: [] } },
			{ type: "response.output_item.added", output_index: 0, item },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id, status: "completed", output: [item], service_tier: body.service_tier,
				usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
		];
	}
	type SocketEvent = { data?: string; code?: number; reason?: string };
	class FakeSocket {
		readyState = 0;
		listeners = new Map<string, Set<(event: SocketEvent) => void>>();
		constructor(url: string) {
			assert.equal(new URL(url).hostname, new URL(baseUrl).hostname);
			socketInstances.push(this);
			queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); });
		}
		addEventListener(name: string, fn: (event: SocketEvent) => void) {
			if (!this.listeners.has(name)) this.listeners.set(name, new Set());
			this.listeners.get(name)!.add(fn);
		}
		removeEventListener(name: string, fn: (event: SocketEvent) => void) { this.listeners.get(name)?.delete(fn); }
		emit(name: string, event: SocketEvent) { for (const fn of [...this.listeners.get(name) ?? []]) fn(event); }
		close() { this.readyState = 3; this.emit("close", { code: 1000 }); }
		send(data: string) {
			try {
				for (const frame of frames(JSON.parse(data))) queueMicrotask(() => this.emit("message", { data: JSON.stringify(frame) }));
			} catch (error) { mockFailure ??= error; throw error; }
		}
	}
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const request = new Request(input, init);
		if (websocket || new URL(request.url).hostname !== new URL(baseUrl).hostname || !request.url.endsWith("/responses")) return deniedFetch(input, init);
		try {
			const bytes = Buffer.from(await request.arrayBuffer());
			const encoding = request.headers.get("content-encoding");
			assert(encoding === null || encoding === "zstd");
			const decoded = encoding === "zstd" ? zstdDecompressSync(bytes) : bytes;
			const body = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
			return new Response(frames(body).map((frame) => "event: " + frame.type + "\ndata: " + JSON.stringify(frame) + "\n\n").join(""),
				{ headers: { "content-type": "text/event-stream" } });
		} catch (error) { mockFailure ??= error; throw error; }
	}) as typeof fetch;

	async function bind(sm: ReturnType<typeof SessionManager.create>) {
		const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings,
			additionalExtensionPaths: [resolve(import.meta.dir, "../src/codex-fast/extension.ts"), resolve(import.meta.dir, "../src/responses-websocket/extension.ts")],
			noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, systemPromptOverride: () => "Reply OK." });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model,
			settingsManager: settings, resourceLoader: loader, sessionManager: sm, noTools: "all" }));
		await session.bindExtensions({ mode: uiMode, uiContext: {
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value), notify: (text: string) => notices.push(text),
		} as never, onError: (error) => errors.push(error.error) });
	}
	async function prompt(text: string) {
		await session!.prompt(text);
		if (mockFailure) throw mockFailure;
		assert.deepEqual(errors, []);
		if (!text.startsWith("/")) assert.equal(session!.getLastAssistantText(), "OK");
	}
	const key = "pi-openai-toolkit:codex-fast";
	const sm = SessionManager.create(env.cwd, join(env.cwd, "sessions"));
	await bind(sm);
	assert.equal(statuses.get(key), "Fast OFF");
	await prompt("/fast on");
	assert(notices.at(-1)?.includes("Usage: /fast"), "invalid argument was not rejected");
	assert.equal(statuses.get(key), "Fast OFF");
	assert.equal(sm.getBranch().filter((entry) => entry.type === "custom" && entry.customType === CODEX_FAST_ENTRY_TYPE).length, 0);
	assert.equal(bodies.length, 0, "invalid command performed inference");
	await prompt("Initial Standard request");
	assert.equal(bodies[0]!.service_tier, "default");
	await prompt("/fast");
	assert.equal(bodies.length, 1, "toggle performed inference");
	assert.equal(statuses.get(key), "Fast ON");
	assert(notices.at(-1)?.startsWith("Fast ON"), "toggle did not emit an ON notification");
	assert(notices.at(-1)?.includes("increase usage/cost"));
	assert(notices.at(-1)?.includes("Backend acceptance is not verified"));
	assert.equal(readCodexFastState(sm.getBranch(), sm.getSessionId()), true);
	await prompt("First Fast request");
	assert.equal(bodies[1]!.service_tier, "priority");
	assert.equal(bodies[1]!.previous_response_id, undefined, "tier change reused old continuation");
	await prompt("Still Fast request");
	assert.equal(bodies[2]!.service_tier, "priority");
	if (websocket) assert.equal(bodies[2]!.previous_response_id, "resp_fast_2", "control request did not exercise cached continuation");
	await session!.reload();
	assert.equal(statuses.get(key), "Fast ON", "reload lost preference");
	assert.equal(bodies.length, 3, "reload performed inference");
	const savedPath = sm.getSessionFile()!;
	const reopened = SessionManager.open(savedPath);
	assert.equal(reopened.getSessionId(), sm.getSessionId());
	assert.equal(readCodexFastState(reopened.getBranch(), reopened.getSessionId()), true);
	const fork = SessionManager.forkFrom(savedPath, env.cwd, join(env.cwd, "fork-sessions"));
	assert.notEqual(fork.getSessionId(), sm.getSessionId());
	session!.dispose();
	await bind(reopened);
	assert.equal(statuses.get(key), "Fast ON", "saved reopen lost preference");
	await prompt("Fast after reopen");
	assert.equal(bodies[3]!.service_tier, "priority");
	await prompt("/fast");
	assert.equal(statuses.get(key), "Fast OFF");
	assert(notices.at(-1)?.startsWith("Fast OFF"), "toggle did not emit an OFF notification");
	assert.equal(readCodexFastState(reopened.getBranch(), reopened.getSessionId()), false);
	assert.equal(bodies.length, 4, "disable performed inference");
	await prompt("Standard after disable");
	assert.equal(bodies[4]!.service_tier, "default");
	assert.equal(bodies[4]!.previous_response_id, undefined, "disable reused Fast continuation");
	session!.dispose();
	await bind(fork);
	assert.equal(statuses.get(key), "Fast OFF", "fork inherited foreign ON preference");
	await prompt("Standard in fork");
	assert.equal(bodies[5]!.service_tier, "default");
	assert.equal(bodies[5]!.previous_response_id, undefined, "fork reused a foreign continuation");
	assert.equal(await readFile(configPath, "utf8"), configBytes, "command modified global configuration");
	assert(notices.some((text) => text.includes("increase usage/cost")));
	env.assertNoNetwork();
	process.stdout.write("OK\n");
} finally {
	session?.dispose();
	closeGatewaySockets();
	closeNativeSockets();
	for (const socket of socketInstances) socket.close();
	globalThis.WebSocket = originalSocket;
	await env.dispose();
}
