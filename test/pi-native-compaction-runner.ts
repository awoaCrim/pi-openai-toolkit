import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const packageDir = resolve(import.meta.dirname, "..");
const mode = process.argv[2];
assert(["threshold", "disabled", "under", "manual", "cancel", "failure"].includes(mode));
const env = await createSmokeEnvironment();
process.env.PI_CACHE_RETENTION = "long";
try {
	const { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { fauxAssistantMessage, InMemoryCredentialStore, InMemoryModelsStore, Type } = await import("@earendil-works/pi-ai");
	const manifest = JSON.parse(await readFile(join(packageDir, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
	assert.equal(manifest.version, "0.85.1");
	const configDir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify({ compaction: { nativeFallback: { enabled: false } } }));
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null,
		refreshOnCreate: false, allowModelNetwork: false,
	});
	// Use the real Responses encoder/onPayload path. Pi's faux transport does not
	// invoke onPayload, so by itself it cannot verify replay or cache parameters.
	modelRuntime.registerProvider("openai", {
		api: "openai-responses", apiKey: "synthetic-smoke-key", baseUrl: "https://toolkit-smoke.invalid/v1",
		models: [{ id: "gpt-6-astra", name: "Smoke Astra", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: mode === "under" ? 64000 : 4096,
			maxTokens: 512, compat: { supportsExplicitPromptCacheMode: true } }],
	});
	const model = modelRuntime.getModel("openai", "gpt-6-astra");
	assert(model);
	const sessionManager = SessionManager.inMemory(env.cwd);
	for (let index = 0; index < 2; index++) {
		sessionManager.appendMessage({ role: "user", content: `STALE-HISTORY-${index}-${"x".repeat(600)}`, timestamp: 10 + index * 2 });
		const message = fauxAssistantMessage("Old answer", { timestamp: 11 + index * 2 });
		sessionManager.appendMessage({ ...message, provider: model.provider, api: model.api, model: model.id,
			usage: { ...message.usage, input: 10, output: 10, totalTokens: 20 } });
	}
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false }, compaction: { enabled: mode !== "disabled" && mode !== "manual", reserveTokens: 2048, keepRecentTokens: mode === "manual" ? 128 : 400 },
	}, { projectTrusted: true });
	const events: AgentSessionEvent[] = [];
	let session: AgentSession | undefined;
	let liveCount = 0;
	let remoteCount = 0;
	let nativeSummaryCount = 0;
	let compactionsAtContinuation = -1;
	const liveBodies: Array<Record<string, unknown>> = [];
	const compactBodies: Array<Record<string, unknown>> = [];
	const hooks: string[] = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd: env.cwd, agentDir: env.agentDir, settingsManager,
		additionalExtensionPaths: [join(packageDir, "extensions/compaction.ts")],
		noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		systemPrompt: "Run the requested deterministic tools, then finish.",
		extensionFactories: [(pi) => {
			pi.on("session_before_compact", (event) => { hooks.push(event.reason); });
			pi.on("context", (event) => {
				// A transient extension message must survive the opaque replay path.
				return { messages: [...event.messages, { role: "user", content: "TRANSIENT-CONTEXT", timestamp: 999 }] };
			});
		}],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const tools = ["first", "second"].map((name) => defineTool({
		name: `${name}_tool`, label: name, description: `Return ${name} result.`, parameters: Type.Object({ value: Type.String() }),
		execute: async (_id, params) => ({ content: [{ type: "text", text: `${name}:${params.value}:${"r".repeat(600)}` }], details: {} }),
	}));
	const created = await createAgentSession({
		cwd: env.cwd, agentDir: env.agentDir, modelRuntime, settingsManager, resourceLoader, sessionManager, model,
		tools: tools.map((tool) => tool.name), customTools: tools,
	});
	session = created.session;
	const unsubscribe = session.subscribe((event) => { events.push(event); });
	const deniedFetch = globalThis.fetch;
	const opaque = { type: "compaction", id: "cmp_smoke", encrypted_content: "opaque-smoke-checkpoint" };
	function streamResponse(output: Array<Record<string, unknown>>, id: string, metadataOnly = false) {
		const events: Array<Record<string, unknown>> = [{ type: "response.created", response: { id, status: "in_progress", output: [] } }];
		for (const [output_index, item] of output.entries()) {
			events.push({ type: "response.output_item.added", output_index, item });
			events.push({ type: "response.output_item.done", output_index, item });
		}
		events.push({ type: "response.completed", response: { id, status: "completed", created_at: 1800000000,
			...(!metadataOnly ? { output } : {}), usage: { input_tokens: id === "resp_tools" ? 1900 : 100, output_tokens: 10, total_tokens: id === "resp_tools" ? 1910 : 110 } } });
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
			{ status: 200, headers: { "content-type": "text/event-stream" } });
	}
	function textResponse(text: string) {
		return streamResponse([{ type: "message", id: `msg_${liveCount}_${nativeSummaryCount}`, role: "assistant", status: "completed",
			content: [{ type: "output_text", text, annotations: [] }] }], `resp_text_${liveCount}_${nativeSummaryCount}`);
	}
	globalThis.fetch = (async (input, init) => {
		const request = new Request(input, init);
		if (request.url !== "https://toolkit-smoke.invalid/v1/responses" || request.method !== "POST") return deniedFetch(input, init);
		const body = await request.json() as Record<string, unknown>;
		assert.equal(body.model, model.id);
		const items = body.input as Array<Record<string, unknown>>;
		if (items.at(-1)?.type === "compaction_trigger") {
			remoteCount++;
			compactBodies.push(body);
			assert.equal(remoteCount, 1, "duplicate synthetic compaction request");
			assert.deepEqual(body.prompt_cache_options, { ttl: "30m" });
			assert(!("prompt_cache_retention" in body));
			if (mode === "cancel") {
				session!.abortCompaction();
				assert(request.signal.aborted);
				throw new DOMException("Smoke cancellation", "AbortError");
			}
			if (mode === "failure") return new Response("synthetic remote failure", { status: 500 });
			return streamResponse([opaque], "resp_compact", true);
		}
		if (mode === "failure" && remoteCount === 1 && nativeSummaryCount === 0) {
			nativeSummaryCount++;
			return textResponse("FALLBACK-SUMMARY");
		}
		liveCount++;
		liveBodies.push(body);
		assert.deepEqual(body.prompt_cache_options, { ttl: "30m" });
		assert.equal(body.prompt_cache_retention, undefined);
		if (liveCount === 1) {
			assert.equal(remoteCount, 0, "compaction occurred before tools crossed the threshold");
			if (mode === "manual") return textResponse("BEFORE-MANUAL");
			return streamResponse(["first", "second"].map((name) => ({ type: "function_call", id: `fc_${name}`,
				call_id: `call_${name}`, name: `${name}_tool`, arguments: JSON.stringify({ value: name }) })), "resp_tools");
		}
		assert.equal(liveCount, 2, "unexpected hidden follow-up or extra live request");
		compactionsAtContinuation = sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
		return textResponse("NATIVE-DONE");
	}) as typeof fetch;
	try {
		assert.equal(Object.getPrototypeOf(session)[Symbol.for("pi-openai-toolkit.inline-compaction.adapter.v1")], undefined);
		await session.prompt(mode === "manual" ? "Reply before manual compaction." : "Run both tools and continue.");
		if (mode === "manual") {
			assert.equal(session.autoCompactionEnabled, false);
			await session.compact("Compact all history.");
			await session.prompt("Continue after manual compaction.");
		}
		const last = session.messages.at(-1);
		assert(last?.role === "assistant");
		assert.equal(last.content.filter((block) => block.type === "text").map((block) => block.text).join(""), "NATIVE-DONE");
		assert.equal(liveCount, 2);
		assert.equal(events.filter((event) => event.type === "agent_start").length, mode === "manual" ? 2 : 1);
		const expectedAttempts = mode === "disabled" || mode === "under" ? 0 : 1;
		assert.equal(remoteCount, expectedAttempts, JSON.stringify({ settings: settingsManager.getCompactionSettings(), branch: sessionManager.getBranch().map((entry) => ({ type: entry.type, role: entry.type === "message" ? entry.message.role : undefined })), events: events.filter((event) => event.type.startsWith("compaction")), hooks }));
		// Cancellation short-circuits later session_before_compact observers.
		assert.deepEqual(hooks, expectedAttempts && mode !== "cancel" ? [mode === "manual" ? "manual" : "threshold"] : []);
		assert.deepEqual(events.filter((event) => event.type === "compaction_start").map((event) => event.reason), expectedAttempts ? [mode === "manual" ? "manual" : "threshold"] : []);
		const expectedCompactions = ["threshold", "manual", "failure"].includes(mode) ? 1 : 0;
		assert.equal(compactionsAtContinuation, expectedCompactions);
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, expectedCompactions);
		if (mode === "threshold" || mode === "manual") {
			const continued = JSON.stringify(liveBodies[1].input);
			assert(continued.includes(opaque.encrypted_content));
			assert(!continued.includes("STALE-HISTORY"));
			assert(!continued.includes("first:first"), "retained tool results were duplicated outside the opaque checkpoint");
			assert(continued.includes("TRANSIENT-CONTEXT"));
		}
		if (expectedAttempts && mode !== "manual") {
			const input = compactBodies[0].input as Array<Record<string, unknown>>;
			assert.deepEqual(input.filter((item) => item.type === "function_call").map((item) => item.call_id), ["call_first", "call_second"]);
			assert.deepEqual(input.filter((item) => item.type === "function_call_output").map((item) => item.call_id), ["call_first", "call_second"]);
		}
		if (mode === "cancel") assert(events.some((event) => event.type === "compaction_end" && event.aborted));
		assert.equal(nativeSummaryCount, mode === "failure" ? 1 : 0);
		assert(!sessionManager.getBranch().some((entry) => entry.type === "custom_message"));
		env.assertNoNetwork();
	} finally {
		unsubscribe();
		session.dispose();
	}
	process.stdout.write("OK\n");
} finally {
	await env.dispose();
}
