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
const provider = native ? "openai-codex" : "managed";
const excluded = scenario === "excluded-notes";
const legacyRecovery = scenario === "legacy-recovery";
const beforePersistSupersession = ["select-before-persist", "queues-before-persist"].includes(scenario);
const selectsUserModel = ["user-select", "select-during", "select-before-persist"].includes(scenario);
const initialFailure = ["failure", "invalid-output", "abort", "invalid-model", "select-during"].includes(scenario) || beforePersistSupersession;
const suppressResume = ["user-select", "user-input", "queues", "navigate"].includes(scenario);
const producer = scenario === "same-model" || scenario === "unset-model" ? "original" : "checkpoint";
const packageDir = resolve(import.meta.dir, "..");

function streamResponse(output: Array<Record<string, unknown>>, id: string, holdOpen = false) {
	const events = [
		{ type: "response.created", response: { id, status: "in_progress", output: [] } },
		...output.flatMap((item, output_index) => [
			{ type: "response.output_item.added", output_index, item },
			{ type: "response.output_item.done", output_index, item },
		]),
		{ type: "response.completed", response: { id, status: "completed", output,
			usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
	];
	const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(holdOpen ? new ReadableStream<Uint8Array>({
		start(controller) { controller.enqueue(new TextEncoder().encode(text)); },
		cancel() { openBodyCancellations++; },
	}) : text, { headers: { "content-type": "text/event-stream" } });
}
function call(name: string, args: Record<string, unknown>, id: string) {
	const [namespace, action] = name.split(".");
	return { type: "function_call", id: `fc_${id}`, call_id: id, name: action ?? name,
		...(action ? { namespace } : {}), arguments: JSON.stringify(args) };
}
function textResponse(content: string, id: string) {
	return streamResponse([{ type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
		content: [{ type: "output_text", text: content, annotations: [] }] }], id);
}
let openBodyCancellations = 0;
const declaredReadTool = (tools: unknown) => Array.isArray(tools) ? tools.find((tool) => tool?.name === "read") : undefined;

try {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
	const { MANUAL_COMPACT_ENTRY_TYPE } = await import("../src/context-management/manual-compact");
	const { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, CONTEXT_WINDOW_COMPACTION_SUMMARY } = await import("../src/context-management/messages");
	const { createNativeCompactionDetails, LEGACY_REMOTE_V2_INPUT_PROVENANCE, CACHE_STACK_ACTIVATION_ENTRY_TYPE } = await import("../src/types");
	const configDir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(configDir, { recursive: true });
	const configPath = join(configDir, "config.json");
	const fixtureConfig = {
		schemaVersion: 2,
		defaults: { context: { mode: "remote-windows", remoteCompaction: {
			model: scenario === "unset-model" ? null : `${provider}/${scenario === "invalid-model" ? "missing" : producer}`,
			inputSource: hookSource ? "pi-context-hook" : "legacy",
		}, nativeFallback: { enabled: true, model: `${provider}/checkpoint` }, remoteWindows: { reminderThresholdPercent: 0 } } },
		models: Object.fromEntries(["original", "checkpoint", "user-choice"].map((id) => [`${provider}/${id}`, native ? {} : { compatibility: { transport: "codex-gateway" } }])),
	};
	await writeFile(configPath, JSON.stringify(fixtureConfig));
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const baseUrl = native ? "https://managed-compact.invalid/backend-api" : "https://managed-compact.invalid/v1";
	const contextBase = native ? `${baseUrl}/codex` : baseUrl;
	const apiKey = native ? `smoke.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature` : "synthetic-managed-key";
	runtime.registerProvider(provider, { api: native ? "openai-codex-responses" : "openai-responses", apiKey, baseUrl,
		models: ["original", "checkpoint", "user-choice"].map((id) => ({ id, name: id, reasoning: id === "original", input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 2048 })) });
	const original = runtime.getModel(provider, "original")!;
	let sm = SessionManager.create(env.cwd, join(env.cwd, "sessions"));
	for (let i = 0; i < 3; i++) {
		sm.appendMessage({ role: "user", content: `RETIRED-PRE-WINDOW-${i}-${"x".repeat(800)}`, timestamp: i });
		sm.appendMessage(fauxAssistantMessage("old answer"));
	}
	const oldHead = sm.getLeafId()!;
	if (scenario === "old-opaque") {
		sm.appendCompaction("pre-window opaque checkpoint", oldHead, 100, createNativeCompactionDetails({
			provider, api: original.api, model: original.id, baseUrl,
			inputProvenance: LEGACY_REMOTE_V2_INPUT_PROVENANCE,
			deferredToolCarryover: { version: 1, source: CACHE_STACK_ACTIVATION_ENTRY_TYPE, toolNames: ["RETIRED-DEFERRED-TOOL"] },
			compactedWindow: [{ type: "compaction", encrypted_content: "RETIRED-OLD-OPAQUE" }],
		}));
	}
	const addMarker = (window: string, number: number) => sm.appendCustomMessageEntry(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, `Remote window ${window}`, true, {
		protocol: 1, id: `marker-${window}`, sessionId: sm.getSessionId(),
		contextManagement: { protocol: 1, kind: "window", firstWindowId: "w0", currentWindowId: window,
			windowNumber: number, ...(number ? { previousWindowId: "w0", trimPreviousWindow: true } : {}) },
	});
	let currentBoundary: string | undefined;
	if (!excluded) {
		addMarker("w0", 0);
		sm.appendMessage({ role: "user", content: "RETIRED-WINDOW-ZERO", timestamp: 4 });
		currentBoundary = addMarker("w1", 1);
		if (scenario === "cleaned") sm.appendCompaction(CONTEXT_WINDOW_COMPACTION_SUMMARY, currentBoundary, 100,
			{ protocol: 1, strategy: "codex-context-window", windowId: "w1" }, true);
	}
	if (legacyRecovery) {
		sm.appendCustomEntry(MANUAL_COMPACT_ENTRY_TYPE, { version: 1, operationId: "legacy-owned", sessionId: sm.getSessionId(),
			sourceWindowId: "w1", anchorId: currentBoundary!, originalModel: `${provider}/original`, targetModel: `${provider}/checkpoint`,
			originalThinking: "high", phase: "checkpointing" });
	}
	const readPath = join(env.cwd, "fixture.txt");
	await writeFile(readPath, "CURRENT-WINDOW-READ-DATA");
	const settings = SettingsManager.inMemory({ transport: "sse", retry: { enabled: false, provider: { maxRetries: 0 } },
		compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 2048 } }, { projectTrusted: true });
	let session: AgentSession;
	let conversationPhase = 0, fullPhase = 0, phasesAtCompact = 0;
	let heldSuccessObserver = false, heldBeforeCompactObserver = false, compactReturned = true;
	let releaseBeforeCompactObserver: (() => void) | undefined;
	let seed = 0, remoteCalls = 0, savedCount = 0, continuations = 0, externalCalls = 0;
	let noteReads = 0, noteWrites = 0, historyReads = 0, rolloverStage = -1, remindersAtCompact = 0;
	let failure: unknown, liveReadTool: unknown;
	const errors: string[] = [];
	const setterCalls: string[] = [];
	const requests: Array<{ model: unknown; input: string; synthetic: boolean }> = [];
	const markers = () => sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CODEX_CONTEXT_WINDOW_MESSAGE_TYPE
		&& (entry.details as { contextManagement: { kind: string } }).contextManagement.kind === "window");
	const checkpoints = () => sm.getBranch().filter((entry) => entry.type === "compaction" && (entry.details as { strategy?: string } | undefined)?.strategy === "openai-remote-compaction-v2");
	const reminderCount = () => sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CODEX_CONTEXT_WINDOW_MESSAGE_TYPE
		&& (entry.details as { contextManagement: { kind: string } }).contextManagement.kind !== "window").length;
	const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings,
		additionalExtensionPaths: [join(packageDir, "src/extension-runtime.ts")],
		noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		systemPromptOverride: () => "MANAGED-SYSTEM-HEAD. Follow the deterministic fixture tools.",
		extensionFactories: [(pi) => {
			pi.on("context", (event) => {
				conversationPhase++;
				return { messages: [...event.messages, { role: "user", content: "CONVERSATION-PHASE", timestamp: 900 }] };
			});
			pi.on("context_with_system", (event) => {
				fullPhase++;
				assert.equal(fullPhase, conversationPhase, "context phases repeated/out of order");
				return { messages: [...event.messages, { role: "user", content: "FULL-TRANSCRIPT-PHASE", timestamp: 901 }] };
			});
			pi.on("session_before_compact", async (event) => {
				if (!beforePersistSupersession || event.reason !== "manual") return;
				assert.equal(remoteCalls, 1, "observer must run after Toolkit returned its candidate");
				assert.equal(checkpoints().length, 0);
				heldBeforeCompactObserver = true;
				await new Promise<void>((done) => { releaseBeforeCompactObserver = done; });
				heldBeforeCompactObserver = false;
			});
			pi.on("session_compact", async (event, ctx) => {
				if (event.reason !== "manual" || !checkpoints().length || excluded) return;
				heldSuccessObserver = true;
				assert(!ctx.isIdle(), "success callback unexpectedly exposed manual idle");
				const before = continuations;
				await new Promise((done) => setTimeout(done, 25));
				assert.equal(continuations, before, "continuation ran during a later success observer");
				assert(!ctx.isIdle());
				heldSuccessObserver = false;
				if (scenario === "queues") {
					await session.steer("QUEUED-USER-1");
					await session.followUp("QUEUED-USER-2");
				}
			});
			pi.on("agent_start", () => { assert(!heldSuccessObserver, "reentrant agent run during compaction success"); });
		}],
	});
	async function createSession(recovery = false) {
		const created = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime,
			model: recovery ? runtime.getModel(provider, "checkpoint")! : original,
			thinkingLevel: recovery ? "off" : "high", settingsManager: settings, resourceLoader: loader, sessionManager: sm,
			tools: ["read", "new_context", "get_context_remaining", "history", "notes"], ...(excluded ? { excludeTools: ["notes"] } : {}) });
		session = created.session;
		const setModel = session.setModel.bind(session);
		session.setModel = async (model) => { setterCalls.push(`model:${model.id}`); return setModel(model); };
		const setThinking = session.setThinkingLevel.bind(session);
		session.setThinkingLevel = (level) => { setterCalls.push(`thinking:${level}`); setThinking(level); };
		await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error.error); } });
	}
	async function compactSession(instructions: string) {
		remindersAtCompact = reminderCount();
		try { return await session!.compact(instructions); }
		catch (error) { throw failure ?? error; }
	}
	async function waitUntil(predicate: () => boolean, label: string) {
		const deadline = Date.now() + 2500;
		while (!predicate() && Date.now() < deadline && !failure) await new Promise((done) => setTimeout(done, 5));
		if (failure) throw failure;
		assert(predicate(), `${label}: ${JSON.stringify({ scenario, requests: requests.map(({ model, synthetic }) => ({ model, synthetic })), errors })}`);
	}
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		try {
			const req = new Request(input, init);
			if (!req.url.startsWith(`${baseUrl}/`) || req.method !== "POST") return deniedFetch(input, init);
			const bytes = Buffer.from(await req.arrayBuffer());
			const body = JSON.parse((req.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8")) as Record<string, unknown>;
			if (req.url.endsWith("/alpha/notes/v2/read_file")) { noteReads++; return Response.json({ encrypted_output: `notes-encrypted-${noteReads}` }); }
			if (req.url.endsWith("/alpha/history/v2/list_windows")) { historyReads++; return Response.json({ encrypted_output: `history-encrypted-${historyReads}` }); }
			if (req.url.endsWith("/alpha/notes/v2/write_file")) { noteWrites++; return Response.json({ success: true, written: true }); }
			if (req.url.endsWith("/alpha/notes/v2/thread_hint")) return Response.json({ text: "Fixture thread hint" });
			if (req.url !== `${contextBase}/responses`) return deniedFetch(input, init);
			assert(!req.signal.aborted, "aborted request reached fetch");
			const items = body.input as Array<Record<string, unknown>>;
			const synthetic = items.at(-1)?.type === "compaction_trigger";
			const inputText = JSON.stringify(items);
			requests.push({ model: body.model, input: inputText, synthetic });
			assert(!inputText.includes("RETIRED-OLD-OPAQUE"), "pre-window checkpoint was replayed");
			if (!excluded) assert(!inputText.includes("RETIRED-PRE-WINDOW") && !inputText.includes("RETIRED-WINDOW-ZERO"), "retired windows were sent");
			assert(!inputText.includes("pi-openai-toolkit:encrypted-output:"), "internal encrypted-output marker reached wire");
			if (synthetic) {
				remoteCalls++;
				assert.equal(body.model, producer);
				assert.equal(session.model?.id, "original", "synthetic producer changed the active model");
				assert.equal(body.store, false); assert.equal(body.stream, true);
				assert(!JSON.stringify(body.client_metadata ?? {}).includes("history_ingest_requested"), "synthetic compression ran ordinary turn-ingest hooks");
				assert.equal(reminderCount(), remindersAtCompact, "synthetic preparation emitted a budget reminder");
				if (remoteCalls === 1) assert(!inputText.includes("<context_window_reminder>"), "synthetic input contains a newly emitted reminder");
				assert.equal(req.headers.get("authorization"), `Bearer ${apiKey}`);
				assert.equal(req.headers.get("session-id"), sm.getSessionId());
				if (!native) assert.equal(req.headers.get("x-codex-model"), producer);
				if (!excluded) {
					assert.equal(conversationPhase - phasesAtCompact, hookSource ? 1 : 0, "synthetic input reran/skipped context hooks");
					assert.equal(fullPhase, conversationPhase);
					assert.equal(inputText.includes("FULL-TRANSCRIPT-PHASE"), hookSource);
					assert(!inputText.includes(CONTEXT_WINDOW_COMPACTION_SUMMARY));
					if (remoteCalls === 1) {
						assert(inputText.includes("ACTIVE-WINDOW-TASK"));
						assert(inputText.includes("CURRENT-WINDOW-READ-DATA"));
						assert(inputText.includes("notes-encrypted-1") && inputText.includes("history-encrypted-1"));
						assert(items.some((item) => item.type === "function_call" && item.namespace === "notes" && item.name === "read_file"));
						assert(items.some((item) => item.type === "function_call_output" && Array.isArray(item.output)
							&& (item.output as Array<{ type: string }>).some((part) => part.type === "encrypted_content")));
					} else {
						assert.equal(inputText.split(`opaque-${remoteCalls - 1}`).length - 1, 1);
						assert(inputText.includes("EDITED-LIVE-TAIL"));
						assert(!inputText.includes("OLD-LIVE-TAIL") && !inputText.includes("HIDDEN-LIVE-TAIL"));
						assert(!inputText.includes("ACTIVE-WINDOW-TASK") && !inputText.includes("CURRENT-WINDOW-READ-DATA"));
					}
					const tools = JSON.stringify(body.tools);
					assert(tools?.includes("notes") && tools.includes("history") && tools.includes("read"), "active Remote request extras/tool head were lost");
					assert.deepEqual(declaredReadTool(body.tools), liveReadTool, "synthetic tool schema differs from the compatible live SDK head");
				}
				if (scenario === "failure") return Response.json({ error: { code: "server_error" } }, { status: 500 });
				if (scenario === "abort") { session.abortCompaction(); throw new DOMException("fixture cancellation", "AbortError"); }
				if (scenario === "select-during") await session.setModel(runtime.getModel(provider, "user-choice")!);
				return streamResponse([{ type: "compaction", encrypted_content: scenario === "invalid-output" ? "" : `opaque-${remoteCalls}` }], `remote-${remoteCalls}`, scenario === "open-stream");
			}
			assert.equal(body.model, "original", "notes duty/native summary/hidden switched-model inference");
			assert.equal((body.reasoning as { effort?: string } | undefined)?.effort, "high", "original thinking level changed");
			assert(JSON.stringify(body).includes("MANAGED-SYSTEM-HEAD"));
			assert(!inputText.includes("Checkpoint duty only.") && !inputText.includes("Read the persisted checkpoint first"));
			if (seed < 2) {
				liveReadTool = declaredReadTool(body.tools);
				assert.equal(remoteCalls, 0);
				return seed++ === 0 ? streamResponse([
					call("read", { path: readPath }, "seed-read"),
					call("notes.read_file", { path: "/root/notes/source.md" }, "seed-notes"),
					call("history.list_windows", { limit: 2 }, "seed-history"),
				], "seed-tools") : textResponse("READY", "seed-ready");
			}
			assert(!initialFailure && !excluded && !legacyRecovery, "failure reached a hidden original-model fallback");
			assert(!heldSuccessObserver && !session.isCompacting, "continuation preceded manual idle");
			assert(compactReturned, "continuation preceded the manual compact result");
			const disk = (await readFile(sm.getSessionFile()!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
			assert(disk.some((entry) => entry.type === "compaction" && entry.details?.compactedWindow?.[0]?.encrypted_content === `opaque-${savedCount}`), "exact checkpoint not durable before inference");
			if (rolloverStage >= 0) {
				if (rolloverStage++ === 0) return streamResponse([
					call("notes.write_file", { path: "/root/notes/next.md", text: "Active task preserved" }, "later-write"),
					call("history.list_windows", { limit: 2 }, "later-history"),
				], "later-tools");
				if (rolloverStage === 2) return streamResponse([call("new_context", {}, "later-rollover")], "later-rollover");
				assert(!inputText.includes(`opaque-${savedCount}`), "later new_context leaked the retired opaque checkpoint");
				const metadata = JSON.parse((body.client_metadata as Record<string, string>)["x-codex-turn-metadata"]);
				assert.notEqual(metadata.context_window_id, "w1");
				return textResponse("ROLLOVER-DONE", "rollover-done");
			}
			assert.equal(inputText.split(`opaque-${savedCount}`).length - 1, 1, "opaque checkpoint missing/duplicated");
			assert(!inputText.includes("ACTIVE-WINDOW-TASK") && !inputText.includes("CURRENT-WINDOW-READ-DATA"));
			assert(!inputText.includes("HIDDEN-LIVE-TAIL") && !inputText.includes("OLD-LIVE-TAIL"));
			const metadata = JSON.parse((body.client_metadata as Record<string, string>)["x-codex-turn-metadata"]);
			assert.equal(metadata.context_window_id, "w1");
			if (inputText.includes("NEWER-USER-WORK") || inputText.includes("REOPEN-REQUEST")) externalCalls++;
			else continuations++;
			return textResponse("CONTINUED", `continued-${continuations}-${externalCalls}`);
		} catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) failure ??= error; throw error; }
	}) as typeof fetch;
	try {
		await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
		await createSession(legacyRecovery);
		if (legacyRecovery) {
			assert.equal(session!.model?.id, "original"); assert.equal(session!.thinkingLevel, "high");
			assert.equal(requests.length, 0); assert.equal(markers().length, 2);
			assert(setterCalls.includes("model:original"));
		} else {
			if (!excluded) await session!.prompt("ACTIVE-WINDOW-TASK: preserve this work and its next steps.");
			if (failure) throw failure;
			fixtureConfig.defaults.context.remoteWindows.reminderThresholdPercent = 100;
			await writeFile(configPath, JSON.stringify(fixtureConfig));
			const originalSessionId = sm.getSessionId();
			const sourceBranch = structuredClone(sm.getBranch());
			const sourceLeaf = sm.getLeafId()!;
			phasesAtCompact = conversationPhase; compactReturned = false;
			if (beforePersistSupersession) {
				const compacting = compactSession("Preserve the exact acceptance criteria");
				try {
					await waitUntil(() => heldBeforeCompactObserver, "later before-compact observer was not reached");
					if (scenario === "select-before-persist") await session!.setModel(runtime.getModel(provider, "user-choice")!);
					else { await session!.steer("QUEUED-USER-1"); await session!.followUp("QUEUED-USER-2"); }
					assert.equal(checkpoints().length, 0, "host committed while a before observer was pending");
				} finally { releaseBeforeCompactObserver?.(); }
				await assert.rejects(compacting, /cancelled|failed/i);
			} else if (initialFailure) await assert.rejects(compactSession("Preserve the exact acceptance criteria"), /cancelled|failed/i);
			else { await compactSession("Preserve the exact acceptance criteria"); savedCount = 1; }
			compactReturned = true;
			if (scenario === "user-select") await session!.setModel(runtime.getModel(provider, "user-choice")!);
			if (scenario === "navigate") await session!.navigateTree(sourceLeaf, { summarize: false });
			if (scenario === "user-input") await session!.prompt("NEWER-USER-WORK");
			if (initialFailure || suppressResume || excluded) {
				await new Promise((done) => setTimeout(done, 100));
				assert.equal(continuations, 0, "failed/superseded operation resumed automatically");
				if (initialFailure) {
					assert.equal(checkpoints().length, scenario === "old-opaque" ? 1 : 0);
					if (!selectsUserModel) assert.deepEqual(sm.getBranch(), sourceBranch, "failed compression changed prior context");
				}
				if (scenario === "queues" || scenario === "queues-before-persist") {
					assert.deepEqual(session!.getSteeringMessages(), ["QUEUED-USER-1"]);
					assert.deepEqual(session!.getFollowUpMessages(), ["QUEUED-USER-2"]);
				}
			} else {
				await waitUntil(() => continuations === 1 && session!.isIdle, "original-model continuation did not complete");
				assert.deepEqual((checkpoints().at(-1)!.details as { compactedWindow: unknown[] }).compactedWindow,
					[{ type: "compaction", encrypted_content: "opaque-1" }]);
				if (scenario === "old-opaque") assert.equal((checkpoints().at(-1)!.details as { deferredToolCarryover?: unknown }).deferredToolCarryover, undefined, "retired checkpoint donated deferred state");
				if (scenario === "repeat") {
					const file = sm.getSessionFile()!;
					session!.dispose(); await loader.reload();
					sm = SessionManager.open(file);
					await createSession();
					await new Promise((done) => setTimeout(done, 30));
					assert.equal(continuations, 1, "reload resumed old work");
					await session!.prompt("REOPEN-REQUEST");
					const changed = sm.appendMessage({ role: "user", content: "OLD-LIVE-TAIL", timestamp: 100 });
					const hidden = sm.appendMessage({ role: "user", content: "HIDDEN-LIVE-TAIL", timestamp: 101 });
					sm.appendContextEdit(changed, { content: `EDITED-LIVE-TAIL-${"y".repeat(1600)}` }); sm.appendContextEdit(hidden, null);
					sm.appendMessage(fauxAssistantMessage("Unsent fixture answer", { timestamp: 102 }));
					session!.refreshContext();
					phasesAtCompact = conversationPhase; compactReturned = false;
					await compactSession("Second current-window compression"); savedCount = 2; compactReturned = true;
					await waitUntil(() => continuations === 2 && session!.isIdle, "second exact checkpoint did not continue");
					assert.equal(remoteCalls, 2);
					assert.equal(checkpoints().filter((entry) => entry.summary === checkpoints().at(-1)!.summary).length, 2, "fixture must exercise equal summaries");
				}
				if (scenario === "sealed-edit") {
					const covered = sourceBranch.find((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message).includes("ACTIVE-WINDOW-TASK"))!;
					sm.appendContextEdit(covered.id, { content: "INVALIDATED-SEALED-CONTEXT" });
					sm.appendMessage({ role: "user", content: "More input ".repeat(500), timestamp: 2000 });
					sm.appendMessage(fauxAssistantMessage("Unsent fixture answer", { timestamp: 2001 }));
					session!.refreshContext();
					const before = requests.length;
					await assert.rejects(compactSession("Do not bypass opaque edit safety"), /cancelled|failed/i);
					await new Promise((done) => setTimeout(done, 75));
					assert.equal(requests.length, before); assert.equal(remoteCalls, 1); assert.equal(continuations, 1);
				}
				if (scenario === "rollover") {
					rolloverStage = 0;
					await session!.prompt("Write notes, inspect history, then switch windows once.");
					assert.equal(noteWrites, 1); assert.equal(historyReads, 2); assert.equal(markers().length, 3);
					assert.equal(remoteCalls, 1, "ordinary rollover maintenance used the user-manual producer");
				}
			}
			if (failure) throw failure;
			assert.equal(sm.getSessionId(), originalSessionId);
			if (scenario !== "rollover") assert.equal(markers().length, excluded ? 0 : 2, "compression opened another window");
			assert.equal(remoteCalls, scenario === "invalid-model" ? 0 : scenario === "repeat" ? 2 : 1);
			assert.equal(noteWrites, scenario === "rollover" ? 1 : 0, "compression started a notes-writing loop");
			assert.equal(session!.model?.id, selectsUserModel ? "user-choice" : "original");
			if (!selectsUserModel) assert.deepEqual(setterCalls, []);
			assert(!sm.getBranch().some((entry) => entry.type === "custom" && entry.customType === MANUAL_COMPACT_ENTRY_TYPE), "new operation created notes-duty records");
			if (scenario === "open-stream") assert.equal(openBodyCancellations, 1);
		}
		assert.deepEqual(errors, []);
		const disk = await readFile(sm.getSessionFile()!, "utf8");
		assert(!disk.includes("synthetic-managed-key"));
		env.assertNoNetwork();
		process.stdout.write("OK\n");
	} finally { session!?.dispose(); }
} finally { await env.dispose(); }
