import { describe, expect, test } from "bun:test";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type {
	AgentLoopTurnUpdate,
	AgentMessage,
	PrepareNextTurnContext,
	ShouldStopAfterTurnContext,
} from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	CompactOptions,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	INLINE_COMPACTION_FOLLOW_UP_TYPE,
	InlineCompactionCoordinator,
	InlineCompactionRuntime,
	SUPPORTED_OFFICIAL_PI_VERSION,
	evaluateCompactionCompactability,
	evaluateTurnBoundary,
	preflightInlineCompactionHost,
} from "./inline-compaction";
import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_TOOLKIT_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
	type CompactionConfig,
	type LoadedToolkitConfig,
} from "./types";

function createAssistantMessage(callIds: string[] = ["call-a", "call-b"]): AgentMessage {
	return {
		role: "assistant",
		content: callIds.map((id) => ({
			type: "toolCall" as const,
			id,
			name: `tool-${id}`,
			arguments: { id },
		})),
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 90,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 100,
	};
}

function createToolResults(callIds: string[] = ["call-a", "call-b"]): ToolResultMessage[] {
	return callIds.map((toolCallId, index) => ({
		role: "toolResult",
		toolCallId,
		toolName: `tool-${toolCallId}`,
		content: [{ type: "text", text: `result-${index}` }],
		isError: false,
		timestamp: 101 + index,
	}));
}

function createLoadedConfig(overrides: Partial<CompactionConfig> = {}): LoadedToolkitConfig {
	return {
		config: {
			...DEFAULT_TOOLKIT_CONFIG,
			compaction: {
				...DEFAULT_COMPACTION_CONFIG,
				nativeFallback: { ...DEFAULT_COMPACTION_CONFIG.nativeFallback },
				autoCompaction: { ...DEFAULT_COMPACTION_CONFIG.autoCompaction },
				responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis],
				...overrides,
			},
			webSearch: {
				...DEFAULT_WEB_SEARCH_CONFIG,
				models: [...DEFAULT_WEB_SEARCH_CONFIG.models],
			},
			imageGeneration: {
				...DEFAULT_IMAGE_GENERATION_CONFIG,
			},
		},
		warnings: [],
	};
}

type FakeHostOptions = {
	officialCompactionEnabled?: boolean;
	prepareNextTurnFailure?: boolean;
	shouldStopFailure?: boolean;
	compactFailure?: boolean;
	compactFailureMessage?: string;
	abortDuringCompact?: boolean;
	externalAbortViaHost?: boolean;
	tooSmall?: boolean;
	contextCompactAborts?: boolean;
	contextCompact?: (options?: CompactOptions) => void;
};

function createMessageEntry(
	id: string,
	parentId: string | null,
	message: AgentMessage,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-26T00:00:00.000Z",
		message,
	};
}

