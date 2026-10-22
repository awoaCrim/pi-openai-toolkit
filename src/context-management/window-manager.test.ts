import { afterEach, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	loadHistoryNotesThreadHint,
} from "./history-notes";
import {
	CodexContextWindowManager,
	findLatestNotesCheckpointSinceBoundary,
	findNotesCheckpointSinceBoundary,
} from "./window-manager";
import {
	CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
	CONTEXT_WINDOW_COMPACTION_SUMMARY,
	declaredToolNames,
} from "./messages";

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
		parentId: index === 0 ? null : branch[index - 1]!.id,
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
	// Cancellation before persistence leaves the same proposal retryable.
	expect(manager.hasPendingTrim()).toBe(true);
	expect(manager.prepareCompaction(event)).toEqual(result);
	if (!result || !("compaction" in result)) throw new Error("Expected a trim proposal");
	const entries = [marker, { type: "compaction", id: "cleanup", parentId: marker.id, timestamp: "now", ...result.compaction }] as never;
	manager.restore(entries, "session-1");
	expect(manager.prepareCompaction({ ...event, branchEntries: entries })).toEqual({ cancel: true });
});

test("maintenance eligibility does not arm until the scheduled marker is persisted", async () => {
	const manager = new CodexContextWindowManager(async () => undefined);
	const sent: Array<Record<string, unknown>> = [];
	const branch: Array<Record<string, unknown>> = [];
	const ctx = fakeContext(() => branch);
	manager.ensureInitialized(fakePi(sent), ctx, true);
	persistSentMarker(branch, sent[0]!);
	await manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true });
	expect(manager.hasPendingTrim()).toBe(false);
	manager.synchronize(ctx);
	expect(manager.hasPendingRollover(ctx)).toBe(true);
	expect(await manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(false);
	expect(sent).toHaveLength(2);
	persistSentMarker(branch, sent[1]!);
	manager.synchronize(ctx);
	expect(manager.hasPendingRollover(ctx)).toBe(false);
	expect(manager.hasPendingTrim()).toBe(true);
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

test("budget uses the provider-visible window after an upstream error", () => {
	const sent: Array<Record<string, unknown>> = [];
	const manager = new CodexContextWindowManager();
	const marker = rolloverMarker("w2");
	manager.restore([marker], "session-1");
	const markerMessage = {
		role: "custom",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
		details: marker.details,
	} as unknown as AgentMessage;
	const messages = [
		{ role: "user", content: "retired history ".repeat(50_000) } as unknown as AgentMessage,
		markerMessage,
		{ role: "user", content: "live window ".repeat(30_000) } as unknown as AgentMessage,
		{
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "503 no available Codex auth candidates",
		} as unknown as AgentMessage,
	];
	const ctx = {
		model: { contextWindow: 272_000 },
		sessionManager: {
			getBranch: () => [marker, assistantUsage(20_000)],
			getSessionId: () => "session-1",
		},
		// This is Pi's durable-transcript estimate. It includes retired remote
		// windows and is intentionally past the safety limit for this regression,
		// while the live window above is only about 90k tokens.
		getContextUsage: () => ({ contextWindow: 272_000, tokens: 270_000 }),
	} as never;

	manager.project(messages, "remote");
	manager.recordBudget(fakePi(sent), ctx, true, 5);

	expect(sent).toHaveLength(0);
	expect(manager.remaining(ctx).remainingTokens).toBeGreaterThan(0);
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
	expect(manager.hasPendingTrim()).toBe(false);
	expect(await manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(true);
	expect(manager.hasPendingTrim()).toBe(false);
	// The accepted marker is not persisted yet, so the trim cannot be consumed.
	const pendingEvent = { reason: "threshold", branchEntries: branch, preparation: { firstKeptEntryId: "keep", tokensBefore: 50 } } as never;
	expect(manager.prepareCompaction(pendingEvent)).toEqual({ cancel: true });

	persistSentMarker(branch, sent[0]!);
	manager.synchronize(ctx);
	const persistedEvent = { reason: "threshold", branchEntries: branch, preparation: { firstKeptEntryId: "keep", tokensBefore: 50 } } as never;
	const proposal = manager.prepareCompaction(persistedEvent);
	expect(proposal).toMatchObject({ compaction: { summary: CONTEXT_WINDOW_COMPACTION_SUMMARY } });
	expect(manager.hasPendingTrim()).toBe(true);
	if (!("compaction" in proposal)) throw new Error("Expected a trim proposal");
	branch.push({ type: "compaction", id: "committed-trim", parentId: branch.at(-1)?.id, timestamp: "now", ...proposal.compaction });
	manager.synchronize(ctx);
	expect(manager.hasPendingTrim()).toBe(false);
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

function headMessage(toolNames: string[]): AgentMessage {
	return {
		role: "system",
		content: "",
		sections: { preamble: "prompt" },
		toolsAdded: toolNames.map((name) => ({ name, description: name, parameters: {} })),
		timestamp: 1,
	} as unknown as AgentMessage;
}

function projectedWindowMarker(windowId: string, windowNumber: number): AgentMessage {
	return {
		role: "custom",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
		content: "window",
		display: true,
		details: {
			protocol: 1,
			id: `marker-${windowId}`,
			sessionId: "session-1",
			contextManagement: {
				protocol: 1,
				kind: "window",
				firstWindowId: "w1",
				currentWindowId: windowId,
				windowNumber,
			},
		},
		timestamp: 1,
	} as unknown as AgentMessage;
}

test("trims the previous window while re-anchoring the prompt and tool head", () => {
	const head = headMessage(["read", "bash"]);
	const oldTurn = { role: "user", content: "before", timestamp: 2 } as unknown as AgentMessage;
	const currentTurn = { role: "user", content: "after", timestamp: 3 } as unknown as AgentMessage;
	const secondMarker = projectedWindowMarker("w2", 1);
	const manager = new CodexContextWindowManager();

	const projected = manager.project([head, projectedWindowMarker("w1", 0), oldTurn, secondMarker, currentTurn], "remote");

	// Pi builds `params.tools` from transcript system messages only: without the rebuilt
	// head the new window would be sent with no tools at all.
	expect((projected[0] as unknown as { role?: string }).role).toBe("system");
	expect(declaredToolNames(projected)).toEqual(["read", "bash"]);
	expect(projected).toContain(secondMarker);
	expect(projected).toContain(currentTurn);
	expect(projected).not.toContain(oldTurn);
	expect(manager.takeProjectionDiagnostics()).toEqual([]);
});

test("the inactive projection drops markers but keeps the head", () => {
	const head = headMessage(["read"]);
	const manager = new CodexContextWindowManager();
	const turn = { role: "user", content: "keep", timestamp: 2 } as unknown as AgentMessage;

	const projected = manager.project([head, projectedWindowMarker("w1", 0), turn], "off");

	expect(projected).toEqual([head, turn]);
});

test("the manager remembers the head that a boundary compaction removed", () => {
	const head = headMessage(["read", "bash"]);
	const secondMarker = projectedWindowMarker("w2", 1);
	const oldTurn = { role: "user", content: "before", timestamp: 2 } as unknown as AgentMessage;
	const currentTurn = { role: "user", content: "after", timestamp: 3 } as unknown as AgentMessage;
	const manager = new CodexContextWindowManager();

	manager.project([head, projectedWindowMarker("w1", 0), oldTurn, secondMarker, currentTurn], "remote");

	// Pi's branch after the boundary compaction starts at the marker: the entry that
	// declared the tools is gone from the transcript entirely.
	const compacted = manager.project([secondMarker, currentTurn], "remote");

	expect((compacted[0] as unknown as { role?: string }).role).toBe("system");
	expect(declaredToolNames(compacted)).toEqual(["read", "bash"]);
	expect(compacted).toContain(currentTurn);
});

test("local projection trims retired windows, keeps the current tool head and leaves encrypted output unencoded", () => {
	const manager = new CodexContextWindowManager();
	manager.restore([rolloverMarker("w2")], "session-1");
	const identity = manager.currentIdentity();
	const head = headMessage(["read", "notes"]);
	const oldTurn = { role: "user", content: "retired history ".repeat(100_000), timestamp: 2 } as AgentMessage;
	const currentTurn = { role: "user", content: "local turn", timestamp: 3 } as AgentMessage;
	const toolResult = {
		role: "toolResult", toolCallId: "notes-call", toolName: "notes",
		content: [{ type: "text", text: "notes operation completed" }],
		details: { codexHistoryNotes: { encrypted_output: "opaque-value" } },
		isError: false, timestamp: 4,
	} as AgentMessage;
	const toolDelta = { role: "system", content: "", toolsRemoved: [{ name: "notes" }], timestamp: 5 } as unknown as AgentMessage;
	const reminder = { ...projectedWindowMarker("w2", 1), details: {
		protocol: 1, id: "reminder", sessionId: "session-1",
		contextManagement: { protocol: 1, kind: "reminder", firstWindowId: "w1", currentWindowId: "w2", windowNumber: 1 },
	} } as AgentMessage;
	const messages = [head, projectedWindowMarker("w1", 0), oldTurn, projectedWindowMarker("w2", 1), currentTurn, toolResult, toolDelta, reminder];
	const original = structuredClone(messages);

	const projected = manager.project(messages, "local");

	expect(declaredToolNames(projected)).toEqual(["read"]);
	expect(projected.slice(1)).toEqual([currentTurn, toolResult]);
	expect(JSON.stringify(projected.map((message) => "content" in message ? message.content : undefined))).not.toContain("opaque-value");
	expect(projected[2]).toBe(toolResult);
	expect(manager.currentIdentity()).toEqual(identity);
	expect(manager.hasPendingTrim()).toBe(true);
	expect(messages).toEqual(original);
});

test("local projection uses the persisted boundary, not a queued rollover, and keeps its guard", async () => {
	const manager = new CodexContextWindowManager(async () => undefined);
	const marker = windowMarker("w1");
	const ctx = fakeContext([marker]);
	const sent: Array<Record<string, unknown>> = [];
	manager.synchronize(ctx);
	await manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true });
	const queued = { role: "custom", customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, content: "queued", details: sent[0]!.details, display: true, timestamp: 1 } as AgentMessage;
	// The runtime synchronizes from the branch before projection.
	manager.synchronize(ctx);
	const identity = manager.currentIdentity();
	const turn = { role: "user", content: "still in persisted window", timestamp: 2 } as AgentMessage;
	expect(manager.project([projectedWindowMarker("w1", 0), turn, queued], "local")).toEqual([turn]);
	expect(manager.currentIdentity()).toEqual(identity);
	expect(manager.hasPendingRollover(ctx)).toBe(true);
	expect(await manager.startNewWindow(fakePi(sent), ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(false);
	expect(sent).toHaveLength(1);
});

test("local projection without a persisted boundary only strips internal markers", () => {
	const manager = new CodexContextWindowManager();
	const head = headMessage(["read"]);
	const turn = { role: "user", content: "keep", timestamp: 2 } as AgentMessage;
	expect(manager.project([head, projectedWindowMarker("w1", 0), turn], "local")).toEqual([head, turn]);
	expect(manager.currentIdentity()).toBeUndefined();
});

test("a missing local boundary fails closed without clearing the persisted identity or trim", () => {
	const manager = new CodexContextWindowManager();
	manager.restore([rolloverMarker("w2")], "session-1");
	const identity = manager.currentIdentity();
	expect(() => manager.project([{ role: "user", content: "retired", timestamp: 1 }], "local")).toThrow("boundary missing");
	expect(manager.currentIdentity()).toEqual(identity);
	expect(manager.hasPendingTrim()).toBe(true);
});

test("detached compaction needs a persisted boundary but no scheduled trim and does not consume a proposal", () => {
	const manager = new CodexContextWindowManager();
	const marker = windowMarker("w1");
	manager.restore([marker], "session-1");
	const identity = manager.currentIdentity();
	const event = { branchEntries: [marker], preparation: { firstKeptEntryId: "other", tokensBefore: 400_000 } } as never;
	const expected = { compaction: {
		summary: CONTEXT_WINDOW_COMPACTION_SUMMARY, firstKeptEntryId: marker.id, tokensBefore: 0,
		details: { protocol: 1, strategy: "codex-context-window", windowId: "w1" },
	} };
	expect(manager.hasPendingTrim()).toBe(false);
	expect(manager.prepareDetachedCompaction(event)).toEqual(expected);
	expect(manager.prepareDetachedCompaction(event)).toEqual(expected);
	expect(manager.prepareCompaction(event)).toEqual({ cancel: true });
	expect(manager.currentIdentity()).toEqual(identity);
	expect(manager.prepareDetachedCompaction({ branchEntries: [], preparation: {} } as never)).toBeUndefined();
});

test("a consumed detached boundary yields to the ordinary chain instead of cancelling", () => {
	const sm = SessionManager.inMemory("/synthetic-project");
	sm.appendMessage({ role: "user", content: "retired pre-window history", timestamp: 1 });
	const marker = sm.appendCustomMessageEntry(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, "window", true, {
		protocol: 1, id: "marker-w2", sessionId: sm.getSessionId(),
		contextManagement: { protocol: 1, kind: "window", firstWindowId: "w1", currentWindowId: "w2",
			previousWindowId: "w1", windowNumber: 1, trimPreviousWindow: true },
	});
	sm.appendMessage({ role: "user", content: "current window work", timestamp: 2 });
	sm.appendMessage(fauxAssistantMessage("current work", { timestamp: 3 }));
	const manager = new CodexContextWindowManager(async () => undefined);
	manager.synchronize({ sessionManager: sm } as never);
	const event = () => ({ branchEntries: sm.getBranch(), preparation: { tokensBefore: 100 } }) as never;

	// First attempt detaches at the durable boundary without summarizing anything.
	const proposal = manager.prepareDetachedCompaction(event());
	if (!proposal || !("compaction" in proposal)) throw new Error("Expected a no-summary detachment");
	expect(proposal.compaction.summary).toBe(CONTEXT_WINDOW_COMPACTION_SUMMARY);
	expect(proposal.compaction.firstKeptEntryId).toBe(marker);
	const { summary, firstKeptEntryId, tokensBefore, details } = proposal.compaction;
	sm.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, true);
	manager.synchronize({ sessionManager: sm } as never);

	// Once persisted, the scheduled-trim path still refuses (a second boundary would
	// move retention backwards) but a local consumer must continue to the ordinary chain.
	expect(manager.prepareCompaction(event())).toEqual({ cancel: true });
	expect(manager.prepareDetachedCompaction(event())).toBeUndefined();
	expect(manager.currentIdentity()?.currentWindowId).toBe("w2");
});

function remoteCompactionWindow(includeHead = true) {
	const sm = SessionManager.inMemory("/synthetic-project");
	const headId = includeHead ? sm.appendMessage(headMessage(["read", "notes"])) : undefined;
	sm.appendMessage({ role: "user", content: "RETIRED-COMPACTION-HISTORY", timestamp: 2 });
	const boundaryId = sm.appendCustomMessageEntry(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, "current window", true, {
		protocol: 1, id: "marker-w2", sessionId: sm.getSessionId(),
		contextManagement: { protocol: 1, kind: "window", firstWindowId: "w1", currentWindowId: "w2",
			previousWindowId: "w1", windowNumber: 1, trimPreviousWindow: true },
	});
	sm.appendMessage({ role: "user", content: "CURRENT-COMPACTION-HISTORY", timestamp: 3 });
	sm.appendMessage(fauxAssistantMessage("current answer", { timestamp: 4 }));
	const ctx = { sessionManager: sm } as never;
	const manager = new CodexContextWindowManager(async () => undefined);
	manager.synchronize(ctx);
	const event = () => ({ branchEntries: sm.getBranch(), preparation: { firstKeptEntryId: headId ?? boundaryId, tokensBefore: 1000 } }) as never;
	return { sm, ctx, manager, headId, boundaryId, event };
}

test("strict remote compression uses canonical current-window messages and real safe source IDs", () => {
	const h = remoteCompactionWindow();
	const before = structuredClone(h.sm.getBranch());
	const prepared = h.manager.prepareRemoteCompaction(h.event(), h.ctx);
	expect(prepared.firstKeptEntryId).toBe(h.boundaryId);
	expect(prepared.owningCompaction).toBeUndefined();
	expect(declaredToolNames(prepared.messages)).toEqual(["read", "notes"]);
	expect(JSON.stringify(prepared.messages)).toContain("CURRENT-COMPACTION-HISTORY");
	expect(JSON.stringify(prepared.messages)).not.toContain("RETIRED-COMPACTION-HISTORY");
	expect(h.sm.getBranch()).toEqual(before);
	expect(h.manager.hasPendingTrim()).toBe(true); // Preparation did not consume maintenance.
});

test("strict remote compression cannot resurrect a remembered head missing from canonical input", () => {
	const h = remoteCompactionWindow();
	const messages = h.sm.buildSessionProjection().messages;
	h.manager.project(messages, "remote"); // Populate the ordinary live fallback head.
	expect(() => h.manager.projectCompactionContext(messages.filter((message) => (message.role as string) !== "system")))
		.toThrow("compaction-system-tool-head-lost");
	const missing = remoteCompactionWindow(false);
	expect(() => missing.manager.prepareRemoteCompaction(missing.event(), missing.ctx)).toThrow("compaction-system-tool-head-lost");
});

for (const invalidCleanup of ["summary", "owner", "window", "retained-start"] as const) {
	test(`strict remote compression rejects a forged Toolkit cleanup (${invalidCleanup})`, () => {
		const h = remoteCompactionWindow();
		h.sm.appendCompaction(invalidCleanup === "summary" ? "unrelated foreign summary" : CONTEXT_WINDOW_COMPACTION_SUMMARY,
			invalidCleanup === "retained-start" ? h.sm.getLeafId()! : h.boundaryId, 100,
			{ protocol: 1, strategy: "codex-context-window", windowId: invalidCleanup === "window" ? "wrong-window" : "w2" }, invalidCleanup !== "owner");
		expect(() => h.manager.prepareRemoteCompaction(h.event(), h.ctx)).toThrow("unverified-window-cleanup");
	});
}

test("strict remote compression refuses an unpersisted rollover without consuming its duplicate guard", async () => {
	const h = remoteCompactionWindow();
	const sent: Array<Record<string, unknown>> = [];
	await h.manager.startNewWindow(fakePi(sent), h.ctx, { triggerTurn: true, trimPreviousWindow: true });
	expect(() => h.manager.prepareRemoteCompaction(h.event(), h.ctx)).toThrow("unsafe-compaction-window-boundary");
	expect(h.manager.hasPendingRollover(h.ctx)).toBe(true);
	expect(sent).toHaveLength(1);
});

test("read-only compression projection stays scoped across awaits without suppressing another live request", async () => {
	const h = remoteCompactionWindow();
	let release!: () => void;
	const suspended = new Promise<void>((resolve) => { release = resolve; });
	const preparing = h.manager.withCompactionProjection(async () => {
		expect(h.manager.isPreparingCompaction).toBe(true);
		await suspended;
		expect(h.manager.isPreparingCompaction).toBe(true);
		return h.manager.project(h.sm.buildSessionProjection().messages, "remote");
	});
	expect(h.manager.isPreparingCompaction).toBe(false);
	h.manager.project(h.sm.buildSessionProjection().messages, "remote");
	release();
	expect(JSON.stringify(await preparing)).not.toContain("RETIRED-COMPACTION-HISTORY");
	expect(h.manager.isPreparingCompaction).toBe(false);
});
