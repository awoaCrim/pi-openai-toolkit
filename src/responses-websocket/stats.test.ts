import { expect, test } from "bun:test";
import { recordSend, clearSendStats, formatSendStats } from "./stats";
import { randomUUID } from "node:crypto";

test("independently loaded modules see the same per-session counters", async () => {
	const a = await import(`./stats.ts?instance=${randomUUID()}`);
	const b = await import(`./stats.ts?instance=${randomUUID()}`);
	const id = randomUUID();
	a.recordSend(id, { transport: "websocket", mode: "full", reason: "new connection", bytes: 100, items: 1, at: 0 });
	b.recordSend(id, { transport: "websocket", mode: "delta", reason: "matched continuation", bytes: 10, items: 1, at: 1 });
	expect(a.formatSendStats(id)).toContain("全量 1 次，增量 1 次");
	expect(b.formatSendStats(id)).toBe(a.formatSendStats(id));
	a.clearSendStats(id);
});

test("reports changed setting names without their values", () => {
	recordSend("settings-fields", { transport: "websocket", mode: "full", reason: "request settings changed",
		changedFields: ["instructions", "tools"], bytes: 100, items: 1, at: 0 });
	expect(formatSendStats("settings-fields")).toContain("请求设置发生变化（instructions, tools）");
	clearSendStats("settings-fields");
});

test("counts full and delta sends, isolates sessions, and clears", () => {
	const record = { transport: "websocket" as const, mode: "full" as const, reason: "new connection", bytes: 123, items: 10, at: 0 };
	recordSend("stats-a", record);
	recordSend("stats-a", { ...record, mode: "delta", bytes: 12, items: 1 });
	recordSend("stats-a", { ...record, transport: "sse-fallback" });
	expect(formatSendStats("stats-a")).toContain("全量 2 次，增量 1 次，SSE 回退 1 次");
	expect(formatSendStats("stats-a")).toContain("12 字节 | 1 条输入");
	expect(formatSendStats("stats-b")).toContain("暂无传输数据");
	clearSendStats("stats-a");
	expect(formatSendStats("stats-a")).toContain("暂无传输数据");
});

test("bounds recent samples while retaining totals", () => {
	for (let i = 0; i < 10; i++) recordSend("stats-bounded", { transport: "websocket", mode: "full", reason: `sample-${i}`, bytes: 1, items: 1, at: 0 });
	const text = formatSendStats("stats-bounded");
	expect(text).toContain("全量 10 次");
	expect(text).not.toContain("sample-4");
	expect(text).toContain("sample-5");
	clearSendStats("stats-bounded");
});
