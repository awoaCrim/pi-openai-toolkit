import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createContextManagementTools, NEW_CONTEXT_CHECKPOINT_REQUIRED_MESSAGE } from "./tools";
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
});

test("new_context force bypasses the checkpoint gate", async () => {
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
	const result = await tools.newContext.execute("t1", { force: true }, undefined, undefined, makeCtx(branch));
	expect(result.details).toEqual({ started: true });
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
		tools.newContext.execute("t1", { force: true }, undefined, undefined, makeCtx(branch)),
	).rejects.toThrow("remote-context-inactive");
});
