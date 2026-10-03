import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_NATIVE_FALLBACK_CONFIG, type CompactionConfig, type NativeFallbackConfig } from "./types";

async function loadNativeFallbackModule() {
	return import("./native-fallback");
}

type FakeModel = {
	provider: string;
	id: string;
	api?: string;
	contextWindow?: number;
	maxTokens?: number;
};

function hugeMessage(chars: number) {
	return {
		role: "user",
		content: [{ type: "text", text: "x".repeat(chars) }],
		timestamp: 1,
	};
}

function hugeToolResult(chars: number) {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		isError: false,
		content: [{ type: "text", text: "x".repeat(chars) }],
		timestamp: 1,
	};
}

function createCtx(args: {
	currentModel?: FakeModel;
	registryModels?: FakeModel[];
	auth?: unknown;
	authError?: Error;
}) {
	return {
		model: args.currentModel,
		modelRegistry: {
			find: (provider: string, modelId: string) =>
				(args.registryModels ?? []).find((model) => model.provider === provider && model.id === modelId),
			getApiKeyAndHeaders: async () => {
				if (args.authError) {
					throw args.authError;
				}
				return args.auth ?? { ok: true, apiKey: "sk-fallback", headers: { "x-h": "1" }, env: { E: "1" } };
			},
		},
	} as never;
}

function createEvent(signal?: AbortSignal) {
	return {
		preparation: {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1234,
			fileOps: { readFiles: [], modifiedFiles: [] },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		},
		customInstructions: "focus on auth work",
		signal: signal ?? new AbortController().signal,
	} as never;
}

function createConfig(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
	return {
		...DEFAULT_COMPACTION_CONFIG,
		responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis],
		nativeFallback: { ...DEFAULT_NATIVE_FALLBACK_CONFIG },
		...overrides,
	};
}

function withFallback(overrides: Partial<NativeFallbackConfig> = {}): Partial<CompactionConfig> {
	return { nativeFallback: { ...DEFAULT_NATIVE_FALLBACK_CONFIG, ...overrides } };
}

afterEach(() => {
	mock.restore();
});

describe("parseModelSpec", () => {
	test("splits on the first slash so model ids may contain slashes", async () => {
		const { parseModelSpec } = await loadNativeFallbackModule();

		expect(parseModelSpec("openai/gpt-5-mini")).toEqual({ provider: "openai", modelId: "gpt-5-mini" });
		expect(parseModelSpec("openrouter/deepseek/deepseek-chat-v3")).toEqual({
			provider: "openrouter",
			modelId: "deepseek/deepseek-chat-v3",
		});
		expect(parseModelSpec("  google/gemini-2.5-flash  ")).toEqual({
			provider: "google",
			modelId: "gemini-2.5-flash",
		});
	});

	test("rejects specs without both provider and model id", async () => {
		const { parseModelSpec } = await loadNativeFallbackModule();

		expect(parseModelSpec("gpt-5-mini")).toBeUndefined();
		expect(parseModelSpec("/gpt-5-mini")).toBeUndefined();
		expect(parseModelSpec("openai/")).toBeUndefined();
		expect(parseModelSpec("")).toBeUndefined();
	});
});

