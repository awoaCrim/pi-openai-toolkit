import { describe, expect, test } from "bun:test";
import {
	DEFAULT_AUTO_MODE_CONFIG,
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
	type AutoModeConfig,
} from "../types";
import { registerAutoModeExtension } from "./extension";
import { buildClassifierPrompt, reviewerSystemPrompt } from "./prompt";
import { transcriptFromEntries } from "./transcript";
import type { ReviewOutcome } from "./types";

type Handler = (event: any, ctx: any) => unknown;

function configWith(overrides: Partial<AutoModeConfig> = {}): AutoModeConfig {
	return {
		...DEFAULT_AUTO_MODE_CONFIG,
		models: [...DEFAULT_AUTO_MODE_CONFIG.models],
		extraTools: [...DEFAULT_AUTO_MODE_CONFIG.extraTools],
		classifier: { ...DEFAULT_AUTO_MODE_CONFIG.classifier },
		circuitBreaker: { ...DEFAULT_AUTO_MODE_CONFIG.circuitBreaker },
		// Unit tests must not construct real Pi tools unless a test asks for them.
		evidenceTools: false,
		...overrides,
	};
}

function allowVerdict(reason = "looks fine"): ReviewOutcome {
	return {
		kind: "allow",
		verdict: { outcome: "allow", riskLevel: "low", userAuthorization: "medium", rationale: reason },
		reviewerModel: "uwoacrimson/gpt-5.6-sol",
		evidenceRounds: 0,
	};
}

function denyVerdict(reason: string): ReviewOutcome {
	return {
		kind: "deny",
		verdict: { outcome: "deny", riskLevel: "high", userAuthorization: "low", rationale: reason },
		reviewerModel: "uwoacrimson/gpt-5.6-sol",
		evidenceRounds: 0,
	};
}

function userEntry(id: string, text: string) {
	return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } };
}

function assistantEntry(id: string, text: string) {
	return { type: "message", id, message: { role: "assistant", content: [{ type: "text", text }] } };
}

