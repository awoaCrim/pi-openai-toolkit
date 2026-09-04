import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { parseModelSpec } from "../runtime";
import { CLASSIFIER_SYSTEM_PROMPT } from "./prompt";
import { boundReviewText, type ClassifierRisk, type FastDecisionReason } from "./types";

/** One completed classification of the trajectory, tagged to a tool-call position. */
export type ScoreRecord = {
	risk: ClassifierRisk;
	/** Tool-call counter value when the sample was taken. */
	scoredAtCall: number;
	/** Fingerprint of the user turns the score was based on. */
	authorizationVersion: string;
	sampledAt: number;
};

/**
 * Mutable per-session tracker for the non-blocking pre-scorer.
 *
 * The counters reproduce Codex's staleness rule: the agent keeps running while a
 * classification is in flight, so a score is only trustworthy if it is recent
 * enough and nothing the user said has changed underneath it.
 */
export type ScoreTracker = {
	latestCallIndex: number;
	latestScoredIndex: number;
	latestFailedIndex: number;
	score?: ScoreRecord;
};

export function createScoreTracker(): ScoreTracker {
	return { latestCallIndex: 0, latestScoredIndex: 0, latestFailedIndex: 0 };
}

/** Reset everything: a new turn or a disengaged mode invalidates prior scoring. */
export function resetScoreTracker(tracker: ScoreTracker): void {
	tracker.latestCallIndex = 0;
	tracker.latestScoredIndex = 0;
	tracker.latestFailedIndex = 0;
	tracker.score = undefined;
}

/**
 * Fingerprint of the user-authored conversation. Any new or edited user turn makes
 * an existing score stale, because the score's authorization premise changed.
 */
export function authorizationVersion(userText: string): string {
	const bounded = boundReviewText(userText, 8_000);
	let hash = 2166136261;
	for (let index = 0; index < bounded.length; index += 1) {
		hash ^= bounded.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return `${bounded.length}:${(hash >>> 0).toString(36)}`;
}

export function recordScoredCall(tracker: ScoreTracker, score: ScoreRecord): void {
	tracker.score = score;
	tracker.latestScoredIndex = Math.max(tracker.latestScoredIndex, score.scoredAtCall);
}

export function recordFailedCall(tracker: ScoreTracker, scoredAtCall: number): void {
	tracker.latestFailedIndex = Math.max(tracker.latestFailedIndex, scoredAtCall);
}

export type FastDecisionInput = {
	tracker: ScoreTracker;
	/** Tool-call counter value for the call being gated. */
	currentCallIndex: number;
	authorizationVersion: string;
	maxLag: number;
	/** Retries after a denial and widened gates must not take the fast path. */
	requiresSynchronousReview?: boolean;
};

/**
 * Decide whether a cached classification can satisfy this gated call without
 * running the blocking reviewer. Anything other than `low_risk` defers to the
 * synchronous review; the classifier never denies an action on its own.
 */
export function fastApprovalEligible(input: FastDecisionInput): {
	eligible: boolean;
	reason: FastDecisionReason;
} {
	const defer = (reason: FastDecisionReason) => ({ eligible: false, reason });

	if (input.requiresSynchronousReview) return defer("requires_synchronous_review");
	if (input.tracker.latestFailedIndex > input.tracker.latestScoredIndex) return defer("scoring_failure");

	const score = input.tracker.score;
	if (!score) return defer("missing_score");

	const lag = input.currentCallIndex - score.scoredAtCall;
	if (lag > input.maxLag) return defer("stale_score");
	if (score.authorizationVersion !== input.authorizationVersion) return defer("authorization_changed");
	if (score.risk === "low") return { eligible: true, reason: "low_risk" };
	return defer("elevated_risk");
}

export type ClassificationResult =
	| { kind: ClassifierRisk; model: string }
	| { kind: "failed"; reason: string };

/**
 * Run one non-blocking classification. Output is a single token; anything else is a
 * failed sample rather than a verdict, so a confused classifier costs a review and
 * never an approval or a denial.
 */
export async function classifyTrajectory(params: {
	registry: Pick<ModelRegistry, "find" | "complete">;
	modelSpec: string;
	prompt: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<ClassificationResult> {
	const parsed = parseModelSpec(params.modelSpec);
	if (!parsed) {
		return { kind: "failed", reason: `autoMode.classifier.model "${params.modelSpec}" is not provider/model-id.` };
	}
	const model = params.registry.find(parsed.provider, parsed.modelId) as Model<Api> | undefined;
	if (!model) {
		return { kind: "failed", reason: `Classifier model ${params.modelSpec} is not available.` };
	}
	const label = boundReviewText(`${model.provider}/${model.id}`, 256);

	const controller = new AbortController();
	const abortFromCaller = () => controller.abort();
	if (params.signal?.aborted) controller.abort();
	else params.signal?.addEventListener("abort", abortFromCaller);
	const timer = setTimeout(() => controller.abort(), params.timeoutMs);

	try {
		const response = await params.registry.complete(
			model,
			{
				systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: params.prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{ signal: controller.signal, cacheRetention: "none" },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			return { kind: "failed", reason: response.errorMessage ?? `Classifier stopped: ${response.stopReason}` };
		}
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("")
			.trim()
			.toLowerCase();
		if (/^high\b/.test(text)) return { kind: "high", model: label };
		if (/^low\b/.test(text)) return { kind: "low", model: label };
		return { kind: "failed", reason: `Classifier returned unreadable output: ${boundReviewText(text, 80)}` };
	} catch (error) {
		return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
		params.signal?.removeEventListener("abort", abortFromCaller);
	}
}
