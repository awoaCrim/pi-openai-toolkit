import { expect, test } from "bun:test";
import { createFallbackNotifier, observeContinuation, reportContinuation } from "./notifications";

test("only unexpected fallback warns, dedupes, and rearms after delta", () => {
	const messages: string[] = [];
	const listener = createFallbackNotifier(message => messages.push(message));
	listener("expected-full");
	listener("delta");
	expect(messages).toHaveLength(0);
	listener("prefix-mismatch");
	listener("prefix-mismatch");
	expect(messages).toHaveLength(1);
	listener("delta");
	listener("prefix-mismatch");
	expect(messages).toHaveLength(2);
});

test("session isolation, disposal, and UI failure do not affect requests", () => {
	const a: string[] = [], b: string[] = [];
	const offA = observeContinuation("a", createFallbackNotifier(message => a.push(message)));
	const offB = observeContinuation("b", createFallbackNotifier(message => b.push(message)));
	const offThrow = observeContinuation("a", () => { throw new Error("UI unavailable"); });
	expect(() => reportContinuation("a", "prefix-mismatch")).not.toThrow();
	expect(a).toHaveLength(1);
	expect(b).toHaveLength(0);
	offA(); offA();
	reportContinuation("a", "delta");
	reportContinuation("a", "prefix-mismatch");
	expect(a).toHaveLength(1);
	offB(); offThrow();
});
