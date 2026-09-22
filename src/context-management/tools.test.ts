import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ContextManagementToolController,
	createContextManagementTools,
	NEW_CONTEXT_CHECKPOINT_REQUIRED_MESSAGE,
	NEW_CONTEXT_PARAMETERS,
} from "./tools";
import { CodexContextWindowManager } from "./window-manager";
import { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE } from "./messages";

function boundaryDetails(windowId: string): never {
	return {
		protocol: 1,
		id: `marker-${windowId}`,
		sessionId: "session-1",
		contextManagement: {
			protocol: 1,
			kind: "window",
			firstWindowId: windowId,
			currentWindowId: windowId,
			windowNumber: 0,
		},
	} as never;
}

const notesCallEntry = {
	type: "message", id: "call-1", parentId: null, timestamp: "2026-09-07T00:00:01.000Z",
	message: {
		role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "notes", arguments: { action: "append_to_file", path: "/w.txt", text: "state" } }],
	},
};

const notesOkEntry = {
	type: "message", id: "res-1", parentId: null, timestamp: "2026-09-07T00:00:02.000Z",
	message: {
		role: "toolResult", toolCallId: "tc-1", toolName: "notes", isError: false,
		content: [{ type: "text", text: "ok" }], details: { codexHistoryNotes: { output: "done" } },
	},
};

function makeCtx(branch: readonly unknown[]): ExtensionContext {
	return {
		model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.5", contextWindow: 100_000 },
		sessionManager: { getBranch: () => branch, getSessionId: () => "session-1" },
		getContextUsage: () => undefined,
	} as never;
}

const activePi = { sendMessage: () => undefined } as unknown as ExtensionAPI;

test("new_context is idempotent while the first rollover marker is not persisted", async () => {
	const branch = [
		{
			type: "custom_message", id: "entry-b", parentId: null, timestamp: "2026-09-07T00:00:00.000Z",
			customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "window", display: true,
			details: boundaryDetails("w-current"),
		},
		notesCallEntry,
		notesOkEntry,
	] as never[];
	const sent: Array<Record<string, unknown>> = [];
	const pi = {
		sendMessage: (message: Record<string, unknown>) => { sent.push(message); },
	} as unknown as ExtensionAPI;
	const manager = new CodexContextWindowManager(async () => undefined);
	manager.restore(branch, "session-1");
	const tools = createContextManagementTools(pi, manager, () => true);
	const ctx = makeCtx(branch);

	const first = await tools.newContext.execute("t1", {}, undefined, undefined, ctx);
	const second = await tools.newContext.execute("t2", {}, undefined, undefined, ctx);

	expect(first.details).toEqual({ started: true });
	expect(second.details).toEqual({ started: false });
	expect(second.content[0]?.text).toContain("already scheduled");
	expect(sent).toHaveLength(1);
});

test("new_context refuses rollover without a successful notes checkpoint", async () => {
	const branch = [
		{
			type: "custom_message", id: "entry-b", parentId: null, timestamp: "2026-09-07T00:00:00.000Z",
			customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "window", display: true,
			details: boundaryDetails("w-current"),
		},
	] as never[];
	const manager = new CodexContextWindowManager(async () => undefined);
	manager.restore(branch, "session-1");
	const tools = createContextManagementTools(activePi, manager, () => true);
	await expect(
		tools.newContext.execute("t1", {}, undefined, undefined, makeCtx(branch)),
	).rejects.toThrow(NEW_CONTEXT_CHECKPOINT_REQUIRED_MESSAGE);
});

test("new_context proceeds after a successful notes checkpoint", async () => {
	const branch = [
		{
			type: "custom_message", id: "entry-b", parentId: null, timestamp: "2026-09-07T00:00:00.000Z",
			customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "window", display: true,
			details: boundaryDetails("w-current"),
		},
		notesCallEntry,
		notesOkEntry,
	] as never[];
	const manager = new CodexContextWindowManager(async () => undefined);
	manager.restore(branch, "session-1");
	const tools = createContextManagementTools(activePi, manager, () => true);
	const result = await tools.newContext.execute("t1", {}, undefined, undefined, makeCtx(branch));
	expect(result.details).toEqual({ started: true });
	expect(result.content[0]?.text).toContain("Context switch scheduled successfully");
	expect(result.content[0]?.text).toContain("resume the active user task");
	expect(result.content[0]?.text).toContain("do not immediately create another checkpoint or call new_context");
});

test("new_context and notes guidance separate pre-rollover checkpointing from post-rollover resume", () => {
	const manager = new CodexContextWindowManager(async () => undefined);
	const tools = createContextManagementTools(activePi, manager, () => true);
	const newContextGuidance = tools.newContext.promptGuidelines?.join(" ") ?? "";
	const notesGuidance = tools.notes.promptGuidelines?.join(" ") ?? "";

	expect(newContextGuidance).toContain("Before this new_context call");
	expect(newContextGuidance).toContain("A successful new_context completes one context switch");
	expect(newContextGuidance).toContain("do not immediately create another checkpoint or call new_context");
	expect(notesGuidance).toContain("Before calling new_context");
	expect(notesGuidance).toContain("After a successful new_context handoff");
	expect(notesGuidance).toContain("unless a later rollover is actually needed");
});

