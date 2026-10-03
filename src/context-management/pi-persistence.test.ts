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
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { createNativeCompactionDetails, LEGACY_REMOTE_V2_INPUT_PROVENANCE } from "../types";

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
				manager.synchronize(ctx);
				expect(manager.hasPendingTrim()).toBe(false);
			}
			if (callback === "after-sync" || syncBeforeNavigation) {
				manager.synchronize(ctx);
				expect(manager.hasPendingTrim()).toBe(false);
				expect(manager.prepareCompaction(event())).toEqual({ cancel: true });
			}
			if (callback === "after-sync") manager.synchronize(ctx);
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

			// Any newer compaction on this sibling owns its summary, even without
			// a matching cleanup acknowledgment. It must never be replaced.
			sm.branch(beforeCommit);
			const unrelatedDetails = { ...details, windowId: "other-window" };
			const siblingId = sm.appendCompaction("other trim", markerId, tokensBefore, unrelatedDetails, true);
			manager.synchronize(ctx);
			expect(manager.hasPendingTrim()).toBe(false);
			expect(manager.prepareCompaction(event())).toEqual({ cancel: true });
			expect(manager.prepareDetachedCompaction(event())).toBeUndefined();
			sm.branch(compactId);
			manager.synchronize(ctx);
			expect(manager.hasPendingTrim()).toBe(false);
			sm.branch(siblingId);
			manager.synchronize(ctx);
			expect(manager.hasPendingTrim()).toBe(false);
		});
	}
}

function appendWindow(sm: SessionManager, id = "w2", trimPreviousWindow = true): string {
	return sm.appendCustomMessageEntry(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, "window", true, {
		protocol: 1, id: `marker-${id}`, sessionId: sm.getSessionId(),
		contextManagement: { protocol: 1, kind: "window", firstWindowId: "w1", currentWindowId: id,
			windowNumber: 1, trimPreviousWindow },
	});
}

for (const opaque of [false, true]) {
	for (const retention of ["marker", "recent", "none"] as const) {
		test(`newer ${opaque ? "opaque" : "native"} projection supersedes historical trim (${retention})`, () => {
			const sm = SessionManager.inMemory("/synthetic-project");
			sm.appendMessage({ role: "user", content: "retired-before-window", timestamp: 1 });
			const marker = appendWindow(sm);
			sm.appendMessage({ role: "user", content: "retired-inside-window", timestamp: 2 });
			const recent = sm.appendMessage({ role: "user", content: "recent", timestamp: 3 });
			const details = opaque ? createNativeCompactionDetails({
				provider: "openai", api: "openai-responses", model: "test", baseUrl: "https://example.test/v1",
				inputProvenance: LEGACY_REMOTE_V2_INPUT_PROVENANCE,
				compactedWindow: [{ type: "compaction", encrypted_content: "opaque-checkpoint" }],
			}) : undefined;
			const checkpoint = sm.appendCompaction("newer summary must survive", retention === "marker" ? marker : recent, 100, details);
			// Canonical retain-none convention: the checkpoint's own source ID.
			const entries = sm.getBranch().map((entry) => entry.id === checkpoint && entry.type === "compaction" && retention === "none"
				? { ...entry, firstKeptEntryId: checkpoint } : entry);
			const manager = new CodexContextWindowManager();
			manager.restore(entries, sm.getSessionId());
			const identity = manager.currentIdentity();
			const messages = buildSessionProjection(entries).messages;
			expect(manager.hasPendingTrim()).toBe(false);
			expect(manager.hasEffectiveWindow()).toBe(false);
			const event = { branchEntries: entries, preparation: { firstKeptEntryId: recent, tokensBefore: 100 } } as never;
			expect(manager.prepareCompaction(event)).toEqual({ cancel: true });
			expect(manager.prepareDetachedCompaction(event)).toBeUndefined();
			expect(manager.project(messages, "remote")).toEqual(messages);
			const local = manager.project(messages, "local");
			expect(local[0]?.role).toBe("compactionSummary");
			expect(JSON.stringify(local)).toContain("newer summary must survive");
			expect(JSON.stringify(local)).not.toContain("retired-before-window");
			expect(manager.currentIdentity()).toEqual(identity);
			const reloaded = new CodexContextWindowManager();
			reloaded.restore(entries, sm.getSessionId());
			expect(reloaded.prepareCompaction(event)).toEqual({ cancel: true });
			expect(reloaded.project(messages, "remote")).toEqual(messages);
		});
	}
}

