import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const env = await createSmokeEnvironment();
const evidence = process.argv[2] ?? "window";
const mode = process.argv[3] ?? "remote-compaction";
const marker = "codex-context-window";
const summary = "[Pi Codex context-window boundary; no conversation summary was generated.]";
try {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
	const dir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.json"), JSON.stringify(mode === "disabled"
		? { compaction: { enabled: false, remoteCompactModel: "retirement/other" } }
		: { schemaVersion: 2, defaults: { context: { mode, remoteCompaction: { model: "retirement/other" } } }, models: { "retirement/other": { context: { mode: "pi" } } } }));
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerProvider("retirement", { api: "openai-responses", apiKey: "synthetic-retirement-key", baseUrl: "https://retirement.invalid/v1", models: ["current", "other"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1024 })) });
	const model = runtime.getModel("retirement", "current")!;
	let sm = SessionManager.create(env.cwd, join(env.cwd, "sessions"));
	for (let i = 0; i < 8; i++) {
		sm.appendMessage({ role: "user", content: `BASE-${i} ${"ordinary source ".repeat(180)}`, timestamp: i * 2 });
		sm.appendMessage(fauxAssistantMessage("ordinary answer"));
	}
	const cleanBase = sm.getLeafId()!;
	if (evidence === "strategy") sm.appendCompaction("damaged old cleanup", cleanBase, 500, { strategy: marker, protocol: "damaged" }, true);
	else if (evidence === "sentinel") sm.appendCompaction(summary, cleanBase, 500, null, true);
	else if (evidence === "manual" || evidence === "terminal-manual") sm.appendCustomEntry("pi-openai-toolkit:manual-compact", evidence === "manual" ? null : { phase: "completed", originalModel: "retirement/other", originalThinking: "high" });
	else sm.appendCustomMessageEntry(marker, "OLD-REMOTE-WINDOW-HISTORY", true, evidence === "malformed-window" ? null : { protocol: 1, contextManagement: { kind: "window", currentWindowId: "old-window" } });
	if (evidence === "superseded") sm.appendCompaction("NEWER-ORDINARY-SUMMARY", cleanBase, 500, { readFiles: [], modifiedFiles: [] }, true);
	for (let i = 0; i < 8; i++) {
		sm.appendMessage({ role: "user", content: `TAIL-${i} ${"ordinary tail ".repeat(180)}`, timestamp: 100 + i * 2 });
		sm.appendMessage(fauxAssistantMessage("ordinary tail answer"));
	}
	const retiredLeaf = sm.getLeafId()!;
	const settings = SettingsManager.inMemory({ transport: "sse", cacheWarming: "off", retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 2048 } }, { projectTrusted: true });
	const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings, additionalExtensionPaths: [resolve(import.meta.dir, "../src/extension-runtime.ts")], noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, systemPromptOverride: () => "RETIREMENT-SYSTEM" });
	await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
	let { session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model, settingsManager: settings, resourceLoader: loader, sessionManager: sm, tools: ["read"] });
	let providerCalls = 0, selectionCalls = 0;
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const request = new Request(input, init);
		if (request.url !== "https://retirement.invalid/v1/responses") return deniedFetch(input, init);
		providerCalls++;
		const output = [{ type: "message", id: "msg-clean", role: "assistant", status: "completed", content: [{ type: "output_text", text: "CLEAN-BRANCH-ANSWER", annotations: [] }] }];
		const events = [{ type: "response.created", response: { id: "resp-clean", status: "in_progress", output: [] } }, { type: "response.output_item.done", output_index: 0, item: output[0] }, { type: "response.completed", response: { id: "resp-clean", status: "completed", output, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }];
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	try {
		const originalSessionId = sm.getSessionId();
		const oldBranch = structuredClone(sm.getBranch());
		const file = sm.getSessionFile()!;
		const bytes = await readFile(file, "utf8");
		const bind = () => session.bindExtensions({ mode: "print", onError: () => undefined });
		const watchSelection = () => {
			const setModel = session.setModel.bind(session);
			session.setModel = async (selected) => { selectionCalls++; return setModel(selected); };
			const setThinking = session.setThinkingLevel.bind(session);
			session.setThinkingLevel = (level) => { selectionCalls++; setThinking(level); };
		};
		watchSelection();
		await bind();
		assert.equal(await readFile(file, "utf8"), bytes, "startup rewrote retired history");
		await assert.rejects(session.compact(), /cancelled/i);
		assert.deepEqual(sm.getBranch(), oldBranch);
		await session.prompt("Must not send retired history").catch(() => undefined);
		assert.equal(providerCalls, 0, "retired branch reached provider or compactor");
		assert.equal(selectionCalls, 0, "retirement restored a selection");
		assert.equal(sm.getSessionId(), originalSessionId);
		assert.equal(session.model?.id, "current");
		for (const entry of oldBranch) assert.deepEqual(sm.getEntry(entry.id), entry);
		// Reopen must not forget evidence or restore an old temporary selection.
		session.dispose();
		sm = SessionManager.open(file);
		({ session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model, settingsManager: settings, resourceLoader: loader, sessionManager: sm, tools: ["read"] }));
		watchSelection(); await bind();
		await assert.rejects(session.compact(), /cancelled/i);
		assert.equal(providerCalls, 0); assert.equal(selectionCalls, 0);
		// A sibling branch is clean even though getEntries() still contains old records.
		sm.branch(cleanBase); session.refreshContext();
		await session.prompt("Clean sibling request");
		assert.equal(providerCalls, 1, "abandoned sibling evidence blocked a clean branch");
		assert(JSON.stringify(session.messages.at(-1)).includes("CLEAN-BRANCH-ANSWER"));
		sm.branch(retiredLeaf); session.refreshContext();
		await assert.rejects(session.compact(), /cancelled/i);
		await session.prompt("Back on the retired branch").catch(() => undefined);
		assert.equal(providerCalls, 1, "branch navigation bypassed retirement");
		assert.equal(selectionCalls, 0);
		for (const entry of oldBranch) assert.deepEqual(sm.getEntry(entry.id), JSON.parse(JSON.stringify(entry)));
		assert((await readFile(file, "utf8")).includes(evidence === "manual" || evidence === "terminal-manual" ? "pi-openai-toolkit:manual-compact" : evidence === "sentinel" ? "Pi Codex context-window boundary" : marker));
		env.assertNoNetwork(); process.stdout.write("OK\n");
	} finally { session.dispose(); }
} finally { await env.dispose(); }
