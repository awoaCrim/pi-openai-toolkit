import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CodexContextWindowManager, findNotesCheckpointSinceBoundary } from "./window-manager";
import { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, CONTEXT_WINDOW_COMPACTION_SUMMARY } from "./messages";

function fakeContext(branch: readonly unknown[] = []): never {
	return {
		model: { contextWindow: 100_000 },
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "session-1",
		},
		getContextUsage: () => undefined,
	} as never;
}

function fakePi(sent: Array<Record<string, unknown>>): never {
	return {
		sendMessage: (message: Record<string, unknown>) => sent.push(message),
	} as never;
}

test("initializes and restores a persisted window marker", () => {
	const sent: Array<Record<string, unknown>> = [];
	const manager = new CodexContextWindowManager(async () => undefined);
	const ctx = fakeContext([]);
	manager.ensureInitialized(fakePi(sent), ctx, true);

	const identity = manager.currentIdentity();
	expect(identity?.windowNumber).toBe(0);
	expect(sent).toHaveLength(1);
	expect(sent[0]?.customType).toBe(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE);
	expect(sent[0]?.display).toBe(true);

	const details = sent[0]?.details;
	const entry = {
		type: "custom_message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
		content: sent[0]?.content,
		display: true,
		details,
	} as never;
	const restored = new CodexContextWindowManager(async () => undefined);
	restored.restore([entry]);
	expect(restored.currentIdentity()).toEqual(identity);
});