test("new_context cannot bypass the checkpoint gate with an obsolete force flag", async () => {
	const branch = [
		{
			type: "custom_message", id: "entry-b", parentId: null, timestamp: "2026-09-07T00:00:00.000Z",
			customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "window", display: true,
			details: boundaryDetails("w-current"),
		},
	] as never[];
	const manager = new CodexContextWindowManager(async () => undefined);
	manager.restore(branch, "session-1");
	const tools = createContextManagementTools(activePi, manager, () => true);
	expect((NEW_CONTEXT_PARAMETERS as { properties?: Record<string, unknown> }).properties).toEqual({});
	await expect(
		tools.newContext.execute("t1", { force: true } as never, undefined, undefined, makeCtx(branch)),
	).rejects.toThrow(NEW_CONTEXT_CHECKPOINT_REQUIRED_MESSAGE);
});

test("new_context is still gated when remote context is inactive", async () => {
	const branch = [
		{
			type: "custom_message", id: "entry-b", parentId: null, timestamp: "2026-09-07T00:00:00.000Z",
			customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "window", display: true,
			details: boundaryDetails("w-current"),
		},
	] as never[];
	const manager = new CodexContextWindowManager(async () => undefined);
	manager.restore(branch, "session-1");
	const tools = createContextManagementTools(activePi, manager, () => false);
	await expect(
		tools.newContext.execute("t1", {}, undefined, undefined, makeCtx(branch)),
	).rejects.toThrow("remote-context-inactive");
});

type PublishedTool = {
	name: string;
	description: string;
	parameters: unknown;
	promptGuidelines?: string[];
};

function controllerHarness(publish: (registered: PublishedTool[]) => PublishedTool[] = (tools) => tools) {
	const registered: PublishedTool[] = [];
	let active = ["read"];
	let bound = true;
	const pi = {
		registerTool: (tool: PublishedTool) => { registered.push(tool); },
		getAllTools: () => {
			if (!bound) throw new Error("This extension ctx is stale after session replacement or reload.");
			return publish(registered.map((tool) => ({ ...tool })));
		},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
	} as unknown as ExtensionAPI;
	const controller = new ContextManagementToolController(pi);
	const registeredTools = controller.register(
		createContextManagementTools(pi, new CodexContextWindowManager(async () => undefined), () => true),
	);
	return {
		controller,
		bind: () => { bound = true; },
		unbind: () => { bound = false; },
		active: () => active,
		registeredTools,
	};
}

test("a stale Pi runtime read does not permanently disable the context tools", () => {
	const harness = controllerHarness();
	harness.unbind();
	expect(harness.registeredTools).toBe(true);

	// Pi 0.86 rejects action methods after a session replacement or reload. That
	// must cost one sync, not the whole session.
	expect(harness.controller.sync(true)).toEqual({ synced: false, registrationState: "unverified" });
	expect(harness.controller.registrationState).toBe("unverified");
	expect(harness.active()).toEqual(["read"]);

	harness.bind();
	expect(harness.controller.sync(true)).toEqual({ synced: true, registrationState: "verified" });
	expect(harness.controller.registrationState).toBe("verified");
	expect(harness.active()).toEqual(["read", "new_context", "get_context_remaining", "history", "notes"]);
});

test("a runtime wrapper around the same definitions keeps the context tools active", () => {
	// Pi may return fresh ToolInfo wrappers. The published schema and guidance
	// remain exact, so a wrapper is still the registered definition.
	const harness = controllerHarness((tools) => tools.map((tool) => ({ ...tool })));

	expect(harness.controller.sync(true)).toEqual({ synced: true, registrationState: "verified" });
	expect(harness.controller.registrationState).toBe("verified");
});

test("a same-name definition with an extra schema field stays a conflict", () => {
	const harness = controllerHarness((tools) => tools.map((tool) => {
		if (tool.name !== "history") return tool;
		const parameters = tool.parameters as Record<string, unknown>;
		const properties = parameters.properties as Record<string, unknown>;
		return {
			...tool,
			parameters: {
				...parameters,
				properties: { ...properties, foreign_option: { type: "string" } },
			},
		};
	}));

	expect(harness.controller.sync(true)).toEqual({ synced: false, registrationState: "conflict" });
	expect(harness.active()).toEqual(["read"]);
});

test("another definition under a context tool name stays a permanent conflict", () => {
	const harness = controllerHarness((tools) => tools.map((tool) =>
		tool.name === "history" ? { ...tool, description: "owned by another extension" } : tool,
	));

	expect(harness.controller.sync(true)).toEqual({ synced: false, registrationState: "conflict" });
	expect(harness.controller.registrationState).toBe("conflict");
	// Retrying must not silently take the name back over the other extension.
	expect(harness.controller.sync(true)).toEqual({ synced: false, registrationState: "conflict" });
	expect(harness.controller.registrationState).toBe("conflict");
	expect(harness.active()).toEqual(["read"]);
});

