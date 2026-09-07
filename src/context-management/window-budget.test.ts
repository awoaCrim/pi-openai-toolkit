import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ContextWindowBudget } from "./window-budget";
import { CONTEXT_WINDOW_FALLBACK_BUFFER } from "./types";

const CONTEXT_WINDOW = 272_000;
const identity = {
	firstWindowId: "win-1",
	currentWindowId: "win-1",
	windowNumber: 0,
};

function makeContext(usedTokens: number): ExtensionContext {
	return {
		model: { contextWindow: CONTEXT_WINDOW } as never,
		getContextUsage: () => ({ contextWindow: CONTEXT_WINDOW, tokens: usedTokens }) as never,
	} as never;
}

test("default 5% triggers a reminder once per window", () => {
	const budget = new ContextWindowBudget();
	// limit = contextWindow - fallback buffer; 5% threshold of that limit
	const limit = CONTEXT_WINDOW - CONTEXT_WINDOW_FALLBACK_BUFFER;
	const threshold = Math.floor((limit * 5) / 100);
	const justAbove = budget.record(makeContext(limit - threshold - 1), identity, undefined, 5);
	expect(justAbove).toBeUndefined();

	const atThreshold = budget.record(makeContext(limit - threshold), identity, undefined, 5);
	expect(atThreshold?.kind).toBe("reminder");
	expect(atThreshold?.content).toContain("context tokens remain");

	// second record for the same window must not re-remind
	const again = budget.record(makeContext(limit - threshold), identity, undefined, 5);
	expect(again).toBeUndefined();
});

test("percent 0 disables reminders but keeps fallback", () => {
	const budget = new ContextWindowBudget();
	const limit = CONTEXT_WINDOW - CONTEXT_WINDOW_FALLBACK_BUFFER;
	const nearFull = budget.record(makeContext(limit - 1), identity, undefined, 0);
	expect(nearFull).toBeUndefined();

	const exhausted = budget.record(makeContext(limit), identity, undefined, 0);
	expect(exhausted?.kind).toBe("fallback");
});

test("higher percent reminds earlier", () => {
	const budget = new ContextWindowBudget();
	const limit = CONTEXT_WINDOW - CONTEXT_WINDOW_FALLBACK_BUFFER;
	// 20% threshold: at 10% remaining it should already remind
	const used = limit - Math.floor((limit * 10) / 100);
	const reminder = budget.record(makeContext(used), identity, undefined, 20);
	expect(reminder?.kind).toBe("reminder");
});

test("fallback fires when remaining hits zero even with percent disabled", () => {
	const budget = new ContextWindowBudget();
	const limit = CONTEXT_WINDOW - CONTEXT_WINDOW_FALLBACK_BUFFER;
	const reminder = budget.record(makeContext(limit), identity, undefined, 0);
	expect(reminder?.kind).toBe("fallback");
});

test("restore re-arms persisted reminder state to prevent re-reminding", () => {
	const budget = new ContextWindowBudget();
	const limit = CONTEXT_WINDOW - CONTEXT_WINDOW_FALLBACK_BUFFER;
	const threshold = Math.floor((limit * 5) / 100);

	// Simulate a restored session where the reminder already fired: after
	// restore, the same window must not be reminded again.
	budget.restore("reminder", identity.currentWindowId);
	const afterRestore = budget.record(makeContext(limit - threshold), identity, undefined, 5);
	expect(afterRestore).toBeUndefined();

	// A fresh window id still reminds normally.
	const fresh = { ...identity, currentWindowId: "win-2" };
	expect(budget.record(makeContext(limit - threshold), fresh, undefined, 5)?.kind).toBe("reminder");
});