for (const replacement of [null, { content: "edited boundary" }]) {
	test(`canonical boundary edit fails closed and rewind restores eligibility (${replacement === null ? "omit" : "replace"})`, () => {
		const sm = SessionManager.inMemory("/synthetic-project");
		sm.appendMessage({ role: "user", content: "old", timestamp: 1 });
		const marker = appendWindow(sm);
		const beforeEdit = sm.appendMessage({ role: "user", content: "current", timestamp: 2 });
		const manager = new CodexContextWindowManager();
		const ctx = { sessionManager: sm };
		manager.synchronize(ctx);
		const event = () => ({ branchEntries: sm.getBranch(), preparation: { tokensBefore: 100 } }) as never;
		expect(manager.hasPendingTrim()).toBe(true);
		sm.appendContextEdit(marker, replacement);
		manager.synchronize(ctx); // Same marker/compaction IDs, different canonical context.
		expect(manager.prepareCompaction(event())).toEqual({ cancel: true });
		expect(() => manager.prepareDetachedCompaction(event())).toThrow("missing or edited");
		for (const mode of ["remote", "local"] as const) {
			expect(() => manager.project(sm.buildSessionProjection().messages, mode)).toThrow("missing or edited");
		}
		sm.branch(beforeEdit);
		manager.synchronize(ctx);
		expect(manager.hasPendingTrim()).toBe(true);
		expect(manager.prepareCompaction(event())).toHaveProperty("compaction");
	});
}

test("explicit new_context after supersession creates a real later boundary without losing identity or notes gate", async () => {
	const sm = SessionManager.inMemory("/synthetic-project");
	sm.appendMessage({ role: "user", content: "old", timestamp: 1 });
	appendWindow(sm);
	const recent = sm.appendMessage({ role: "user", content: "recent", timestamp: 2 });
	sm.appendCompaction("preserve until explicit rollover", recent, 100);
	sm.appendMessage(fauxAssistantMessage([fauxToolCall("notes", { action: "write_file", path: "/checkpoint.md" }, { id: "notes" })]));
	sm.appendMessage({ role: "toolResult", toolCallId: "notes", toolName: "notes", isError: false,
		content: [{ type: "text", text: "done" }], details: { codexHistoryNotes: { output: "done" } }, timestamp: 3 });
	const manager = new CodexContextWindowManager(async () => undefined);
	const ctx = { sessionManager: sm, model: { contextWindow: 100_000 }, getContextUsage: () => undefined } as never;
	manager.synchronize(ctx);
	expect(manager.hasNotesCheckpointSinceBoundary(ctx)).toBe(true);
	const sent: Array<{ content: string; details: unknown }> = [];
	const pi = { sendMessage: (message: { content: string; details: unknown }) => sent.push(message) } as never;
	expect(await manager.startNewWindow(pi, ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(true);
	expect(manager.currentIdentity()?.previousWindowId).toBe("w2");
	expect(manager.hasPendingRollover(ctx)).toBe(true);
	manager.synchronize(ctx);
	const before = manager.project(sm.buildSessionProjection().messages, "remote");
	expect(JSON.stringify(before)).toContain("preserve until explicit rollover");
	expect(await manager.startNewWindow(pi, ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(false);
	const newMarker = sm.appendCustomMessageEntry(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, sent[0]!.content, true, sent[0]!.details);
	manager.synchronize(ctx);
	expect(manager.hasPendingRollover(ctx)).toBe(false);
	expect(manager.hasNotesCheckpointSinceBoundary(ctx)).toBe(false);
	const event = () => ({ branchEntries: sm.getBranch(), preparation: { tokensBefore: 100 } }) as never;
	const proposal = manager.prepareCompaction(event());
	if (!("compaction" in proposal)) throw new Error("Expected fresh boundary");
	expect(proposal.compaction.firstKeptEntryId).toBe(newMarker);
	expect(manager.prepareCompaction(event())).toEqual(proposal); // Cancellation is retryable.
	const { summary, firstKeptEntryId, tokensBefore, details } = proposal.compaction;
	sm.appendCompaction(summary, firstKeptEntryId, tokensBefore, details);
	manager.synchronize(ctx); // No callback needed.
	expect(manager.prepareCompaction(event())).toEqual({ cancel: true });
	expect(manager.prepareDetachedCompaction(event())).toEqual({ cancel: true });
	expect(JSON.stringify(manager.project(sm.buildSessionProjection().messages, "local"))).not.toContain("recent");
});

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
