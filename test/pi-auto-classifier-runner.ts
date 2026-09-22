import assert from "node:assert/strict";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const env = await createSmokeEnvironment();
try {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } = await import("@earendil-works/pi-ai");
	const { Type } = await import("typebox");
	const { registerAutoModeExtension } = await import("../src/auto-mode/extension");
	const { CONFIG_PATH } = await import("../src/config");
	const { DEFAULT_AUTO_MODE_CONFIG, DEFAULT_TOOLKIT_CONFIG } = await import("../src/types");
	const { AUTO_MODE_ENTRY_TYPE } = await import("../src/auto-mode/types");
	assert.equal(CONFIG_PATH, join(env.agentDir, "extensions/pi-openai-toolkit/config.json"));
	const mode = process.argv[2];
	assert(mode === "steer" || mode === "followUp");
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null,
		refreshOnCreate: false, allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "faux", api: "faux" });
	modelRuntime.registerNativeProvider(faux.provider);
	const model = faux.getModel();
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }, { projectTrusted: true });
	const sm = SessionManager.inMemory(env.cwd);
	let session: AgentSession;
	let reviews = 0;
	let deliveredUsers = 0;
	const executed: string[] = [];
	const samples: Array<{ signal: AbortSignal; resolve: (message: AssistantMessage) => void }> = [];
	const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
	const autoMode = {
		...DEFAULT_AUTO_MODE_CONFIG,
		models: [`${model.provider}/${model.id}`], reviewerModel: `${model.provider}/${model.id}`,
		gate: "all" as const, evidenceTools: false,
		classifier: { ...DEFAULT_AUTO_MODE_CONFIG.classifier, enabled: true, maxLag: 2 },
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: env.cwd, agentDir: env.agentDir, settingsManager,
		noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		extensionFactories: [(pi) => {
			registerAutoModeExtension(pi, (() => ({ config: { ...DEFAULT_TOOLKIT_CONFIG, autoMode }, warnings: [] })) as never, async () => {
				reviews++;
				return {
					kind: "allow", verdict: { outcome: "allow", riskLevel: "low", userAuthorization: "high", rationale: "Synthetic allow" },
					reviewerModel: `${model.provider}/${model.id}`, evidenceRounds: 0,
				};
			}, () => ({ supported: true, setTheme() {}, setState() {}, clear() {} }));
			pi.on("session_start", (_event, ctx) => {
				// Only classifier completions use this seam. Main responses still use Pi's faux provider.
				// Deliberately ignore abort so obsolete settlement overlaps a newer sample.
				ctx.modelRegistry.complete = async (_model, _context, options) => new Promise<AssistantMessage>((resolve) => {
					assert(options?.signal);
					samples.push({ signal: options.signal, resolve });
				});
			});
			pi.on("message_start", (event) => {
				if (event.message.role !== "user") return;
				deliveredUsers++;
				if (deliveredUsers === 2) {
					assert.equal(samples.length, 1);
					assert(samples[0].signal.aborted, "Delivery must invalidate A before B's model call");
				}
			});
			pi.on("tool_result", async (event) => {
				if (event.toolCallId !== "a1") return;
				assert.equal(samples.length, 1);
				await session.prompt("Same user request text", { streamingBehavior: mode });
				assert.equal(deliveredUsers, 1);
				assert(!samples[0].signal.aborted, "Enqueue must preserve A's live classification");
			});
			pi.registerTool({
				name: "probe", label: "Probe", description: "No-op fixture tool", parameters: Type.Object({}),
				execute: async (id) => { executed.push(id); return { content: [{ type: "text", text: "OK" }], details: {} }; },
			});
		}],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	({ session } = await createAgentSession({
		cwd: env.cwd, agentDir: env.agentDir, modelRuntime, model, settingsManager, resourceLoader,
		sessionManager: sm, tools: ["probe"],
	}));
	const errors: string[] = [];
	try {
		await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error.error); } });
		await session.prompt("/auto on");
		const call = (id: string) => fauxAssistantMessage(fauxToolCall("probe", {}, { id }), { stopReason: "toolUse" });
		faux.setResponses([
			call("a1"),
			...(mode === "followUp" ? [fauxAssistantMessage("A done")] : []),
			call("b1"),
			async () => {
				assert.equal(deliveredUsers, 2);
				assert.equal(samples.length, 2, "B must start its own sample while A remains unresolved");
				assert(!samples[1].signal.aborted);
				samples[0].resolve(fauxAssistantMessage("low"));
				await flush();
				return call("b2");
			},
			async () => {
				assert.equal(reviews, 3, "A's late low score must not approve B's next tool");
				assert.equal(samples.length, 2, "A's settlement must not clear B's in-flight slot");
				samples[1].resolve(fauxAssistantMessage("low"));
				await flush();
				return call("b3");
			},
			fauxAssistantMessage("Done"),
		]);
		await session.prompt("Same user request text");
		assert.deepEqual(errors, []);
		assert.equal(deliveredUsers, 2);
		assert.equal(reviews, 3);
		assert.deepEqual(executed, ["a1", "b1", "b2", "b3"]);
		const decisions = sm.getEntries().flatMap((entry) => entry.type === "custom" && entry.customType === AUTO_MODE_ENTRY_TYPE
			? [entry.data as { toolCallId: string; source: string }] : []);
		assert.deepEqual(decisions.map((d) => [d.toolCallId, d.source]), [
			["a1", "reviewer"], ["b1", "reviewer"], ["b2", "reviewer"], ["b3", "classifier"],
		]);
		const last = session.messages.at(-1);
		assert(last?.role === "assistant" && last.stopReason === "stop");
		env.assertNoNetwork();
	} finally {
		// Settle the final sample too, so its timeout/listeners are cleaned up.
		for (const sample of samples) sample.resolve(fauxAssistantMessage("high"));
		await flush();
		session.dispose();
	}
	process.stdout.write("OK\n");
} finally {
	await env.dispose();
}
