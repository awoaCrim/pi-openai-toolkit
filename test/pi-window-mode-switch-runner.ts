import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const env = await createSmokeEnvironment();
const localApi = process.argv[2];
const mode = process.argv[3];
assert(localApi === "openai-responses" || localApi === "openai-completions");
assert(mode === "remote-compaction" || mode === "pi");
const baseUrl = "https://window-mode-switch.invalid/v1";
const retired = "RETIRED-WINDOW0-SENTINEL";
const current = "CURRENT-WINDOW1-SENTINEL";
const oldOpaque = "PRE-WINDOW-OPAQUE-SENTINEL";
// Pi's tools option is a host allowlist, including extension-owned tools.
const allowedTools = ["read", "new_context", "get_context_remaining", "history", "notes"];

function responseStream(index: number, text = `ANSWER-${index}`) {
	const output = [{ type: "message", id: `msg_${index}`, role: "assistant", status: "completed",
		content: [{ type: "output_text", text, annotations: [] }] }];
	const events = [
		{ type: "response.created", response: { id: `resp_${index}`, status: "in_progress", output: [] } },
		{ type: "response.output_item.done", output_index: 0, item: output[0] },
		{ type: "response.completed", response: { id: `resp_${index}`, status: "completed", output,
			usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
function completionStream(index: number, text = `ANSWER-${index}`) {
	const chunk = { id: `chat_${index}`, object: "chat.completion.chunk", created: 1, model: "local" };
	const events = [
		{ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
	];
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

try {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
	const { createNativeCompactionDetails, createNativeCompactionResult, LEGACY_REMOTE_V2_INPUT_PROVENANCE } = await import("../src/types");
	const { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, CONTEXT_WINDOW_COMPACTION_SUMMARY } = await import("../src/context-management/messages");
	const { isCodexContextManagementMessageDetails } = await import("../src/context-management/types");
	const configDir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify({
		schemaVersion: 2,
		defaults: { context: { mode: "remote-compaction", remoteCompaction: { apis: [] }, nativeFallback: { enabled: false } } },
		models: {
			"remote-gateway/remote": { compatibility: { transport: "codex-gateway" }, context: { mode: "remote-windows" } },
			...(mode === "pi" ? { "local-provider/local": { context: { mode: "pi" } } } : {}),
		},
	}));
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	for (const [provider, api, id] of [["remote-gateway", "openai-responses", "remote"], ["local-provider", localApi, "local"]] as const) {
		runtime.registerProvider(provider, { api, apiKey: `synthetic-${provider}-key`, baseUrl,
			models: [{ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 64000, maxTokens: 1024 }] });
	}
	const remote = runtime.getModel("remote-gateway", "remote")!;
	const local = runtime.getModel("local-provider", "local")!;
	let sm = SessionManager.create(env.cwd, join(env.cwd, "sessions"));
	const covered = sm.appendMessage({ role: "user", content: "BEFORE-OPAQUE-CHECKPOINT", timestamp: 1 });
	sm.appendMessage(fauxAssistantMessage("older work", { timestamp: 2 }));
	const checkpoint = createNativeCompactionResult({ firstKeptEntryId: covered, tokensBefore: 100,
		details: createNativeCompactionDetails({ provider: remote.provider, api: remote.api, model: remote.id, baseUrl,
			inputProvenance: LEGACY_REMOTE_V2_INPUT_PROVENANCE, compactedWindow: [{ type: "compaction", encrypted_content: oldOpaque }] }),
	});
	sm.appendCompaction(checkpoint.summary, checkpoint.firstKeptEntryId, checkpoint.tokensBefore, checkpoint.details);
	const settings = SettingsManager.inMemory({ transport: "sse", cacheWarming: "off",
		retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 2048 } },
		{ projectTrusted: true });
	const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings,
		additionalExtensionPaths: [resolve(import.meta.dir, "../src/extension-runtime.ts")],
		noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		systemPromptOverride: () => "MODE-SWITCH-SYSTEM-HEAD",
	});
	await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
	let session: AgentSession;
	({ session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model: remote,
		settingsManager: settings, resourceLoader: loader, sessionManager: sm, tools: allowedTools }));
	const errors: string[] = [];
	const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
	let failure: unknown;
	let persistedWindowId: string;
	let detached = false, summaryCalls = 0;
	const currentSummary = "CURRENT-COMPACTED-MODE-SWITCH";
	const markers = () => sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CODEX_CONTEXT_WINDOW_MESSAGE_TYPE
		&& isCodexContextManagementMessageDetails(entry.details) && entry.details.contextManagement.kind === "window");
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		try {
			const request = new Request(input, init);
			if (request.method !== "POST" || ![`${baseUrl}/responses`, `${baseUrl}/chat/completions`].includes(request.url)) return deniedFetch(input, init);
			assert(!request.signal.aborted, "aborted mode-switch request reached the encoder transport");
			const body = await request.json() as Record<string, unknown>;
			assert(!JSON.stringify(body).includes("compaction_trigger"), "local compression called a remote producer");
			if (JSON.stringify(body).includes("<conversation>")) {
				summaryCalls++;
				assert.equal(body.model, "local");
				assert(!JSON.stringify(body).includes(retired) && !JSON.stringify(body).includes(oldOpaque));
				assert(!JSON.stringify(body).includes(CONTEXT_WINDOW_COMPACTION_SUMMARY));
				return localApi === "openai-completions" ? completionStream(summaryCalls, currentSummary) : responseStream(summaryCalls, currentSummary);
			}
			requests.push({ body, headers: request.headers });
			const isRemote = body.model === "remote";
			assert(isRemote || body.model === "local");
			assert.equal(request.url, `${baseUrl}/${isRemote || localApi === "openai-responses" ? "responses" : "chat/completions"}`);
			assert.equal(request.headers.get("authorization"), `Bearer synthetic-${isRemote ? "remote-gateway" : "local-provider"}-key`);
			const text = JSON.stringify(body);
			assert(text.includes("MODE-SWITCH-SYSTEM-HEAD"));
			const tools = body.tools as Array<{ name?: string; function?: { name?: string } }>;
			const names = tools.map((tool) => tool.name ?? tool.function?.name);
			assert(names.includes("read"), "current read schema was lost");
			if (requests.length === 1) assert(text.includes(retired), "fixture did not start inside Remote window0");
			else {
				assert(!text.includes(retired), "retired window leaked into an actual provider body");
				assert(text.includes(current), "current window was lost");
			}
			assert(!text.includes(oldOpaque), "pre-window opaque checkpoint was rehydrated");
			const metadata = body.client_metadata as Record<string, unknown> | undefined;
			if (isRemote) {
				assert(text.includes("new_context") && text.includes("history") && text.includes("notes"), "Remote tools were not active");
				assert.equal(metadata?.["x-codex-window-id"], `${sm.getSessionId()}:${requests.length === 1 ? 0 : 1}`);
				assert.equal(request.headers.get("x-codex-window-id"), metadata?.["x-codex-window-id"]);
				if (requests.length > 1) assert(JSON.stringify(metadata).includes(persistedWindowId));
			} else {
				assert(!text.includes("INTERNAL-WINDOW1-MARKER") && !text.includes(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE), "local request kept an internal marker");
				assert.deepEqual(names, ["read"], `local request ${requests.length} reactivated Remote tools (active: ${session.getActiveToolNames()})`);
				assert.equal(metadata?.["x-codex-window-id"], undefined);
				assert.equal(metadata?.["x-codex-turn-metadata"], undefined);
				for (const header of ["x-codex-window-id", "x-codex-turn-metadata", "x-codex-turn-state", "x-codex-affinity-scope", "x-codex-model", "chatgpt-account-id"]) {
					assert.equal(request.headers.get(header), null, `local request inherited ${header}`);
				}
			}
			if (detached) {
				const entries = (await readFile(sm.getSessionFile()!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
				assert(entries.filter((entry) => entry.type === "compaction").at(-1)?.summary.includes(currentSummary),
					"consumer preceded durable native compression");
			}
			return !isRemote && localApi === "openai-completions" ? completionStream(requests.length) : responseStream(requests.length);
		} catch (error) { failure ??= error; throw error; }
	}) as typeof fetch;
	try {
		const bind = () => session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
		async function prompt(text: string, expectedRequests: number) {
			await session.prompt(text);
			if (failure) throw failure;
			assert.deepEqual(errors, []);
			assert.equal(requests.length, expectedRequests, JSON.stringify(session.messages.at(-1)));
			assert.equal(session.messages.at(-1)?.role, "assistant");
			assert(JSON.stringify(session.messages.at(-1)).includes(`ANSWER-${expectedRequests}`));
		}
		await bind();
		await prompt(`${retired} ${"old work ".repeat(1000)}`, 1);
		assert.equal(markers().length, 1);
		const initial = markers()[0]!;
		assert(initial.type === "custom_message" && isCodexContextManagementMessageDetails(initial.details));
		persistedWindowId = "fixture-window1";
		const boundary = sm.appendCustomMessageEntry(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, "INTERNAL-WINDOW1-MARKER", true, {
			protocol: 1, id: "fixture-marker1", sessionId: sm.getSessionId(),
			contextManagement: { protocol: 1, kind: "window", firstWindowId: initial.details.contextManagement.firstWindowId,
				previousWindowId: initial.details.contextManagement.currentWindowId, currentWindowId: persistedWindowId,
				windowNumber: 1, trimPreviousWindow: true },
		});
		for (let i = 0; i < 4; i++) {
			sm.appendMessage({ role: "user", content: `${current} ${"current work ".repeat(200)}`, timestamp: 3 + 2 * i });
			sm.appendMessage({ ...fauxAssistantMessage("current work", { timestamp: 4 + 2 * i }), provider: remote.provider, api: remote.api, model: remote.id });
		}
		session.refreshContext();
		const rawBeforeSwitch = structuredClone(sm.getBranch());
		await session.setModel(local);
		assert.deepEqual(session.getActiveToolNames(), ["read"], "model_select kept Remote tools active");
		await prompt("After selecting the local model", 2);
		try { await session.compact(); } catch (error) { throw failure ?? error; }
		assert.equal(requests.length, 2, "local compression launched a user continuation");
		assert(summaryCalls > 0, "local mode skipped actual native compression");
		const compactions = sm.getBranch().filter((entry) => entry.type === "compaction");
		assert.equal(compactions.length, 2);
		assert(compactions.at(-1)?.summary.includes(currentSummary));
		assert.notEqual(compactions.at(-1)?.details?.strategy, "codex-context-window");
		assert(sm.getBranch().findIndex((entry) => entry.id === compactions.at(-1)?.firstKeptEntryId) >= sm.getBranch().findIndex((entry) => entry.id === boundary));
		detached = true;
		const file = sm.getSessionFile()!;
		for (const entry of rawBeforeSwitch) assert.deepEqual(sm.getEntry(entry.id), entry, "mode switch rewrote raw history");
		session.dispose();
		sm = SessionManager.open(file);
		await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model: local,
			settingsManager: settings, resourceLoader: loader, sessionManager: sm, tools: allowedTools }));
		await bind();
		await prompt("After reopening under the local policy", 3);
		await session.setModel(remote);
		await prompt("Back on the Remote model", 4);
		assert.equal(markers().length, 2, "model toggle initialized a duplicate window");
		const latest = markers().at(-1)!;
		assert(latest.type === "custom_message" && isCodexContextManagementMessageDetails(latest.details));
		assert.equal(latest.details.contextManagement.currentWindowId, persistedWindowId);
		for (const entry of rawBeforeSwitch) assert.deepEqual(sm.getEntry(entry.id), JSON.parse(JSON.stringify(entry)), "reopen changed persisted history");
		const disk = await readFile(file, "utf8");
		assert(disk.includes(retired) && disk.includes(oldOpaque), "fixture must retain retired history on disk");
		assert(!disk.includes("synthetic-remote-gateway-key") && !disk.includes("synthetic-local-provider-key"));
		env.assertNoNetwork();
		process.stdout.write("OK\n");
	} finally { session.dispose(); }
} finally { await env.dispose(); }
