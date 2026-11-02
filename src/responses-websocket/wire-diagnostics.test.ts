import { expect, test } from "bun:test";
import { clearWireDiagnostics, formatWireDiagnostics, recordWireRequest } from "./wire-diagnostics";

const model = { provider: "test", id: "gpt-test", compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } };
test("detects a changed first tool batch without retaining original fields", () => {
	const sid = "wire-changed";
	recordWireRequest(sid, model, { input: [{ type: "additional_tools", tools: [{ name: "private-tool-name" }] }], prompt_cache_key: "private-cache-key" });
	recordWireRequest(sid, model, { input: [{ type: "additional_tools", tools: [{ name: "private-tool-name" }, { name: "new-tool" }] }], prompt_cache_key: "private-cache-key" });
	const text = formatWireDiagnostics(sid);
	expect(text).toContain("变化，首个位置 0");
	expect(text).toContain("追加批次=0:2");
	expect(text).not.toContain("private-tool-name");
	expect(text).not.toContain("private-cache-key");
	clearWireDiagnostics(sid);
});
test("preserves the input prefix, tracks settings separately, and is key-order independent", () => {
	const sid = "wire-prefix";
	recordWireRequest(sid, model, { input: [{ type: "message", content: "private-prompt" }], tools: [], max_output_tokens: 4096 });
	recordWireRequest(sid, model, { input: [{ content: "private-prompt", type: "message" }, { type: "additional_tools", tools: [{}] }], tools: [], max_output_tokens: 2048 });
	const text = formatWireDiagnostics(sid);
	expect(text).toContain("旧请求前缀=保留");
	expect(text).toContain("请求设置变化=max_output_tokens");
	expect(text).not.toContain("private-prompt");
	clearWireDiagnostics(sid);
});
test("records actual disabled capabilities and model switches establish fresh baselines", () => {
	const sid = "wire-flags";
	recordWireRequest(sid, { ...model, compat: {} }, { input: [], tools: [{}] });
	expect(formatWireDiagnostics(sid)).toContain("中途系统提示=关、增量工具=关");
	recordWireRequest(sid, { ...model, id: "other" }, { input: [] });
	expect(formatWireDiagnostics(sid).split("\n").at(-2)).toContain("首次基线");
	clearWireDiagnostics(sid);
});
test("sessions are isolated and only five recent records remain", () => {
	for (let i = 0; i < 8; i++) recordWireRequest("wire-bounds", model, { input: Array(i).fill({ role: "user" }) });
	expect(formatWireDiagnostics("wire-bounds").split("\n")).toHaveLength(7);
	expect(formatWireDiagnostics("other-session")).toBe("暂无发送位置指纹。");
	clearWireDiagnostics("wire-bounds");
});