test("allows multiple new context rollovers and keeps the guard transient", async () => {
	const sent: Array<Record<string, unknown>> = [];
	const manager = new CodexContextWindowManager(async () => undefined);
	const ctx = fakeContext([]);
	manager.ensureInitialized(fakePi(sent), ctx, true);
	const first = manager.currentIdentity()?.currentWindowId;
	expect(await manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(true);
	const second = manager.currentIdentity();
	expect(second?.currentWindowId).not.toBe(first);
	expect(second?.windowNumber).toBe(1);
	expect(await manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(true);
	expect(manager.currentIdentity()?.windowNumber).toBe(2);
	expect(sent).toHaveLength(3);
});

test("does not restore a marker from another forked session", () => {
	const manager = new CodexContextWindowManager();
	const oldMarker = {
		type: "custom_message", id: "old", parentId: null, timestamp: "now",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "old", display: true,
		details: { protocol: 1, id: "old", sessionId: "session-old", contextManagement: { protocol: 1, kind: "window", firstWindowId: "a", currentWindowId: "a", windowNumber: 0 } },
	} as never;
	manager.restore([oldMarker], "session-new");
	expect(manager.currentIdentity()).toBeUndefined();
});

test("ignores malformed markers belonging to another session", () => {
	const manager = new CodexContextWindowManager();
	const foreignMalformed = {
		type: "custom_message", id: "foreign", parentId: null, timestamp: "now",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "foreign", display: true,
		details: { protocol: 1, id: "foreign", sessionId: "session-old", contextManagement: { protocol: 1, kind: "window" } },
	} as never;
	const current = {
		type: "custom_message", id: "current", parentId: null, timestamp: "now",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "current", display: true,
		details: { protocol: 1, id: "current", sessionId: "session-new", contextManagement: { protocol: 1, kind: "window", firstWindowId: "a", currentWindowId: "a", windowNumber: 0 } },
	} as never;

	expect(() => manager.restore([foreignMalformed, current], "session-new")).not.toThrow();
	expect(manager.currentIdentity()?.currentWindowId).toBe("a");

	const foreignMessage = {
		role: "custom", customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
		details: foreignMalformed.details,
	} as unknown as AgentMessage;
	const currentMessage = {
		role: "custom", customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
		details: current.details,
	} as unknown as AgentMessage;
	manager.restore([current], "session-new");
	expect(() => manager.project([foreignMessage, currentMessage], "remote")).not.toThrow();
});

test("projects only the latest remote window and removes markers when inactive", () => {
	const identity = {
		firstWindowId: "first",
		currentWindowId: "current",
		previousWindowId: "previous",
		windowNumber: 1,
	};
	const marker = {
		role: "custom",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
		details: {
			protocol: 1,
			id: "message-1",
			contextManagement: { protocol: 1, kind: "window", ...identity },
		},
	} as unknown as AgentMessage;
	const before = { role: "user", content: "before", timestamp: Date.now() } as unknown as AgentMessage;
	const after = { role: "user", content: "after", timestamp: Date.now() } as unknown as AgentMessage;
	const manager = new CodexContextWindowManager();
	const messages = [before, marker, after];
	expect(manager.project(messages, "remote")).toEqual([marker, after]);
	expect(manager.project(messages, "off")).toEqual([before, after]);
});

test("projects opaque history/notes output as a native encrypted tool result marker", () => {
	const manager = new CodexContextWindowManager();
	const marker = {
		role: "custom",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
		details: {
			protocol: 1,
			id: "message-1",
			contextManagement: { protocol: 1, kind: "window", firstWindowId: "a", currentWindowId: "a", windowNumber: 0 },
		},
	} as unknown as AgentMessage;
	const toolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "history",
		content: [{ type: "text", text: "history operation completed" }],
		details: { codexHistoryNotes: { encrypted_output: "opaque-value" } },
		isError: false,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
	const projected = manager.project([marker, toolResult], "remote");
	expect((projected[1] as never as { content: Array<{ text: string }> }).content[0]?.text)
		.toContain("opaque-value");
});

test("fails closed on a malformed newer marker instead of selecting an older one", () => {
	const manager = new CodexContextWindowManager();
	const oldMarker = {
		type: "custom_message", id: "old", parentId: null, timestamp: "now",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "old", display: true,
		details: { protocol: 1, id: "old", contextManagement: { protocol: 1, kind: "window", firstWindowId: "a", currentWindowId: "a", windowNumber: 0 } },
	} as never;
	const malformed = {
		type: "custom_message", id: "new", parentId: null, timestamp: "now",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "new", display: true,
		details: { protocol: 1, id: "new", contextManagement: { protocol: 1, kind: "window" } },
	} as never;
	expect(() => manager.restore([oldMarker, malformed])).toThrow("Malformed persisted");
});

test("requires an explicitly scheduled rollover before threshold compaction", () => {
	const manager = new CodexContextWindowManager();
	const event = {
		reason: "threshold",
		branchEntries: [],
		preparation: { firstKeptEntryId: "keep", tokensBefore: 50 },
	} as never;
	expect(manager.prepareCompaction(event)).toEqual({ cancel: true });
});

test("creates a no-summary compaction boundary only for the scheduled rollover", () => {
	const manager = new CodexContextWindowManager();
	const marker = rolloverMarker("w2");
	manager.restore([marker], "session-1");
	const event = {
		reason: "threshold",
		branchEntries: [marker],
		preparation: { firstKeptEntryId: "keep", tokensBefore: 50 },
	} as never;
	const result = manager.prepareCompaction(event);
	expect(result).toMatchObject({ compaction: { summary: CONTEXT_WINDOW_COMPACTION_SUMMARY } });
	// The trim is consumed exactly once; a second compaction for the same
	// rollover must cancel instead of writing another no-op boundary.
	expect(manager.prepareCompaction(event)).toEqual({ cancel: true });
});

test("cancels manual and overflow compaction when no rollover trim is pending", () => {
	const manager = new CodexContextWindowManager();
	const marker = windowMarker("w1");
	manager.restore([marker], "session-1");
	for (const reason of ["manual", "overflow"]) {
		const event = {
			reason,
			branchEntries: [marker],
			preparation: { firstKeptEntryId: "keep", tokensBefore: 50 },
		} as never;
		expect(manager.prepareCompaction(event)).toEqual({ cancel: true });
	}
});

test("budget checks wait for the current window's own usage anchor", () => {
	const sent: Array<Record<string, unknown>> = [];
	const manager = new CodexContextWindowManager();
	const marker = rolloverMarker("w2");
	manager.restore([marker], "session-1");
	const staleCtx = {
		model: { contextWindow: 100_000 },
		sessionManager: { getBranch: () => [marker], getSessionId: () => "session-1" },
		getContextUsage: () => ({ contextWindow: 100_000, tokens: 78_000 }),
	} as never;
	// 78k belongs to the previous window's last request; the new window has
	// not produced any usage yet, so no reminder may fire on that stale anchor.
	manager.recordBudget(fakePi(sent), staleCtx, true, 10);
	expect(sent).toHaveLength(0);

	const freshCtx = {
		...staleCtx,
		sessionManager: { getBranch: () => [marker, assistantUsage(20_000)], getSessionId: () => "session-1" },
	} as never;
	manager.recordBudget(fakePi(sent), freshCtx, true, 10);
	expect(sent).toHaveLength(1);
	expect(String(sent[0]?.content)).toContain("context tokens remain");
});

function rolloverMarker(windowId: string) {
	return {
		type: "custom_message", id: `entry-m-${windowId}`, parentId: null, timestamp: "2026-09-07T00:00:00.000Z",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "window", display: true,
		details: { protocol: 1, id: `m-${windowId}`, sessionId: "session-1", contextManagement: { protocol: 1, kind: "window", firstWindowId: "w1", currentWindowId: windowId, windowNumber: 1, trimPreviousWindow: true } },
	} as never;
}

function assistantUsage(tokens: number) {
	return {
		type: "message", id: `entry-u-${tokens}`, parentId: null, timestamp: "2026-09-07T00:00:03.000Z",
		message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { totalTokens: tokens } },
	} as never;
}

function notesCall(id: string, action: string) {
	return {
		type: "message", id: `entry-${id}`, parentId: null, timestamp: "2026-09-07T00:00:01.000Z",
		message: { role: "assistant", content: [{ type: "toolCall", id, name: "notes", arguments: { action } }] },
	} as never;
}
function notesResult(id: string, ok: boolean) {
	return {
		type: "message", id: `entry-res-${id}`, parentId: null, timestamp: "2026-09-07T00:00:02.000Z",
		message: {
			role: "toolResult", toolCallId: id, toolName: "notes", isError: !ok,
			content: [{ type: "text", text: ok ? "done" : "boom" }],
			...(ok ? { details: { codexHistoryNotes: { output: "done" } } } : {}),
		},
	} as never;
}
function windowMarker(windowId: string) {
	return {
		type: "custom_message", id: `entry-m-${windowId}`, parentId: null, timestamp: "2026-09-07T00:00:00.000Z",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "window", display: true,
		details: { protocol: 1, id: `m-${windowId}`, sessionId: "session-1", contextManagement: { protocol: 1, kind: "window", firstWindowId: windowId, currentWindowId: windowId, windowNumber: 0 } },
	} as never;
}

test("notes checkpoint scan requires a success after the latest boundary", () => {
	expect(findNotesCheckpointSinceBoundary([windowMarker("w1"), notesCall("tc-a", "append_to_file"), notesResult("tc-a", true)], "session-1")).toBe(true);
	expect(findNotesCheckpointSinceBoundary([windowMarker("w1")], "session-1")).toBe(false);
	expect(findNotesCheckpointSinceBoundary([
		notesCall("tc-old", "write_file"), notesResult("tc-old", true), windowMarker("w1"),
	], "session-1")).toBe(false);
	expect(findNotesCheckpointSinceBoundary([
		windowMarker("w1"), notesCall("tc-b", "append_to_file"), notesResult("tc-b", false),
	], "session-1")).toBe(false);
	expect(findNotesCheckpointSinceBoundary([
		windowMarker("w1"), notesCall("tc-c", "read_file"), notesResult("tc-c", true),
	], "session-1")).toBe(false);
});

test("notes checkpoint scan tracks the latest boundary across rollovers", () => {
	const entries = [
		windowMarker("w1"),
		notesCall("tc-a", "append_to_file"), notesResult("tc-a", true),
		windowMarker("w2"),
	] as never[];
	// The old window's checkpoint must not authorize the new window's rollover.
	expect(findNotesCheckpointSinceBoundary(entries, "session-1")).toBe(false);
});

test("manager exposes the checkpoint gate for the current session branch", () => {
	const manager = new CodexContextWindowManager(async () => undefined);
	const entries = [
		windowMarker("w1"), notesCall("tc-a", "append_to_file"), notesResult("tc-a", true),
	] as never[];
	manager.restore(entries, "session-1");
	const ctx = {
		sessionManager: { getBranch: () => entries, getSessionId: () => "session-1" },
	} as never;
	expect(manager.hasNotesCheckpointSinceBoundary(ctx)).toBe(true);
});