test("tools the runtime has not published yet remain pending", () => {
	const harness = controllerHarness(() => []);

	expect(harness.controller.sync(true)).toEqual({ synced: false, registrationState: "unverified" });
	expect(harness.controller.registrationState).toBe("unverified");
	expect(harness.active()).toEqual(["read"]);
});

test("a same-name definition with extra prompt guidance stays a conflict", () => {
	const harness = controllerHarness((tools) => tools.map((tool) => ({
		...tool,
		promptGuidelines: tool.promptGuidelines ? [...tool.promptGuidelines, "foreign guidance"] : ["foreign guidance"],
	})));

	expect(harness.controller.registrationState).toBe("conflict");
	expect(harness.controller.sync(true)).toEqual({ synced: false, registrationState: "conflict" });
});

function switchedWindowMarker(): never {
	return {
		type: "custom_message", id: "entry-switch", parentId: null, timestamp: "2026-09-07T00:00:00.000Z",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "window", display: true,
		details: {
			protocol: 1, id: "m-switch", sessionId: "session-1",
			contextManagement: { protocol: 1, kind: "window", firstWindowId: "w1", currentWindowId: "w2", windowNumber: 1 },
		},
	} as never;
}

const bashResultEntry = {
	type: "message", id: "res-bash", parentId: null, timestamp: "2026-09-07T00:00:03.000Z",
	message: {
		role: "toolResult", toolCallId: "tc-bash", toolName: "bash", isError: false,
		content: [{ type: "text", text: "done" }],
	},
};

test("a window entered by rollover must do real work before rolling over again", async () => {
	const idleBranch = [switchedWindowMarker(), notesCallEntry, notesOkEntry] as never[];
	const manager = new CodexContextWindowManager(async () => undefined);
	manager.restore(idleBranch, "session-1");
	const tools = createContextManagementTools(activePi, manager, () => true);

	const refused = await tools.newContext.execute("t1", {}, undefined, undefined, makeCtx(idleBranch));

	expect(refused.details).toEqual({ started: false });
	expect(refused.content[0]?.text).toContain("has not run any substantive tool");

	const workedBranch = [switchedWindowMarker(), notesCallEntry, notesOkEntry, bashResultEntry] as never[];
	const workedCtx = makeCtx(workedBranch);
	manager.synchronize(workedCtx);

	const allowed = await tools.newContext.execute("t2", {}, undefined, undefined, workedCtx);

	expect(allowed.details).toEqual({ started: true });
});

test("the first window can still roll over without any tool activity", async () => {
	const branch = [
		{
			type: "custom_message", id: "entry-first", parentId: null, timestamp: "2026-09-07T00:00:00.000Z",
			customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "window", display: true,
			details: {
				protocol: 1, id: "m-first", sessionId: "session-1",
				contextManagement: { protocol: 1, kind: "window", firstWindowId: "w1", currentWindowId: "w1", windowNumber: 0 },
			},
		},
		notesCallEntry,
		notesOkEntry,
	] as never[];
	const manager = new CodexContextWindowManager(async () => undefined);
	manager.restore(branch, "session-1");
	const tools = createContextManagementTools(activePi, manager, () => true);

	const started = await tools.newContext.execute("t1", {}, undefined, undefined, makeCtx(branch));

	expect(started.details).toEqual({ started: true });
});

test("an exhausted switched window can still escape through new_context", async () => {
	const branch = [switchedWindowMarker(), notesCallEntry, notesOkEntry] as never[];
	const manager = new CodexContextWindowManager(async () => undefined);
	manager.restore(branch, "session-1");
	const tools = createContextManagementTools(activePi, manager, () => true);
	const exhaustedCtx = {
		...makeCtx(branch),
		getContextUsage: () => ({ tokens: 100_000, contextWindow: 100_000 }),
	} as never;

	const started = await tools.newContext.execute("t1", {}, undefined, undefined, exhaustedCtx);

	expect(started.details).toEqual({ started: true });
});


test("new_context passes the operation gateway policy to its awaited thread hint", async () => {
	const branch = [
		{ type: "custom_message", id: "boundary", customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, details: boundaryDetails("w-current") },
		notesCallEntry, notesOkEntry,
	] as never[];
	const captured: unknown[] = [];
	let reads = 0;
	const manager = new CodexContextWindowManager(async (_ctx, _signal, gatewayModels) => { captured.push(gatewayModels); return undefined; });
	manager.restore(branch, "session-1");
	const tools = createContextManagementTools(activePi, manager, async () => {
		reads++;
		return { active: true, gatewayModels: ["p/selected"] };
	});
	await tools.newContext.execute("call", {}, undefined, undefined, makeCtx(branch));
	expect(reads).toBe(1);
	expect(captured).toEqual([["p/selected"]]);
});
