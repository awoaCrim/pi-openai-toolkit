import { describe, expect, test } from "bun:test";
import { DEFAULT_AUTO_MODE_CONFIG, DEFAULT_COMPACTION_CONFIG, DEFAULT_IMAGE_GENERATION_CONFIG, DEFAULT_WEB_SEARCH_CONFIG, type AutoModeConfig } from "../types";
import { registerAutoModeExtension } from "./extension";
import type { ReviewOutcome } from "./types";

type Handler = (event: any, ctx: any) => unknown;

function configWith(overrides: Partial<AutoModeConfig> = {}): AutoModeConfig {
	return {
		...DEFAULT_AUTO_MODE_CONFIG,
		models: [...DEFAULT_AUTO_MODE_CONFIG.models],
		extraTools: [...DEFAULT_AUTO_MODE_CONFIG.extraTools],
		...overrides,
	};
}

function createHarness(options: {
	autoMode?: Partial<AutoModeConfig>;
	flagValue?: boolean;
	outcome?: ReviewOutcome;
	confirmed?: boolean;
	hasUI?: boolean;
} = {}) {
	const autoMode = configWith(options.autoMode);
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
	const flags = new Map<string, boolean | string | undefined>([["auto", options.flagValue ?? false]]);
	const entries: Array<{ type: string; data: any }> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const statuses: Array<string | undefined> = [];
	const reviewCalls: Array<Record<string, unknown>> = [];

	const outcome: ReviewOutcome = options.outcome ?? {
		kind: "allow",
		reason: "looks fine",
		reviewerModel: "uwoacrimson/gpt-5.6-sol",
	};

	const pi = {
		on: (event: string, handler: Handler) => {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		registerFlag: (name: string, definition: { description?: string }) => {
			flags.set(name, flags.get(name));
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
		modelRegistry: { find: () => undefined, complete: async () => undefined },
		ui: {
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			confirm: async () => options.confirmed ?? false,
		},
	};

	const requestReview = async (params: Record<string, unknown>): Promise<ReviewOutcome> => {
		reviewCalls.push(params);
		return outcome;
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

	return {
		pi,
		ctx,
		handlers,
		commands,
		entries,
		notifications,
		statuses,
		reviewCalls,
		autoMode,
		fire,
		runCommand,
		setFlag: (value: boolean) => flags.set("auto", value),
	};
}

const allowlisted = { models: ["uwoacrimson/gpt-5.6-luna"], reviewerModel: "uwoacrimson/gpt-5.6-sol" };

describe("auto mode extension registration", () => {
	test("registers the startup flag and the toggle command once", () => {
		const harness = createHarness();
		registerAutoModeExtension(harness.pi as never, (() => ({ config: {}, warnings: [] })) as never, (async () => ({})) as never);
		expect(harness.commands.has("auto")).toBe(true);
		expect(harness.commands.get("auto")?.description).toContain("/auto");
		expect((harness.pi as any).on).toBeTypeOf("function");
		expect(harness.handlers.get("tool_call")).toHaveLength(1);
		expect(harness.handlers.has("before_provider_request")).toBe(false);
	});

	test("engaging at session start is synchronous and makes no provider call", async () => {
		const harness = createHarness({ autoMode: allowlisted, flagValue: true });
		const result = harness.fire("session_start");
		expect(result).toBeUndefined();
		expect(harness.reviewCalls).toHaveLength(0);
		expect(harness.statuses.at(-1)).toContain("auto-review");

		await harness.fire("tool_call", { toolName: "bash", toolCallId: "call-1", input: { command: "ls" } });
		expect(harness.reviewCalls).toHaveLength(1);
	});

	test("the flag cannot engage an unlisted model", async () => {
		const harness = createHarness({ autoMode: { models: ["uwoacrimson/gpt-5.6-sol"], reviewerModel: "uwoacrimson/gpt-5.6-sol" }, flagValue: true });
		harness.fire("session_start");
		expect(harness.notifications.at(-1)?.level).toBe("warning");
		expect(harness.statuses.at(-1)).toBeUndefined();

		await harness.fire("tool_call", { toolName: "bash", toolCallId: "call-1", input: { command: "ls" } });
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

	test("an allow verdict runs the tool and records the decision", async () => {
		const harness = createHarness({ autoMode: allowlisted, flagValue: true });
		harness.fire("session_start");
		const result = await harness.fire("tool_call", { toolName: "bash", toolCallId: "c1", input: { command: "npm test" } });
		expect(result).toBeUndefined();
		expect(harness.entries.at(-1)?.data).toMatchObject({ toolName: "bash", toolCallId: "c1", decision: "allow", source: "reviewer" });
		expect(JSON.stringify(harness.entries)).not.toContain("npm test");
	});

	test("a deny verdict blocks with the reviewer reason", async () => {
		const harness = createHarness({
			autoMode: allowlisted,
			flagValue: true,
			outcome: { kind: "deny", reason: "force push rewrites shared history", reviewerModel: "uwoacrimson/gpt-5.6-sol" },
		});
		harness.fire("session_start");
		const result = (await harness.fire("tool_call", {
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "git push --force" },
		})) as { block?: boolean; reason?: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("force push rewrites shared history");
		expect(harness.entries.at(-1)?.data).toMatchObject({ decision: "deny", source: "reviewer" });
	});

	test("review failure degrades to a human confirmation when UI exists", async () => {
		const harness = createHarness({
			autoMode: allowlisted,
			flagValue: true,
			outcome: { kind: "unavailable", reason: "reviewer model is not available" },
			confirmed: true,
		});
		harness.fire("session_start");
		const result = await harness.fire("tool_call", { toolName: "write", toolCallId: "c1", input: { path: "a.ts" } });
		expect(result).toBeUndefined();
		expect(harness.entries.at(-1)?.data).toMatchObject({ decision: "unavailable-allowed", source: "human" });
	});

	test("a human declining after review failure keeps the tool blocked", async () => {
		const harness = createHarness({
			autoMode: allowlisted,
			flagValue: true,
			outcome: { kind: "unavailable", reason: "review timed out" },
			confirmed: false,
		});
		harness.fire("session_start");
		const result = (await harness.fire("tool_call", {
			toolName: "write",
			toolCallId: "c1",
			input: { path: "a.ts" },
		})) as { block?: boolean; reason?: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("Blocked by user");
	});

	test("without an interactive UI a failed review fails closed", async () => {
		const harness = createHarness({
			autoMode: allowlisted,
			flagValue: true,
			outcome: { kind: "unavailable", reason: "reviewer returned no verdict" },
			hasUI: false,
		});
		harness.fire("session_start");
		const result = (await harness.fire("tool_call", {
			toolName: "edit",
			toolCallId: "c1",
			input: { edits: [] },
		})) as { block?: boolean; reason?: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("no interactive UI can confirm");
		expect(harness.entries.at(-1)?.data).toMatchObject({ decision: "unavailable-blocked", source: "policy" });
	});

	test("the all gate and extraTools widen coverage", async () => {
		const all = createHarness({ autoMode: { ...allowlisted, gate: "all" }, flagValue: true });
		all.fire("session_start");
		await all.fire("tool_call", { toolName: "read", toolCallId: "c", input: { path: "a.ts" } });
		expect(all.reviewCalls).toHaveLength(1);

		const extras = createHarness({
			autoMode: { ...allowlisted, extraTools: ["openai_generate_image"] },
			flagValue: true,
		});
		extras.fire("session_start");
		await extras.fire("tool_call", { toolName: "openai_generate_image", toolCallId: "c", input: { prompt: "x" } });
		expect(extras.reviewCalls).toHaveLength(1);
		await extras.fire("tool_call", { toolName: "read", toolCallId: "c2", input: { path: "a.ts" } });
		expect(extras.reviewCalls).toHaveLength(1);
	});

	test("forwards the latest user request as reviewer intent", async () => {
		const harness = createHarness({ autoMode: allowlisted, flagValue: true });
		harness.fire("session_start");
		harness.fire("before_agent_start", { prompt: "add a regression test for the replay bug" });
		await harness.fire("tool_call", { toolName: "bash", toolCallId: "c1", input: { command: "bun test" } });
		expect(harness.reviewCalls[0]).toMatchObject({
			intent: "add a regression test for the replay bug",
			cwd: "/project",
			timeoutMs: DEFAULT_AUTO_MODE_CONFIG.timeoutMs,
		});
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

		await harness.fire("tool_call", { toolName: "bash", toolCallId: "c1", input: { command: "ls" } });
		expect(harness.reviewCalls).toHaveLength(1);

		await harness.runCommand("off");
		expect(harness.statuses.at(-1)).toBeUndefined();
		await harness.fire("tool_call", { toolName: "bash", toolCallId: "c2", input: { command: "ls" } });
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
		await harness.fire("tool_call", { toolName: "bash", toolCallId: "c1", input: { command: "ls" } });
		expect(harness.reviewCalls).toHaveLength(0);
	});

	test("switching back re-engages only through an explicit request", async () => {
		const harness = createHarness({ autoMode: allowlisted, flagValue: true });
		harness.fire("session_start");
		harness.fire("model_select", { model: { provider: "uwoacrimson", api: "openai-responses", id: "gpt-5.5" } });
		harness.fire("model_select", { model: { provider: "uwoacrimson", api: "openai-responses", id: "gpt-5.6-luna" } });
		await harness.fire("tool_call", { toolName: "bash", toolCallId: "c1", input: { command: "ls" } });
		expect(harness.reviewCalls).toHaveLength(0);

		await harness.runCommand("on");
		await harness.fire("tool_call", { toolName: "bash", toolCallId: "c2", input: { command: "ls" } });
		expect(harness.reviewCalls).toHaveLength(1);
	});
});
