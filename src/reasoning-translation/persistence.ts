import { createHash } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	REASONING_TRANSLATION_ENTRY_TYPE,
	type ReasoningTranslationEntryV1,
	cloneUsage,
	isReasoningTranslationEntry,
} from "./types";

export type ThinkingRunProjection = {
	runKey: number;
	sourceMarkdown: string;
};

export function projectThinkingRuns(message: Pick<AssistantMessage, "content">): ThinkingRunProjection[] {
	const runs: ThinkingRunProjection[] = [];
	for (let index = 0; index < message.content.length; index++) {
		const content = message.content[index];
		if (content.type !== "thinking") continue;

		const runKey = index;
		const blocks: string[] = [];
		for (; index < message.content.length; index++) {
			const block = message.content[index];
			if (block.type !== "thinking") break;
			const thinking = block.thinking.trim();
			if (thinking) blocks.push(thinking);
		}
		index--;
		if (blocks.length > 0) {
			runs.push({ runKey, sourceMarkdown: blocks.join("\n\n") });
		}
	}
	return runs;
}

export function hashThinkingMarkdown(sourceMarkdown: string): string {
	return createHash("sha256").update(sourceMarkdown, "utf8").digest("hex");
}

export function createReasoningTranslationEntry(args: {
	sourceMarkdown: string;
	displayText: string;
	targetLanguage: string;
	translator: { provider: string; model: string };
	usage?: import("@earendil-works/pi-ai").Usage;
}): ReasoningTranslationEntryV1 {
	return {
		version: 1,
		sourceHash: hashThinkingMarkdown(args.sourceMarkdown),
		displayText: args.displayText,
		targetLanguage: args.targetLanguage,
		translator: { ...args.translator },
		usage: cloneUsage(args.usage),
	};
}

export function replayReasoningTranslations(
	entries: readonly SessionEntry[],
): Map<string, ReasoningTranslationEntryV1> {
	const translations = new Map<string, ReasoningTranslationEntryV1>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== REASONING_TRANSLATION_ENTRY_TYPE) continue;
		if (!isReasoningTranslationEntry(entry.data)) continue;
		translations.set(entry.data.sourceHash, {
			...entry.data,
			translator: { ...entry.data.translator },
			usage: cloneUsage(entry.data.usage),
		});
	}
	return translations;
}
