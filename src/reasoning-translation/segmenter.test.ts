import { describe, expect, test } from "bun:test";
import { flushThinkingSource, segmentThinkingSource } from "./segmenter";


describe("reasoning translation segmenter", () => {
	test("flushes natural sentence and newline boundaries", () => {
		expect(segmentThinkingSource("First sentence. Second sentence")).toEqual({
			segments: ["First sentence. "],
			remainder: "Second sentence",
		});
		expect(segmentThinkingSource("line one\nline two")).toEqual({
			segments: ["line one\n"],
			remainder: "line two",
		});
	});

	test("hard-cuts long unbroken text at 400 UTF-16 code units", () => {
		const source = "x".repeat(401);
		const result = segmentThinkingSource(source);
		expect(result.segments).toEqual(["x".repeat(400)]);
		expect(result.remainder).toBe("x");
	});

	test("keeps whitespace attached and does not send whitespace-only segments", () => {
		expect(flushThinkingSource("  Hello.  ")).toEqual({
			segments: ["  Hello.  "],
			remainder: "",
		});
		expect(flushThinkingSource(" \n ")).toEqual({ segments: [], remainder: "" });
	});

	test("flushes a short tail on idle/end flush", () => {
		expect(segmentThinkingSource("unfinished")).toEqual({ segments: [], remainder: "unfinished" });
		expect(flushThinkingSource("unfinished")).toEqual({ segments: ["unfinished"], remainder: "" });
	});
});