function createFakeHost(options: FakeHostOptions = {}) {
	const message = createAssistantMessage();
	const toolResults = createToolResults();
	const currentUser: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: "Run both tools and continue." }],
		timestamp: 90,
	};
	const oldUserOne: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: `old-one-${"x".repeat(160)}` }],
		timestamp: 1,
	};
	const oldAssistantOne: AgentMessage = {
		...createAssistantMessage([]),
		content: [{ type: "text", text: "old answer one" }],
		stopReason: "stop",
		timestamp: 2,
	};
	const oldUserTwo: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: `old-two-${"y".repeat(160)}` }],
		timestamp: 3,
	};
	const oldAssistantTwo: AgentMessage = {
		...createAssistantMessage([]),
		content: [{ type: "text", text: "old answer two" }],
		stopReason: "stop",
		timestamp: 4,
	};
	const completeBranch: SessionEntry[] = [
		createMessageEntry("old-user-one", null, oldUserOne),
		createMessageEntry("old-assistant-one", "old-user-one", oldAssistantOne),
		createMessageEntry("old-user-two", "old-assistant-one", oldUserTwo),
		createMessageEntry("old-assistant-two", "old-user-two", oldAssistantTwo),
		createMessageEntry("current-user", "old-assistant-two", currentUser),
		createMessageEntry("current-assistant", "current-user", message),
		createMessageEntry("tool-a-entry", "current-assistant", toolResults[0]),
		createMessageEntry("tool-b-entry", "tool-a-entry", toolResults[1]),
	];
	const branch: SessionEntry[] = options.tooSmall
		? completeBranch.slice(-4)
		: completeBranch;
	const abortController = new AbortController();
	let abortCalls = 0;
	let abortCompactionCalls = 0;
	let compactCalls = 0;
	const originalPrepare = async (context: PrepareNextTurnContext): Promise<AgentLoopTurnUpdate> => {
		if (options.prepareNextTurnFailure) throw new Error("prepare failed");
		return { context: context.context };
	};
	const originalStop = async (_context: ShouldStopAfterTurnContext): Promise<boolean> => {
		if (options.shouldStopFailure) throw new Error("stop failed");
		return false;
	};
	const sessionManager = {
		getBranch: () => branch,
	};
	const host = {
		agent: {
			state: {
				messages: [message, ...toolResults] as AgentMessage[],
				pendingToolCalls: new Set<string>(),
			},
			prepareNextTurnWithContext: originalPrepare,
			shouldStopAfterTurn: originalStop,
			get signal() {
				return abortController.signal;
			},
		},
		async abort() {
			abortCalls += 1;
			if (options.externalAbortViaHost) abortController.abort();
		},
		abortCompaction() {
			abortCompactionCalls += 1;
		},
		async compact() {
			compactCalls += 1;
			await this.abort();
			if (options.externalAbortViaHost) await this.abort();
			if (options.abortDuringCompact) abortController.abort();
			if (options.compactFailure || options.compactFailureMessage) {
				throw new Error(options.compactFailureMessage ?? "compact failed");
			}
			const previous = branch.at(-1);
			branch.push({
				type: "compaction",
				id: `compaction-${compactCalls}`,
				parentId: previous?.id ?? null,
				timestamp: "2026-08-26T00:00:01.000Z",
				summary: "compacted",
				firstKeptEntryId: "current-assistant",
				tokensBefore: 120,
			});
			this.agent.state.messages = [
				{
					role: "compactionSummary",
					summary: "compacted",
					tokensBefore: 120,
					timestamp: 200,
				},
				message,
				...toolResults,
			] as AgentMessage[];
		},
		extensionRunner: {
			createContext: () => ({
				signal: abortController.signal,
				hasUI: false,
				sessionManager,
				getContextUsage: () => ({ tokens: 120, contextWindow: 128, percent: 93.75 }),
				compact: (compactOptions) => {
					if (options.contextCompactAborts) abortController.abort();
					options.contextCompact?.(compactOptions);
				},
			} as ExtensionContext),
		},
		sessionManager,
		settingsManager: {
			getCompactionSettings: () => ({
				enabled: options.officialCompactionEnabled ?? true,
				reserveTokens: 16,
				keepRecentTokens: options.tooSmall ? 10_000 : 32,
			}),
		},
	};

	return {
		host,
		message,
		toolResults,
		abortController,
		get abortCalls() {
			return abortCalls;
		},
		get abortCompactionCalls() {
			return abortCompactionCalls;
		},
		get compactCalls() {
			return compactCalls;
		},
	};
}

function createNextTurnContext(message: AgentMessage, toolResults: ToolResultMessage[]): PrepareNextTurnContext {
	return {
		message: message as never,
		toolResults,
		context: {
			systemPrompt: "system",
			messages: [message, ...toolResults],
			tools: [],
		},
		newMessages: [message, ...toolResults],
	};
}

