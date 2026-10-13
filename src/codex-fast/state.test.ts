import { describe, expect, test } from "bun:test";
import { CODEX_FAST_ENTRY_TYPE, readCodexFastState } from "./state";

const entry = (enabled: unknown, sessionId: unknown = "session", version: unknown = 1) => ({
	type: "custom", customType: CODEX_FAST_ENTRY_TYPE, data: { version, sessionId, enabled },
});

describe("session-only Codex Fast state", () => {
	test("empty or missing identity is OFF; last owned boolean wins", () => {
		expect(readCodexFastState([], "session")).toBe(false);
		expect(readCodexFastState([entry(true)], undefined)).toBe(false);
		expect(readCodexFastState([entry(true)], "")).toBe(false);
		expect(readCodexFastState([entry(false), entry(true)], "session")).toBe(true);
		expect(readCodexFastState([entry(true), entry(false)], "session")).toBe(false);
	});
	test("foreign fork/copied entries and unrelated entry types cannot enable", () => {
		expect(readCodexFastState([entry(true)], "fork")).toBe(false);
		expect(readCodexFastState([entry(true), entry(false, "other")], "session")).toBe(true);
		expect(readCodexFastState([{ ...entry(true), type: "message" }, { ...entry(true), customType: "other" }], "session")).toBe(false);
	});
	for (const malformed of [entry("true"), entry(1), entry(null), entry(true, "session", 2), entry(true, 7),
		{ type: "custom", customType: CODEX_FAST_ENTRY_TYPE, data: null },
		{ type: "custom", customType: CODEX_FAST_ENTRY_TYPE },
	]) {
		test("malformed newest preference cannot resurrect ON: " + JSON.stringify(malformed), () => {
			expect(readCodexFastState([entry(true), malformed], "session")).toBe(false);
		});
	}
	test("projection/branch caller chooses its own history, not file timestamps", () => {
		const a = { ...entry(true), timestamp: "later-time" };
		const b = { ...entry(false), timestamp: "earlier-time" };
		expect(readCodexFastState([a], "session")).toBe(true);
		expect(readCodexFastState([a, b], "session")).toBe(false);
		expect(readCodexFastState([null, [], {}, a], "session")).toBe(true);
	});
});
