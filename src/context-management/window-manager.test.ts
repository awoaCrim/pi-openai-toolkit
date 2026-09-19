import { afterEach, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	loadHistoryNotesThreadHint,
} from "./history-notes";
import {
	CodexContextWindowManager,
	findLatestNotesCheckpointSinceBoundary,
	findNotesCheckpointSinceBoundary,
} from "./window-manager";
import { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, CONTEXT_WINDOW_COMPACTION_SUMMARY } from "./messages";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function fakeContext(branch: readonly unknown[] | (() => readonly unknown[]) = []): never {
	return {
		model: { contextWindow: 100_000 },
		sessionManager: {
			getBranch: () => (typeof branch === "function" ? branch() : branch),
			getSessionId: () => "session-1",
		},
		getContextUsage: () => undefined,
	} as never;
}

function persistSentMarker(branch: Array<Record<string, unknown>>, message: Record<string, unknown>): void {
	const index = branch.length;
	branch.push({
		type: "custom_message",
		id: `entry-m${index}`,
		parentId: index === 0 ? null : `entry-m${index - 1}`,
		timestamp: `2026-09-07T00:00:0${index}.000Z`,
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
		content: message.content,
		display: true,
		details: message.details,
	});
}

function fakeHistoryContext(branch: readonly unknown[] = []): never {
	return {
		model: {
			provider: "openai-codex",
			api: "openai-codex-responses",
			id: "gpt-5.5",
			baseUrl: "https://chatgpt.com/backend-api",
			contextWindow: 100_000,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "token",
				headers: { "chatgpt-account-id": "account" },
				baseUrl: "https://chatgpt.com/backend-api",
			}),
		},
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

