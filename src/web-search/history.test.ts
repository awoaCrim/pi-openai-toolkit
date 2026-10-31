import { describe, expect, test } from "bun:test";
import { contextSummary, makeSearchRecord, restoreSearchHistory, searchSummary } from "./history";

const model = { provider: "test", api: "openai-responses", id: "gpt-test" };
const meta = { ...model, model: model.id, responseId: "resp_test", completion: "completed" };
const search = { type: "web_search_call", id: "ws_test", status: "completed",
	action: { type: "search", query: "RFC 6455" } };
const annotation = { type: "url_citation", start_index: 0, end_index: 3, url: "https://example.test/", title: "Source" };
const answer = { type: "message", id: "msg_test", role: "assistant", status: "completed", phase: "final_answer",
	content: [{ type: "output_text", text: "The WebSocket Protocol.", annotations: [annotation], logprobs: [] }] };
const clientAnswer = () => ({ ...answer, content: [{ type: "output_text", text: answer.content[0]!.text, annotations: [] }] });
function fixture(output = [search, answer]) {
	const record = makeSearchRecord(meta, output)!;
	const summary = { role: "user", content: [{ type: "input_text", text: contextSummary(record) }] };
	const input = [{ role: "user", content: "question" }, clientAnswer(), summary, { role: "user", content: "next" }];
	return { record, payload: { model: model.id, input } };
}

describe("hosted search history replay", () => {
	test("restores raw search items and citations, not a duplicate context summary", () => {
		const { record, payload } = fixture();
		const original = structuredClone(payload);
		const result: any = restoreSearchHistory(payload, [record], model);
		expect(result.input.map((i: any) => i.type || i.role)).toEqual(["user", "web_search_call", "message", "user"]);
		expect(result.input[1]).toEqual(search);
		expect(result.input[2].content[0].annotations).toEqual([annotation]);
		expect(payload).toEqual(original);
		expect(JSON.stringify(record)).not.toContain("The WebSocket Protocol.");
		expect(restoreSearchHistory(result, [record], model)).toBe(result);
	});
	test("keeps reasoning and multi-search output order without storing reasoning twice", () => {
		const reasoning = { type: "reasoning", id: "rs_test", encrypted_content: "opaque", summary: [] };
		const later = { ...search, id: "ws_second", action: { type: "open_page", url: "https://example.test/" } };
		const record = makeSearchRecord(meta, [search, reasoning, later, answer])!;
		const payload = { input: [reasoning, clientAnswer(), { role: "user", content: contextSummary(record) }] };
		const result: any = restoreSearchHistory(payload, [record], model);
		expect(result.input.map((i: any) => i.id)).toEqual(["ws_test", "rs_test", "ws_second", "msg_test"]);
		expect(JSON.stringify(record)).not.toContain("opaque");
	});
	for (const mutation of ["text", "phase", "id", "citations", "missing", "duplicate", "summary-missing", "summary-duplicate"]) {
		test(`does not overwrite changed or ambiguous history: ${mutation}`, () => {
			const { record, payload } = fixture();
			const p: any = structuredClone(payload);
			if (mutation === "text") p.input[1].content[0].text = "User edited this";
			if (mutation === "phase") p.input[1].phase = "commentary";
			if (mutation === "id") p.input[1].id = "msg_changed";
			if (mutation === "citations") p.input[1].content[0].annotations = [{ ...annotation, url: "https://changed.test" }];
			if (mutation === "missing") p.input.splice(1, 1);
			if (mutation === "duplicate") p.input.push(structuredClone(p.input[1]));
			if (mutation === "summary-missing") p.input.splice(2, 1);
			if (mutation === "summary-duplicate") p.input.push(structuredClone(p.input[2]));
			expect(restoreSearchHistory(p, [record], model)).toBe(p);
		});
	}
	test("different models/providers and abandoned branches keep the summary, not raw replay", () => {
		const { record, payload } = fixture();
		expect(restoreSearchHistory(payload, [], model)).toBe(payload);
		expect(restoreSearchHistory(payload, [record], { ...model, id: "other" })).toBe(payload);
		expect(restoreSearchHistory(payload, [record], { ...model, provider: "other" })).toBe(payload);
	});
	test("unknown output kinds, multi-part messages and failed turns remain conservative", () => {
		for (const output of [[search, { type: "unknown", id: "x" }, answer],
			[search, { ...answer, content: [...answer.content, ...answer.content] }]]) {
			expect(makeSearchRecord(meta, output)!.replay).toBeUndefined();
		}
		expect(makeSearchRecord({ ...meta, completion: "error" }, [search, answer])!.replay).toBeUndefined();
	});
	test("multi-part citations remain durable even when their replay mapping is unsupported", () => {
		const record = makeSearchRecord(meta, [{ ...answer, content: [...answer.content, ...answer.content] }])!;
		expect(record.replay).toBeUndefined();
		expect(record.citations.map(c => c.contentIndex)).toEqual([0, 1]);
		expect(record.citations[1]!.annotations).toEqual([annotation]);
	});
	test("captures returned errors but never invents an HTTP result", () => {
		const { record } = fixture();
		expect(searchSummary(record)).not.toContain("403");
		expect(searchSummary(record)).toContain("未返回的页面正文");
		const failed = makeSearchRecord({ ...meta, completion: "error" }, [{
			...search, status: "failed", error: { message: "HTTP 403 Forbidden" },
		}])!;
		expect(searchSummary(failed)).toContain("HTTP 403 Forbidden");
		expect(failed.replay).toBeUndefined();
	});
	test("ordinary replies do not produce a search record", () => {
		expect(makeSearchRecord(meta, [clientAnswer()])).toBeUndefined();
	});
});
