import type { AutoModeConfig } from "../types";

export const AUTO_MODE_ENTRY_TYPE = "pi-openai-toolkit.auto-mode-decision.v1";
export const AUTO_MODE_STATUS_KEY = "pi-openai-toolkit:auto-mode";
export const AUTO_MODE_FLAG = "auto";
export const AUTO_MODE_COMMAND = "auto";

/**
 * Built-in tools that change state outside the conversation. Everything else is
 * read-only by default and only reviewed when the user opts in through
 * `autoMode.extraTools` or `gate: "all"`.
 */
export const SIDE_EFFECT_TOOLS = ["bash", "write", "edit"] as const;

export const MAX_REVIEW_INPUT_CHARS = 8_000;
export const MAX_REVIEW_INTENT_CHARS = 2_000;
export const MAX_REVIEW_REASON_CHARS = 600;
export const MAX_REVIEW_MODEL_KEY_CHARS = 256;

export type ReviewDecision = "allow" | "deny";

/**
 * Result of asking the reviewer model about one pending tool call.
 * `unavailable` means the review could not be completed at all; it is never
 * treated as approval.
 */
export type ReviewOutcome =
	| { kind: "allow"; reason: string; reviewerModel: string }
	| { kind: "deny"; reason: string; reviewerModel: string }
	| { kind: "unavailable"; reason: string };

export type AutoModeDecisionRecord = {
	timestamp: number;
	toolName: string;
	toolCallId: string;
	decision: ReviewDecision | "unavailable-allowed" | "unavailable-blocked";
	reason: string;
	reviewerModel?: string;
	source: "reviewer" | "human" | "policy";
};

export type AutoModeModelRef = {
	provider?: string;
	id?: string;
};

export type AutoModeGateSource = AutoModeConfig["gate"];

/**
 * Truncate to a bounded single-line-safe diagnostic. Reviewer reasons and tool
 * arguments both originate from untrusted text, so every persisted copy is capped.
 */
export function boundReviewText(value: unknown, maxChars: number): string {
	const text = typeof value === "string" ? value : String(value ?? "");
	const collapsed = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
	if (collapsed.length <= maxChars) return collapsed;
	return `${collapsed.slice(0, Math.max(0, maxChars - 3))}...`;
}