test("keeps a rollover guard until its target marker is persisted, then allows the next rollover", async () => {
	const sent: Array<Record<string, unknown>> = [];
	const branch: Array<Record<string, unknown>> = [];
	const manager = new CodexContextWindowManager(async () => undefined);
	const ctx = fakeContext(() => branch as never);
	manager.ensureInitialized(fakePi(sent), ctx, true);
	persistSentMarker(branch, sent[0]!);

	const first = manager.currentIdentity()?.currentWindowId;
	expect(await manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(true);
	const second = manager.currentIdentity();
	expect(second?.currentWindowId).not.toBe(first);
	expect(second?.windowNumber).toBe(1);
	expect(sent).toHaveLength(2);

	// The new marker was accepted by sendMessage(), not yet persisted. A second
	// call must be idempotent instead of scheduling another window against the
	// old window's checkpoint.
	expect(manager.hasPendingRollover(ctx)).toBe(true);
	expect(await manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(false);
	expect(sent).toHaveLength(2);

	// A queued marker visible from projection is still not durable evidence.
	manager.project([
		{
			role: "custom",
			customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
			details: sent[1]?.details,
		},
	] as never, "remote");
	expect(manager.hasPendingRollover(ctx)).toBe(true);
	expect(await manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(false);
	expect(sent).toHaveLength(2);

	// Observing the target marker in the persisted branch retires the guard and
	// the next rollover becomes possible again.
	persistSentMarker(branch, sent[1]!);
	manager.synchronize(ctx);
	expect(manager.hasPendingRollover(ctx)).toBe(false);
	expect(await manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(true);
	expect(manager.currentIdentity()?.windowNumber).toBe(2);
	expect(sent).toHaveLength(3);
});

test("a pending rollover is discarded when the session changes", async () => {
	const sent: Array<Record<string, unknown>> = [];
	const manager = new CodexContextWindowManager(async () => undefined);
	const ctx = fakeContext([]);
	manager.ensureInitialized(fakePi(sent), ctx, true);
	expect(await manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(true);
	expect(manager.hasPendingRollover(ctx)).toBe(true);

	const otherSessionCtx = {
		model: { contextWindow: 100_000 },
		sessionManager: { getBranch: () => [], getSessionId: () => "session-2" },
		getContextUsage: () => undefined,
	} as never;
	manager.synchronize(otherSessionCtx);
	expect(manager.hasPendingRollover(otherSessionCtx)).toBe(false);
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

function notesCall(id: string, action: string, path = "/checkpoint.md") {
	return {
		type: "message", id: `entry-${id}`, parentId: null, timestamp: "2026-09-07T00:00:01.000Z",
		message: { role: "assistant", content: [{ type: "toolCall", id, name: "notes", arguments: { action, path } }] },
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
function notesResultWithDetails(id: string, result: Record<string, unknown>, isError: boolean | undefined) {
	return {
		type: "message", id: `entry-res-${id}`, parentId: null, timestamp: "2026-09-07T00:00:02.000Z",
		message: {
			role: "toolResult", toolCallId: id, toolName: "notes",
			...(isError === undefined ? {} : { isError }),
			content: [{ type: "text", text: "backend response" }],
			details: { codexHistoryNotes: result },
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

test("notes checkpoint scan rejects semantic failures and returns the latest successful receipt", () => {
	const entries = [
		windowMarker("w1"),
		notesCall("tc-rejected", "append_to_file", "/rejected.md"),
		notesResultWithDetails("tc-rejected", { ok: false, output: "write rejected" }, false),
		notesCall("tc-success", "write_file", "/active-task.md"),
		notesResultWithDetails("tc-success", { success: true, output: "done" }, false),
	] as never[];
	expect(findNotesCheckpointSinceBoundary(entries, "session-1")).toBe(true);
	expect(findLatestNotesCheckpointSinceBoundary(entries, "session-1")).toEqual({
		path: "/active-task.md",
		toolCallId: "tc-success",
	});

	const rejectedOnly = [
		windowMarker("w1"),
		notesCall("tc-rejected", "append_to_file", "/rejected.md"),
		notesResultWithDetails("tc-rejected", { ok: false }, false),
	] as never[];
	expect(findNotesCheckpointSinceBoundary(rejectedOnly, "session-1")).toBe(false);

	const missingErrorFlag = [
		windowMarker("w1"),
		notesCall("tc-missing-error", "write_file"),
		notesResultWithDetails("tc-missing-error", { output: "done" }, undefined),
	] as never[];
	expect(findNotesCheckpointSinceBoundary(missingErrorFlag, "session-1")).toBe(false);
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

test("rollover carries a checkpoint receipt when the thread hint is unavailable", async () => {
	const sent: Array<Record<string, unknown>> = [];
	const entries = [
		windowMarker("w1"),
		notesCall("tc-a", "write_file", "/active-task.md"), notesResult("tc-a", true),
	] as never[];
	const manager = new CodexContextWindowManager(async () => {
		throw new Error("thread hint unavailable");
	});
	manager.restore(entries, "session-1");
	const ctx = fakeContext(entries);
	await expect(manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true })).resolves.toBe(true);
	expect(sent).toHaveLength(1);
	const content = String(sent[0]?.content);
	expect(content).toContain("Context switch completed");
	expect(content).toContain("Checkpoint successfully written:");
	expect(content).toContain(JSON.stringify("/active-task.md"));
	expect(content).toContain("before doing anything else");
	expect(content).toContain("resume the active user task");
	expect(content).toContain("Do not immediately create another checkpoint or call new_context");
});

test("rollover carries a checkpoint receipt when thread hint response is rejected", async () => {
	const sent: Array<Record<string, unknown>> = [];
	const entries = [
		windowMarker("w1"),
		notesCall("tc-a", "write_file", "/active-task.md"), notesResult("tc-a", true),
	] as never[];
	globalThis.fetch = async () => new Response(JSON.stringify({ success: false, text: "rejected hint" }), { status: 200 });
	const manager = new CodexContextWindowManager((ctx, signal) => loadHistoryNotesThreadHint(ctx, signal));
	manager.restore(entries, "session-1");
	const ctx = fakeHistoryContext(entries);
	await expect(manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true })).resolves.toBe(true);
	expect(sent).toHaveLength(1);
	const content = String(sent[0]?.content);
	expect(content).toContain("Context switch completed");
	expect(content).toContain("Checkpoint successfully written:");
	expect(content).toContain(JSON.stringify("/active-task.md"));
	expect(content).toContain("resume the active user task");
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

test("the checkpoint gate scans with the live session id, not the cached one", () => {
	const manager = new CodexContextWindowManager(async () => undefined);
	// The manager still holds the identity of the session Pi navigated away
	// from; the live branch belongs to session-new and holds a valid pair.
	manager.restore([windowMarker("w-old")], "session-old");
	const liveEntries = [
		windowMarkerForSession("session-new", "w-new"),
		notesCallForSession("session-new", "tc-live", "write_file", "/live.md"),
		notesResultForSession("session-new", "tc-live", { output: "done" }, false),
	] as never[];
	const ctx = {
		sessionManager: { getBranch: () => liveEntries, getSessionId: () => "session-new" },
	} as never;
	expect(manager.hasNotesCheckpointSinceBoundary(ctx)).toBe(true);

	// A genuinely foreign branch still cannot authorize the live session.
	const foreignEntries = [
		windowMarkerForSession("session-old", "w-old"),
		notesCallForSession("session-old", "tc-old", "write_file", "/old.md"),
		notesResultForSession("session-old", "tc-old", { output: "done" }, false),
	] as never[];
	const foreignCtx = {
		sessionManager: { getBranch: () => foreignEntries, getSessionId: () => "session-new" },
	} as never;
	expect(manager.hasNotesCheckpointSinceBoundary(foreignCtx)).toBe(false);
});

test("notes checkpoint scan requires a persisted result paired with the exact call", () => {
	const cases: Array<[string, unknown[]]> = [
		["call without a result", [notesCall("tc-none", "write_file")]],
		["result before its call", [notesResult("tc-order", true), notesCall("tc-order", "write_file")]],
		["mismatched tool call id", [notesCall("tc-a", "write_file"), notesResult("tc-b", true)]],
		["orphan result without a call", [notesResult("tc-orphan", true)]],
		["non-notes tool result", [notesCall("tc-x", "write_file"), historyResult("tc-x")]],
		["malformed result details", [notesCall("tc-m", "write_file"), notesResultWithDetailsRaw("tc-m", "not-a-record", false)]],
		["missing result details", [notesCall("tc-m2", "write_file"), notesResultWithDetailsRaw("tc-m2", undefined, false)]],
	];
	for (const [name, rest] of cases) {
		expect(
			findNotesCheckpointSinceBoundary([windowMarker("w1"), ...rest] as never[], "session-1"),
			name,
		).toBe(false);
	}
});

test("rollover arms a once-only trim that is consumed by the persisted boundary", async () => {
	const sent: Array<Record<string, unknown>> = [];
	const branch: Array<Record<string, unknown>> = [
		windowMarker("w1") as never,
		notesCall("tc-a", "write_file", "/active-task.md") as never,
		notesResult("tc-a", true) as never,
	];
	const manager = new CodexContextWindowManager(async () => undefined);
	const ctx = fakeContext(() => branch as never);
	manager.restore(branch as never, "session-1");
	expect(await manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(true);
	// The accepted marker is not persisted yet, so the trim cannot be consumed.
	const pendingEvent = { reason: "threshold", branchEntries: branch, preparation: { firstKeptEntryId: "keep", tokensBefore: 50 } } as never;
	expect(manager.prepareCompaction(pendingEvent)).toEqual({ cancel: true });

	persistSentMarker(branch, sent[0]!);
	manager.synchronize(ctx);
	const persistedEvent = { reason: "threshold", branchEntries: branch, preparation: { firstKeptEntryId: "keep", tokensBefore: 50 } } as never;
	expect(manager.prepareCompaction(persistedEvent)).toMatchObject({ compaction: { summary: CONTEXT_WINDOW_COMPACTION_SUMMARY } });
	expect(manager.prepareCompaction(persistedEvent)).toEqual({ cancel: true });
});

function windowMarkerForSession(sessionId: string, windowId: string) {
	return {
		type: "custom_message", id: `entry-m-${sessionId}-${windowId}`, parentId: null, timestamp: "2026-09-07T00:00:00.000Z",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "window", display: true,
		details: { protocol: 1, id: `m-${sessionId}-${windowId}`, sessionId, contextManagement: { protocol: 1, kind: "window", firstWindowId: windowId, currentWindowId: windowId, windowNumber: 0 } },
	} as never;
}

function notesCallForSession(sessionId: string, id: string, action: string, path: string) {
	return {
		type: "message", id: `entry-${sessionId}-${id}`, parentId: null, timestamp: "2026-09-07T00:00:01.000Z",
		message: { role: "assistant", content: [{ type: "toolCall", id, name: "notes", arguments: { action, path } }] },
	} as never;
}

function notesResultForSession(sessionId: string, id: string, result: Record<string, unknown>, isError: boolean | undefined) {
	return {
		type: "message", id: `entry-res-${sessionId}-${id}`, parentId: null, timestamp: "2026-09-07T00:00:02.000Z",
		message: {
			role: "toolResult", toolCallId: id, toolName: "notes",
			...(isError === undefined ? {} : { isError }),
			content: [{ type: "text", text: "backend response" }],
			details: { codexHistoryNotes: result },
		},
	} as never;
}

function historyResult(id: string) {
	return {
		type: "message", id: `entry-hist-${id}`, parentId: null, timestamp: "2026-09-07T00:00:02.000Z",
		message: {
			role: "toolResult", toolCallId: id, toolName: "history", isError: false,
			content: [{ type: "text", text: "done" }], details: { codexHistoryNotes: { output: "done" } },
		},
	} as never;
}

function notesResultWithDetailsRaw(id: string, result: unknown, isError: boolean | undefined) {
	return {
		type: "message", id: `entry-res-raw-${id}`, parentId: null, timestamp: "2026-09-07T00:00:02.000Z",
		message: {
			role: "toolResult", toolCallId: id, toolName: "notes",
			...(isError === undefined ? {} : { isError }),
			content: [{ type: "text", text: "backend response" }],
			...(result === undefined ? {} : { details: { codexHistoryNotes: result } }),
		},
	} as never;
}