describe("runNativeFallbackCompaction", () => {
	test("returns no-model-configured when the caller supplies no model spec", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();

		const result = await runNativeFallbackCompaction({
			ctx: createCtx({}),
			event: createEvent(),
			config: createConfig(),
		});

		expect(result).toEqual({ ok: false, reason: "no-model-configured" });
	});

	test("returns disabled without touching the registry when the switch is off", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();

		const result = await runNativeFallbackCompaction({
			ctx: createCtx({ registryModels: [{ provider: "google", id: "gemini-2.5-flash" }] }),
			event: createEvent(),
			config: createConfig(withFallback({ enabled: false })),
			modelSpec: "google/gemini-2.5-flash",
		});

		expect(result).toEqual({ ok: false, reason: "disabled" });
	});

	test("the native chain ignores remoteCompactModel unless the caller passes it explicitly", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();
		let compactCalls = 0;

		const result = await runNativeFallbackCompaction({
			ctx: createCtx({
				currentModel: { provider: "uwoacrimson", id: "gpt-5.6-sol" },
				registryModels: [{ provider: "uwoacrimson", id: "gpt-5.6-luna" }],
			}),
			event: createEvent(),
			config: createConfig({ remoteCompactModel: "uwoacrimson/gpt-5.6-luna" }),
			compactFn: (async () => {
				compactCalls += 1;
				return { summary: "unused", firstKeptEntryId: "entry-keep", tokensBefore: 1, details: {} };
			}) as never,
		});

		expect(result).toEqual({ ok: false, reason: "no-model-configured" });
		expect(compactCalls).toBe(0);
	});

	test("the caller-supplied spec drives the native chain regardless of remoteCompactModel", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();
		const explicitModel = { provider: "google", id: "gemini-2.5-flash" };

		const result = await runNativeFallbackCompaction({
			ctx: createCtx({
				currentModel: { provider: "uwoacrimson", id: "gpt-5.6-sol" },
				registryModels: [{ provider: "uwoacrimson", id: "gpt-5.6-luna" }, explicitModel],
			}),
			event: createEvent(),
			config: createConfig({
				remoteCompactModel: "uwoacrimson/gpt-5.6-luna",
				nativeFallback: { ...DEFAULT_NATIVE_FALLBACK_CONFIG, model: "google/gemini-2.5-flash" },
			}),
			modelSpec: "google/gemini-2.5-flash",
			compactFn: (async () => ({
				summary: "## Goal\nExplicit summary model.",
				firstKeptEntryId: "entry-keep",
				tokensBefore: 1234,
				details: {},
			})) as never,
		});

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.model).toEqual({ provider: "google", id: "gemini-2.5-flash" });
	});

	test("returns invalid-model-spec for malformed specs", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();

		const result = await runNativeFallbackCompaction({
			ctx: createCtx({}),
			event: createEvent(),
			config: createConfig(),
			modelSpec: "not-a-spec",
		});

		expect(result).toEqual({ ok: false, reason: "invalid-model-spec", modelSpec: "not-a-spec" });
	});

	test("returns model-not-found when the registry cannot resolve the spec", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();

		const result = await runNativeFallbackCompaction({
			ctx: createCtx({ registryModels: [] }),
			event: createEvent(),
			config: createConfig(),
			modelSpec: "google/gemini-2.5-flash",
		});

		expect(result).toEqual({ ok: false, reason: "model-not-found", modelSpec: "google/gemini-2.5-flash" });
	});

	test("returns same-as-current-model so pi's default path keeps streaming UI", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();
		const model = { provider: "anthropic", id: "claude-fable-5" };

		const result = await runNativeFallbackCompaction({
			ctx: createCtx({ currentModel: model, registryModels: [model] }),
			event: createEvent(),
			config: createConfig(),
			modelSpec: "anthropic/claude-fable-5",
		});

		expect(result).toEqual({
			ok: false,
			reason: "same-as-current-model",
			modelSpec: "anthropic/claude-fable-5",
		});
	});

	test("returns auth-failed when the registry reports an auth error", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();

		const result = await runNativeFallbackCompaction({
			ctx: createCtx({
				currentModel: { provider: "anthropic", id: "claude-fable-5" },
				registryModels: [{ provider: "google", id: "gemini-2.5-flash" }],
				auth: { ok: false, error: "no API key configured" },
			}),
			event: createEvent(),
			config: createConfig(),
			modelSpec: "google/gemini-2.5-flash",
		});

		expect(result).toEqual({
			ok: false,
			reason: "auth-failed",
			modelSpec: "google/gemini-2.5-flash",
			errorMessage: "no API key configured",
		});
	});

	test("runs pi's native compact() with the configured model, auth, and thinking level", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();
		const fallbackModel = { provider: "google", id: "gemini-2.5-flash" };
		const compactCalls: unknown[][] = [];
		const compactionResult = {
			summary: "## Goal\nShip the auth feature.",
			firstKeptEntryId: "entry-keep",
			tokensBefore: 1234,
			details: { readFiles: ["a.ts"], modifiedFiles: [] },
		};

		const event = createEvent();
		const result = await runNativeFallbackCompaction({
			ctx: createCtx({
				currentModel: { provider: "anthropic", id: "claude-fable-5" },
				registryModels: [fallbackModel],
				auth: {
					ok: true,
					apiKey: "sk-fallback",
					headers: { "x-h": "1", "x-delete": null },
					env: { E: "1" },
				},
			}),
			event,
			config: createConfig(withFallback({ thinkingLevel: "low" })),
			modelSpec: "google/gemini-2.5-flash",
			compactFn: (async (...args: unknown[]) => {
				compactCalls.push(args);
				return compactionResult;
			}) as never,
		});

		expect(result).toEqual({
			ok: true,
			result: compactionResult,
			model: { provider: "google", id: "gemini-2.5-flash" },
		});
		expect(compactCalls.length).toBe(1);
		const [preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, env] =
			compactCalls[0]!;
		expect(preparation).toBe((event as { preparation: unknown }).preparation);
		expect(model).toBe(fallbackModel as never);
		expect(apiKey).toBe("sk-fallback");
		expect(headers).toEqual({ "x-h": "1" });
		expect(customInstructions).toBe("focus on auth work");
		expect(signal).toBe((event as { signal: AbortSignal }).signal);
		expect(thinkingLevel).toBe("low");
		expect(streamFn).toBeUndefined();
		expect(env).toEqual({ E: "1" });
	});

	test("maps abort errors from compact() to the aborted reason", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();

		const result = await runNativeFallbackCompaction({
			ctx: createCtx({
				registryModels: [{ provider: "google", id: "gemini-2.5-flash" }],
			}),
			event: createEvent(),
			config: createConfig(),
			modelSpec: "google/gemini-2.5-flash",
			compactFn: (async () => {
				throw new DOMException("The operation was aborted.", "AbortError");
			}) as never,
		});

		expect(result).toEqual({
			ok: false,
			reason: "aborted",
			modelSpec: "google/gemini-2.5-flash",
		});
	});

	test("maps generic compact() failures to compact-failed with the error message", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();

		const result = await runNativeFallbackCompaction({
			ctx: createCtx({
				registryModels: [{ provider: "google", id: "gemini-2.5-flash" }],
			}),
			event: createEvent(),
			config: createConfig(),
			modelSpec: "google/gemini-2.5-flash",
			compactFn: (async () => {
				throw new Error("Summarization failed: rate limited");
			}) as never,
		});

		expect(result).toEqual({
			ok: false,
			reason: "compact-failed",
			modelSpec: "google/gemini-2.5-flash",
			errorMessage: "Summarization failed: rate limited",
		});
	});

	test("rejects empty summaries so a blank compaction never replaces history", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();

		const result = await runNativeFallbackCompaction({
			ctx: createCtx({
				registryModels: [{ provider: "google", id: "gemini-2.5-flash" }],
			}),
			event: createEvent(),
			config: createConfig(),
			modelSpec: "google/gemini-2.5-flash",
			compactFn: (async () => ({
				summary: "   ",
				firstKeptEntryId: "entry-keep",
				tokensBefore: 1234,
			})) as never,
		});

		expect(result).toEqual({
			ok: false,
			reason: "empty-summary",
			modelSpec: "google/gemini-2.5-flash",
		});
	});
});

