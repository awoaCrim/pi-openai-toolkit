import { expect, test, spyOn } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerHostedSearchHistory } from "./history-extension";
import { SEARCH_HISTORY, SEARCH_DISPLAY } from "./history";

function harness(manager?: SessionManager) {
	const hooks = new Map<string, Function>(), entries: any[] = [], notices: string[] = [];
	const pi: any = { on: (name: string, handler: Function) => hooks.set(name, handler),
		appendEntry: (customType: string, data: unknown) => manager
			? manager.appendCustomEntry(customType, data) : entries.push({ type: "custom", customType, data }) };
	const ctx: any = { model: { provider: "test", api: "openai-responses", id: "gpt-test" }, hasUI: true,
		ui: { notify: (s: string) => notices.push(s), setStatus: () => {} },
		sessionManager: manager ?? { getBranch: () => entries } };
	registerHostedSearchHistory(pi);
	const emit = (name: string, event = {}) => hooks.get(name)!(event, ctx);
	const stream = (data: unknown) => emit("provider_stream_event", { provider: "test", api: "openai-responses", model: "gpt-test", data });
	return { hooks, entries, notices, ctx, emit, stream };
}
const call = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "test" } };
const output = { type: "message", role: "assistant", id: "msg_1", status: "completed",
	content: [{ type: "output_text", text: "Answer", annotations: [] }] };
const assistant: any = { role: "assistant", provider: "test", api: "openai-responses", model: "gpt-test",
	responseId: "resp_1", stopReason: "stop", content: [{ type: "text", text: "Answer" }], timestamp: 1 };

test("unsupported runtimes warn once on actual hosted requests, not on ordinary chat", () => {
	const h = harness();
	h.emit("turn_start");
	h.emit("before_provider_request", { payload: { input: [] } });
	h.emit("message_end", { message: assistant });
	expect(h.notices).toHaveLength(0);
	const event = { payload: { input: [], tools: [{ type: "web_search" }] } };
	for (let i = 0; i < 2; i++) {
		h.emit("turn_start"); h.emit("before_provider_request", event);
		h.emit("message_end", { message: assistant });
	}
	expect(h.notices).toHaveLength(1);
	expect(h.notices[0]).toContain(">=0.99.0");
	expect(h.notices[0]).toContain("not persisted");
	expect(h.entries).toHaveLength(0);
	h.emit("session_start");
	h.emit("turn_start"); h.emit("before_provider_request", event);
	h.emit("message_end", { message: assistant });
	expect(h.notices).toHaveLength(2);
});

test("unsupported non-UI runtimes report missing capture on stderr", () => {
	const h = harness();
	h.ctx.hasUI = false;
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		h.emit("turn_start");
		h.emit("before_provider_request", { payload: { tools: [{ type: "web_search_preview" }] } });
		h.emit("message_end", { message: assistant });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("unavailable");
	} finally { warn.mockRestore(); }
});

function finish(h: ReturnType<typeof harness>, failed = false) {
	h.emit("turn_start");
	h.emit("before_provider_request", { payload: { input: [], tools: [{ type: "web_search" }] } });
	h.stream({ type: "response.created", response: { id: "resp_1" } });
	// The published Pi runtime emits this only after the raw response.created.
	h.stream({ type: "response.output_item.added", output_index: 0, item: { ...call, status: "in_progress" } });
	h.stream({ type: "response.output_item.done", output_index: 0, item: call });
	h.stream({ type: failed ? "response.failed" : "response.completed",
		response: { status: failed ? "failed" : "completed", output: failed ? [] : [call, output] } });
	h.emit("message_end", { message: failed ? { ...assistant, stopReason: "error" } : assistant });
}

