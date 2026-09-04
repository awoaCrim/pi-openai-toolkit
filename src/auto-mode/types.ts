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

/** Budgets for the compact transcript handed to the reviewer. */
export const MAX_TRANSCRIPT_CHARS = 24_000;
export const MAX_TRANSCRIPT_TOOL_CHARS = 12_000;
export const MAX_TRANSCRIPT_ENTRY_CHARS = 2_000;
export const MAX_TRANSCRIPT_RECENT_ENTRIES = 40;
export const TRUNCATION_MARKER = "<truncated />";

/** Risk of the planned action itself, as scored by the reviewer. */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/** How far the observed conversation actually authorizes that action. */
export type UserAuthorization = "unknown" | "low" | "medium" | "high";

/**
 * Why a review could not be completed. Kept separate from `deny` on purpose: an
 * infrastructure failure must never be reported to the agent as a safety verdict.
 */
export type ReviewFailureCause =
	| "not-configured"
	| "timeout"
	| "cancelled"
	| "provider-error"
	| "invalid-output";

/**
 * The reviewer's full verdict. Only `outcome` is required from the model; the
 * remaining fields are back-filled by `parseReviewVerdict` so that a terse
 * `{"outcome":"allow"}` answer is still a usable, recordable decision.
 */
export type GuardianVerdict = {
	outcome: "allow" | "deny";
	riskLevel: RiskLevel;
	userAuthorization: UserAuthorization;
	rationale: string;
};

/**
 * Result of asking the reviewer model about one pending tool call.
 * `unavailable` means the review could not be completed at all; it is never
 * treated as approval.
 */
export type ReviewOutcome =
	| {
			kind: "allow";
			verdict: GuardianVerdict;
			reviewerModel: string;
			evidenceRounds: number;
	  }
	| {
			kind: "deny";
			verdict: GuardianVerdict;
			reviewerModel: string;
			evidenceRounds: number;
	  }
	| { kind: "unavailable"; reason: string; cause: ReviewFailureCause };

/** Non-blocking pre-score produced by the trajectory classifier. */
export type ClassifierRisk = "low" | "high";

/**
 * Why the classifier's cached score could or could not satisfy a gated call.
 * Mirrors the deferral reasons the blocking reviewer exists to cover: anything
 * other than `low_risk` falls through to the synchronous review.
 */
export type FastDecisionReason =
	| "low_risk"
	| "elevated_risk"
	| "stale_score"
	| "scoring_failure"
	| "missing_score"
	| "authorization_changed"
	| "requires_synchronous_review";

export type AutoModeDecisionSource =
	| "reviewer"
	| "classifier"
	| "human"
	| "policy"
	| "circuit-breaker";

export type AutoModeDecisionRecord = {
	timestamp: number;
	toolName: string;
	toolCallId: string;
	decision:
		| "allow"
		| "deny"
		| "unavailable-allowed"
		| "unavailable-blocked"
		| "turn-interrupted";
	reason: string;
	reviewerModel?: string;
	source: AutoModeDecisionSource;
	/** Present on reviewer verdicts; omitted for classifier fast paths. */
	riskLevel?: RiskLevel;
	userAuthorization?: UserAuthorization;
	evidenceRounds?: number;
	/** Only present when `source` is `classifier`. */
	fastDecision?: FastDecisionReason;
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
