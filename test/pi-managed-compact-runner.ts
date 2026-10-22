import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const env = await createSmokeEnvironment();
const caseName = process.argv[2] ?? "plain";
const native = caseName.startsWith("native-");
const hookSource = caseName.endsWith("-hook");
const scenario = (native ? caseName.slice(7) : caseName).replace(/-hook$/, "");
const provider = native ? "openai-codex" : "lifecycle";
const baseUrl = native ? "https://compact-lifecycle.invalid/backend-api" : "https://compact-lifecycle.invalid/v1";
const producer = ["same-model", "unset-model"].includes(scenario) ? "original" : "checkpoint";
const beforePersist = ["select-before-persist", "queues-before-persist"].includes(scenario);
const cancelled = ["abort", "select-during", "select-before-persist", "queues-before-persist"].includes(scenario);
let openBodyCancellations = 0;
function response(output: Array<Record<string, unknown>>, index: number, holdOpen = false) {
	const id = `lifecycle-${index}`;
	const events = [{ type: "response.created", response: { id, status: "in_progress", output: [] } },
		...output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
		{ type: "response.completed", response: { id, status: "completed", output, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }];
	const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(holdOpen ? new ReadableStream<Uint8Array>({
		start(controller) { controller.enqueue(new TextEncoder().encode(text)); },
		cancel() { openBodyCancellations++; },
	}) : text, { headers: { "content-type": "text/event-stream" } });
}
try {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
	const dir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.json"), JSON.stringify({ schemaVersion: 2, defaults: { context: {
		mode: "remote-compaction", remoteCompaction: { model: scenario === "unset-model" ? null : `${provider}/${producer}`, inputSource: hookSource ? "pi-context-hook" : "legacy" }, nativeFallback: { enabled: false },
	} }, models: Object.fromEntries(["original", "checkpoint", "user-choice"].map((id) => [`${provider}/${id}`, native ? {} : { compatibility: { transport: "codex-gateway" } }])) }));
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const apiKey = native ? `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "lifecycle-account" } })).toString("base64url")}.signature` : "synthetic-lifecycle-key";
	runtime.registerProvider(provider, { api: native ? "openai-codex-responses" : "openai-responses", apiKey, baseUrl, models: ["original", "checkpoint", "user-choice"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 2048 })) });
	const original = runtime.getModel(provider, "original")!;
	let sm = SessionManager.create(env.cwd, join(env.cwd, "sessions"));
	let covered = "";
	for (let i = 0; i < 10; i++) {
		const id = sm.appendMessage({ role: "user", content: `ORDINARY-TASK-${i} ${"acceptance criteria ".repeat(150)}`, timestamp: i * 2 });
		covered ||= id;
		sm.appendMessage(fauxAssistantMessage("ordinary source answer"));
	}
	const settings = SettingsManager.inMemory({ transport: "sse", cacheWarming: "off", retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 2048 } }, { projectTrusted: true });
	let session: AgentSession;
	let conversationPhases = 0, fullPhases = 0, phasesBeforeCompact = 0;
	let remoteCalls = 0, consumerCalls = 0, modelSelections = 0, thinkingSelections = 0, explicitThinkingSelections = 0;
	let observerPending = false, successObserverPending = false;
	let releaseObserver: (() => void) | undefined;
	let failure: unknown;
	const errors: string[] = [];
	const checkpoints = () => sm.getBranch().filter((entry) => entry.type === "compaction");
	const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings, additionalExtensionPaths: [resolve(import.meta.dir, "../src/extension-runtime.ts")], noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, systemPromptOverride: () => "LIFECYCLE-SYSTEM", extensionFactories: [(pi) => {
		pi.on("context", (event) => { conversationPhases++; return { messages: [...event.messages, { role: "user", content: "CONVERSATION-PHASE", timestamp: 900 }] }; });
		pi.on("context_with_system", (event) => { fullPhases++; assert.equal(fullPhases, conversationPhases); return { messages: [...event.messages, { role: "user", content: "FULL-PHASE", timestamp: 901 }] }; });
		pi.on("session_before_compact", async () => {
			if (!beforePersist) return;
			assert.equal(remoteCalls, 1); assert.equal(checkpoints().length, 0);
			observerPending = true;
			await new Promise<void>((done) => { releaseObserver = done; });
			observerPending = false;
		});
		pi.on("session_compact", async (_event, ctx) => {
			successObserverPending = true;
			assert(!ctx.isIdle());
			const calls = consumerCalls;
			await new Promise((done) => setTimeout(done, 20));
			assert.equal(consumerCalls, calls, "compaction launched a continuation before observers settled");
			if (scenario === "queues") { await session.steer("QUEUED-STEER"); await session.followUp("QUEUED-FOLLOWUP"); }
			successObserverPending = false;
		});
		pi.on("agent_start", () => { assert(!successObserverPending); });
	}] });
	await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
	async function createSession() {
		({ session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model: original, settingsManager: settings, resourceLoader: loader, sessionManager: sm, tools: ["read"] }));
		const setModel = session.setModel.bind(session);
		session.setModel = async (model) => { modelSelections++; return setModel(model); };
		const setThinking = session.setThinkingLevel.bind(session);
		session.setThinkingLevel = (level) => { thinkingSelections++; setThinking(level); };
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
	}
	async function chooseUserModel() {
		const before = thinkingSelections;
		await session.setModel(runtime.getModel(provider, "user-choice")!);
		explicitThinkingSelections += thinkingSelections - before;
	}
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		try {
			const request = new Request(input, init);
			if (request.url !== `${baseUrl}${native ? "/codex" : ""}/responses`) return deniedFetch(input, init);
			const bytes = Buffer.from(await request.arrayBuffer());
			const body = JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8")) as Record<string, unknown>;
			const items = body.input as Array<Record<string, unknown>>;
			const serialized = JSON.stringify(body);
			assert(!serialized.includes("codex-context-window") && !serialized.includes("new_context") && !serialized.includes("get_context_remaining"));
			assert.equal(request.headers.get("x-codex-window-id"), null);
			assert.equal(request.headers.get("session-id"), sm.getSessionId());
			assert.equal(request.headers.get("authorization"), `Bearer ${apiKey}`);
			if (items.at(-1)?.type === "compaction_trigger") {
				remoteCalls++;
				assert.equal(body.model, producer); assert.equal(session.model?.id, "original");
				assert.equal(conversationPhases - phasesBeforeCompact, hookSource ? 1 : 0);
				assert.equal(serialized.includes("FULL-PHASE"), hookSource);
				if (remoteCalls === 1) assert(serialized.includes("ORDINARY-TASK-"));
				else { assert(serialized.includes("opaque-1") && serialized.includes("EDITED-LIVE-TAIL")); assert(!serialized.includes("ORDINARY-TASK-") && !serialized.includes("HIDDEN-LIVE-TAIL") && !serialized.includes("OLD-LIVE-TAIL")); }
				if (scenario === "abort") { session.abortCompaction(); throw new DOMException("aborted", "AbortError"); }
				if (scenario === "select-during") await chooseUserModel();
				return response([{ type: "compaction", encrypted_content: `opaque-${remoteCalls}` }], remoteCalls, scenario === "open-stream");
			}
			consumerCalls++;
			assert(serialized.includes(`opaque-${remoteCalls}`));
			assert.equal(serialized.split(`opaque-${remoteCalls}`).length - 1, 1);
			const disk = (await readFile(sm.getSessionFile()!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(disk.filter((entry) => entry.type === "compaction").length, remoteCalls);
			return response([{ type: "message", id: `msg-${consumerCalls}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "CONTINUED", annotations: [] }] }], 100 + consumerCalls);
		} catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) failure ??= error; throw error; }
	}) as typeof fetch;
	try {
		await createSession();
		const originalSessionId = sm.getSessionId();
		const sourceBranch = structuredClone(sm.getBranch());
		const sourceLeaf = sm.getLeafId()!;
		phasesBeforeCompact = conversationPhases;
		const compacting = session!.compact("Preserve acceptance criteria");
		if (beforePersist) {
			const deadline = Date.now() + 3000;
			while (!observerPending && !failure && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
			if (failure) throw failure;
			assert(observerPending, "later observer was never reached");
			try {
				if (scenario === "select-before-persist") await chooseUserModel();
				else { await session!.steer("QUEUED-STEER"); await session!.followUp("QUEUED-FOLLOWUP"); }
				assert.equal(checkpoints().length, 0);
			} finally { releaseObserver?.(); }
		}
		if (cancelled) await assert.rejects(compacting, /cancelled|failed/i);
		else await compacting.catch((error) => { throw failure ?? error; });
		if (failure) throw failure;
		assert.equal(checkpoints().length, cancelled ? 0 : 1);
		await new Promise((done) => setTimeout(done, 50));
		assert.equal(consumerCalls, 0, "manual compact started a synthetic continuation");
		if (scenario === "user-select") await chooseUserModel();
		if (scenario === "navigate") {
			const before = thinkingSelections;
			await session!.navigateTree(sourceLeaf, { summarize: false });
			explicitThinkingSelections += thinkingSelections - before;
		}
		if (scenario === "queues" || scenario === "queues-before-persist") {
			assert.deepEqual(session!.getSteeringMessages(), ["QUEUED-STEER"]);
			assert.deepEqual(session!.getFollowUpMessages(), ["QUEUED-FOLLOWUP"]);
		} else if (!cancelled && !["user-select", "navigate"].includes(scenario)) {
			await session!.prompt("Explicit next user request");
			if (failure) throw failure;
			assert.equal(consumerCalls, 1);
			if (scenario === "repeat") {
				const file = sm.getSessionFile()!;
				session!.dispose(); sm = SessionManager.open(file); await createSession();
				assert.equal(consumerCalls, 1, "reopening launched work");
				const old = sm.appendMessage({ role: "user", content: "OLD-LIVE-TAIL", timestamp: 1000 });
				const hidden = sm.appendMessage({ role: "user", content: "HIDDEN-LIVE-TAIL", timestamp: 1001 });
				sm.appendContextEdit(old, { content: `EDITED-LIVE-TAIL ${"new work ".repeat(500)}` }); sm.appendContextEdit(hidden, null);
				sm.appendMessage(fauxAssistantMessage("more source answer")); session!.refreshContext();
				phasesBeforeCompact = conversationPhases;
				await session!.compact().catch((error) => { throw failure ?? error; });
				assert.equal(remoteCalls, 2);
				await session!.prompt("Explicit next request after recursion");
				assert.equal(consumerCalls, 2);
			}
			if (scenario === "sealed-edit") {
				sm.appendContextEdit(covered, { content: "INVALIDATED-SEALED-CONTEXT" });
				sm.appendMessage({ role: "user", content: "more input ".repeat(500), timestamp: 2000 }); sm.appendMessage(fauxAssistantMessage("more answer")); session!.refreshContext();
				await assert.rejects(session!.compact(), /cancelled/i);
				assert.equal(remoteCalls, 1);
			}
		}
		if (failure) throw failure;
		assert.deepEqual(errors, []);
		assert.equal(sm.getSessionId(), originalSessionId);
		assert.equal(session!.model?.id, ["select-during", "select-before-persist", "user-select"].includes(scenario) ? "user-choice" : "original");
		assert.equal(modelSelections, ["select-during", "select-before-persist", "user-select"].includes(scenario) ? 1 : 0);
		assert.equal(thinkingSelections, explicitThinkingSelections, "compaction changed thinking outside explicit host selection/navigation");
		for (const entry of sourceBranch) assert.deepEqual(sm.getEntry(entry.id), JSON.parse(JSON.stringify(entry)), "compaction rewrote source history");
		assert(!sm.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi-openai-toolkit:manual-compact"));
		if (scenario === "open-stream") assert.equal(openBodyCancellations, 1);
		env.assertNoNetwork(); process.stdout.write("OK\n");
	} finally { session!?.dispose(); }
} finally { await env.dispose(); }
