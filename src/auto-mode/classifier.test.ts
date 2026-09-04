import { describe, expect, test } from "bun:test";
import {
	authorizationVersion,
	classifyTrajectory,
	createScoreTracker,
	fastApprovalEligible,
	recordFailedCall,
	recordScoredCall,
	resetScoreTracker,
} from "./classifier";

const classifierModel = { provider: "uwoacrimson", id: "gpt-5.6-luna", api: "openai-responses" } as never;

function registryReturning(
	result: { text?: string; stopReason?: string; errorMessage?: string; throws?: string },
	available = true,
) {
	const calls: unknown[] = [];
	return {
		calls,
		registry: {
			find: () => (available ? classifierModel : undefined),
			complete: async (_model: unknown, context: unknown) => {
				calls.push(context);
				if (result.throws) throw new Error(result.throws);
				return {
					role: "assistant",
					content: [{ type: "text", text: result.text ?? "" }],
					stopReason: result.stopReason ?? "stop",
					errorMessage: result.errorMessage,
					usage: {},
				};
			},
		} as never,
	};
}

function classify(registry: never, overrides: Record<string, unknown> = {}) {
	return classifyTrajectory({
		registry,
		modelSpec: "uwoacrimson/gpt-5.6-luna",
		prompt: "transcript",
		timeoutMs: 5_000,
		...overrides,
	});
}

function trackerWith(score: { risk: "low" | "high"; scoredAtCall: number; authorizationVersion?: string }) {
	const tracker = createScoreTracker();
	recordScoredCall(tracker, {
		risk: score.risk,
		scoredAtCall: score.scoredAtCall,
		authorizationVersion: score.authorizationVersion ?? "auth-1",
		sampledAt: 1,
	});
	return tracker;
}

describe("classifier fast path", () => {
	test("a fresh low-risk score satisfies the call", () => {
		expect(
			fastApprovalEligible({
				tracker: trackerWith({ risk: "low", scoredAtCall: 4 }),
				currentCallIndex: 6,
				authorizationVersion: "auth-1",
				maxLag: 2,
			}),
		).toEqual({ eligible: true, reason: "low_risk" });
	});

	test("a high-risk classification defers to the blocking reviewer rather than denying", () => {
		expect(
			fastApprovalEligible({
				tracker: trackerWith({ risk: "high", scoredAtCall: 5 }),
				currentCallIndex: 5,
				authorizationVersion: "auth-1",
				maxLag: 2,
			}),
		).toEqual({ eligible: false, reason: "elevated_risk" });
	});

	test("a score older than the lag budget is stale", () => {
		expect(
			fastApprovalEligible({
				tracker: trackerWith({ risk: "low", scoredAtCall: 1 }),
				currentCallIndex: 4,
				authorizationVersion: "auth-1",
				maxLag: 2,
			}),
		).toEqual({ eligible: false, reason: "stale_score" });
	});

	test("a new user turn invalidates a score taken under the old authorization", () => {
		expect(
			fastApprovalEligible({
				tracker: trackerWith({ risk: "low", scoredAtCall: 5, authorizationVersion: "auth-1" }),
				currentCallIndex: 5,
				authorizationVersion: "auth-2",
				maxLag: 2,
			}),
		).toEqual({ eligible: false, reason: "authorization_changed" });
	});

	test("a failed sample after the last good sample forces a review", () => {
		const tracker = trackerWith({ risk: "low", scoredAtCall: 5 });
		recordFailedCall(tracker, 6);
		expect(
			fastApprovalEligible({
				tracker,
				currentCallIndex: 6,
				authorizationVersion: "auth-1",
				maxLag: 2,
			}),
		).toEqual({ eligible: false, reason: "scoring_failure" });
	});

	test("no score at all, or a blocked retry, always defers", () => {
		expect(
			fastApprovalEligible({
				tracker: createScoreTracker(),
				currentCallIndex: 1,
				authorizationVersion: "auth-1",
				maxLag: 2,
			}),
		).toEqual({ eligible: false, reason: "missing_score" });

		expect(
			fastApprovalEligible({
				tracker: trackerWith({ risk: "low", scoredAtCall: 5 }),
				currentCallIndex: 5,
				authorizationVersion: "auth-1",
				maxLag: 2,
				requiresSynchronousReview: true,
			}),
		).toEqual({ eligible: false, reason: "requires_synchronous_review" });
	});

	test("resetting clears both the score and the counters", () => {
		const tracker = trackerWith({ risk: "low", scoredAtCall: 5 });
		recordFailedCall(tracker, 7);
		resetScoreTracker(tracker);
		expect(tracker).toEqual({ latestCallIndex: 0, latestScoredIndex: 0, latestFailedIndex: 0 });
	});
});

describe("authorization fingerprint", () => {
	test("is stable for identical text and changes when the user speaks again", () => {
		expect(authorizationVersion("run the tests")).toBe(authorizationVersion("run the tests"));
		expect(authorizationVersion("run the tests")).not.toBe(
			authorizationVersion("run the tests\nactually deploy it"),
		);
	});

	test("bounds its input so a huge transcript cannot slow every call", () => {
		// Only the first slice is hashed, so text that differs past the bound is equal.
		expect(authorizationVersion("x".repeat(50_000))).toBe(
			authorizationVersion(`${"x".repeat(50_000)} then something else entirely`),
		);
		expect(authorizationVersion(`y${"x".repeat(50_000)}`)).not.toBe(
			authorizationVersion(`x${"x".repeat(50_000)}`),
		);
	});
});

describe("classifyTrajectory", () => {
	test("reads the single-token verdict and ignores trailing words", async () => {
		const high = registryReturning({ text: "high" });
		await expect(classify(high.registry)).resolves.toEqual({ kind: "high", model: "uwoacrimson/gpt-5.6-luna" });
		const low = registryReturning({ text: " low\n" });
		await expect(classify(low.registry)).resolves.toMatchObject({ kind: "low" });
	});

	test("anything unreadable is a failed sample, never a low-risk score", async () => {
		const unclear = registryReturning({ text: "probably fine" });
		expect(await classify(unclear.registry)).toMatchObject({ kind: "failed" });

		const empty = registryReturning({ text: "" });
		expect(await classify(empty.registry)).toMatchObject({ kind: "failed" });
	});

	test("provider trouble and an unusable model spec report as failed", async () => {
		const thrown = registryReturning({ throws: "socket hang up" });
		expect(await classify(thrown.registry)).toMatchObject({ kind: "failed", reason: "socket hang up" });

		const errored = registryReturning({ stopReason: "error", errorMessage: "429" });
		expect(await classify(errored.registry)).toMatchObject({ kind: "failed", reason: "429" });

		const missing = registryReturning({ text: "low" }, false);
		expect(await classify(missing.registry)).toMatchObject({ kind: "failed" });

		await expect(classify(missing.registry, { modelSpec: "not-a-spec" })).resolves.toMatchObject({
			kind: "failed",
		});
	});

	test("sends the classifier policy and the transcript together, with no tools", async () => {
		const harness = registryReturning({ text: "low" });
		await classify(harness.registry, { prompt: "the bounded transcript" });
		const context = harness.calls[0] as { systemPrompt: string; messages: unknown[]; tools?: unknown };
		expect(context.systemPrompt).toContain("non-blocking");
		expect(context.systemPrompt).toContain("Output that token immediately and nothing else.");
		expect(JSON.stringify(context.messages)).toContain("the bounded transcript");
		expect(context.tools).toBeUndefined();
	});
});
