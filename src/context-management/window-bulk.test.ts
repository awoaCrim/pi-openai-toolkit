import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE } from "./messages";
import {
	decideBulkCliffAction,
	decideBulkCloseOut,
	measureWindowBulk,
	type WindowBulkReport,
} from "./window-bulk";

function windowMarker(windowId: string): AgentMessage {
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
				windowNumber: windowId === "w1" ? 0 : 1,
			},
		},
		timestamp: 1,
	} as unknown as AgentMessage;
}

function turn(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `tc-${text.slice(0, 8)}`,
		toolName: "bash",
		isError: false,
		content: [{ type: "text", text }],
		timestamp: 2,
	} as unknown as AgentMessage;
}

const RETIRED_BULK = "x".repeat(400_000);

test("a transcript without a retired window reports nothing", () => {
	expect(
		measureWindowBulk({ messages: [turn("a"), turn("b")], contextWindow: 272_000 }),
	).toBeUndefined();
	// The very first window has retired nothing, so there is no cliff to measure.
	expect(
		measureWindowBulk({
			messages: [windowMarker("w1"), turn("a")],
			contextWindow: 272_000,
		}),
	).toBeUndefined();
});

test("the durable view is compared against the windowed view", () => {
	const report = measureWindowBulk({
		messages: [
			windowMarker("w1"),
			turn(RETIRED_BULK),
			windowMarker("w2"),
			turn("small"),
		],
		contextWindow: 272_000,
	});

	expect(report).toBeDefined();
	expect(report!.unmanagedTokens).toBeGreaterThan(report!.managedTokens * 2);
	expect(report!.expanded).toBe(true);
	expect(report!.managedTokens).toBeLessThan(64);
	expect(report!.windowId).toBe("w2");
	expect(report!.targetContextWindow).toBe(272_000);
});

test("over budget means the durable view would not fit the target window", () => {
	const messages = [
		windowMarker("w1"),
		turn(RETIRED_BULK),
		windowMarker("w2"),
		turn("small"),
	];

	const narrow = measureWindowBulk({ messages, contextWindow: 20_000 });
	const wide = measureWindowBulk({ messages, contextWindow: 10_000_000 });

	expect(narrow?.overBudget).toBe(true);
	expect(wide?.overBudget).toBe(false);
	// A missing window size is never guessed at.
	expect(measureWindowBulk({ messages, contextWindow: undefined })?.targetContextWindow).toBe(0);
});

test("markers that were already retired stay out of the durable total", () => {
	const withMarkers = measureWindowBulk({
		messages: [windowMarker("w1"), turn(RETIRED_BULK), windowMarker("w2"), turn("small")],
		contextWindow: 272_000,
	})!;
	const withoutMarkers = measureWindowBulk({
		messages: [turn(RETIRED_BULK), windowMarker("w2"), turn("small")],
		contextWindow: 272_000,
	})!;

	expect(withMarkers.unmanagedTokens).toBe(withoutMarkers.unmanagedTokens);
});

function report(overrides: Partial<WindowBulkReport>): WindowBulkReport {
	return {
		windowId: "w2",
		unmanagedTokens: 400_000,
		managedTokens: 20_000,
		targetContextWindow: 272_000,
		expanded: true,
		overBudget: true,
		...overrides,
	};
}

test("only the compact policy closes a cliff that is also over budget", () => {
	expect(decideBulkCliffAction(report({}), "compact")).toBe("compact");
	expect(decideBulkCliffAction(report({ overBudget: false }), "compact")).toBe("warn");
	expect(decideBulkCliffAction(report({}), "warn")).toBe("warn");
	expect(decideBulkCliffAction(report({ expanded: false }), "compact")).toBe("ignore");
	expect(decideBulkCliffAction(report({ expanded: false }), "warn")).toBe("ignore");
});

test("a close-out is only executed where a compaction can finish", () => {
	const base = { action: "compact" as const, mode: "tui", trigger: "model-switch" as const, hasPendingTrim: false };

	expect(decideBulkCloseOut(base)).toBe("compact");
	// Print mode exits with the turn and would kill the summary mid-request.
	expect(decideBulkCloseOut({ ...base, mode: "print" })).toBe("warn");
	// A turn-end close-out needs the queued trim, or the window policy cancels the compaction.
	expect(decideBulkCloseOut({ ...base, trigger: "turn-end", hasPendingTrim: false })).toBe("warn");
	expect(decideBulkCloseOut({ ...base, trigger: "turn-end", hasPendingTrim: true })).toBe("compact");
	// Warnings are never promoted.
	expect(decideBulkCloseOut({ ...base, action: "warn" })).toBe("warn");
	expect(decideBulkCloseOut({ ...base, action: "ignore" })).toBe("ignore");
});
