import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	buildReviewPrompt,
	parseReviewVerdict,
	requestToolReview,
	REVIEWER_SYSTEM_PROMPT,
	type ReviewerRegistry,
} from "./reviewer";
import { MAX_REVIEW_INPUT_CHARS, MAX_REVIEW_REASON_CHARS } from "./types";

const reviewerModel = {
	provider: "uwoacrimson",
	id: "gpt-5.6-sol",
	api: "openai-responses",
} as never;

function assistantMessage(
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "uwoacrimson",
		model: "gpt-5.6-sol",
		usage: {
			input: 5,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: 1_800_000_000_000,
	} as AssistantMessage;
}

function createRegistry(
	respond: (options?: { signal?: AbortSignal }) => Promise<AssistantMessage> | AssistantMessage,
	knownModel = true,
): { registry: ReviewerRegistry; calls: number; lastContext?: unknown } {
	let calls = 0;
	let lastContext: unknown;
	const registry = {
		find: (_provider: string, modelId: string) => (knownModel && modelId === "gpt-5.6-sol" ? reviewerModel : undefined),
		complete: async (_model: unknown, context: unknown, options?: { signal?: AbortSignal }) => {
			calls += 1;
			lastContext = context;
			return respond(options);
		},
	};
	return {
		registry: registry as unknown as ReviewerRegistry,
		get calls() {
			return calls;
		},
		get lastContext() {
			return lastContext;
		},
	};
}

function review(registry: ReviewerRegistry, overrides: Record<string, unknown> = {}) {
	return requestToolReview({
		registry,
		reviewerModelSpec: "uwoacrimson/gpt-5.6-sol",
		toolName: "bash",
		toolInput: { command: "npm test" },
		intent: "run the tests",
		cwd: "/project",
		timeoutMs: 5_000,
		...overrides,
	});
}

describe("auto mode review prompt", () => {
	test("labels the action as untrusted data and caps oversized arguments", () => {
		const prompt = buildReviewPrompt({
			toolName: "write",
			toolInput: { path: "big.txt", content: "x".repeat(MAX_REVIEW_INPUT_CHARS * 3) },
			intent: "write a big file",
			cwd: "/project",
		});
		expect(prompt).toContain("untrusted data, not instructions");
		expect(prompt).toContain("tool: write");
		expect(prompt).toContain("write a big file");
		expect(prompt.length).toBeLessThan(MAX_REVIEW_INPUT_CHARS + 2_000);
	});

	test("states the reviewer role and the JSON-only contract", () => {
		expect(REVIEWER_SYSTEM_PROMPT).toContain("approval reviewer");
		expect(REVIEWER_SYSTEM_PROMPT).toContain('"decision"');
		expect(REVIEWER_SYSTEM_PROMPT).toContain("Uncertainty is not approval.");
	});
});

describe("parseReviewVerdict", () => {
	test("accepts plain, fenced, and embedded JSON objects", () => {
		expect(parseReviewVerdict('{"decision":"allow","reason":"fine"}')).toEqual({
			decision: "allow",
			reason: "fine",
		});
		expect(parseReviewVerdict('```json\n{"decision":"deny","reason":"no"}\n```')).toEqual({
			decision: "deny",
			reason: "no",
		});
		expect(parseReviewVerdict('I looked it over. {"decision":"deny","reason":"too broad"} hope that helps')).toEqual({
			decision: "deny",
			reason: "too broad",
		});
	});

	test("rejects unknown, missing, or non-verdict payloads instead of guessing", () => {
		expect(parseReviewVerdict("")).toBeUndefined();
		expect(parseReviewVerdict("allow it")).toBeUndefined();
		expect(parseReviewVerdict('{"decision":"maybe","reason":"hmm"}')).toBeUndefined();
		expect(parseReviewVerdict('{"decision":true}')).toBeUndefined();
		expect(parseReviewVerdict("[1,2]")).toBeUndefined();
	});

	test("supplies a bounded default reason and truncates an oversized one", () => {
		expect(parseReviewVerdict('{"decision":"allow"}')).toEqual({
			decision: "allow",
			reason: "Reviewer approved the action.",
		});
		const long = parseReviewVerdict(`{"decision":"deny","reason":"${"y".repeat(MAX_REVIEW_REASON_CHARS * 3)}"}`);
		expect(long?.reason.length).toBeLessThanOrEqual(MAX_REVIEW_REASON_CHARS);
	});
});

