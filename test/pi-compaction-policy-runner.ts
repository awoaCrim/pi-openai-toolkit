import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const env = await createSmokeEnvironment();
const mode = process.argv[2] ?? "remote-compaction";
const scenario = process.argv[3] ?? "remote";
const source = process.argv[4] ?? "legacy";
const native = process.argv[5] === "native";
const official = process.argv[5] === "official";
assert(["remote-compaction", "pi"].includes(mode));
const automatic = scenario === "threshold" || scenario === "overflow";
const remoteEnabled = mode === "remote-compaction" && ["remote", "remote-same-model", "remote-unset-model", "remote-failure", "abort", "owning-remote", "standalone"].includes(scenario);
const remoteSuccess = remoteEnabled && ["remote", "remote-same-model", "remote-unset-model", "owning-remote", "standalone"].includes(scenario);
const producer = ["remote-same-model", "remote-unset-model"].includes(scenario) ? "consumer" : "producer";
const failedCompression = scenario === "abort" || scenario === "summary-failure";
const ownsCheckpoint = scenario.startsWith("owning-");
const owningOpaque = "CURRENT-OWNED-OPAQUE";
const expectedModel = mode !== "remote-compaction" || ["default", "disabled", "same-model"].includes(scenario)
	? "consumer" : scenario === "remote-failure" ? "producer" : "summary";
