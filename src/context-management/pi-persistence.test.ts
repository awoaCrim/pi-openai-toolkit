import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	Type,
} from "@earendil-works/pi-ai";
import { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE } from "./messages";
import { createContextManagementTools } from "./tools";
import { CodexContextWindowManager } from "./window-manager";

test("Pi 0.85.1 persists a sequential notes result before new_context and deduplicates rollover", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-context-checkpoint-"));
	let session: AgentSession | undefined;
	try {
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("notes", { action: "write_file", path: "/checkpoint.md", text: "state" }, { id: "notes-call" }),
				fauxToolCall("new_context", {}, { id: "new-context-call-1" }),
				fauxToolCall("new_context", {}, { id: "new-context-call-2" }),
			]),
			fauxAssistantMessage("done"),
		]);
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory(
			{ retry: { enabled: false }, compaction: { enabled: false } },
			{ projectTrusted: true },
		);
		const sessionManager = SessionManager.inMemory(cwd);
		const sessionId = sessionManager.getSessionId();
		sessionManager.appendCustomMessageEntry(
			CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
			"seed",
			true,
			{
				protocol: 1,
				id: "seed",
				sessionId,
				contextManagement: {
					protocol: 1,
					kind: "window",
					firstWindowId: "w1",
					currentWindowId: "w1",
					windowNumber: 0,
				},
			},
		);
		const manager = new CodexContextWindowManager(async () => undefined);
		const gateObservations: boolean[] = [];
		const notes = defineTool({
			name: "notes",
			label: "notes",
			description: "Persist a checkpoint.",
			parameters: Type.Object({
				action: Type.String(),
				path: Type.String(),
				text: Type.Optional(Type.String()),
			}),
			executionMode: "sequential",
			execute: async () => ({
				content: [{ type: "text" as const, text: "done" }],
				details: { codexHistoryNotes: { output: "done" } },
			}),
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			noThemes: true,
			extensionFactories: [
				(pi) => {
					const contextTools = createContextManagementTools(pi, manager, () => true);
					pi.registerTool(contextTools.newContext);
					pi.on("session_start", (_event, ctx) => manager.ensureInitialized(pi, ctx, true));
				},
			],
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager,
			model: faux.getModel(),
			tools: ["notes", "new_context"],
			customTools: [notes],
		});
		session = created.session;
		session.subscribe((event) => {
			if (event.type !== "tool_execution_start" || event.toolName !== "new_context") return;
			gateObservations.push(sessionManager.getBranch().some((entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "notes" &&
				entry.message.isError === false,
			));
		});

		await session.prompt("checkpoint and roll over");

		const branch = sessionManager.getBranch();
		const newContextResults = branch.filter((entry): entry is Extract<SessionEntry, { type: "message" }> =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "new_context",
		);
		const markers = branch.filter((entry) =>
			entry.type === "custom_message" && entry.customType === CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
		);
		expect(gateObservations).toEqual([true, true]);
		expect(newContextResults.map((entry) => entry.message.details)).toEqual([
			{ started: true },
			{ started: false },
		]);
		expect(markers).toHaveLength(2);
		expect(markers[1]?.type === "custom_message" ? markers[1].details.contextManagement.windowNumber : undefined).toBe(1);
	} finally {
		session?.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
});