describe("evaluateTurnBoundary", () => {
	test("requires a complete multi-tool call/result pairing", () => {
		const message = createAssistantMessage();
		const toolResults = createToolResults();
		const base = {
			enabled: true,
			continuation: "inline" as const,
			message,
			contextUsage: { tokens: 120, contextWindow: 128 },
			reserveTokens: 16,
		};

		expect(evaluateTurnBoundary({ ...base, toolResults }).reason).toBe("threshold-exceeded");
		expect(evaluateTurnBoundary({ ...base, toolResults: toolResults.slice(0, 1) }).reason).toBe(
			"incomplete-tool-pairing",
		);
		expect(
			evaluateTurnBoundary({
				...base,
				toolResults: [toolResults[0], { ...toolResults[1], toolCallId: toolResults[0].toolCallId }],
			}).reason,
		).toBe("incomplete-tool-pairing");
		expect(
			evaluateTurnBoundary({ ...base, toolResults: [toolResults[1], toolResults[0]] }).reason,
		).toBe("incomplete-tool-pairing");
	});

	test("skips threshold misses, unknown usage, disabled modes, and external aborts", () => {
		const message = createAssistantMessage(["call-a"]);
		const toolResults = createToolResults(["call-a"]);
		const base = {
			enabled: true,
			continuation: "inline" as const,
			message,
			toolResults,
			reserveTokens: 16,
		};

		expect(
			evaluateTurnBoundary({ ...base, contextUsage: { tokens: 80, contextWindow: 128 } }).reason,
		).toBe("below-threshold");
		expect(
			evaluateTurnBoundary({ ...base, contextUsage: { tokens: null, contextWindow: 128 } }).reason,
		).toBe("unknown-usage");
		expect(evaluateTurnBoundary({ ...base, enabled: false }).reason).toBe("disabled");
		expect(evaluateTurnBoundary({ ...base, continuation: "off" }).reason).toBe("continuation-off");
		expect(evaluateTurnBoundary({ ...base, externalAborted: true }).reason).toBe("aborted");
	});

	test("adds completed tool results only when the usage snapshot excludes them", () => {
		const message = createAssistantMessage(["call-a"]);
		const toolResults = createToolResults(["call-a"]);
		const decision = evaluateTurnBoundary({
			enabled: true,
			continuation: "followUp",
			message,
			toolResults,
			contextUsage: { tokens: 111, contextWindow: 128 },
			reserveTokens: 16,
			toolResultsIncluded: false,
		});
		expect(decision.compact).toBe(true);
		expect(decision.contextTokens).toBeGreaterThan(111);
	});
});

describe("evaluateCompactionCompactability", () => {
	test("mirrors official Pi cut-point eligibility", () => {
		const compactable = createFakeHost();
		const tooSmall = createFakeHost({ tooSmall: true });

		expect(
			evaluateCompactionCompactability(
				compactable.host.sessionManager.getBranch(),
				compactable.host.settingsManager.getCompactionSettings().keepRecentTokens,
			),
		).toEqual({ compactable: true, reason: "compactable" });
		expect(
			evaluateCompactionCompactability(
				tooSmall.host.sessionManager.getBranch(),
				tooSmall.host.settingsManager.getCompactionSettings().keepRecentTokens,
			),
		).toEqual({ compactable: false, reason: "nothing-to-summarize" });
	});
});

