import assert from "node:assert/strict";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
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
	const [mode, scenario, sameContentArg] = process.argv.slice(2);
	assert(mode === "idle" || mode === "steer" || mode === "followUp");
	assert(scenario === "fresh" || scenario === "queued-active" || scenario === "continuation");
	const sameContent = sameContentArg === "same";
	const promptA = "Request A";
	const promptB = sameContent ? promptA : "Separate request B";
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
	let executions = 0;
	const events: string[] = [];
	const autoMode = {
		...DEFAULT_AUTO_MODE_CONFIG,
		models: [`${model.provider}/${model.id}`], reviewerModel: `${model.provider}/${model.id}`,
		gate: "all" as const, evidenceTools: false,
		classifier: { ...DEFAULT_AUTO_MODE_CONFIG.classifier, enabled: false },
		circuitBreaker: { consecutiveDenials: 2, recentDenials: 0, windowSize: 50 },
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: env.cwd, agentDir: env.agentDir, settingsManager,
		noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		extensionFactories: [(pi) => {
			registerAutoModeExtension(pi, (() => ({ config: { ...DEFAULT_TOOLKIT_CONFIG, autoMode }, warnings: [] })) as never, async () => {
				reviews++;
				assert(reviews <= 3, "Unexpected extra model continuation");
				events.push(`review:${reviews}:user:${deliveredUsers}`);
				const queueAt = scenario === "queued-active" ? 2 : 1;
				if (mode !== "idle" && scenario !== "continuation" && reviews === queueAt) {
					// Queue while the current review is open. In queued-active, A already has one denial.
					if (sameContent) await session.prompt(promptB, { streamingBehavior: mode });
					else await session[mode](promptB);
					assert.equal(deliveredUsers, 1, "Enqueue must not deliver B yet");
					events.push("queued:B");
				}
				return {
					kind: "deny", verdict: { outcome: "deny", riskLevel: "high", userAuthorization: "low", rationale: "Synthetic denial" },
					reviewerModel: `${model.provider}/${model.id}`, evidenceRounds: 0,
				};
			}, () => ({ supported: true, setTheme() {}, setState() {}, clear() {} }));
			pi.on("before_agent_start", () => { events.push("before_agent_start"); });
			pi.on("message_start", (event) => {
				if (event.message.role === "user") events.push(`delivered:${++deliveredUsers}`);
			});
			pi.on("turn_end", () => { events.push("turn_end"); });
			pi.registerTool({
				name: "probe", label: "Probe", description: "Synthetic denied tool", parameters: Type.Object({}),
				execute: async () => { executions++; throw new Error("Denied tool must never execute"); },
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
		if (scenario === "continuation") {
			faux.setResponses([call("a1"), call("a2"), fauxAssistantMessage("Must not reach this response")]);
			await session.prompt(promptA);
		} else if (scenario === "queued-active") {
			faux.setResponses([call("a1"), call("a2"), call("b1"), fauxAssistantMessage("B can continue")]);
			await session.prompt(promptA);
		} else if (mode === "idle") {
			faux.setResponses([call("a1"), fauxAssistantMessage("A done")]);
			await session.prompt(promptA);
			faux.setResponses([call("b1"), fauxAssistantMessage("B can continue")]);
			await session.prompt(promptB);
		} else {
			faux.setResponses(mode === "followUp"
				? [call("a1"), fauxAssistantMessage("A done"), call("b1"), fauxAssistantMessage("B can continue")]
				: [call("a1"), call("b1"), fauxAssistantMessage("B can continue")]);
			await session.prompt(promptA);
		}
		assert.deepEqual(errors, []);
		const decisions = sm.getEntries().flatMap((entry) => entry.type === "custom" && entry.customType === AUTO_MODE_ENTRY_TYPE
			? [entry.data as { toolCallId: string; decision: string }] : []);
		assert.deepEqual(decisions.filter((d) => d.decision === "turn-interrupted").map((d) => d.toolCallId),
			scenario === "fresh" ? [] : ["a2"], JSON.stringify({ decisions, events }));
		assert.equal(executions, 0);
		assert.equal(reviews, scenario === "queued-active" ? 3 : 2);
		assert.equal(deliveredUsers, scenario === "continuation" ? 1 : 2);
		assert.equal(events.filter((e) => e === "before_agent_start").length, mode === "idle" && scenario === "fresh" ? 2 : 1);
		assert.equal(faux.state.callCount, scenario === "continuation" ? 2 : scenario === "queued-active" || mode !== "steer" ? 4 : 3);
		if (scenario !== "continuation") {
			const last = session.messages.at(-1);
			assert(last?.role === "assistant" && last.stopReason === "stop", JSON.stringify(last));
			assert.deepEqual(last.content, [{ type: "text", text: "B can continue" }]);
			assert(events.includes(`review:${reviews}:user:2`), JSON.stringify(events));
			if (mode !== "idle") assert(events.indexOf("queued:B") < events.indexOf("delivered:2"));
		} else {
			assert.equal(session.messages.at(-1)?.role, "toolResult");
		}
		env.assertNoNetwork();
	} finally {
		session.dispose();
	}
	process.stdout.write("OK\n");
} finally {
	await env.dispose();
}
