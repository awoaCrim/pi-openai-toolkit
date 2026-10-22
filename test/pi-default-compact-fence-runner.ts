import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const env = await createSmokeEnvironment();
const mode = process.argv[2];
const change = process.argv[3];
try {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
	const dir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.json"), JSON.stringify(mode === "disabled" ? { compaction: { enabled: false } } : {
		schemaVersion: 2, defaults: { context: { mode: mode === "pi" ? "pi" : "remote-compaction", remoteCompaction: { apis: [] }, nativeFallback: { enabled: false } } },
	}));
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerProvider("default-fence", { api: "openai-responses", apiKey: "synthetic-default-key", baseUrl: "https://default-fence.invalid/v1", models: ["original", "choice"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1024 })) });
	const original = runtime.getModel("default-fence", "original")!;
	const sm = SessionManager.create(env.cwd, join(env.cwd, "sessions"));
	for (let i = 0; i < 8; i++) {
		sm.appendMessage({ role: "user", content: `SOURCE-${i} ${"ordinary criteria ".repeat(180)}`, timestamp: i * 2 });
		sm.appendMessage(fauxAssistantMessage("ordinary answer"));
	}
	const before = structuredClone(sm.getBranch());
	const settings = SettingsManager.inMemory({ transport: "sse", cacheWarming: "off", retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 2048 } }, { projectTrusted: true });
	let enterObserver!: () => void, releaseObserver!: () => void;
	const entered = new Promise<void>((done) => { enterObserver = done; });
	const released = new Promise<void>((done) => { releaseObserver = done; });
	const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings, additionalExtensionPaths: [resolve(import.meta.dir, "../src/extension-runtime.ts")], noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, systemPromptOverride: () => "DEFAULT-FENCE-SYSTEM", extensionFactories: [(pi) => {
		pi.on("session_before_compact", async () => { enterObserver(); await released; });
	}] });
	await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
	let session: AgentSession;
	({ session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model: original, settingsManager: settings, resourceLoader: loader, sessionManager: sm, tools: ["read"] }));
	const errors: string[] = [];
	let requests = 0;
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const request = new Request(input, init);
		if (request.url !== "https://default-fence.invalid/v1/responses") return deniedFetch(input, init);
		requests++;
		const body = await request.json();
		assert(!JSON.stringify(body).includes("compaction_trigger"), "default handoff ran a remote protocol");
		assert.equal(body.model, "original");
		const output = [{ type: "message", id: "msg-default", role: "assistant", status: "completed", content: [{ type: "output_text", text: "PI-DEFAULT-SUMMARY", annotations: [] }] }];
		const events = [{ type: "response.created", response: { id: "resp-default", status: "in_progress", output: [] } }, { type: "response.output_item.done", output_index: 0, item: output[0] }, { type: "response.completed", response: { id: "resp-default", status: "completed", output, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }];
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	try {
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
		const compacting = session.compact().then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
		await entered;
		try {
			if (change === "retired-evidence") sm.appendCustomMessageEntry("codex-context-window", "late reserved evidence", true, null);
			if (change === "selection") await session.setModel(runtime.getModel("default-fence", "choice")!);
			if (change === "queues") { await session.steer("QUEUED-STEER"); await session.followUp("QUEUED-FOLLOWUP"); }
		} finally { releaseObserver(); }
		const outcome = await compacting;
		if (change === "clean") {
			assert.equal(outcome.error, undefined);
			assert(outcome.result?.summary.includes("PI-DEFAULT-SUMMARY"));
			assert(requests > 0, "stable handoff did not run Pi default");
			const saved = sm.getBranch().findLast((entry) => entry.type === "compaction")!;
			assert.equal(saved.fromHook, false, "cancel-only handoff claimed an extension checkpoint");
		} else {
			assert(outcome.error instanceof Error && /cancelled/i.test(outcome.error.message));
			assert.equal(requests, 0, "stale default handoff reached inference");
			assert(!sm.getBranch().some((entry) => entry.type === "compaction"));
			if (change === "queues") { assert.deepEqual(session.getSteeringMessages(), ["QUEUED-STEER"]); assert.deepEqual(session.getFollowUpMessages(), ["QUEUED-FOLLOWUP"]); }
		}
		assert.deepEqual(errors, []);
		for (const entry of before) assert.deepEqual(sm.getEntry(entry.id), entry);
		assert.equal(session.model?.id, change === "selection" ? "choice" : "original");
		env.assertNoNetwork(); process.stdout.write("OK\n");
	} finally { session.dispose(); }
} finally { await env.dispose(); }
