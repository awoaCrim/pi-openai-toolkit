import { expect, test } from "bun:test";
import { recordSend, clearSendStats, formatSendStats } from "./stats";

test("counts full and delta sends, isolates sessions, and clears", () => {
	const record = { transport: "websocket" as const, mode: "full" as const, reason: "new connection", bytes: 123, items: 10, at: 0 };
	recordSend("stats-a", record);
	recordSend("stats-a", { ...record, mode: "delta", bytes: 12, items: 1 });
	recordSend("stats-a", { ...record, transport: "sse-fallback" });
	expect(formatSendStats("stats-a")).toContain("full 2, delta 1, SSE fallbacks 1");
	expect(formatSendStats("stats-a")).toContain("12 bytes | 1 input items");
	expect(formatSendStats("stats-b")).toContain("No transport samples");
	clearSendStats("stats-a");
	expect(formatSendStats("stats-a")).toContain("No transport samples");
});

test("bounds recent samples while retaining totals", () => {
	for (let i = 0; i < 10; i++) recordSend("stats-bounded", { transport: "websocket", mode: "full", reason: `sample-${i}`, bytes: 1, items: 1, at: 0 });
	const text = formatSendStats("stats-bounded");
	expect(text).toContain("full 10");
	expect(text).not.toContain("sample-4");
	expect(text).toContain("sample-5");
	clearSendStats("stats-bounded");
});
