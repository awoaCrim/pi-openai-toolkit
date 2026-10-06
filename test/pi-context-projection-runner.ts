import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const env = await createSmokeEnvironment();
const scenario = process.argv[2];
const standalone = scenario === "standalone" || scenario === "standalone-hook";
const hookSource = scenario === "pi-context-hook" || scenario === "edited-checkpoint-hook" || scenario === "standalone-hook";
const baseUrl = standalone ? "https://api.openai.com/v1" : "https://projection.invalid/v1";
function canonicalWindow(index: number) {
	// Provider JSON may contain these ordinary own keys; every persistence and
	// replay clone must preserve them without invoking Object.prototype setters.
	const futureFields: Record<string, unknown> = JSON.parse('{"__proto__":{"topLevel":true},"nested":{"__proto__":{"inner":true}}}');
	return [
		{ type: "message", role: "user", content: [{ type: "input_text", text: `STANDALONE-RETAINED-USER-${index}` }], future: { order: [1, null, true] } },
		{ type: "compaction", encrypted_content: `opaque-${index}`, future: { metadata: ["preserved"] }, ...futureFields },
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: `STANDALONE-RETAINED-ASSISTANT-${index}`, annotations: [] }] },
	];
}
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
	runtime.registerProvider("projection", { api: "openai-responses", apiKey: "synthetic-projection-key", baseUrl,
		models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1024 }] });
	const model = runtime.getModel("projection", "test")!;
	if (standalone) {
		const refreshed = await runtime.refresh({ allowNetwork: false, providers: ["projection"] });
		assert.equal(refreshed.errors.size, 0);
		assert(runtime.hasConfiguredAuth(model.provider), "official fixture needs a populated configured-auth snapshot");
		assert.equal(runtime.isUsingOAuth(model.provider), false);
	}
	let sm = SessionManager.create(env.cwd, join(env.cwd, "sessions"));
	const covered = sm.appendMessage({ role: "user", content: `COVERED-${"x".repeat(1200)}`, timestamp: 1 });
	const hidden = sm.appendMessage({ role: "user", content: "HIDDEN-BEFORE-COMPACT", timestamp: 2 });
	const replaced = sm.appendMessage(fauxAssistantMessage("OLD-BEFORE-COMPACT", { timestamp: 3 }));
	sm.appendContextEdit(hidden, null);
	sm.appendContextEdit(replaced, { content: "REPLACEMENT-BEFORE-COMPACT" });
	if (standalone) {
		sm.appendMessage({ ...fauxAssistantMessage("", { timestamp: 4 }), provider: model.provider, api: model.api, model: model.id,
			content: [{ type: "toolCall", id: "fixture_call|fixture_item", name: "read", arguments: { path: "synthetic.txt" } }], stopReason: "toolUse" });
		sm.appendMessage({ role: "toolResult", toolCallId: "fixture_call|fixture_item", toolName: "read", content: [{ type: "text", text: "SYNTHETIC-TOOL-RESULT" }], isError: false, timestamp: 5 });
	}
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
	let { session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model,
		settingsManager: settings, resourceLoader: loader, sessionManager: sm, tools: ["read"] });
	let live = 0, compact = 0, v2 = 0;
	let failure: unknown;
	const bodies: Array<Record<string, unknown>> = [];
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		try {
			const request = new Request(input, init);
			if (request.url !== `${baseUrl}/responses` && !(standalone && request.url === `${baseUrl}/responses/compact`)) return deniedFetch(input, init);
			assert(!request.signal.aborted, "cancelled replay reached network");
			const body = await request.json() as Record<string, unknown>;
			bodies.push(body);
			const text = JSON.stringify(body.input);
			assert(!text.includes("HIDDEN-BEFORE-COMPACT") && !text.includes("OLD-BEFORE-COMPACT"));
			assert(!text.includes("HIDDEN-LIVE-TAIL") && !text.includes("OLD-LIVE-TAIL"));
			const synthetic = (body.input as Array<{ type?: string }>).at(-1)?.type === "compaction_trigger";
			if (standalone && synthetic) {
				v2++;
				assert.equal(request.headers.get("authorization"), "Bearer synthetic-projection-key");
				return Response.json({ error: { code: "unsupported_parameter", param: "input", message: "synthetic protocol rejection" } }, { status: 400 });
			}
			let output: Array<Record<string, unknown>>;
			if (synthetic || request.url.endsWith("/compact")) {
				compact++;
				assert.equal(text.includes("FULL-TRANSCRIPT-PHASE"), hookSource);
				if (compact === 1) assert(text.includes("REPLACEMENT-BEFORE-COMPACT"));
				if (compact === 2) {
					assert(text.includes("opaque-1") && text.includes("REPLACEMENT-LIVE-TAIL"));
					assert(!text.includes("COVERED-"));
				}
				if (standalone) {
					assert(Object.keys(body).every((key) => ["input", "instructions", "model", "service_tier", "prompt_cache_key", "prompt_cache_options", "prompt_cache_retention"].includes(key)));
					assert.equal(request.headers.get("accept"), "application/json");
					assert.equal(request.redirect, "error");
					const v2Body = bodies.at(-2)!;
					assert.deepEqual(body.input, (v2Body.input as unknown[]).slice(0, -1), "second protocol reused different prepared input");
					if (compact === 1) {
						assert(text.includes("SYNTHETIC-TOOL-RESULT"));
						assert((body.input as Array<{ type?: string }>).some((item) => item.type === "function_call"));
						assert((body.input as Array<{ type?: string }>).some((item) => item.type === "function_call_output"));
					} else {
						assert.deepEqual((body.input as unknown[]).slice(0, canonicalWindow(compact - 1).length), canonicalWindow(compact - 1));
						assert.equal(text.split(`opaque-${compact - 1}`).length - 1, 1);
					}
					output = canonicalWindow(compact);
					return Response.json({ id: `standalone-${compact}`, output, future: { responseField: true } });
				}
				output = [{ type: "compaction", encrypted_content: `opaque-${compact}` }];
			} else {
				live++;
				if (standalone && compact > 0) {
					const diskEntries = (await readFile(sm.getSessionFile()!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
					const checkpoints = diskEntries.filter((entry) => entry.type === "compaction");
					assert.equal(checkpoints.length, compact, "durable checkpoint missing before continuation");
					assert.deepEqual(checkpoints.at(-1).details.compactedWindow, canonicalWindow(compact));
					assert.equal(checkpoints.at(-1).details.strategy, "openai-native-compact-v1");
					const inputItems = body.input as Array<{ type?: string }>;
					const checkpointStart = inputItems.findIndex((item) => JSON.stringify(item).includes(`STANDALONE-RETAINED-USER-${compact}`));
					assert(checkpointStart >= 0);
					assert.deepEqual(inputItems.slice(checkpointStart, checkpointStart + canonicalWindow(compact).length), canonicalWindow(compact));
					assert.equal(text.split(`STANDALONE-RETAINED-USER-${compact}`).length - 1, 1);
					assert(!text.includes("opaque compaction window") && !text.includes("SYNTHETIC-TOOL-RESULT"));
				}
				assert(JSON.stringify(body).includes("CANONICAL-SYSTEM-HEAD"));
				assert(text.includes("CONVERSATION-PHASE") && text.includes("FULL-TRANSCRIPT-PHASE"));
				assert.deepEqual((body.tools as Array<{ name: string }>).map((tool) => tool.name), ["read"]);
				if (live === 1) assert(text.includes("REPLACEMENT-BEFORE-COMPACT"));
				if (standalone && compact === 1) assert(text.includes("After reopen"));
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
		async function compactSession() {
			try { await session.compact(); } catch (error) { throw failure ?? error; }
		}
		await session.prompt("Initial request");
		if (failure) throw failure;
		assert.deepEqual(errors, []);
		assert(live > 0, JSON.stringify(session.messages.at(-1)));
		if (scenario !== "boundary") {
			await compactSession();
			if (failure) throw failure;
			assert.equal(compact, 1);
			if (standalone) {
				const disk = await readFile(sm.getSessionFile()!, "utf8");
				const checkpoint = disk.trim().split("\n").map((line) => JSON.parse(line)).findLast((entry) => entry.type === "compaction");
				assert.deepEqual(checkpoint.details.compactedWindow, canonicalWindow(1));
				assert.equal(checkpoint.summary, "[OpenAI standalone opaque compaction window]");
				const reopened = SessionManager.open(sm.getSessionFile()!);
				assert.deepEqual(reopened.buildSessionProjection().messages, sm.buildSessionProjection().messages);
				assert.deepEqual(reopened.getBranch().findLast((entry) => entry.type === "compaction")?.details, checkpoint.details);
				session.dispose(); sm = reopened;
				({ session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model,
					settingsManager: settings, resourceLoader: loader, sessionManager: sm, tools: ["read"] }));
				await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
				await session.prompt("After reopen");
				if (failure) throw failure;
				assert.equal(live, 2);
			}
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
				if (scenario !== "retain-none") { await compactSession(); assert.equal(compact, 2); }
				await session.prompt("After compaction");
				assert.equal(live, standalone ? 3 : 2);
				if (standalone) assert.equal(v2, compact, "one V2 attempt per standalone operation");
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
