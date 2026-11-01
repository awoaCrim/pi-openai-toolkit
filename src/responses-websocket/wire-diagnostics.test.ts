import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	CACHE_DIAGNOSTIC_MISS_LIMIT, CACHE_DIAGNOSTIC_RECENT_LIMIT, CACHE_DIAGNOSTIC_TTL_MS,
	clearCacheDiagnostics, clearWireDiagnostics, formatWireDiagnostics, getCacheDiagnostics,
	recordWireFailure, recordWireRequest, recordWireResponse, recordWireSend,
} from "./wire-diagnostics";

const model = { provider: "test", id: "gpt-test", compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } };
const ids = new Set<string>();
function request(sid: string, body: Record<string, unknown> = { input: [] }) {
	ids.add(sid);
	return recordWireRequest(sid, model, body)!;
}
function response(sid: string, receipt: ReturnType<typeof request>, input = 100_000, cached: unknown = 0, tier?: unknown) {
	recordWireResponse(sid, receipt, { type: "response.completed", response: {
		id: "private-response-id", service_tier: tier,
		usage: { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: 10 },
		output: [{ text: "private-output" }],
	} });
}
afterEach(() => {
	for (const id of ids) { clearWireDiagnostics(id); clearCacheDiagnostics(id); }
	ids.clear();
});
test("detects a changed first tool batch without retaining original fields", () => {
	const sid = "wire-changed";
	request(sid, { input: [{ type: "additional_tools", tools: [{ name: "private-tool-name" }] }], prompt_cache_key: "private-cache-key" });
	request(sid, { input: [{ type: "additional_tools", tools: [{ name: "private-tool-name" }, { name: "new-tool" }] }], prompt_cache_key: "private-cache-key" });
	const text = formatWireDiagnostics(sid);
	expect(text).toContain("变化，首个位置 0");
	expect(text).toContain("追加批次=0:2");
	expect(text).not.toContain("private-tool-name");
	expect(text).not.toContain("private-cache-key");
	clearWireDiagnostics(sid);
});
test("preserves the input prefix, tracks settings separately, and is key-order independent", () => {
	const sid = "wire-prefix";
	request(sid, { input: [{ type: "message", content: "private-prompt" }], tools: [], max_output_tokens: 4096 });
	request(sid, { input: [{ content: "private-prompt", type: "message" }, { type: "additional_tools", tools: [{}] }], tools: [], max_output_tokens: 2048 });
	const text = formatWireDiagnostics(sid);
	expect(text).toContain("旧请求前缀=保留");
	expect(text).toContain("请求设置变化=max_output_tokens");
	expect(text).not.toContain("private-prompt");
	clearWireDiagnostics(sid);
});
test("records actual disabled capabilities and model switches establish fresh baselines", () => {
	const sid = "wire-flags";
	ids.add(sid);
	recordWireRequest(sid, { ...model, compat: {} }, { input: [], tools: [{}] });
	expect(formatWireDiagnostics(sid)).toContain("中途系统提示=关、增量工具=关");
	recordWireRequest(sid, { ...model, id: "other" }, { input: [] });
	expect(formatWireDiagnostics(sid)).toContain("首次基线");
	clearWireDiagnostics(sid);
});
test("sessions are isolated and only five recent records remain", () => {
	for (let i = 0; i < 8; i++) request("wire-bounds", { input: Array(i).fill({ role: "user" }) });
	expect(formatWireDiagnostics("wire-bounds").match(/实际能力/g)).toHaveLength(5);
	expect(getCacheDiagnostics("wire-bounds").recent).toHaveLength(8);
	expect(formatWireDiagnostics("other-session")).toBe("暂无发送位置指纹。");
	clearWireDiagnostics("wire-bounds");
});

test("correlates out-of-order responses with their own immutable request receipt", () => {
	const sid = randomUUID(), socket = {};
	const a = request(sid, { input: [{ text: "one" }], service_tier: "default" });
	const b = request(sid, { input: [{ text: "one" }, { text: "two" }], service_tier: "priority" });
	const send = { transport: "websocket" as const, mode: "delta" as const, reason: "matched continuation", bytes: 100, items: 1, at: Date.now() };
	recordWireSend(a, send, socket);
	recordWireSend(b, send, socket);
	response(sid, b, 200_000, 1000, "default");
	response(sid, a, 100_000, 99_000, "default");
	const result = getCacheDiagnostics(sid);
	expect(result.recent.map(r => r.usage?.input)).toEqual([100_000, 200_000]);
	expect(result.misses.map(r => r.sequence)).toEqual([b.sequence]);
	expect(a.connection).toBe(b.connection);
	expect(b.requestedTier).toBe("priority");
	expect(b.returnedTier).toBe("default");
	expect(b.changedSettings).toEqual(["service_tier"]);
	expect(b.prefix).toBe("preserved");
	expect(a.inputFingerprint).not.toBe(b.inputFingerprint);
});