test("persists before the assistant, keeps the entry hidden, and restores the exact prefix after reload", () => {
	const h = harness();
	finish(h);
	expect(h.notices).toHaveLength(1);
	expect(h.entries).toHaveLength(1);
	expect(h.entries[0].customType).toBe(SEARCH_HISTORY);
	const boundary = h.emit("turn_end");
	expect(boundary.entries[0].customType).toBe(SEARCH_DISPLAY);
	expect(boundary.entries[0].display).toBe(false);
	expect(h.emit("turn_end")).toBeUndefined();
	h.emit("session_shutdown"); h.emit("session_start");
	const display = { role: "custom", ...boundary.entries[0], timestamp: 2 };
	const context = h.emit("context", { messages: [assistant, display] });
	expect(context.messages).toHaveLength(2); // One context summary, not two.
	const payload = { input: [output, { role: "user", content: context.messages[1].content }] };
	expect(h.emit("before_provider_request", { payload }).input).toEqual([call, output]);
});
test("does not read an abandoned branch or resurrect compacted-away answers", () => {
	const h = harness(); finish(h);
	const record = h.entries[0];
	h.entries.length = 0;
	expect(h.emit("context", { messages: [assistant] }).messages).toEqual([assistant]);
	h.entries.push(record);
	const compacted = [{ role: "user", content: "Compacted summary", timestamp: 2 }];
	expect(h.emit("context", { messages: compacted }).messages).toEqual(compacted);
});
test("retains search evidence on failure without making failed output replayable", () => {
	const h = harness(); finish(h, true);
	expect(h.entries[0].data.calls).toHaveLength(1);
	expect(h.entries[0].data.completion).toBe("error");
	expect(h.entries[0].data.replay).toBeUndefined();
	expect(h.emit("turn_end").entries[0].content).toContain("响应状态：error");
});
test("ignores unrelated/background stream events and deduplicates the same response", () => {
	const h = harness();
	h.stream({ type: "response.created", response: { id: "background" } });
	expect(h.entries).toHaveLength(0);
	finish(h); h.emit("turn_end"); finish(h);
	expect(h.entries).toHaveLength(1);
	expect(h.emit("turn_end")).toBeUndefined();
});

test("independent sessions do not share search evidence", () => {
	const a = harness(), b = harness();
	finish(a);
	expect(a.entries).toHaveLength(1);
	expect(b.entries).toHaveLength(0);
	expect(b.emit("context", { messages: [assistant] }).messages).toEqual([assistant]);
});

test("notification failures do not discard the durable search record", () => {
	const h = harness();
	h.ctx.ui.setStatus = (_key: string, value: unknown) => { if (value === undefined) throw new Error("UI unavailable"); };
	expect(() => finish(h)).toThrow("UI unavailable");
	expect(h.entries).toHaveLength(1);
	expect(h.emit("turn_end").entries).toHaveLength(1);
});

test("real session branches and compaction keep records scoped to surviving context", () => {
	const manager = SessionManager.inMemory();
	const user = manager.appendMessage({ role: "user", content: "Search", timestamp: 0 });
	const h = harness(manager);
	finish(h);
	const answerId = manager.appendMessage(assistant);
	const display = h.emit("turn_end").entries[0];
	const displayId = manager.appendCustomMessageEntry(display.customType, display.content, display.display, display.details);
	expect(manager.buildSessionContext().messages.some((m: any) =>
		m.role === "custom" && m.customType === SEARCH_DISPLAY && m.display === false)).toBe(true);
	const nextUser = manager.appendMessage({ role: "user", content: "Next", timestamp: 3 });
	manager.branch(answerId);
	expect(manager.getBranch().some(e => e.type === "custom" && e.customType === SEARCH_HISTORY)).toBe(true);
	expect(h.emit("context", { messages: manager.buildSessionContext().messages }).messages
		.some((m: any) => m.role === "custom" && m.content.includes("pi-hosted-search-record"))).toBe(true);
	manager.branch(user);
	expect(h.emit("context", { messages: manager.buildSessionContext().messages }).messages
		.some((m: any) => m.role === "custom")).toBe(false);
	manager.branch(nextUser);
	manager.appendCompaction("Summary", displayId, 10000);
	const retained = h.emit("context", { messages: manager.buildSessionContext().messages }).messages;
	expect(retained.some((m: any) => m.role === "assistant")).toBe(false);
	expect(retained.filter((m: any) => m.role === "custom")).toHaveLength(1);
	manager.appendCompaction("New summary", nextUser, 10000);
	const compacted = h.emit("context", { messages: manager.buildSessionContext().messages }).messages;
	expect(compacted.some((m: any) => m.role === "custom")).toBe(false);
});
