import { expect, test } from "bun:test";
import { SessionManager, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE } from "./messages";
import { prepareScopedNativeCompaction } from "./scoped-compaction";
import { CodexContextWindowManager } from "./window-manager";

function fixture() {
	const sm = SessionManager.inMemory("/scoped-compaction-test");
	sm.appendMessage({ role: "system", content: "CURRENT-SYSTEM-HEAD", timestamp: 1 });
	const retiredId = sm.appendMessage({ role: "user", content: "RETIRED-PLAINTEXT".repeat(10000), timestamp: 2 });
	const tool = (id: string, path: string) => {
		const call = sm.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path }, { id })));
		const result = sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `${path} content` }], isError: false, timestamp: 3 });
		return { call, result };
	};
	tool("retired-call", "RETIRED-FILE-PATH");
	sm.appendCompaction("RETIRED-SUMMARY", retiredId, 100, { readFiles: ["RETIRED-METADATA-PATH"], modifiedFiles: [] });
	const boundaryId = sm.appendCustomMessageEntry(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, "current window", true, {
		protocol: 1, id: "current-marker", sessionId: sm.getSessionId(), contextManagement: { protocol: 1, kind: "window",
			firstWindowId: "w0", currentWindowId: "w1", windowNumber: 1, trimPreviousWindow: true },
	});
	const currentId = sm.appendMessage({ role: "user", content: "RAW-SECRET-REPLACED", timestamp: 4 });
	sm.appendContextEdit(currentId, { content: "CANONICAL-CURRENT-EDIT" });
	tool("current-call", "CURRENT-FILE-PATH");
	const removed = tool("removed-call", "OMITTED-FILE-PATH");
	sm.appendContextEdit(removed.call, null);
	sm.appendContextEdit(removed.result, null);
	const windows = new CodexContextWindowManager(async () => undefined);
	const ctx = { sessionManager: sm, getContextUsage: () => undefined } as ExtensionContext;
	const prepare = (keepRecentTokens = 128) => {
		windows.synchronize(ctx);
		const event: SessionBeforeCompactEvent = {
			type: "session_before_compact", reason: "manual", willRetry: false, branchEntries: sm.getBranch(), signal: new AbortController().signal,
			preparation: { firstKeptEntryId: retiredId, tokensBefore: 700000, previousSummary: "RETIRED-RAW-PREPARATION",
				messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false,
				fileOps: { read: new Set(["RETIRED-RAW-FILE-PATH"]), written: new Set(), edited: new Set() },
				settings: { enabled: true, keepRecentTokens, reserveTokens: 2048 } },
		};
		const scope = windows.prepareRemoteCompaction(event, ctx);
		return { event, scope, result: prepareScopedNativeCompaction(event, scope) };
	};
	return { sm, ctx, windows, currentId, boundaryId, prepare };
}

test("scoped native preparation honors canonical edits, omissions, real cut IDs and only current file operations", () => {
	const f = fixture();
	const tailId = f.sm.appendMessage({ role: "user", content: "RECENT-KEPT-TAIL ".repeat(200), timestamp: 5 });
	f.sm.appendMessage(fauxAssistantMessage("recent answer"));
	const before = structuredClone(f.sm.getBranch());
	const { event, result } = f.prepare();
	const wire = JSON.stringify(result.preparation);
	expect(wire).toContain("CANONICAL-CURRENT-EDIT");
	for (const excluded of ["RAW-SECRET-REPLACED", "OMITTED-FILE-PATH", "RETIRED-"]) expect(wire).not.toContain(excluded);
	expect(result.preparation.firstKeptEntryId).toBe(tailId);
	expect(result.preparation.previousSummary).toBeUndefined();
	expect([...result.preparation.fileOps.read]).toEqual(["CURRENT-FILE-PATH"]);
	expect(result.preparation.tokensBefore).toBeLessThan(2000);
	expect(result.preparation.messagesToSummarize.some((message) => message.role === "toolResult")).toBe(true);
	expect(event.preparation.previousSummary).toBe("RETIRED-RAW-PREPARATION");
	expect(f.sm.getBranch()).toEqual(before);
});

test("scoped native recursion merges only the owning text checkpoint and never retains before it", () => {
	const f = fixture();
	const checkpointId = f.sm.appendCompaction("CURRENT-OWNED-NATIVE-SUMMARY", f.currentId, 100,
		{ readFiles: ["CURRENT-OWNED-READ"], modifiedFiles: ["CURRENT-OWNED-EDIT"] });
	const tailId = f.sm.appendMessage({ role: "user", content: "NEW-ACTUAL-USER-ENTRY", timestamp: 10 });
	f.sm.appendMessage(fauxAssistantMessage("new answer"));
	// Even when the recent-token budget would retain all visible context, a
	// newly saved checkpoint must not point backwards through its existing owner.
	const { result } = f.prepare(100000);
	expect(result.preparation.firstKeptEntryId).toBe(tailId);
	expect(f.sm.getBranch().findIndex((entry) => entry.id === tailId)).toBeGreaterThan(f.sm.getBranch().findIndex((entry) => entry.id === checkpointId));
	expect(result.preparation.previousSummary).toBe("CURRENT-OWNED-NATIVE-SUMMARY");
	expect([...result.preparation.fileOps.read]).toEqual(["CURRENT-OWNED-READ", "CURRENT-FILE-PATH"]);
	expect([...result.preparation.fileOps.edited]).toEqual(["CURRENT-OWNED-EDIT"]);
	expect(JSON.stringify(result.preparation)).not.toContain("RETIRED-");
	expect(JSON.stringify(result.preparation.messagesToSummarize)).toContain("CANONICAL-CURRENT-EDIT");
});

test("a native cut cannot invent an intra-source retention ID when canonical contributions are ambiguous", () => {
	const f = fixture();
	f.sm.appendMessage({ role: "user", content: "RECENT-KEPT-TAIL ".repeat(200), timestamp: 5 });
	const { event, scope } = f.prepare();
	const source = scope.entries.find((entry) => entry.sourceEntry.id === f.currentId)!;
	source.messages.push({ role: "user", content: "SECOND-CONTRIBUTION-SAME-ID", timestamp: 7 });
	expect(() => prepareScopedNativeCompaction(event, scope)).toThrow("compaction-source-projection-unavailable");
});