describe("official host adapter", () => {
	test("preflights the complete shape and rejects an inaccessible seam", () => {
		const fixture = createFakeHost();
		expect(preflightInlineCompactionHost(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION)).toEqual({
			ok: true,
			version: SUPPORTED_OFFICIAL_PI_VERSION,
			supportsInline: true,
			supportsFollowUp: true,
		});
		expect(
			preflightInlineCompactionHost(
				{ ...fixture.host, agent: { ...fixture.host.agent, prepareNextTurnWithContext: undefined } },
				SUPPORTED_OFFICIAL_PI_VERSION,
			),
		).toEqual(expect.objectContaining({ ok: false, reason: "missing-inline-seam" }));
		expect(preflightInlineCompactionHost(fixture.host, "0.85.0")).toEqual(
			expect.objectContaining({ ok: false, reason: "unsupported-official-pi-version" }),
		);
	});

	test("preserves host next-turn errors when no inline continuation is pending", async () => {
		const fixture = createFakeHost({
			prepareNextTurnFailure: true,
			shouldStopFailure: true,
		});
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		const nextTurn = createNextTurnContext(fixture.message, fixture.toolResults);

		await expect(fixture.host.agent.prepareNextTurnWithContext(nextTurn)).rejects.toThrow("prepare failed");
		await expect(fixture.host.agent.shouldStopAfterTurn?.(nextTurn)).rejects.toThrow("stop failed");
		coordinator.dispose();
	});

	test("compacts through the host and resynchronizes the next-turn context", async () => {
		const fixture = createFakeHost();
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		await coordinator.handleTurnEnd(
			{ type: "turn_end", message: fixture.message, toolResults: fixture.toolResults },
			createLoadedConfig().config.compaction,
		);

		expect(fixture.compactCalls).toBe(1);
		expect(fixture.abortCalls).toBe(0);
		const nextTurn = createNextTurnContext(fixture.message, fixture.toolResults);
		const update = await fixture.host.agent.prepareNextTurnWithContext(nextTurn);
		expect(update?.context?.messages).toEqual(fixture.host.agent.state.messages);
		expect(update?.context?.messages).not.toBe(nextTurn.context.messages);
		expect(await fixture.host.agent.shouldStopAfterTurn?.(nextTurn)).toBe(false);
		expect(coordinator.state).toEqual(
			expect.objectContaining({
				installed: true,
				inFlight: false,
				adapterStatus: "supported",
				lastCompactedBaseline: 120,
			}),
		);
	});

	test("fails closed when the compacted message array becomes stale before the next request", async () => {
		const fixture = createFakeHost();
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		await coordinator.handleTurnEnd(
			{ type: "turn_end", message: fixture.message, toolResults: fixture.toolResults },
			createLoadedConfig().config.compaction,
		);
		fixture.host.agent.state.messages = [...fixture.host.agent.state.messages];
		const nextTurn = createNextTurnContext(fixture.message, fixture.toolResults);
		const update = await fixture.host.agent.prepareNextTurnWithContext(nextTurn);

		expect(update?.context?.messages).toBe(nextTurn.context.messages);
		expect(await fixture.host.agent.shouldStopAfterTurn?.(nextTurn)).toBe(true);
		expect(coordinator.state.adapterStatus).toBe("failed");
		expect(coordinator.state.pendingTurnId).toBeUndefined();
	});

	test("keeps an unfinished tool loop running when official Pi has nothing to summarize", async () => {
		const fixture = createFakeHost({ tooSmall: true });
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		await coordinator.handleTurnEnd(
			{ type: "turn_end", message: fixture.message, toolResults: fixture.toolResults },
			createLoadedConfig().config.compaction,
		);
		const nextTurn = createNextTurnContext(fixture.message, fixture.toolResults);

		expect(fixture.compactCalls).toBe(0);
		expect(await fixture.host.agent.shouldStopAfterTurn?.(nextTurn)).toBe(false);
		expect(coordinator.state).toEqual(
			expect.objectContaining({
				inFlight: false,
				pendingTurnId: undefined,
				adapterStatus: "supported",
				lastSkipReason: "nothing-to-summarize",
			}),
		);
	});

	test("treats a source-race nothing-to-compact error as a safe no-op", async () => {
		const fixture = createFakeHost({
			compactFailureMessage: "Nothing to compact (session too small)",
		});
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		await coordinator.handleTurnEnd(
			{ type: "turn_end", message: fixture.message, toolResults: fixture.toolResults },
			createLoadedConfig().config.compaction,
		);
		const nextTurn = createNextTurnContext(fixture.message, fixture.toolResults);

		expect(fixture.compactCalls).toBe(1);
		expect(await fixture.host.agent.shouldStopAfterTurn?.(nextTurn)).toBe(false);
		expect(coordinator.state).toEqual(
			expect.objectContaining({
				adapterStatus: "supported",
				lastSkipReason: "nothing-to-summarize",
			}),
		);
	});

	test("clears pending state and stops after compaction failure", async () => {
		const fixture = createFakeHost({ compactFailure: true });
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		await coordinator.handleTurnEnd(
			{ type: "turn_end", message: fixture.message, toolResults: fixture.toolResults },
			createLoadedConfig().config.compaction,
		);
		const nextTurn = createNextTurnContext(fixture.message, fixture.toolResults);

		expect(await fixture.host.agent.shouldStopAfterTurn?.(nextTurn)).toBe(true);
		expect(coordinator.state).toEqual(
			expect.objectContaining({ inFlight: false, pendingTurnId: undefined, adapterStatus: "failed" }),
		);
	});

	test("propagates an external abort to compaction and never resumes", async () => {
		const fixture = createFakeHost({ abortDuringCompact: true });
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		await coordinator.handleTurnEnd(
			{ type: "turn_end", message: fixture.message, toolResults: fixture.toolResults },
			createLoadedConfig().config.compaction,
		);
		const nextTurn = createNextTurnContext(fixture.message, fixture.toolResults);

		expect(fixture.abortCompactionCalls).toBe(1);
		expect(await fixture.host.agent.shouldStopAfterTurn?.(nextTurn)).toBe(true);
		expect(coordinator.state.pendingTurnId).toBeUndefined();
	});

	test("does not swallow a later user abort after the compact-owned abort", async () => {
		const fixture = createFakeHost({ externalAbortViaHost: true });
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		await coordinator.handleTurnEnd(
			{ type: "turn_end", message: fixture.message, toolResults: fixture.toolResults },
			createLoadedConfig().config.compaction,
		);

		expect(fixture.abortCalls).toBe(1);
		expect(fixture.abortCompactionCalls).toBe(1);
		expect(coordinator.state.pendingTurnId).toBeUndefined();
		expect(coordinator.state.adapterStatus).toBe("failed");
	});

	test("clears a successful continuation when the host ends without another turn", async () => {
		const fixture = createFakeHost();
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		await coordinator.handleTurnEnd(
			{ type: "turn_end", message: fixture.message, toolResults: fixture.toolResults },
			createLoadedConfig().config.compaction,
		);

		expect(coordinator.state.pendingTurnId).toBeDefined();
		coordinator.handleAgentEnd();
		expect(coordinator.state.pendingTurnId).toBeUndefined();
		expect(coordinator.state.inFlight).toBe(false);
	});

	test("installs the official AgentSession prototype bridge idempotently", () => {
		const prototype = PiCodingAgent.AgentSession.prototype as unknown as Record<string, unknown>;
		const runtimeOne = new InlineCompactionRuntime(
			{ sendMessage: () => {} },
			() => createLoadedConfig(),
		);
		const firstWrapper = prototype._emitExtensionEvent;
		const runtimeTwo = new InlineCompactionRuntime(
			{ sendMessage: () => {} },
			() => createLoadedConfig(),
		);

		expect(runtimeOne.installation.supportsInline).toBe(true);
		expect(runtimeTwo.installation.supportsInline).toBe(true);
		expect(prototype._emitExtensionEvent).toBe(firstWrapper);
		runtimeOne.dispose();
		runtimeTwo.dispose();
	});
});