const provider = native ? "openai-codex" : "policy-fixture";
const baseUrl = official ? "https://api.openai.com/v1" : native ? "https://compact-policy.invalid/backend-api" : "https://compact-policy.invalid/v1";
const initial = "INITIAL-ORDINARY-HISTORY";
const current = "CURRENT-ORDINARY-HISTORY";
const compacted = "ORDINARY-COMPRESSED";
let streamId = 0;
function response(output: Array<Record<string, unknown>>) {
	const id = `policy-${++streamId}`;
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
function textResponse(text: string) {
	return response([{ type: "message", id: `msg-${streamId + 1}`, role: "assistant", status: "completed",
		content: [{ type: "output_text", text, annotations: [] }] }]);
}

try {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
	const { createNativeCompactionDetails, createNativeCompactionResult, getRemoteV2InputProvenance } = await import("../src/types");
	const configDir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(configDir, { recursive: true });
	const configPath = join(configDir, "config.json");
	const policy = {
		schemaVersion: 2,
		defaults: { context: { mode, remoteCompaction: {
			model: scenario === "remote-unset-model" ? null : `${provider}/${producer}`, inputSource: source, apis: remoteEnabled ? ["openai-responses", "openai-codex-responses"] : [],
		}, nativeFallback: { enabled: scenario !== "disabled", model: scenario === "default" ? null
			: `${provider}/${scenario === "same-model" ? "consumer" : "summary"}` } } },
		models: Object.fromEntries(["consumer", "producer", "summary"].map((id) => [`${provider}/${id}`,
			native || official ? {} : { compatibility: { transport: "codex-gateway" } }])),
	};
	await writeFile(configPath, JSON.stringify(policy));
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const apiKey = native ? `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "policy-account" } })).toString("base64url")}.signature`
		: "synthetic-policy-key";
	runtime.registerProvider(provider, { api: native ? "openai-codex-responses" : "openai-responses", apiKey, baseUrl,
		models: ["consumer", "producer", "summary"].map((id) => ({ id, name: id, reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 2048 })) });
	const consumer = runtime.getModel(provider, "consumer")!;
	const sm = SessionManager.create(env.cwd, join(env.cwd, "sessions"));
	const settings = SettingsManager.inMemory({ transport: "sse", cacheWarming: "off",
		retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false, keepRecentTokens: 128,
			reserveTokens: scenario === "threshold" ? 60000 : 2048 } }, { projectTrusted: true });
	let session: AgentSession;
	let phase: "seed" | "compact" | "continued" = "seed";
	let remoteCalls = 0, summaryCalls = 0, consumerCalls = 0, hookProjections = 0, standaloneCalls = 0;
	let overflowSent = false;
	let failure: unknown;
	const errors: string[] = [];
	const requests: Array<{ kind: string; model: unknown; input: string }> = [];
	const compactReasons: string[] = [];
	const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings,
		additionalExtensionPaths: [resolve(import.meta.dir, "../src/extension-runtime.ts")],
		noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		systemPromptOverride: () => "POLICY-SYSTEM-HEAD",
		extensionFactories: [(pi) => {
			pi.on("context", (event) => {
				if (phase !== "compact") return;
				hookProjections++;
				return { messages: [...event.messages, { role: "user", content: "ORDERED-COMPACT-HOOK", timestamp: 1000 }] };
			});
		}],
	});
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		try {
			const request = new Request(input, init);
			const standalone = request.url === `${baseUrl}/responses/compact`;
			if (request.method !== "POST" || (!standalone && request.url !== `${baseUrl}${native ? "/codex" : ""}/responses`)) return deniedFetch(input, init);
			const bytes = Buffer.from(await request.arrayBuffer());
			const body = JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8")) as Record<string, unknown>;
			const items = body.input as Array<Record<string, unknown>>;
			const serialized = JSON.stringify(body);
			const synthetic = items.at(-1)?.type === "compaction_trigger";
			const summary = !synthetic && (serialized.includes("<conversation>") || (serialized.includes("# Instructions") && serialized.includes("# Conversation")));
			requests.push({ kind: synthetic ? "remote" : summary ? "summary" : "consumer", model: body.model, input: serialized });
			assert(!serialized.includes("codex-context-window"), "ordinary session emitted a window marker");
			assert(!serialized.includes("new_context") && !serialized.includes("get_context_remaining"), "ordinary session published removed tools");
			assert.equal(request.headers.get("x-codex-window-id"), null);
			// Codex/gateway affinity is not an official API-key header contract.
			if (synthetic || standalone) assert.equal(request.headers.get("session-id"), official ? null : sm.getSessionId());
			if (standalone) {
				standaloneCalls++;
				assert(official && scenario === "standalone");
				assert.equal(body.model, "producer");
				assert(serialized.includes(current));
				assert.equal(body.tools, undefined);
				assert(!synthetic);
				return Response.json({ output: [{ type: "compaction", encrypted_content: "policy-opaque" }] });
			}
			if (synthetic || summary) {
				assert.equal(session!.model?.id, "consumer", "compactor changed active selection");

				if (synthetic) {
					remoteCalls++;
					assert(remoteEnabled, "wrong mode selected Toolkit Remote V2");
					assert.equal(body.model, producer);
					assert(serialized.includes(current));
					if (scenario === "owning-remote") {
						assert(serialized.includes(owningOpaque), "current owning checkpoint was omitted");
						assert(!serialized.includes(`${current}-0 `), "covered retained history was duplicated beside opaque checkpoint");
					}
					assert.equal(serialized.includes("ORDERED-COMPACT-HOOK"), source === "pi-context-hook");
					if (scenario === "standalone") return Response.json({ error: { code: "unsupported_parameter", message: "compaction_trigger is unsupported" } }, { status: 400 });
					if (scenario === "remote-failure") return Response.json({ error: { code: "server_error" } }, { status: 500 });
					if (scenario === "abort") { session!.abortCompaction(); throw new DOMException("aborted", "AbortError"); }
					return response([{ type: "compaction", encrypted_content: scenario === "invalid-output" ? "" : "policy-opaque" }]);
				}
				summaryCalls++;
				assert.equal(body.model, expectedModel, "native summary used wrong reason-dependent model");
				assert(!serialized.includes("Pi Codex context-window boundary"));
				if (scenario === "owning-native") assert(serialized.includes("CURRENT-OWNED-NATIVE-SUMMARY"));
				if (scenario === "summary-failure") return Response.json({ error: { code: "server_error" } }, { status: 500 });
				return textResponse(compacted);
			}
			consumerCalls++;
			assert.equal(body.model, "consumer");
			if (phase === "compact" && scenario === "overflow" && !overflowSent) {
				overflowSent = true;
				return Response.json({ error: { code: "context_length_exceeded", type: "invalid_request_error", message: "maximum context length exceeded" } }, { status: 400 });
			}
			if (phase === "continued" || (automatic && summaryCalls > 0)) {
				const disk = (await readFile(sm.getSessionFile()!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
				const saved = disk.filter((entry) => entry.type === "compaction").at(-1);
				assert(saved && saved.summary !== "[Pi Codex context-window boundary; no conversation summary was generated.]", "consumer preceded durable real compression");
				assert(serialized.includes(remoteSuccess ? "policy-opaque" : compacted), "consumer did not receive new compressed context");
				assert(serialized.length < 15000, "automatic recovery did not reduce current context");
			}
			return textResponse("POLICY-ANSWER");
		} catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) failure ??= error; throw error; }
	}) as typeof fetch;
	try {
		await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model: consumer,
			settingsManager: settings, resourceLoader: loader, sessionManager: sm,
			tools: ["read"] }));
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
		assert.deepEqual(session.getActiveToolNames(), ["read"]);
		await session.prompt(`${initial} ${"ordinary work ".repeat(500)}`);
		if (failure) throw failure;
		const boundary = sm.appendMessage({ role: "user", content: "CURRENT-WORK-BOUNDARY", timestamp: 2 });
		for (let i = 0; i < 12; i++) {
			sm.appendMessage({ role: "user", content: `${current}-${i} ${"current work ".repeat(200)}`, timestamp: 10 + 2 * i });
			sm.appendMessage({ ...fauxAssistantMessage(`current answer ${i}`), provider, api: consumer.api, model: consumer.id });
			if (ownsCheckpoint && i === 5) {
				if (scenario === "owning-native") sm.appendCompaction("CURRENT-OWNED-NATIVE-SUMMARY", boundary, 100, { readFiles: ["CURRENT-OWNED-PATH"], modifiedFiles: [] });
				else {
					const checkpoint = createNativeCompactionResult({ firstKeptEntryId: boundary, tokensBefore: 100,
						details: createNativeCompactionDetails({ provider, api: consumer.api, model: consumer.id, baseUrl,
							inputProvenance: getRemoteV2InputProvenance(source === "legacy" ? "legacy" : "pi-context-hook"),
							compactedWindow: [{ type: "compaction", encrypted_content: owningOpaque }] }) });
					sm.appendCompaction(checkpoint.summary, checkpoint.firstKeptEntryId, checkpoint.tokensBefore, checkpoint.details, true);
				}
			}
		}
		policy.defaults.context.mode = mode;
		await writeFile(configPath, JSON.stringify(policy));
		session.refreshContext();
		const before = structuredClone(sm.getBranch());
		const originalSessionId = sm.getSessionId();
		phase = "compact";
		session.subscribe((event) => { if (event.type === "compaction_end" && event.result) compactReasons.push(event.reason); });
		if (automatic) {
			session.setAutoCompactionEnabled(true);
			await session.prompt("Continue the real current task");
		} else if (failedCompression) {
			await assert.rejects(session.compact("Preserve the current task"), /cancelled|failed/i);
		} else await session.compact("Preserve the current task").catch((error) => { throw failure ?? error; });
		if (failure) throw failure;
		assert.deepEqual(errors, []);
		if (failedCompression) {
			assert.deepEqual(sm.getBranch(), before, "failed compression persisted a checkpoint");
		} else {
			const saved = sm.getBranch().filter((entry) => entry.type === "compaction").at(-1)!;
			assert.notEqual(saved.summary, "[Pi Codex context-window boundary; no conversation summary was generated.]");
			assert(saved.summary.includes(remoteSuccess ? "opaque" : compacted));
			assert(before.some((entry) => entry.id === saved.firstKeptEntryId), "compactor fabricated a retained source ID");
			if (remoteSuccess) {
				assert.equal(saved.details?.strategy, scenario === "standalone" ? "openai-native-compact-v1" : "openai-remote-compaction-v2");
				assert.equal(saved.details?.model, "consumer");
			}
			const reopened = SessionManager.open(sm.getSessionFile()!);
			assert.deepEqual(reopened.getBranch().findLast((entry) => entry.type === "compaction")?.details, JSON.parse(JSON.stringify(saved.details)));
			assert.equal(remoteCalls, remoteEnabled ? 1 : 0);
			assert.equal(summaryCalls > 0, !remoteSuccess);
			assert.equal(standaloneCalls, scenario === "standalone" ? 1 : 0);
			if (automatic) assert(compactReasons.includes(scenario), "native scheduler did not perform expected compaction");
			if (!automatic) {
				const calls = consumerCalls;
				await new Promise((done) => setTimeout(done, 100));
				assert.equal(consumerCalls, calls, "manual compact started a synthetic continuation");
				await assert.rejects(session.compact(), /already compacted/i);
				phase = "continued";
				await session.prompt("Legitimate next user request");
			} else {
				assert.equal(session.messages.at(-1)?.role, "assistant");
				assert(JSON.stringify(session.messages.at(-1)).includes("POLICY-ANSWER"));
			}
		}
		if (failure) throw failure;
		assert.equal(session.model?.id, "consumer");
		assert.equal(sm.getSessionId(), originalSessionId);
		assert(!sm.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === "codex-context-window"));
		assert(!sm.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi-openai-toolkit:manual-compact"));
		for (const entry of before) assert.deepEqual(sm.getEntry(entry.id), entry, "compression rewrote raw history");
		if (remoteSuccess && source === "pi-context-hook") assert.equal(hookProjections, 1);
		env.assertNoNetwork();
		process.stdout.write("OK\n");
	} finally { session!.dispose(); }
} finally { await env.dispose(); }