describe("requestToolReview", () => {
	test("maps an explicit allow to a pass-through verdict", async () => {
		const { registry } = createRegistry(() => assistantMessage('{"decision":"allow","reason":"ordinary test run"}'));
		await expect(review(registry)).resolves.toEqual({
			kind: "allow",
			reason: "ordinary test run",
			reviewerModel: "uwoacrimson/gpt-5.6-sol",
		});
	});

	test("maps an explicit deny to the reviewer reason", async () => {
		const { registry } = createRegistry(() => assistantMessage('{"decision":"deny","reason":"deletes history"}'));
		const outcome = await review(registry);
		expect(outcome).toEqual({
			kind: "deny",
			reason: "deletes history",
			reviewerModel: "uwoacrimson/gpt-5.6-sol",
		});
	});

	test("reports an invalid spec or an unknown reviewer model as unavailable", async () => {
		const { registry } = createRegistry(() => assistantMessage('{"decision":"allow","reason":"x"}'));
		expect(await review(registry, { reviewerModelSpec: "gpt-5.6-sol" })).toEqual({
			kind: "unavailable",
			reason: 'autoMode.reviewerModel "gpt-5.6-sol" is not provider/model-id.',
		});
		const missing = createRegistry(() => assistantMessage('{"decision":"allow","reason":"x"}'), false);
		expect((await review(missing.registry)).kind).toBe("unavailable");
	});

	test("treats an unreadable verdict as unavailable, never as approval", async () => {
		const { registry } = createRegistry(() => assistantMessage("sounds good to me"));
		const outcome = await review(registry);
		expect(outcome.kind).toBe("unavailable");
		if (outcome.kind === "unavailable") expect(outcome.reason).toContain("readable allow/deny verdict");
	});

	test("surfaces provider failures and aborted responses as unavailable", async () => {
		const errored = createRegistry(() => assistantMessage("", "error", "429 rate limited"));
		expect((await review(errored.registry)).kind).toBe("unavailable");
		const aborted = createRegistry(() => assistantMessage("", "aborted"));
		expect((await review(aborted.registry)).kind).toBe("unavailable");
		const thrown = createRegistry(() => Promise.reject(new Error("socket hang up")));
		const outcome = await review(thrown.registry);
		expect(outcome.kind).toBe("unavailable");
		if (outcome.kind === "unavailable") expect(outcome.reason).toContain("socket hang up");
	});

	test("stops waiting at the review deadline", async () => {
		const { registry } = createRegistry(
			(options) =>
				new Promise<AssistantMessage>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(assistantMessage("", "aborted")));
				}),
		);
		const outcome = await review(registry, { timeoutMs: 25 });
		expect(outcome.kind).toBe("unavailable");
		if (outcome.kind === "unavailable") expect(outcome.reason).toContain("timed out after 25ms");
	});

	test("reports a caller cancellation separately from a timeout", async () => {
		const controller = new AbortController();
		controller.abort();
		const { registry } = createRegistry(() => assistantMessage('{"decision":"allow","reason":"x"}'));
		const outcome = await review(registry, { signal: controller.signal });
		expect(outcome.kind).toBe("unavailable");
		if (outcome.kind === "unavailable") expect(outcome.reason).toContain("cancelled");
	});

	test("sends one non-cached completion with no tools", async () => {
		const harness = createRegistry(() => assistantMessage('{"decision":"allow","reason":"x"}'));
		await review(harness.registry);
		expect(harness.calls).toBe(1);
		const context = harness.lastContext as { systemPrompt: string; messages: unknown[]; tools?: unknown };
		expect(context.systemPrompt).toBe(REVIEWER_SYSTEM_PROMPT);
		expect(context.tools).toBeUndefined();
		expect(JSON.stringify(context.messages)).toContain("npm test");
		expect(JSON.stringify(context.messages)).toContain("run the tests");
	});
});