for (const [input, cached, severe] of [
	[49_999, 0, false], [50_000, 4999, true], [50_000, 5000, false],
	[50_000, undefined, false], [50_000, -1, false], [50_000, 50_001, false],
	[50_000, "private-cached-value", false],
] as const) {
	test(`classifies only valid severe misses (${input}, ${cached})`, () => {
		const sid = randomUUID(), receipt = request(sid);
		if (cached === undefined) {
			recordWireResponse(sid, receipt, { type: "response.completed", response: { usage: { input_tokens: input } } });
		} else response(sid, receipt, input, cached);
		expect(receipt.severeMiss === true).toBe(severe);
		expect(getCacheDiagnostics(sid).misses).toHaveLength(severe ? 1 : 0);
		if (cached === undefined || typeof cached !== "number" || cached < 0 || cached > input) {
			expect(receipt.usage?.cached).toBeUndefined();
		}
	});
}

test("keeps severe misses after recent requests roll over and session resources are released", () => {
	const sid = randomUUID(), bad = request(sid);
	response(sid, bad);
	for (let i = 0; i < 70; i++) response(sid, request(sid), 100_000, 99_000);
	clearWireDiagnostics(sid);
	const result = getCacheDiagnostics(sid);
	expect(result.recent).toHaveLength(CACHE_DIAGNOSTIC_RECENT_LIMIT);
	expect(result.recent.some(r => r.sequence === bad.sequence)).toBe(false);
	expect(result.misses.map(r => r.sequence)).toEqual([bad.sequence]);
	expect(formatWireDiagnostics(sid)).toContain("严重 miss 留存：1 条");
});

test("bounds severe-miss storage independently and expires it after 24 hours", () => {
	const sid = randomUUID(), now = spyOn(Date, "now").mockReturnValue(1000);
	try {
		for (let i = 0; i < 40; i++) response(sid, request(sid));
		expect(getCacheDiagnostics(sid).misses).toHaveLength(CACHE_DIAGNOSTIC_MISS_LIMIT);
		now.mockReturnValue(1000 + CACHE_DIAGNOSTIC_TTL_MS + 1);
		expect(getCacheDiagnostics(sid)).toEqual({ recent: [], misses: [] });
	} finally { now.mockRestore(); }
});

test("bounds retained session histories and isolates their responses", () => {
	const old = randomUUID();
	response(old, request(old));
	for (let i = 0; i < 101; i++) { const sid = randomUUID(); request(sid); }
	expect(getCacheDiagnostics(old)).toEqual({ recent: [], misses: [] });
});

test("records unknown usage and transport failure without claiming zero billed input", () => {
	const sid = randomUUID(), receipt = request(sid);
	recordWireFailure(receipt, true);
	expect(receipt.outcome).toBe("aborted");
	expect(receipt.usage).toBeUndefined();
	expect(formatWireDiagnostics(sid)).toContain("输入=未知");
	expect(getCacheDiagnostics(sid).misses).toHaveLength(0);
});

test("sanitized JSON cannot retain provider outputs, IDs, arbitrary tiers, or request contents", () => {
	const sid = randomUUID(), receipt = request(sid, {
		input: [{ id: "private-input-id", text: "private-prompt", url: "https://private.example" }],
		prompt_cache_key: "private-key", tools: [{ name: "private-tool" }], service_tier: "private-request-tier",
	});
	response(sid, receipt, 100_000, 0, "private-returned-tier");
	const text = formatWireDiagnostics(sid, true);
	for (const value of ["private-input-id", "private-prompt", "private.example", "private-key", "private-tool",
		"private-response-id", "private-output", "private-request-tier", "private-returned-tier"]) {
		expect(text).not.toContain(value);
	}
	expect(receipt.requestedTier).toBe("other");
	expect(receipt.returnedTier).toBe("other");
	const copy = getCacheDiagnostics(sid);
	copy.recent[0]!.usage!.input = 0;
	expect(getCacheDiagnostics(sid).recent[0]!.usage!.input).toBe(100_000);
});

test("independently loaded modules share request receipts, histories and connection ordinals", async () => {
	const module = await import(`./wire-diagnostics.ts?instance=${randomUUID()}`);
	const sid = randomUUID(), socket = {}, receipt = request(sid);
	module.recordWireSend(receipt, { transport: "websocket", mode: "full", reason: "test", bytes: 1, items: 0, at: Date.now() }, socket);
	module.recordWireResponse(sid, receipt, { type: "response.done", response: {
		usage: { input_tokens: 100_000, input_tokens_details: { cached_tokens: 0 } },
	} });
	const next = request(sid);
	recordWireSend(next, { transport: "websocket", mode: "delta", reason: "test", bytes: 1, items: 0, at: Date.now() }, socket);
	expect(next.connection).toBe(receipt.connection);
	expect(getCacheDiagnostics(sid).misses).toHaveLength(1);
	expect(module.getCacheDiagnostics(sid).misses).toHaveLength(1);
});
