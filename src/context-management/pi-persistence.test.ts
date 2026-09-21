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

for (const callback of ["absent", "before-sync", "after-sync"] as const) {
	for (const syncBeforeNavigation of [false, true]) {
		test(`pending trim follows Pi branches (callback=${callback}, sync before navigation=${syncBeforeNavigation})`, () => {
			const sm = SessionManager.inMemory("/synthetic-project");
			const sessionId = sm.getSessionId();
			sm.appendMessage({ role: "user", content: "old task", timestamp: Date.now() });
			const markerId = sm.appendCustomMessageEntry(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, "rollover", true, {
				protocol: 1, id: "marker", sessionId,
				contextManagement: {
					protocol: 1, kind: "window", firstWindowId: "w1", currentWindowId: "w2",
					windowNumber: 1, trimPreviousWindow: true,
				},
			});
			// Pi tree navigation can select this assistant while retaining the marker.
			const beforeCommit = sm.appendMessage(fauxAssistantMessage("work after rollover"));
			const manager = new CodexContextWindowManager();
			const ctx = { sessionManager: sm };
			const event = () => ({
				type: "session_before_compact", reason: "manual", branchEntries: sm.getBranch(),
				preparation: { firstKeptEntryId: markerId, tokensBefore: 100 },
			}) as never;
			manager.synchronize(ctx);
			const proposal = manager.prepareCompaction(event());
			if (!("compaction" in proposal)) throw new Error("Expected trim proposal");
			// Cancellation after preparation must retain the same proposal.
			manager.synchronize(ctx);
			expect(manager.hasPendingTrim()).toBe(true);
			expect(manager.prepareCompaction(event())).toEqual(proposal);
			const { summary, firstKeptEntryId, tokensBefore, details } = proposal.compaction;
			const compactId = sm.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, true);
			if (callback === "before-sync") {
				manager.recordCompaction(details);
				expect(manager.hasPendingTrim()).toBe(false);
			}
			if (callback === "after-sync" || syncBeforeNavigation) {
				manager.synchronize(ctx);
				expect(manager.hasPendingTrim()).toBe(false);
				expect(manager.prepareCompaction(event())).toEqual({ cancel: true });
			}
			if (callback === "after-sync") manager.recordCompaction(details);
			sm.branch(beforeCommit);
			manager.synchronize(ctx);
			expect(manager.hasPendingTrim()).toBe(true);
			expect(manager.prepareCompaction(event())).toEqual(proposal);
			// A cancelled retry on the older branch remains retryable too.
			manager.synchronize(ctx);
			expect(manager.prepareCompaction(event())).toEqual(proposal);
			sm.branch(compactId);
			manager.synchronize(ctx);
			expect(manager.hasPendingTrim()).toBe(false);
			expect(manager.prepareCompaction(event())).toEqual({ cancel: true });
			manager.synchronize(ctx);
			expect(manager.hasPendingTrim()).toBe(false);

			// An unrelated compaction on a sibling branch is not an acknowledgment.
			sm.branch(beforeCommit);
			const unrelatedDetails = { ...details, windowId: "other-window" };
			const siblingId = sm.appendCompaction("other trim", markerId, tokensBefore, unrelatedDetails, true);
			manager.synchronize(ctx);
			manager.recordCompaction(unrelatedDetails);
			expect(manager.hasPendingTrim()).toBe(true);
			expect(manager.prepareCompaction(event())).toEqual(proposal);
			sm.branch(compactId);
			manager.synchronize(ctx);
			expect(manager.hasPendingTrim()).toBe(false);
			sm.branch(siblingId);
			manager.synchronize(ctx);
			expect(manager.hasPendingTrim()).toBe(true);
		});
	}
}

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
		const rolloverContent = markers[1]?.type === "custom_message" ? String(markers[1].content) : "";
		expect(rolloverContent).toContain("Context switch completed");
		expect(rolloverContent).toContain("resume the active user task");
		expect(rolloverContent).toContain("Do not immediately create another checkpoint or call new_context");
	} finally {
		session?.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
});