describe("public follow-up fallback", () => {
	test("uses ExtensionAPI.sendMessage after public compaction completes", async () => {
		const sent: Array<{ message: unknown; options: unknown }> = [];
		let compactCalls = 0;
		const fixture = createFakeHost({
			contextCompactAborts: true,
			contextCompact: (options) => {
				compactCalls += 1;
				options?.onComplete?.({
					summary: "summary",
					firstKeptEntryId: "current-assistant",
					tokensBefore: 120,
				});
			},
		});
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		const runtime = new InlineCompactionRuntime(
			{
				sendMessage: (message, options) => {
					sent.push({ message, options });
				},
			},
			() => createLoadedConfig({
				autoCompaction: {
					...DEFAULT_COMPACTION_CONFIG.autoCompaction,
					continuation: "followUp",
				},
			}),
		);

		await runtime.handlePrivateTurnEnd(coordinator, {
			type: "turn_end",
			message: fixture.message,
			toolResults: fixture.toolResults,
		});

		expect(compactCalls).toBe(1);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({
			message: expect.objectContaining({
				customType: INLINE_COMPACTION_FOLLOW_UP_TYPE,
				display: false,
				details: expect.objectContaining({ owner: "pi-openai-toolkit", mode: "followUp" }),
			}),
			options: { triggerTurn: true, deliverAs: "followUp" },
		});
		runtime.dispose();
		coordinator.dispose();
	});

	test("fails closed without hidden work when public compaction fails", async () => {
		let sendCalls = 0;
		const fixture = createFakeHost({
			contextCompact: (options) => {
				options?.onError?.(new Error("Nothing to compact (session too small)"));
			},
		});
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		const runtime = new InlineCompactionRuntime(
			{ sendMessage: () => { sendCalls += 1; } },
			() => createLoadedConfig({
				autoCompaction: {
					...DEFAULT_COMPACTION_CONFIG.autoCompaction,
					continuation: "followUp",
				},
			}),
		);

		await runtime.handlePrivateTurnEnd(coordinator, {
			type: "turn_end",
			message: fixture.message,
			toolResults: fixture.toolResults,
		});
		await runtime.handlePrivateTurnEnd(coordinator, {
			type: "turn_end",
			message: fixture.message,
			toolResults: fixture.toolResults,
		});

		expect(sendCalls).toBe(0);
		runtime.dispose();
		coordinator.dispose();
	});

	test("does not send a follow-up after an external abort", async () => {
		let sendCalls = 0;
		let complete: (() => void) | undefined;
		const fixture = createFakeHost({
			contextCompact: (options) => {
				complete = options?.onComplete;
			},
		});
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		const runtime = new InlineCompactionRuntime(
			{ sendMessage: () => { sendCalls += 1; } },
			() => createLoadedConfig({
				autoCompaction: {
					...DEFAULT_COMPACTION_CONFIG.autoCompaction,
					continuation: "followUp",
				},
			}),
		);

		await runtime.handlePrivateTurnEnd(coordinator, {
			type: "turn_end",
			message: fixture.message,
			toolResults: fixture.toolResults,
		});
		fixture.abortController.abort();
		complete?.();

		expect(sendCalls).toBe(0);
		runtime.dispose();
		coordinator.dispose();
	});

	test("respects disabled official compaction settings on the supported follow-up path", async () => {
		let compactCalls = 0;
		let sendCalls = 0;
		const fixture = createFakeHost({
			officialCompactionEnabled: false,
			contextCompact: () => { compactCalls += 1; },
		});
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		const runtime = new InlineCompactionRuntime(
			{ sendMessage: () => { sendCalls += 1; } },
			() => createLoadedConfig({
				autoCompaction: {
					...DEFAULT_COMPACTION_CONFIG.autoCompaction,
					continuation: "followUp",
				},
			}),
		);

		await runtime.handlePrivateTurnEnd(coordinator, {
			type: "turn_end",
			message: fixture.message,
			toolResults: fixture.toolResults,
		});

		expect(compactCalls).toBe(0);
		expect(sendCalls).toBe(0);
		runtime.dispose();
		coordinator.dispose();
	});

	test("does not abort or enqueue work for a too-small session", async () => {
		let compactCalls = 0;
		let sendCalls = 0;
		const fixture = createFakeHost({
			tooSmall: true,
			contextCompact: () => { compactCalls += 1; },
		});
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		const runtime = new InlineCompactionRuntime(
			{ sendMessage: () => { sendCalls += 1; } },
			() => createLoadedConfig({
				autoCompaction: {
					...DEFAULT_COMPACTION_CONFIG.autoCompaction,
					continuation: "followUp",
				},
			}),
		);

		for (let attempt = 0; attempt < 2; attempt += 1) {
			await runtime.handlePrivateTurnEnd(coordinator, {
				type: "turn_end",
				message: fixture.message,
				toolResults: fixture.toolResults,
			});
		}

		expect(compactCalls).toBe(0);
		expect(sendCalls).toBe(0);
		runtime.dispose();
		coordinator.dispose();
	});

	test("off mode does not compact or enqueue hidden work", async () => {
		let compactCalls = 0;
		let sendCalls = 0;
		const fixture = createFakeHost({
			contextCompact: () => { compactCalls += 1; },
		});
		const coordinator = new InlineCompactionCoordinator(fixture.host, SUPPORTED_OFFICIAL_PI_VERSION);
		const runtime = new InlineCompactionRuntime(
			{ sendMessage: () => { sendCalls += 1; } },
			() => createLoadedConfig({
				autoCompaction: {
					...DEFAULT_COMPACTION_CONFIG.autoCompaction,
					continuation: "off",
				},
			}),
		);

		await runtime.handlePrivateTurnEnd(coordinator, {
			type: "turn_end",
			message: fixture.message,
			toolResults: fixture.toolResults,
		});

		expect(compactCalls).toBe(0);
		expect(sendCalls).toBe(0);
		runtime.dispose();
		coordinator.dispose();
	});
});
