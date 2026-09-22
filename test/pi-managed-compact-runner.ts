import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const env = await createSmokeEnvironment();
const caseName = process.argv[2] ?? "plain";
const native = caseName.startsWith("native-");
const scenario = caseName === "native-codex" ? "plain" : native ? caseName.slice(7) : caseName;
const provider = native ? "openai-codex" : "managed";
const sameModel = scenario === "same-model" || scenario === "unset-model";
const incomplete = ["notes-failed", "no-rollover", "cancel-notes"].includes(scenario);
const cancelledAfter = scenario === "cancel-after-schedule";
const userSelection = scenario === "user-select";
const noContinuation = incomplete || cancelledAfter || userSelection;
const refused = scenario === "approval-refused" || scenario === "excluded-notes";
const targetKey = `${provider}/${sameModel ? "original" : "checkpoint"}`;
const packageDir = resolve(import.meta.dir, "..");

function streamResponse(output: Array<Record<string, unknown>>, id: string) {
	const events = [
		{ type: "response.created", response: { id, status: "in_progress", output: [] } },
		...output.flatMap((item, output_index) => [
			{ type: "response.output_item.added", output_index, item },
			{ type: "response.output_item.done", output_index, item },
		]),
		{ type: "response.completed", response: { id, status: "completed", output,
			usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
function call(name: string, args: Record<string, unknown>, id: string) {
	const [namespace, action] = name.split(".");
	return { type: "function_call", id: `fc_${id}`, call_id: id, name: action ?? name,
		...(action ? { namespace } : {}), arguments: JSON.stringify(args) };
}
function text(content: string, id: string) {
	return streamResponse([{ type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
		content: [{ type: "output_text", text: content, annotations: [] }] }], id);
}

try {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage, Type } = await import("@earendil-works/pi-ai");
	const { MANUAL_COMPACT_ENTRY_TYPE } = await import("../src/context-management/manual-compact");
	const { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE } = await import("../src/context-management/messages");
	const configDir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify({
		schemaVersion: 2,
		defaults: { context: { mode: "remote-windows", remoteCompaction: { model: scenario === "unset-model" ? null : targetKey } } },
		models: Object.fromEntries(["original", "checkpoint"].map((id) => [`${provider}/${id}`, { ...(native ? {} : { compatibility: { transport: "codex-gateway" } }),
			...(scenario === "approval-refused" && id === "original" ? { autoMode: { available: true, reviewerModel: "managed/original" } } : {}) }])),
	}));
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const baseUrl = native ? "https://managed-compact.invalid/backend-api" : "https://managed-compact.invalid/v1";
	const contextBase = native ? `${baseUrl}/codex` : baseUrl;
	const apiKey = native ? `smoke.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature` : "synthetic-managed-key";
	runtime.registerProvider(provider, { api: native ? "openai-codex-responses" : "openai-responses", apiKey, baseUrl,
		models: ["original", "checkpoint"].map((id) => ({ id, name: id, reasoning: id === "original", input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 2048 })) });
	const original = runtime.getModel(provider, "original")!;
	const sm = SessionManager.create(env.cwd, join(env.cwd, "sessions"));
	for (let i = 0; i < 3; i++) {
		sm.appendMessage({ role: "user", content: `RETIRED-PRE-WINDOW-${i}-${"x".repeat(800)}`, timestamp: i });
		sm.appendMessage(fauxAssistantMessage("old answer"));
	}
	const settings = SettingsManager.inMemory({ transport: "sse", retry: { enabled: false, provider: { maxRetries: 0 } },
		compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 2048 } }, { projectTrusted: true });
	let session: AgentSession;
	let queued = false;
	let probeExecutions = 0;
	let settled = 0;
	let notifyingSettled = false;
	let actionableTurns = 0;
	let handoffSettlementObserved = false;
	const errors: string[] = [];
	const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings,
		additionalExtensionPaths: [join(packageDir, "src/extension-runtime.ts"), ...(scenario === "approval-refused" ? [join(packageDir, "src/auto-mode/extension.ts")] : [])],
		noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		systemPromptOverride: () => "MANAGED-SYSTEM-HEAD. Follow the deterministic fixture tools.",
		extensionFactories: [(pi) => {
			pi.registerTool({ name: "probe", label: "Probe", description: "Ordinary work must not run during checkpoint duty", parameters: Type.Object({}),
				execute: async () => { probeExecutions++; return { content: [{ type: "text", text: "ok" }], details: {} }; } });
			pi.on("tool_result", async (event) => {
				if (userSelection && event.toolName === "notes") {
					await session.setModel(original); session.setThinkingLevel("medium"); return;
				}
				if (event.toolName !== "new_context" || queued) return;
				if (cancelledAfter) { void session.abort(); return; }
				if (scenario === "queues") {
					queued = true;
					await session.steer("QUEUED-USER-REQUEST-1");
					await session.steer("QUEUED-USER-REQUEST-2");
					await session.followUp("QUEUED-USER-REQUEST-3");
					return;
				}
				if (scenario === "steer" || scenario === "followUp") {
					queued = true;
					await session[scenario]("QUEUED-USER-REQUEST");
				}
			});
			pi.on("turn_end", (event, ctx) => {
				assert(ctx.sessionManager.getEntry(event.messageEntryId), "turn boundary preceded assistant persistence");
				for (const id of event.toolResultEntryIds) assert(ctx.sessionManager.getEntry(id));
				assert(Array.isArray(event.entries));
				assert.equal(typeof event.continue, "boolean");
				actionableTurns++;
			});
			pi.on("agent_start", () => { assert(!notifyingSettled, "reentrant launch inside settled notification"); });
			pi.on("agent_settled", async (_event, ctx) => {
				assert(ctx.isIdle());
				const firstHandoffSettlement = markers().length === 2 && !handoffSettlementObserved;
				if (firstHandoffSettlement) assert.equal(resumedCalls, 0, "continuation preceded the later settled observer");
				notifyingSettled = true;
				await new Promise((done) => setTimeout(done, 5));
				assert(ctx.isIdle(), "deferred continuation launched before all observers finished");
				if (firstHandoffSettlement) {
					assert.equal(resumedCalls, 0, "continuation launched during settled notification");
					handoffSettlementObserved = true;
				}
				notifyingSettled = false;
				settled++;
			});
		}],
	});
	await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
	({ session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model: original,
		thinkingLevel: "high", settingsManager: settings, resourceLoader: loader, sessionManager: sm,
		...(scenario === "excluded-notes" ? { excludeTools: ["notes"] } : {}) }));
	const requests: Array<{ model: unknown; reasoning: unknown; input: string; switched: boolean }> = [];
	let noteWrites = 0, noteReads = 0, checkpointCalls = 0, resumedCalls = 0;
	let seed = true;
	let failure: unknown;
	const markers = () => sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CODEX_CONTEXT_WINDOW_MESSAGE_TYPE
		&& (entry.details as { contextManagement: { kind: string } }).contextManagement.kind === "window");
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		try {
			const req = new Request(input, init);
			if (!req.url.startsWith(`${baseUrl}/`) || req.method !== "POST") return deniedFetch(input, init);
			const bytes = Buffer.from(await req.arrayBuffer());
			const body = JSON.parse((req.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8")) as Record<string, unknown>;
			if (req.url.endsWith("/alpha/notes/v2/write_file")) {
				noteWrites++;
				assert.equal(body.path, "/root/notes/managed-checkpoint.md");
				if (scenario === "cancel-notes") { void session.abort(); throw new DOMException("fixture cancellation", "AbortError"); }
				return Response.json({ success: scenario !== "notes-failed", written: scenario !== "notes-failed" });
			}
			if (req.url.endsWith("/alpha/notes/v2/read_file")) { noteReads++; return Response.json({ text: "ACTIVE-TASK and next steps preserved.", returned_lines: 1 }); }
			if (req.url.endsWith("/alpha/notes/v2/thread_hint")) return Response.json({ text: "Fixture thread hint" });
			if (req.url !== `${contextBase}/responses`) return deniedFetch(input, init);
			assert(!req.signal.aborted, "aborted temporary-model inference reached fetch");
			const switched = markers().length === 2;
			const inputText = JSON.stringify(body.input);
			requests.push({ model: body.model, reasoning: body.reasoning, input: inputText, switched });
			assert.equal(body.model, seed || switched ? "original" : targetKey.split("/")[1], JSON.stringify({ scenario, phase: sm.getBranch().filter((entry) => entry.type === "custom" && entry.customType === MANUAL_COMPACT_ENTRY_TYPE), requests: requests.map(({ model, switched }) => ({ model, switched })), selected: session.model?.id }));
			assert(JSON.stringify(body).includes("MANAGED-SYSTEM-HEAD"));
			const tools = JSON.stringify(body.tools);
			assert(tools.includes("new_context") && tools.includes("notes") && tools.includes("history"), tools);
			if (seed) { seed = false; return text("Ready for manual compact", "seed"); }
			if (switched) {
				assert(handoffSettlementObserved, "new-window inference preceded the completed settled dispatch");
				assert(!inputText.includes("ACTIVE-TASK-ONLY-IN-SOURCE"));
				assert(!inputText.includes("Checkpoint duty only."));
				assert(inputText.includes("managed-checkpoint.md"));
				if (queued) assert(inputText.includes("QUEUED-USER-REQUEST"));
				resumedCalls++;
				return resumedCalls === 1 ? streamResponse([call("notes.read_file", { path: "/root/notes/managed-checkpoint.md" }, "receipt-read")], "read") : text("DONE", "done");
			}
			checkpointCalls++;
			assert(inputText.includes("Managed /compact"));
			assert(inputText.includes("Preserve the exact acceptance criteria"));
			if (checkpointCalls === 1) return streamResponse([call("notes.write_file", { path: "/root/notes/managed-checkpoint.md", text: "ACTIVE-TASK checkpoint" }, "checkpoint-write")], "write");
			if (incomplete) return text("Checkpoint could not finish", "incomplete");
			assert.equal(checkpointCalls, 2, `unexpected checkpoint-model continuation: ${inputText.slice(-5000)}`);
			return streamResponse([
				call("new_context", {}, "rollover"),
				...(scenario === "mixed" ? [call("probe", {}, "ordinary-work")] : []),
				...(scenario === "duplicate" ? [call("new_context", {}, "rollover-again")] : []),
			], "rollover");
		} catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) failure ??= error; throw error; }
	}) as typeof fetch;
	try {
		await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error.error); } });
		if (scenario !== "excluded-notes") await session.prompt("ACTIVE-TASK-ONLY-IN-SOURCE: preserve this work and its next steps.");
		if (scenario === "approval-refused") await session.prompt("/auto on");
		await assert.rejects(session.compact("Preserve the exact acceptance criteria"), /cancelled/);
		const start = Date.now();
		while (!refused && Date.now() - start < 9000 && (settled < (noContinuation ? 2 : 3) || !session.isIdle)) await new Promise((done) => setTimeout(done, 10));
		if (failure) throw failure;
		assert.deepEqual(errors, []);
		assert(session.isIdle, `did not settle: ${JSON.stringify({ requests, settled })}`);
		assert.equal(session.model?.id, "original");
		assert.equal(session.thinkingLevel, userSelection ? "medium" : "high");
		assert.equal(probeExecutions, 0);
		if (!refused) assert(actionableTurns >= 2);
		assert.equal(noteWrites, refused ? 0 : 1);
		assert.equal(noteReads, noContinuation || refused ? 0 : 1);
		assert.equal(markers().length, scenario === "excluded-notes" ? 0 : incomplete || userSelection || refused ? 1 : 2);
		assert.equal(resumedCalls, noContinuation || refused ? 0 : scenario === "queues" ? 3 : 2);
		for (const request of requests) {
			assert.equal((request.reasoning as { effort?: string } | undefined)?.effort, request.model === "original" ? "high" : undefined);
		}
		const branch = sm.getBranch();
		const records = branch.filter((entry) => entry.type === "custom" && entry.customType === MANUAL_COMPACT_ENTRY_TYPE);
		if (scenario === "excluded-notes") {
			assert.equal(records.length, 0); assert.equal(requests.length, 0);
		} else {
		assert(records.length > 0, "no durable handoff record");
		assert.equal((records.at(-1) as { data: { phase: string } }).data.phase, userSelection ? "superseded" : incomplete || refused ? "failed" : "completed");
		if (!incomplete && !userSelection && !refused) {
			const requestIndex = branch.indexOf(records[0]);
			const noteIndex = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId.startsWith("checkpoint-write"));
			const markerIndex = branch.findIndex((entry) => entry.id === markers()[1].id);
			assert(requestIndex < noteIndex && noteIndex < markerIndex, JSON.stringify({ requestIndex, noteIndex, markerIndex }));
		}
		}
		if (scenario === "repeat-compact") {
			const before = requests.length;
			await assert.rejects(session.compact("Do not bypass cooldown"), /cancelled/);
			assert.equal(requests.length, before); assert.equal(markers().length, 2);
		}
		if (scenario === "queues") {
			const first = requests.find((request) => request.switched)!.input;
			assert(first.indexOf("QUEUED-USER-REQUEST-1") < first.indexOf("QUEUED-USER-REQUEST-2"));
			assert(requests.at(-1)!.input.includes("QUEUED-USER-REQUEST-3"));
		}
		const disk = await readFile(sm.getSessionFile()!, "utf8");
		if (scenario !== "excluded-notes") assert(disk.includes(MANUAL_COMPACT_ENTRY_TYPE));
		assert(!disk.includes("synthetic-managed-key"));
		env.assertNoNetwork();
		process.stdout.write("OK\n");
	} finally { session.dispose(); }
} finally { await env.dispose(); }