function createHarness(options: {
	autoMode?: Partial<AutoModeConfig>;
	flagValue?: boolean;
	outcome?: ReviewOutcome;
	confirmed?: boolean;
	hasUI?: boolean;
	classifierText?: string;
	sessionEntries?: unknown[];
	/** Successive verdicts, for tests that need a sequence such as deny-allow-deny. */
	outcomes?: ReviewOutcome[];
} = {}) {
	const autoMode = configWith(options.autoMode);
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
	const flags = new Map<string, boolean | string | undefined>([["auto", options.flagValue ?? false]]);
	const entries: Array<{ type: string; data: any }> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const statuses: Array<string | undefined> = [];
	const reviewCalls: Array<Record<string, unknown>> = [];
	const classifierCalls: Array<Record<string, unknown>> = [];

	const outcome: ReviewOutcome = options.outcome ?? allowVerdict();
	const sequence = options.outcomes ? [...options.outcomes] : undefined;

	const pi = {
		on: (event: string, handler: Handler) => {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		registerFlag: (name: string, definition: { description?: string }) => {
			(flags as any).definitions ??= {};
			(flags as any).definitions[name] = definition;
		},
		registerCommand: (name: string, definition: { description?: string; handler: any }) => {
			commands.set(name, definition);
		},
		getFlag: (name: string) => flags.get(name),
		appendEntry: (type: string, data: unknown) => {
			entries.push({ type, data });
		},
	};

	const ctx = {
		hasUI: options.hasUI ?? true,
		cwd: "/project",
		model: { provider: "uwoacrimson", api: "openai-responses", id: "gpt-5.6-luna" },
		signal: undefined,
		sessionManager: {
			buildContextEntries: () => options.sessionEntries ?? [userEntry("u1", "add a regression test for the replay bug")],
		},
		modelRegistry: {
			find: () => ({ provider: "uwoacrimson", id: "gpt-5.6-sol", api: "openai-responses" }),
			complete: async (_model: unknown, context: any) => {
				classifierCalls.push({ systemPrompt: context.systemPrompt, messages: context.messages });
				return {
					role: "assistant",
					content: [{ type: "text", text: options.classifierText ?? "low" }],
					stopReason: "stop",
					usage: {},
				};
			},
		},
		ui: {
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			confirm: async () => options.confirmed ?? false,
		},
	};

	const requestReview = async (params: Record<string, unknown>): Promise<ReviewOutcome> => {
		reviewCalls.push(params);
		if (sequence && sequence.length > 1) return sequence.shift()!;
		return sequence?.[0] ?? outcome;
	};

	const loadConfig = () => ({
		config: {
			compaction: DEFAULT_COMPACTION_CONFIG,
			webSearch: DEFAULT_WEB_SEARCH_CONFIG,
			imageGeneration: DEFAULT_IMAGE_GENERATION_CONFIG,
			autoMode,
		},
		source: undefined,
		warnings: [],
	});

	registerAutoModeExtension(pi as never, loadConfig as never, requestReview as never);

	const fire = (event: string, handlerEvent: unknown = {}, handlerCtx = ctx) =>
		handlers.get(event)?.[0]?.(handlerEvent, handlerCtx);
	const runCommand = async (args: string, handlerCtx = ctx) => commands.get("auto")?.handler(args, handlerCtx);
	/** Let the fire-and-forget classification promise settle. */
	const flush = async () => {
		for (let round = 0; round < 5; round += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	};

	return {
		pi,
		ctx,
		handlers,
		commands,
		entries,
		notifications,
		statuses,
		reviewCalls,
		classifierCalls,
		autoMode,
		fire,
		runCommand,
		flush,
		setFlag: (value: boolean) => flags.set("auto", value),
	};
}

const allowlisted = { models: ["uwoacrimson/gpt-5.6-luna"], reviewerModel: "uwoacrimson/gpt-5.6-sol" };
const bashCall = { toolName: "bash", toolCallId: "c1", input: { command: "bun test" } };

describe("auto mode extension registration", () => {
	test("registers the startup flag and the toggle command once", () => {
		const harness = createHarness();
		registerAutoModeExtension(harness.pi as never, (() => ({ config: {}, warnings: [] })) as never, (async () => ({})) as never);
		expect(harness.commands.has("auto")).toBe(true);
		expect(harness.commands.get("auto")?.description).toContain("/auto");
		expect(harness.handlers.get("tool_call")).toHaveLength(1);
		expect(harness.handlers.has("before_provider_request")).toBe(false);
		expect(harness.handlers.has("tool_result")).toBe(true);
		expect(harness.handlers.has("turn_start")).toBe(true);
	});

	test("engaging at session start is synchronous and makes no provider call", async () => {
		const harness = createHarness({ autoMode: allowlisted, flagValue: true });
		const result = harness.fire("session_start");
		expect(result).toBeUndefined();
		expect(harness.reviewCalls).toHaveLength(0);
		expect(harness.classifierCalls).toHaveLength(0);
		expect(harness.statuses.at(-1)).toContain("auto-review");

		await harness.fire("tool_call", bashCall);
		expect(harness.reviewCalls).toHaveLength(1);
	});

	test("the flag cannot engage an unlisted model", async () => {
		const harness = createHarness({ autoMode: { models: ["uwoacrimson/gpt-5.6-sol"], reviewerModel: "uwoacrimson/gpt-5.6-sol" }, flagValue: true });
		harness.fire("session_start");
		expect(harness.notifications.at(-1)?.level).toBe("warning");
		expect(harness.statuses.at(-1)).toBeUndefined();

		await harness.fire("tool_call", bashCall);
		expect(harness.reviewCalls).toHaveLength(0);
	});

	test("a missing reviewer model keeps auto mode unavailable", () => {
		const harness = createHarness({ autoMode: { models: ["uwoacrimson/gpt-5.6-luna"] }, flagValue: true });
		harness.fire("session_start");
		expect(harness.statuses.at(-1)).toBeUndefined();
	});
});

describe("auto mode tool gate", () => {
	test("read-only tools bypass the reviewer by default", async () => {
		const harness = createHarness({ autoMode: allowlisted, flagValue: true });
		harness.fire("session_start");
		const result = await harness.fire("tool_call", { toolName: "read", toolCallId: "c", input: { path: "a.ts" } });
		expect(result).toBeUndefined();
		expect(harness.reviewCalls).toHaveLength(0);
	});

	test("an allow verdict runs the tool and records the risk axes", async () => {
		const harness = createHarness({ autoMode: allowlisted, flagValue: true });
		harness.fire("session_start");
		const result = await harness.fire("tool_call", bashCall);
		expect(result).toBeUndefined();
		expect(harness.entries.at(-1)?.data).toMatchObject({
			toolName: "bash",
			toolCallId: "c1",
			decision: "allow",
			source: "reviewer",
			riskLevel: "low",
			userAuthorization: "medium",
		});
		expect(JSON.stringify(harness.entries)).not.toContain("bun test");
	});

	test("a deny verdict blocks and forbids circumvention", async () => {
		const harness = createHarness({ autoMode: allowlisted, flagValue: true, outcome: denyVerdict("force push rewrites shared history") });
		harness.fire("session_start");
		const result = (await harness.fire("tool_call", {
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "git push --force" },
		})) as { block?: boolean; reason?: string; terminate?: boolean };
		expect(result.block).toBe(true);
		expect(result.terminate).toBeUndefined();
		expect(result.reason).toContain("force push rewrites shared history");
		expect(result.reason).toContain("Risk: high");
		expect(result.reason).toContain("must not attempt to achieve the same outcome by workaround");
		expect(harness.entries.at(-1)?.data).toMatchObject({ decision: "deny", source: "reviewer" });
	});

	test("review failure degrades to a human confirmation when UI exists", async () => {
		const harness = createHarness({
			autoMode: allowlisted,
			flagValue: true,
			outcome: { kind: "unavailable", reason: "reviewer model is not available", cause: "not-configured" },
			confirmed: true,
		});
		harness.fire("session_start");
		const result = await harness.fire("tool_call", { toolName: "write", toolCallId: "c1", input: { path: "a.ts" } });
		expect(result).toBeUndefined();
		expect(harness.entries.at(-1)?.data).toMatchObject({ decision: "unavailable-allowed", source: "human" });
	});

	test("an incomplete review is reported as a failure, never as a safety verdict", async () => {
		const harness = createHarness({
			autoMode: allowlisted,
			flagValue: true,
			outcome: { kind: "unavailable", reason: "review timed out", cause: "timeout" },
			hasUI: false,
		});
		harness.fire("session_start");
		const result = (await harness.fire("tool_call", {
			toolName: "edit",
			toolCallId: "c1",
			input: { edits: [] },
		})) as { block?: boolean; reason?: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("Review status: timeout");
		expect(result.reason).toContain("Do not assume the action is unsafe");
		expect(result.reason).not.toContain("rejected by the approval reviewer");
	});

	test("without an interactive UI a failed review fails closed", async () => {
		const harness = createHarness({
			autoMode: allowlisted,
			flagValue: true,
			outcome: { kind: "unavailable", reason: "reviewer returned no verdict", cause: "invalid-output" },
			hasUI: false,
		});
		harness.fire("session_start");
		const result = (await harness.fire("tool_call", {
			toolName: "edit",
			toolCallId: "c1",
			input: { edits: [] },
		})) as { block?: boolean; reason?: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("no interactive surface is available");
		expect(harness.entries.at(-1)?.data).toMatchObject({ decision: "unavailable-blocked", source: "policy" });
	});

	test("the all gate and extraTools widen coverage", async () => {
		const all = createHarness({ autoMode: { ...allowlisted, gate: "all" }, flagValue: true });
		all.fire("session_start");
		await all.fire("tool_call", { toolName: "read", toolCallId: "c", input: { path: "a.ts" } });
		expect(all.reviewCalls).toHaveLength(1);

		const extras = createHarness({ autoMode: { ...allowlisted, extraTools: ["openai_generate_image"] }, flagValue: true });
		extras.fire("session_start");
		await extras.fire("tool_call", { toolName: "openai_generate_image", toolCallId: "c", input: { prompt: "x" } });
		expect(extras.reviewCalls).toHaveLength(1);
		await extras.fire("tool_call", { toolName: "read", toolCallId: "c2", input: { path: "a.ts" } });
		expect(extras.reviewCalls).toHaveLength(1);
	});

	test("forwards a bounded transcript instead of a single intent line", async () => {
		const harness = createHarness({
			autoMode: allowlisted,
			flagValue: true,
			sessionEntries: [
				userEntry("u1", "add a regression test for the replay bug"),
				assistantEntry("a1", "I will edit the replay test."),
			],
		});
		harness.fire("session_start");
		await harness.fire("tool_call", bashCall);
		const call = harness.reviewCalls[0] as { transcript?: string; cwd?: string; timeoutMs?: number };
		expect(call.transcript).toContain("[user]: add a regression test for the replay bug");
		expect(call.transcript).toContain("[assistant]: I will edit the replay test.");
		expect(call.cwd).toBe("/project");
		expect(call.timeoutMs).toBe(DEFAULT_AUTO_MODE_CONFIG.timeoutMs);
	});

	test("transcript can be switched off, which leaves authorization unknown", async () => {
		const harness = createHarness({ autoMode: { ...allowlisted, transcript: false }, flagValue: true });
		harness.fire("session_start");
		await harness.fire("tool_call", bashCall);
		expect((harness.reviewCalls[0] as { transcript?: string }).transcript).toBeUndefined();
	});

	test("read-only evidence tools are handed to the reviewer only when enabled", async () => {
		const off = createHarness({ autoMode: allowlisted, flagValue: true });
		off.fire("session_start");
		await off.fire("tool_call", bashCall);
		expect((off.reviewCalls[0] as { evidenceTools?: unknown }).evidenceTools).toBeUndefined();

		const on = createHarness({ autoMode: { ...allowlisted, evidenceTools: true }, flagValue: true });
		on.fire("session_start");
		await on.fire("tool_call", bashCall);
		const tools = (on.reviewCalls[0] as { evidenceTools?: Array<{ name: string }> }).evidenceTools;
		expect(tools?.map((tool) => tool.name).sort()).toEqual(["find", "grep", "ls", "read"]);
	});
});

describe("auto mode trajectory pre-scorer", () => {
	const classifier = {
		classifier: { enabled: true, model: "uwoacrimson/gpt-5.6-sol", timeoutMs: 15_000, maxLag: 2 },
	};

	test("a fresh low-risk score satisfies the next gated call without a review", async () => {
		const harness = createHarness({ autoMode: { ...allowlisted, ...classifier }, flagValue: true });
		harness.fire("session_start");

		await harness.fire("tool_call", bashCall);
		expect(harness.reviewCalls).toHaveLength(1);
		await harness.fire("tool_result", { toolName: "bash", toolCallId: "c1", input: bashCall.input });
		await harness.flush();
		expect(harness.classifierCalls).toHaveLength(1);

		await harness.fire("tool_call", { ...bashCall, toolCallId: "c2" });
		expect(harness.reviewCalls).toHaveLength(1);
		expect(harness.entries.at(-1)?.data).toMatchObject({
			toolCallId: "c2",
			decision: "allow",
			source: "classifier",
			fastDecision: "low_risk",
		});
	});

	test("a high-risk classification still runs the blocking reviewer", async () => {
		const harness = createHarness({ autoMode: { ...allowlisted, ...classifier }, flagValue: true, classifierText: "high" });
		harness.fire("session_start");
		await harness.fire("tool_call", bashCall);
		await harness.fire("tool_result", { toolName: "bash", toolCallId: "c1", input: bashCall.input });
		await harness.flush();

		await harness.fire("tool_call", { ...bashCall, toolCallId: "c2" });
		expect(harness.reviewCalls).toHaveLength(2);
	});

	test("a stale score cannot satisfy a later call", async () => {
		const harness = createHarness({
			autoMode: { ...allowlisted, classifier: { ...classifier.classifier, maxLag: 0 } },
			flagValue: true,
		});
		harness.fire("session_start");
		await harness.fire("tool_call", bashCall);
		await harness.fire("tool_result", { toolName: "bash", toolCallId: "c1", input: bashCall.input });
		await harness.flush();

		// Two unreviewed calls push the score past the lag budget.
		await harness.fire("tool_call", { toolName: "read", toolCallId: "r1", input: { path: "a" } });
		await harness.fire("tool_call", { toolName: "read", toolCallId: "r2", input: { path: "b" } });
		await harness.fire("tool_call", { ...bashCall, toolCallId: "c2" });
		expect(harness.reviewCalls).toHaveLength(2);
	});

	test("an unreadable classification is a failure, not a low-risk score", async () => {
		const harness = createHarness({ autoMode: { ...allowlisted, ...classifier }, flagValue: true, classifierText: "maybe high?" });
		harness.fire("session_start");
		await harness.fire("tool_call", bashCall);
		await harness.fire("tool_result", { toolName: "bash", toolCallId: "c1", input: bashCall.input });
		await harness.flush();

		await harness.fire("tool_call", { ...bashCall, toolCallId: "c2" });
		expect(harness.reviewCalls).toHaveLength(2);
	});

	test("a tool denied earlier in the turn never takes the fast path", async () => {
		const harness = createHarness({
			autoMode: { ...allowlisted, ...classifier },
			flagValue: true,
			outcome: denyVerdict("writes outside the project"),
		});
		harness.fire("session_start");
		await harness.fire("tool_call", bashCall);
		expect(harness.entries.at(-1)?.data).toMatchObject({ decision: "deny" });

		await harness.fire("tool_result", { toolName: "bash", toolCallId: "c1", input: bashCall.input });
		await harness.flush();
		await harness.fire("tool_call", { ...bashCall, toolCallId: "c2" });
		expect(harness.reviewCalls).toHaveLength(2);
	});
});

describe("auto mode rejection circuit breaker", () => {
	test("repeated denials interrupt the turn instead of negotiating forever", async () => {
		const harness = createHarness({
			autoMode: {
				...allowlisted,
				circuitBreaker: { consecutiveDenials: 2, recentDenials: 0, windowSize: 50 },
			},
			flagValue: true,
			outcome: denyVerdict("touches credentials"),
		});
		harness.fire("session_start");

		const first = (await harness.fire("tool_call", { ...bashCall, toolCallId: "c1" })) as { terminate?: boolean };
		expect(first.terminate).toBeUndefined();

		const second = (await harness.fire("tool_call", { ...bashCall, toolCallId: "c2" })) as {
			block?: boolean;
			terminate?: boolean;
			reason?: string;
		};
		expect(second.block).toBe(true);
		expect(second.terminate).toBe(true);
		expect(second.reason).toContain("Repeated denials");
		expect(harness.entries.at(-1)?.data).toMatchObject({ decision: "turn-interrupted", source: "circuit-breaker" });
	});

	test("an allow resets the consecutive run", async () => {
		const harness = createHarness({
			autoMode: { ...allowlisted, circuitBreaker: { consecutiveDenials: 2, recentDenials: 0, windowSize: 50 } },
			flagValue: true,
			outcomes: [
				denyVerdict("first attempt is too broad"),
				allowVerdict("narrower retry is fine"),
				denyVerdict("this one is too broad again"),
			],
		});
		harness.fire("session_start");

		const first = (await harness.fire("tool_call", { ...bashCall, toolCallId: "c1" })) as { terminate?: boolean };
		expect(first.terminate).toBeUndefined();
		// An allow returns nothing at all: the tool runs.
		await expect(harness.fire("tool_call", { ...bashCall, toolCallId: "c2" })).resolves.toBeUndefined();
		const third = (await harness.fire("tool_call", { ...bashCall, toolCallId: "c3" })) as { terminate?: boolean };
		expect(third.terminate).toBeUndefined();
	});

	test("turn_start clears the breaker so the next turn starts clean", async () => {
		const harness = createHarness({
			autoMode: { ...allowlisted, circuitBreaker: { consecutiveDenials: 2, recentDenials: 0, windowSize: 50 } },
			flagValue: true,
			outcomes: [
				denyVerdict("denied in the first turn"),
				denyVerdict("would be the second denial and trip the breaker"),
				denyVerdict("first denial of the new turn"),
			],
		});
		harness.fire("session_start");
		await harness.fire("tool_call", { ...bashCall, toolCallId: "c1" });

		const tripped = (await harness.fire("tool_call", { ...bashCall, toolCallId: "c2" })) as { terminate?: boolean };
		expect(tripped.terminate).toBe(true);

		harness.fire("turn_start");
		const next = (await harness.fire("tool_call", { ...bashCall, toolCallId: "c3" })) as { terminate?: boolean };
		expect(next.terminate).toBeUndefined();
	});
});

describe("auto mode command", () => {
	test("/auto on and off toggle engagement without a provider call", async () => {
		const harness = createHarness({ autoMode: allowlisted });
		harness.fire("session_start");
		expect(harness.statuses.at(-1)).toBeUndefined();

		await harness.runCommand("on");
		expect(harness.statuses.at(-1)).toContain("auto-review");
		expect(harness.reviewCalls).toHaveLength(0);

		await harness.fire("tool_call", bashCall);
		expect(harness.reviewCalls).toHaveLength(1);

		await harness.runCommand("off");
		expect(harness.statuses.at(-1)).toBeUndefined();
		await harness.fire("tool_call", { ...bashCall, toolCallId: "c2" });
		expect(harness.reviewCalls).toHaveLength(1);
	});

	test("/auto all overrides the configured gate and /auto side restores it", async () => {
		const harness = createHarness({ autoMode: allowlisted });
		harness.fire("session_start");
		await harness.runCommand("all");
		await harness.fire("tool_call", { toolName: "read", toolCallId: "c1", input: { path: "a" } });
		expect(harness.reviewCalls).toHaveLength(1);

		await harness.runCommand("side");
		await harness.fire("tool_call", { toolName: "read", toolCallId: "c2", input: { path: "a" } });
		expect(harness.reviewCalls).toHaveLength(1);
	});

	test("/auto status reports the reviewer, pre-scorer, and breaker settings", async () => {
		const harness = createHarness({ autoMode: allowlisted, flagValue: true });
		harness.fire("session_start");
		await harness.runCommand("status");
		const message = harness.notifications.at(-1)?.message ?? "";
		expect(message).toContain("Reviewer: uwoacrimson/gpt-5.6-sol");
		expect(message).toContain("Pre-scorer: off");
		expect(message).toContain("Circuit breaker: 3 consecutive");
	});

	test("/auto status and unknown arguments report instead of changing state", async () => {
		const harness = createHarness({ autoMode: allowlisted });
		harness.fire("session_start");
		await harness.runCommand("status");
		expect(harness.notifications.at(-1)?.message).toContain("Auto mode off");
		await harness.runCommand("nonsense");
		expect(harness.notifications.at(-1)?.message).toContain("Usage: /auto");
		expect(harness.reviewCalls).toHaveLength(0);
	});
});

describe("auto mode model changes", () => {
	test("switching to an unlisted model disengages auto mode", async () => {
		const harness = createHarness({ autoMode: allowlisted, flagValue: true });
		harness.fire("session_start");
		harness.fire("model_select", { model: { provider: "uwoacrimson", api: "openai-responses", id: "gpt-5.5" } });
		expect(harness.notifications.at(-1)?.message).toContain("not allowlisted");
		await harness.fire("tool_call", bashCall);
		expect(harness.reviewCalls).toHaveLength(0);
	});

	test("switching back re-engages only through an explicit request", async () => {
		const harness = createHarness({ autoMode: allowlisted, flagValue: true });
		harness.fire("session_start");
		harness.fire("model_select", { model: { provider: "uwoacrimson", api: "openai-responses", id: "gpt-5.5" } });
		harness.fire("model_select", { model: { provider: "uwoacrimson", api: "openai-responses", id: "gpt-5.6-luna" } });
		await harness.fire("tool_call", bashCall);
		expect(harness.reviewCalls).toHaveLength(0);

		await harness.runCommand("on");
		await harness.fire("tool_call", { ...bashCall, toolCallId: "c2" });
		expect(harness.reviewCalls).toHaveLength(1);
	});
});

describe("auto mode reviewer prompt and transcript", () => {
	test("the reviewer policy separates risk from authorization and pins the trust model", () => {
		const prompt = reviewerSystemPrompt(false);
		expect(prompt).toContain("# User authorization scoring");
		expect(prompt).toContain("# Base risk taxonomy");
		expect(prompt).toContain("# Outcome policy");
		expect(prompt).toContain("marked `[user]` establish authorization");
		expect(prompt).toContain('{"outcome":"allow"}');
		expect(prompt).not.toContain("# Investigation");
	});

	test("investigation rules only appear when read-only tools are actually offered", () => {
		expect(reviewerSystemPrompt(true)).toContain("You have read-only tools: `read`, `grep`, `find`, `ls`.");
	});

	test("the classifier is told it cannot approve anything", () => {
		expect(buildClassifierPrompt({ transcript: "x", pendingToolName: "bash", pendingToolInput: {} })).toContain(
			"Classify the trajectory. One token.",
		);
	});

	test("user turns survive verbose tool output", () => {
		const lines = [
			userEntry("u1", "the original task"),
			...Array.from({ length: 30 }, (_, index) => ({
				type: "message",
				id: `t${index}`,
				message: { role: "toolResult", content: [{ type: "text", text: `output ${index} ${"x".repeat(500)}` }] },
			})),
			userEntry("u2", "the latest ask"),
		];
		const { text } = transcriptFromEntries(lines as never, { maxTotalChars: 4_000, maxToolChars: 1_000 });
		expect(text).toContain("[user]: the original task");
		expect(text).toContain("[user]: the latest ask");
		expect(text.length).toBeLessThan(6_000);
	});

	test("omitted history is marked rather than silently dropped", () => {
		const lines = Array.from({ length: 80 }, (_, index) => assistantEntry(`a${index}`, `step ${index}`));
		const { text, omitted } = transcriptFromEntries(lines as never, { maxRecentEntries: 10, maxTotalChars: 2_000 });
		expect(omitted).toBe(true);
		expect(text).toContain("earlier conversation entries were omitted");
	});
});
