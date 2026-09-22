import { describe, expect, test } from "bun:test";
import { buildReviewTranscript, transcriptFromEntries, type TranscriptLine } from "./transcript";
import { MAX_TRANSCRIPT_CHARS, TRUNCATION_MARKER } from "./types";

describe("review transcript authorization budget", () => {
	test("an oversized initial user turn cannot hide a subsequent restriction", () => {
		const result = buildReviewTranscript([
			{ role: "user", text: "initial task ".repeat(3000) },
			{ role: "assistant", text: "I will deploy" },
			{ role: "user", text: "Do not deploy or publish anything." },
		]);
		expect(result.text).toContain("[user]: Do not deploy or publish anything.");
		expect(result.text).toContain("initial task");
		expect(result.text).toContain(TRUNCATION_MARKER);
		expect(result.omitted).toBe(true);
		expect(result.text.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
	});

	test("budgets rendered entries including labels, separators and omission notices", () => {
		const lines: TranscriptLine[] = [
			{ role: "user", text: "old ".repeat(1000) },
			{ role: "tool", text: "output ".repeat(1000) },
			{ role: "user", text: "Do not publish." },
		];
		for (const maxTotalChars of [0, 5, 70, 120, 300, 2000, 24000]) {
			const result = buildReviewTranscript(lines, { maxTotalChars, maxToolChars: 80 });
			expect(result.text.length).toBeLessThanOrEqual(maxTotalChars);
			expect(result.omitted).toBe(true);
			if (maxTotalChars >= 120) expect(result.text).toContain("[user]: Do not publish.");
		}
	});

	test("reports truncation of persisted compaction summaries", () => {
		const result = transcriptFromEntries([{ type: "compaction", summary: "old context ".repeat(2000) }] as never);
		expect(result.omitted).toBe(true);
		expect(result.text).toContain(TRUNCATION_MARKER);
		expect(result.text.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
	});

	test("marks budget omissions and recent-window omissions, but not complete short transcripts", () => {
		const lines: TranscriptLine[] = [{ role: "user", text: "review only" }, { role: "tool", text: "large output" }];
		expect(buildReviewTranscript(lines).omitted).toBe(false);
		expect(buildReviewTranscript(lines, { maxToolChars: 0 }).omitted).toBe(true);
		expect(buildReviewTranscript(lines, { maxRecentEntries: 1 }).omitted).toBe(true);
		expect(buildReviewTranscript(lines).text).toBe("[1] [user]: review only\n[2] [tool]: large output");
	});
});
