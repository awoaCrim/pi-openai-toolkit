import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createReasoningTranslationEntry,
	hashThinkingMarkdown,
	projectThinkingRuns,
	replayReasoningTranslations,
} from "./persistence";
import { REASONING_TRANSLATION_ENTRY_TYPE } from "./types";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content, api: "openai-responses", provider: "source", model: "gpt", usage: {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}, stopReason: "stop", timestamp: Date.now() };
}

describe("reasoning translation persistence", () => {
	test("projects adjacent thinking blocks exactly like Pi's renderer", () => {
		expect(projectThinkingRuns(assistant([
			{ type: "thinking", thinking: " first " },
			{ type: "thinking", thinking: " second\n" },
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: " third " },
		]))).toEqual([
			{ runKey: 0, sourceMarkdown: "first\n\nsecond" },
			{ runKey: 3, sourceMarkdown: "third" },
		]);
	});

	test("hashes canonical source and replays latest valid entries", () => {
		const first = createReasoningTranslationEntry({
			sourceMarkdown: "source",
			displayText: "first",
			targetLanguage: "Simplified Chinese",
			translator: { provider: "translator", model: "model-a" },
		});
		const latest = createReasoningTranslationEntry({
			sourceMarkdown: "source",
			displayText: "latest",
			targetLanguage: "Japanese",
			translator: { provider: "translator", model: "model-b" },
		});
		const replayed = replayReasoningTranslations([
			{ type: "custom", customType: REASONING_TRANSLATION_ENTRY_TYPE, data: first, id: "1", parentId: null, timestamp: "1" },
			{ type: "custom", customType: REASONING_TRANSLATION_ENTRY_TYPE, data: { invalid: true }, id: "2", parentId: "1", timestamp: "2" },
			{ type: "custom", customType: REASONING_TRANSLATION_ENTRY_TYPE, data: { ...latest, sourceHash: "invalid" }, id: "2b", parentId: "2", timestamp: "2b" },
			{ type: "custom", customType: REASONING_TRANSLATION_ENTRY_TYPE, data: latest, id: "3", parentId: "2b", timestamp: "3" },
		]);
		expect(hashThinkingMarkdown("source")).toBe(first.sourceHash);
		expect(replayed.get(first.sourceHash)?.displayText).toBe("latest");
	});
});
