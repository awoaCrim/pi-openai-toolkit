import type { Usage } from "@earendil-works/pi-ai";
import { REASONING_TRANSLATION_EXTENSION_ID } from "../types";

export const REASONING_TRANSLATION_ENTRY_TYPE = REASONING_TRANSLATION_EXTENSION_ID;
export const TRANSLATING_LABEL = "Translating…";
export const IDLE_FLUSH_MS = 800;
export const MAX_SEGMENT_LENGTH = 400;
export const MAX_TRANSLATION_OUTPUT_TOKENS = 2048;
/** Hard upper bound so an uncooperative provider cannot hold the FIFO forever. */
export const TRANSLATION_TIMEOUT_MS = 30_000;

export type ReasoningTranslationEntryV1 = {
	version: 1;
	sourceHash: string;
	displayText: string;
	targetLanguage: string;
	translator: {
		provider: string;
		model: string;
	};
	usage?: Usage;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsage(value: unknown): value is Usage {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	const cost = value.cost;
	const numericFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
	if (numericFields.some((field) => !isFiniteNonNegativeNumber(value[field]))) return false;
	if (value.reasoning !== undefined && !isFiniteNonNegativeNumber(value.reasoning)) return false;
	if (value.cacheWrite1h !== undefined && !isFiniteNonNegativeNumber(value.cacheWrite1h)) return false;
	return ["input", "output", "cacheRead", "cacheWrite", "total"].every((field) =>
		isFiniteNonNegativeNumber(cost[field]),
	);
}

export function isReasoningTranslationEntry(value: unknown): value is ReasoningTranslationEntryV1 {
	if (!isRecord(value) || value.version !== 1) return false;
	if (typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/iu.test(value.sourceHash)) return false;
	if (!isNonEmptyString(value.displayText)) return false;
	if (!isNonEmptyString(value.targetLanguage) || !isRecord(value.translator)) return false;
	if (!isNonEmptyString(value.translator.provider) || !isNonEmptyString(value.translator.model)) return false;
	return value.usage === undefined || isUsage(value.usage);
}

export function cloneUsage(usage: Usage | undefined): Usage | undefined {
	return usage
		? {
			...usage,
			cost: { ...usage.cost },
		  }
		: undefined;
}
