import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const env = await createSmokeEnvironment();
const scenario = process.argv[2];
const hookSource = scenario === "pi-context-hook" || scenario === "edited-checkpoint-hook";
try {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { fauxAssistantMessage, InMemoryCredentialStore, InMemoryModelsStore, getCurrentSystemPrompt, getCurrentTools } = await import("@earendil-works/pi-ai");
	const configDir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify({ schemaVersion: 2, defaults: {
		context: { mode: "remote-compaction", remoteCompaction: { inputSource: hookSource ? "pi-context-hook" : "legacy" }, nativeFallback: { enabled: false } },
	} }));
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerProvider("projection", { api: "openai-responses", apiKey: "synthetic-projection-key", baseUrl: "https://projection.invalid/v1",
		models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1024 }] });
	const model = runtime.getModel("projection", "test")!;
	const sm = SessionManager.create(env.cwd, join(env.cwd, "sessions"));
	const covered = sm.appendMessage({ role: "user", content: `COVERED-${"x".repeat(1200)}`, timestamp: 1 });
	const hidden = sm.appendMessage({ role: "user", content: "HIDDEN-BEFORE-COMPACT", timestamp: 2 });
	const replaced = sm.appendMessage(fauxAssistantMessage("OLD-BEFORE-COMPACT", { timestamp: 3 }));
	sm.appendContextEdit(hidden, null);
	sm.appendContextEdit(replaced, { content: "REPLACEMENT-BEFORE-COMPACT" });
	const settings = SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } },
		compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 2048 } }, { projectTrusted: true });
	let conversationPhase = 0, fullPhase = 0, boundaryContinued = false;
	const errors: string[] = [];
	const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings,
		additionalExtensionPaths: [resolve(import.meta.dir, "../src/extension-runtime.ts")],
		noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		systemPromptOverride: () => "CANONICAL-SYSTEM-HEAD",
		extensionFactories: [(pi) => {
			pi.on("context", (event) => {
				assert(event.messages.every((message) => message.role !== "system"));
				conversationPhase++;
				return { messages: [...event.messages, { role: "user", content: "CONVERSATION-PHASE", timestamp: 900 }] };
			});
			pi.on("context_with_system", (event) => {
				fullPhase++;
				assert.equal(fullPhase, conversationPhase, "projection phases ran more than once or out of order");
				assert.equal(event.messages[0]?.role, "system");
				assert(getCurrentSystemPrompt(event.messages).includes("CANONICAL-SYSTEM-HEAD"));
				assert.deepEqual(getCurrentTools(event.messages).map((tool) => tool.name), ["read"]);
				return { messages: [...event.messages, { role: "user", content: "FULL-TRANSCRIPT-PHASE", timestamp: 901 }] };
			});
			pi.on("turn_end", (event, ctx) => {
				assert(ctx.sessionManager.getEntry(event.messageEntryId));
				if (scenario !== "boundary" || boundaryContinued) return;
				boundaryContinued = true;
				return { entries: [...event.entries,
					{ type: "context_edit", targetId: event.messageEntryId, replacement: null },
					{ type: "custom_message", customType: "fixture", content: "BOUNDARY-CONTINUATION", display: false },
				], continue: true };
			});
		}],
	});
	await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model,
		settingsManager: settings, resourceLoader: loader, sessionManager: sm, tools: ["read"] });
	let live = 0, compact = 0;
	let failure: unknown;
	const bodies: Array<Record<string, unknown>> = [];
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		try {
			const request = new Request(input, init);
			if (request.url !== "https://projection.invalid/v1/responses") return deniedFetch(input, init);
			assert(!request.signal.aborted, "cancelled replay reached network");
			const body = await request.json() as Record<string, unknown>;
			bodies.push(body);
			const text = JSON.stringify(body.input);
			assert(!text.includes("HIDDEN-BEFORE-COMPACT") && !text.includes("OLD-BEFORE-COMPACT"));
			assert(!text.includes("HIDDEN-LIVE-TAIL") && !text.includes("OLD-LIVE-TAIL"));
			const synthetic = (body.input as Array<{ type?: string }>).at(-1)?.type === "compaction_trigger";
			let output: Array<Record<string, unknown>>;
			if (synthetic) {
				compact++;
				assert.equal(text.includes("FULL-TRANSCRIPT-PHASE"), hookSource);
				if (compact === 1) assert(text.includes("REPLACEMENT-BEFORE-COMPACT"));
				if (compact === 2) {
					assert(text.includes("opaque-1") && text.includes("REPLACEMENT-LIVE-TAIL"));
					assert(!text.includes("COVERED-"));
				}
				output = [{ type: "compaction", encrypted_content: `opaque-${compact}` }];
			} else {
				live++;
				assert(JSON.stringify(body).includes("CANONICAL-SYSTEM-HEAD"));
				assert(text.includes("CONVERSATION-PHASE") && text.includes("FULL-TRANSCRIPT-PHASE"));
				assert.deepEqual((body.tools as Array<{ name: string }>).map((tool) => tool.name), ["read"]);
				if (live === 1) assert(text.includes("REPLACEMENT-BEFORE-COMPACT"));
				if (live === 2 && scenario === "boundary") {
					assert(!text.includes("ANSWER-1") && text.includes("BOUNDARY-CONTINUATION"));
				} else if (live === 2) {
					assert(text.includes(`opaque-${compact}`));
					assert(!text.includes("COVERED-") && !text.includes("REPLACEMENT-LIVE-TAIL"));
				}
				output = [{ type: "message", id: `msg_${live}`, role: "assistant", status: "completed",
					content: [{ type: "output_text", text: `ANSWER-${live}`, annotations: [] }] }];
			}
			const events = [
				{ type: "response.created", response: { id: `resp_${bodies.length}`, status: "in_progress", output: [] } },
				...output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
				{ type: "response.completed", response: { id: `resp_${bodies.length}`, status: "completed", output,
					usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
			];
			return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		} catch (error) { failure ??= error; throw error; }
	}) as typeof fetch;
	try {
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
		await session.prompt("Initial request");
		if (failure) throw failure;
		assert.deepEqual(errors, []);
		assert(live > 0, JSON.stringify(session.messages.at(-1)));
		if (scenario !== "boundary") {
			await session.compact();
			if (failure) throw failure;
			assert.equal(compact, 1);
			if (scenario.startsWith("edited-checkpoint")) {
				sm.appendContextEdit(covered, null);
				session.refreshContext();
				await session.prompt("Do not replay invalidated checkpoint");
				assert.equal(live, 1, "edited opaque checkpoint was dispatched");
				// Ensure Pi reaches session_before_compact rather than its too-small preflight.
				sm.appendMessage({ role: "user", content: "More input ".repeat(500), timestamp: 2000 });
				sm.appendMessage(fauxAssistantMessage("Unsent fixture answer", { timestamp: 2001 }));
				session.refreshContext();
				await assert.rejects(session.compact(), /cancelled/);
				assert.equal(compact, 1);
			} else {
				if (scenario === "retain-none") {
					const latest = sm.getBranch().findLast((entry) => entry.type === "compaction")!;
					assert(latest.type === "compaction");
					sm.appendCompaction(latest.summary, null, 100, latest.details, true);
				} else {
					const hiddenTail = sm.appendMessage({ role: "user", content: `HIDDEN-LIVE-TAIL-${"x".repeat(800)}`, timestamp: 1000 });
					const oldTail = sm.appendMessage(fauxAssistantMessage("OLD-LIVE-TAIL", { timestamp: 1001 }));
					sm.appendContextEdit(hiddenTail, null);
					sm.appendContextEdit(oldTail, { content: `REPLACEMENT-LIVE-TAIL-${"y".repeat(800)}` });
				}
				session.refreshContext();
				if (scenario !== "retain-none") { await session.compact(); assert.equal(compact, 2); }
				await session.prompt("After compaction");
				assert.equal(live, 2);
			}
		} else { assert.equal(live, 2); assert.equal(compact, 0); }
		if (failure) throw failure;
		assert.deepEqual(errors, []);
		assert.equal(fullPhase, conversationPhase);
		const disk = await readFile(sm.getSessionFile()!, "utf8");
		assert(disk.includes("HIDDEN-BEFORE-COMPACT") && disk.includes("context_edit"));
		const reopened = SessionManager.open(sm.getSessionFile()!);
		assert.deepEqual(reopened.buildSessionProjection().messages, sm.buildSessionProjection().messages);
		env.assertNoNetwork();
		process.stdout.write("OK\n");
	} finally { session.dispose(); }
} finally { await env.dispose(); }