describe("summarization size guard", () => {
	test("estimateSummarizationRequest covers the conversation, the previous summary and the output", async () => {
		const { estimateSummarizationRequest, fitsSummarizationRequest } = await loadNativeFallbackModule();
		const preparation = {
			...createEvent().preparation,
			messagesToSummarize: [hugeMessage(40_000)],
			turnPrefixMessages: [hugeMessage(4_000)],
			previousSummary: "y".repeat(4_000),
		};

		const size = estimateSummarizationRequest(preparation as never, { contextWindow: 272_000, maxTokens: 32_768 });

		// The serialized history, previous summary, and fixed framing are measured with Pi's chars/4 heuristic.
		expect(size.inputTokens).toBeGreaterThanOrEqual(Math.ceil(45_000 / 4));
		// pi caps the summary at min(floor(0.8 * reserveTokens), model.maxTokens).
		expect(size.outputTokens).toBe(13_107);
		expect(size.totalTokens).toBe(size.inputTokens + size.outputTokens);
		const narrowOutput = estimateSummarizationRequest(preparation as never, { contextWindow: 272_000, maxTokens: 4_096 });
		expect(narrowOutput.outputTokens).toBe(4_096);

		expect(fitsSummarizationRequest(size, { contextWindow: 272_000 })).toBe(true);
		expect(fitsSummarizationRequest(size, { contextWindow: 1_000 })).toBe(false);
		// An unknown window is never guessed at.
		expect(fitsSummarizationRequest(size, {})).toBe(true);
	});

	test("matches Pi's serialized tool-result prompt instead of raw tool content", async () => {
		const { estimateSummarizationRequest, fitsSummarizationRequest, runNativeFallbackCompaction } = await loadNativeFallbackModule();
		const preparation = {
			...createEvent().preparation,
			messagesToSummarize: [hugeToolResult(1_200_000)],
		};
		const size = estimateSummarizationRequest(preparation as never, { contextWindow: 272_000, maxTokens: 32_768 });

		// Pi truncates the tool result to 2,000 characters before serializeConversation().
		expect(size.inputTokens).toBeLessThan(2_000);
		expect(size.outputTokens).toBe(13_107);
		expect(fitsSummarizationRequest(size, { contextWindow: 272_000 })).toBe(true);

		let authCalls = 0;
		let compactCalls = 0;
		const fallbackModel = {
			provider: "uwoacrimson",
			id: "gpt-5.6-luna",
			contextWindow: 272_000,
			maxTokens: 32_768,
		};
		const ctx = createCtx({
			currentModel: { provider: "uwoacrimson", id: "deepseek-v4-flash-0731", contextWindow: 400_000 },
			registryModels: [fallbackModel],
		});
		(ctx.modelRegistry as never as { getApiKeyAndHeaders: unknown }).getApiKeyAndHeaders = async () => {
			authCalls += 1;
			return { ok: true, apiKey: "sk-fallback", headers: {}, env: {} };
		};
		const result = await runNativeFallbackCompaction({
			ctx,
			event: { ...createEvent(), preparation } as never,
			config: createConfig(withFallback({ model: "uwoacrimson/gpt-5.6-luna" })),
			modelSpec: "uwoacrimson/gpt-5.6-luna",
			compactFn: (async () => {
				compactCalls += 1;
				return { summary: "ok", firstKeptEntryId: "entry-keep", tokensBefore: 1, details: {} };
			}) as never,
		});

		expect(result.ok).toBe(true);
		expect(authCalls).toBe(1);
		expect(compactCalls).toBe(1);
	});

	test("uses effective reserve and checks split-turn requests independently", async () => {
		const { estimateSummarizationRequest } = await loadNativeFallbackModule();
		const preparation = {
			...createEvent().preparation,
			isSplitTurn: true,
			settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 },
			messagesToSummarize: [hugeMessage(400_000)],
			turnPrefixMessages: [hugeMessage(400_000)],
			previousSummary: "p".repeat(4_000),
		};
		const size = estimateSummarizationRequest(
			preparation as never,
			{ contextWindow: 120_000, maxTokens: 32_768 },
			"c".repeat(4_000),
		);

		// History uses floor(0.8 * effective reserve), and the two serialized
		// conversations are separate requests rather than one combined input.
		expect(size.outputTokens).toBe(8_000);
		expect(size.totalTokens).toBe(size.inputTokens + 8_000);
		expect(size.totalTokens).toBeLessThan(120_000);

		const prefixOnly = estimateSummarizationRequest(
			{
				...preparation,
				messagesToSummarize: [],
				previousSummary: undefined,
			} as never,
			{ contextWindow: 120_000, maxTokens: 32_768 },
			"ignored for the turn-prefix request",
		);
		expect(prefixOnly.outputTokens).toBe(5_000);
		expect(prefixOnly.inputTokens).toBeLessThan(size.inputTokens);
	});

	test("checks an oversized split-turn prefix even when the history request fits", async () => {
		const { estimateSummarizationRequest, runNativeFallbackCompaction } = await loadNativeFallbackModule();
		const preparation = {
			...createEvent().preparation,
			isSplitTurn: true,
			settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 },
			messagesToSummarize: [hugeMessage(400)],
			turnPrefixMessages: [hugeMessage(500_000)],
			previousSummary: undefined,
		};
		const model = { provider: "uwoacrimson", id: "gpt-5.6-luna", contextWindow: 120_000, maxTokens: 32_768 };
		const historySize = estimateSummarizationRequest(
			{ ...preparation, isSplitTurn: false, turnPrefixMessages: [] } as never,
			model,
			"focus on auth work",
		);
		const prefixSize = estimateSummarizationRequest(
			{ ...preparation, messagesToSummarize: [], previousSummary: undefined } as never,
			model,
		);
		expect(historySize.totalTokens).toBeLessThan(model.contextWindow);
		expect(prefixSize.totalTokens).toBeGreaterThan(model.contextWindow);

		let authCalls = 0;
		let compactCalls = 0;
		const ctx = createCtx({
			currentModel: { provider: "uwoacrimson", id: "deepseek-v4-flash-0731", contextWindow: 400_000 },
			registryModels: [model],
		});
		(ctx.modelRegistry as never as { getApiKeyAndHeaders: unknown }).getApiKeyAndHeaders = async () => {
			authCalls += 1;
			return { ok: true, apiKey: "sk-fallback", headers: {}, env: {} };
		};
		const result = await runNativeFallbackCompaction({
			ctx,
			event: { ...createEvent(), preparation } as never,
			config: createConfig(withFallback({ model: "uwoacrimson/gpt-5.6-luna" })),
			modelSpec: "uwoacrimson/gpt-5.6-luna",
			compactFn: (async () => {
				compactCalls += 1;
				return { summary: "must not run", firstKeptEntryId: "entry-keep", tokensBefore: 1, details: {} };
			}) as never,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.reason).toBe("model-window-too-small");
		expect(result.contextWindow).toBe(model.contextWindow);
		expect(result.estimatedTokens).toBe(prefixSize.totalTokens);
		expect(compactCalls).toBe(0);
		expect(authCalls).toBe(0);
	});

	test("counts previous summary and custom instructions in the history request", async () => {
		const { estimateSummarizationRequest } = await loadNativeFallbackModule();
		const base = {
			...createEvent().preparation,
			messagesToSummarize: [hugeMessage(400)],
			previousSummary: undefined,
		};
		const withPromptExtras = estimateSummarizationRequest(
			{ ...base, previousSummary: "p".repeat(4_000) } as never,
			{ maxTokens: 32_768 },
			"c".repeat(4_000),
		);
		const withoutPromptExtras = estimateSummarizationRequest(base as never, { maxTokens: 32_768 });

		expect(withPromptExtras.inputTokens - withoutPromptExtras.inputTokens).toBe(2_000);

		const splitPrefix = estimateSummarizationRequest(
			{
				...base,
				isSplitTurn: true,
				messagesToSummarize: [],
				turnPrefixMessages: [hugeMessage(400)],
				previousSummary: "p".repeat(4_000),
			} as never,
			{ maxTokens: 32_768 },
			"c".repeat(4_000),
		);
		const splitPrefixWithoutExtras = estimateSummarizationRequest(
			{
				...base,
				isSplitTurn: true,
				messagesToSummarize: [],
				turnPrefixMessages: [hugeMessage(400)],
				previousSummary: undefined,
			} as never,
			{ maxTokens: 32_768 },
		);
		expect(splitPrefix.inputTokens).toBe(splitPrefixWithoutExtras.inputTokens);
	});

	test("model-window-too-small is reported before the registry or the model is touched", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();
		let compactCalls = 0;
		let authCalls = 0;
		const ctx = createCtx({
			currentModel: { provider: "uwoacrimson", id: "deepseek-v4-flash-0731", contextWindow: 400_000 },
			registryModels: [{ provider: "uwoacrimson", id: "gpt-5.6-luna", contextWindow: 272_000, maxTokens: 32_768 }],
		});
		(ctx.modelRegistry as never as { getApiKeyAndHeaders: unknown }).getApiKeyAndHeaders = async () => {
			authCalls += 1;
			return { ok: true, apiKey: "sk-fallback", headers: {}, env: {} };
		};
		const preparation = { ...createEvent().preparation, messagesToSummarize: [hugeMessage(1_100_000)] };

		const result = await runNativeFallbackCompaction({
			ctx,
			event: { ...createEvent(), preparation } as never,
			config: createConfig(withFallback({ model: "uwoacrimson/gpt-5.6-luna" })),
			modelSpec: "uwoacrimson/gpt-5.6-luna",
			compactFn: (async () => {
				compactCalls += 1;
				throw new Error("must not be called");
			}) as never,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.reason).toBe("model-window-too-small");
		expect(result.contextWindow).toBe(272_000);
		expect(result.estimatedTokens).toBeGreaterThan(272_000);
		expect(compactCalls).toBe(0);
		expect(authCalls).toBe(0);
	});

	test("a fallback model with room to spare still runs unchanged", async () => {
		const { runNativeFallbackCompaction } = await loadNativeFallbackModule();
		let compactCalls = 0;

		const result = await runNativeFallbackCompaction({
			ctx: createCtx({
				currentModel: { provider: "uwoacrimson", id: "deepseek-v4-flash-0731", contextWindow: 400_000 },
				registryModels: [{ provider: "uwoacrimson", id: "gpt-5.6-luna", contextWindow: 272_000, maxTokens: 32_768 }],
			}),
			event: createEvent(),
			config: createConfig(withFallback({ model: "uwoacrimson/gpt-5.6-luna" })),
			modelSpec: "uwoacrimson/gpt-5.6-luna",
			compactFn: (async () => {
				compactCalls += 1;
				return { summary: "ok", firstKeptEntryId: "entry-keep", tokensBefore: 1, details: {} };
			}) as never,
		});

		expect(result.ok).toBe(true);
		expect(compactCalls).toBe(1);
	});
});
