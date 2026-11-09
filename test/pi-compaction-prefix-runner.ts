import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createSmokeEnvironment } from "./pi-smoke-environment.ts";

const env = await createSmokeEnvironment();
const transport = process.argv[2] ?? "gateway-sse";
const source = process.argv[3] ?? "legacy";
const native = transport.startsWith("native");
const ws = transport.endsWith("ws");
const errorCase = source.endsWith("error");
const loadoutCase = source.includes("loadout");
const wrappedCase = source.includes("wrapped");
const sdkRoot = process.env.TOOLKIT_PREFIX_SDK ?? process.argv[4];
const sdk = await import(sdkRoot ? `${sdkRoot}/pi-coding-agent/dist/index.js` : "@earendil-works/pi-coding-agent");
const ai = await import(sdkRoot ? `${sdkRoot}/pi-ai/dist/index.js` : "@earendil-works/pi-ai");
const compat = await import(sdkRoot ? `${sdkRoot}/pi-ai/dist/compat.js` : "@earendil-works/pi-ai/compat");
const { closeOpenAICodexWebSocketSessions } = await import(sdkRoot
	? `${sdkRoot}/pi-ai/dist/api/openai-codex-responses.js` : "@earendil-works/pi-ai/api/openai-codex-responses");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
const { InMemoryCredentialStore, InMemoryModelsStore } = ai;
const originalSocket = globalThis.WebSocket;
let session: any;
const sockets: Array<{ close(): void }> = [];
let failure: unknown;
let ordinary = 0, compact = 0, projections = 0;
let previous: Record<string, any> | undefined;
const histories = new Map<string, { input: unknown[]; output: unknown[] }>();
const errors: string[] = [];
try {
	const configDir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify({
		schemaVersion: 2,
		defaults: { context: { mode: "remote-compaction", remoteCompaction: { inputSource: source.startsWith("hook") ? "pi-context-hook" : "legacy" } },
			responsesWebSocket: { enabled: true }, webSearch: { route: "hosted" } },
	}));
	const api = native ? "openai-codex-responses" : "openai-responses";
	const baseUrl = "https://prefix.invalid/v1";
	const apiKey = native
		? `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64url")}.signature`
		: "synthetic";
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerProvider("prefix", {
		api, apiKey, baseUrl,
		streamSimple: (model: any, context: any, options: any) => compat.getApiProvider(api)!.streamSimple(model, context, options),
		models: [{ id: "gpt-prefix", name: "prefix", reasoning: true, input: ["text"],
			compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }, contextWindow: 64000, maxTokens: 2048 }],
	});
	const model = runtime.getModel("prefix", "gpt-prefix");
	const settings = SettingsManager.inMemory({
		transport: ws ? "websocket-cached" : "sse", cacheWarming: "off",
		retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 3000 } },
		compaction: { enabled: false, keepRecentTokens: 32, reserveTokens: 2048 },
	}, { projectTrusted: true });
	function frames(wire: Record<string, any>) {
		const body = structuredClone(wire);
		delete body.type;
		if (body.previous_response_id) {
			const history = histories.get(body.previous_response_id);
			assert(history, "unknown WS baseline");
			body.input = [...history.input, ...history.output, ...body.input];
			delete body.previous_response_id;
		}
		const isCompact = body.input.at(-1)?.type === "compaction_trigger";
		if (isCompact) {
			compact++;
			assert(previous, "compaction has no live baseline");
			assert.deepEqual(body.input.slice(0, previous.input.length), previous.input, "rewritten input prefix");
			for (const key of ["tools", "instructions", "reasoning", "prompt_cache_key", "service_tier"]) {
				assert.deepEqual(body[key], previous[key], `changed ${key}`);
			}
			assert.equal(JSON.stringify(body.input).split("manual checkpoint guidance").length - 1, compact === 1 ? 1 : 0);
		} else {
			ordinary++;
			previous = body;
		}
		assert(ordinary <= 6 && compact <= 2, "unexpected dispatch or retry");
		const id = `resp_${ordinary}_${compact}`;
		const output = isCompact ? [{ type: "compaction", encrypted_content: `opaque-${compact}` }]
			: ordinary === 1 ? [
				{ type: "reasoning", id: "rs_prefix", encrypted_content: "encrypted-reasoning", summary: [] },
				...(source.startsWith("hook") ? [{
					type: "web_search_call", id: "ws_prefix", status: "completed",
					action: { type: "search", query: "synthetic fixture reference", sources: [{ type: "url", url: "https://fixture.invalid/reference" }] },
				}] : []),
				{ type: "function_call", id: "fc_prefix", call_id: "call_prefix", name: "fixture_lookup", arguments: '{"id":7}', status: "completed" },
			] : [{ type: "message", id: `msg_${ordinary}`, role: "assistant", status: "completed",
				content: [{ type: "output_text", text: "FIXTURE-FACT retained", annotations: [] }] }];
		// The response-only function-call status is not part of Pi's replay
		// encoding (the WS prefix comparator also ignores this lifecycle field).
		histories.set(id, { input: body.input, output: output.map((item) => {
			if (item.type !== "function_call") return item;
			const { status: _status, ...replay } = item;
			return replay;
		}) });
		return [
			{ type: "response.created", response: { id, status: "in_progress", output: [] } },
			...output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
			{ type: "response.completed", response: { id, status: "completed", output,
				usage: { input_tokens: 10000, output_tokens: 20, total_tokens: 10020,
					input_tokens_details: { cached_tokens: 9000, cache_write_tokens: 0 } } } },
		];
	}
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input: any, init: any) => {
		const req = new Request(input, init);
		if (!req.url.startsWith(baseUrl)) return deniedFetch(input, init);
		try {
			const bytes = Buffer.from(await req.arrayBuffer());
			const body = JSON.parse((req.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString());
			if (ws) assert.equal(body.input.at(-1)?.type, "compaction_trigger", "ordinary WS escaped to HTTP");
			return new Response(frames(body).map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
				{ headers: { "content-type": "text/event-stream" } });
		} catch (error) { failure ??= error; throw error; }
	}) as typeof fetch;
	class FakeSocket {
		readyState = 0;
		listeners = new Map<string, Set<(event: any) => void>>();
		constructor() { sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); }); }
		addEventListener(name: string, fn: (event: any) => void) {
			if (!this.listeners.has(name)) this.listeners.set(name, new Set());
			this.listeners.get(name)!.add(fn);
		}
		removeEventListener(name: string, fn: (event: any) => void) { this.listeners.get(name)?.delete(fn); }
		emit(name: string, event: any) { for (const fn of [...this.listeners.get(name) ?? []]) fn(event); }
		close() { this.readyState = 3; this.emit("close", { code: 1000 }); }
		send(data: string) {
			try {
				for (const event of frames(JSON.parse(data))) queueMicrotask(() => this.emit("message", { data: JSON.stringify(event) }));
			} catch (error) { failure ??= error; throw error; }
		}
	}
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	let manager = SessionManager.create(env.cwd, join(env.cwd, "sessions"));
	async function open() {
		const loader = new DefaultResourceLoader({
			cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings,
			additionalExtensionPaths: ["extension-runtime.ts", "web-search/extension.ts", "codex-fast/extension.ts", "responses-websocket/extension.ts"]
				.map((p) => resolve(import.meta.dirname, "../src", p)),
			noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
			systemPromptOverride: () => "Preserve FIXTURE-FACT.",
			extensionFactories: [(pi: any) => {
				pi.on("before_provider_request", (event: any) => {
					if (session?.isCompacting) {
						projections++;
						if (errorCase) throw new Error("intentional compaction transform failure");
					}
					return event.payload;
				});
			}],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model, thinkingLevel: "low",
			settingsManager: settings, resourceLoader: loader, sessionManager: manager,
			tools: loadoutCase ? ["fixture_lookup", "edit", "write"] : ["fixture_lookup"],
			customTools: [{
				name: "fixture_lookup", label: "lookup", description: "Synthetic fixture only",
				parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
				execute: async () => ({ content: [{ type: "text", text: "FIXTURE-FACT " + "synthetic ledger record ".repeat(1000) }], details: {} }),
				...(loadoutCase ? { prepareLoadout: () => ({ hiddenDeclarations: ["edit", "write"] }) } : {}),
			}],
		}));
		await session.bindExtensions({ mode: "print", onError: (error: any) => errors.push(error.error) });
		if (wrappedCase) {
			const previousTransform = session.agent.transformContext;
			session.agent.transformContext = async (messages: any[], signal: AbortSignal) => {
				const transformed = await previousTransform(messages, signal);
				return transformed.map((message: any, index: number) => index === 0 && message.role === "system"
					? { ...message, sections: { ...message.sections, fixture_host: "HOST-PROJECTION-MARKER" } }
					: message);
			};
		}
	}
	await open();
	await session.prompt("Look up the fixture");
	if (failure) throw failure;
	await session.prompt("Confirm the fact");
	if (failure) throw failure;
	if (loadoutCase) {
		const canonical = JSON.stringify(manager.buildSessionProjection().messages);
		assert(canonical.includes('"name":"edit"'), "fixture must retain hidden declarations on disk");
		assert(!JSON.stringify(previous).includes('"name":"edit"'), "host did not filter the normal request");
	}
	if (wrappedCase) assert(JSON.stringify(previous).includes("HOST-PROJECTION-MARKER"));
	if (source.includes("reload")) await session.reload();
	if (source.startsWith("hook")) assert(JSON.stringify(previous?.input).includes("synthetic fixture reference"), "hosted-search history was not exercised");
	const before = ordinary;
	try {
		await session.compact("manual checkpoint guidance");
		if (failure) throw failure;
		assert(!errorCase, "failed transform allowed compaction");
	} catch (error) {
		if (failure) throw failure;
		if (!errorCase) throw error;
		assert.match(String(error), /cancelled/i);
	}
	assert.equal(ordinary, before, "dry-run encoder dispatched a model request");
	if (errorCase) {
		assert.equal(compact, 0);
		assert(!manager.getBranch().some((e: any) => e.type === "compaction"));
		assert(errors.some((e) => e.includes("intentional")));
	} else {
		const entry = manager.getBranch().find((e: any) => e.type === "compaction");
		assert.equal(entry.details.strategy, "openai-remote-compaction-v2");
		assert.equal(entry.usage.cacheRead, 9000);
		assert.equal(entry.usage.input, 1000);
		const file = manager.getSessionFile();
		session.dispose();
		manager = SessionManager.open(file);
		await open();
		await session.prompt("Continue after reopening");
		if (failure) throw failure;
		await session.prompt("Confirm the checkpoint again");
		if (failure) throw failure;
		await session.compact();
		if (failure) throw failure;
		await session.prompt("Continue after second checkpoint");
		if (failure) throw failure;
		assert.equal(compact, 2);
		assert(projections >= 2);
		assert.deepEqual(errors, []);
	}
	env.assertNoNetwork();
	process.stdout.write("OK\n");
} finally {
	session?.dispose();
	closeOpenAICodexWebSocketSessions();
	for (const socket of sockets) socket.close();
	globalThis.WebSocket = originalSocket;
	await env.dispose();
}
