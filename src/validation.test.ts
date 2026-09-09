import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { clearRequestContextCache, getCompactionRequestExtras } from "./request-context-cache";
import { transformWebSearchPayload } from "./web-search/payload";
import { WEB_SEARCH_SOURCE_INCLUDE } from "./web-search/types";
import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_TOOLKIT_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
	NATIVE_COMPACTION_FALLBACK_SUMMARY,
	createNativeCompactionDetails,
	type CompactionConfig,
	type DeferredToolCarryoverV1,
} from "./types";

type AssistantPhase = "commentary" | "final_answer";

type ToolCallBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
};

type TextBlock = {
	type: "text";
	text: string;
	textSignature?: string;
};

type TestModel = {
	provider: string;
	api: string;
	id: string;
	baseUrl: string;
	input: string[];
	reasoning: boolean;
	compat?: {
		supportsAdditionalTools?: boolean;
		supportsToolSearch?: boolean;
		supportsExplicitPromptCacheMode?: boolean;
		supportsLongCacheRetention?: boolean;
	};
};

type TestSessionEntry =
	| {
		type: "message" | "compaction";
		id: string;
		timestamp: string;
		message?: Record<string, unknown>;
		summary?: string;
		firstKeptEntryId?: string;
		tokensBefore?: number;
		details?: ReturnType<typeof createNativeCompactionDetails>;
	}
	| {
		type: "custom";
		id: string;
		timestamp: string;
		customType: string;
		data?: unknown;
	};

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

type HookHarnessOptions = {
	compactResult?: Record<string, unknown>;
	config?: Partial<CompactionConfig>;
	nativeFallbackResult?: Record<string, unknown>;
};

const defaultModel: TestModel = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-5-mini",
	baseUrl: "https://api.openai.com/v1",
	input: ["text"],
	reasoning: true,
};

const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n`;
const COMPACTION_SUMMARY_SUFFIX = `\n</summary>`;

// Failure artifacts are written unconditionally, so point the mocked config at a
// temporary root instead of the real HOME artifact directory.
const testArtifactRoot = join(os.tmpdir(), "pi-openai-toolkit-validation-artifacts");

let timestampCounter = 0;

async function loadSerializerModule() {
	return import("./serializer");
}

async function serializeResponsesInput(model: TestModel, messages: Record<string, unknown>[]): Promise<unknown[]> {
	const { serializeMessagesToResponsesInput } = await loadSerializerModule();
	return serializeMessagesToResponsesInput(model as never, messages as never);
}

async function createInputParitySignature(input: readonly unknown[]): Promise<string[]> {
	const { createResponsesInputParitySignature } = await loadSerializerModule();
	return createResponsesInputParitySignature(input);
}

function nextTimestamp(): string {
	const timestamp = new Date(Date.UTC(2026, 2, 20, 12, 0, timestampCounter)).toISOString();
	timestampCounter += 1;
	return timestamp;
}

function createTextBlock(text: string, phase?: AssistantPhase, id = `msg_${timestampCounter}`): TextBlock {
	return {
		type: "text",
		text,
		...(phase
			? {
				textSignature: JSON.stringify({
					v: 1,
					id,
					phase,
				}),
			}
			: {}),
	};
}

function createToolCallBlock(
	callId: string,
	name: string,
	argumentsObject: Record<string, unknown>,
	itemId = `fc_${callId}`,
): ToolCallBlock {
	return {
		type: "toolCall",
		id: `${callId}|${itemId}`,
		name,
		arguments: argumentsObject,
	};
}

function createUserEntry(id: string, text: string): TestSessionEntry {
	return {
		type: "message",
		id,
		timestamp: nextTimestamp(),
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		},
	};
}

function createAssistantEntry(
	id: string,
	blocks: Array<TextBlock | ToolCallBlock>,
	model: TestModel = defaultModel,
	stopReason: string = "stop",
): TestSessionEntry {
	return {
		type: "message",
		id,
		timestamp: nextTimestamp(),
		message: {
			role: "assistant",
			provider: model.provider,
			api: model.api,
			model: model.id,
			stopReason,
			content: blocks,
			timestamp: Date.now(),
		},
	};
}

function createToolResultEntry(id: string, toolCallId: string, toolName: string, text: string): TestSessionEntry {
	return {
		type: "message",
		id,
		timestamp: nextTimestamp(),
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			isError: false,
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		},
	};
}

function createCompactionEntry(args: {
	id: string;
	firstKeptEntryId: string;
	tokensBefore?: number;
	model?: TestModel;
	compactionModel?: TestModel;
	deferredToolCarryover?: DeferredToolCarryoverV1;
	compactedWindow: unknown[];
	compactResponseId?: string;
}): TestSessionEntry {
	const model = args.model ?? defaultModel;
	return {
		type: "compaction",
		id: args.id,
		timestamp: nextTimestamp(),
		summary: NATIVE_COMPACTION_FALLBACK_SUMMARY,
		firstKeptEntryId: args.firstKeptEntryId,
		tokensBefore: args.tokensBefore ?? 256,
		details: createNativeCompactionDetails({
			provider: model.provider,
			api: model.api,
			model: model.id,
			baseUrl: model.baseUrl,
			compactionModel: args.compactionModel
				? {
					provider: args.compactionModel.provider,
					api: args.compactionModel.api,
					model: args.compactionModel.id,
					baseUrl: args.compactionModel.baseUrl,
				}
				: undefined,
			deferredToolCarryover: args.deferredToolCarryover,
			compactedWindow: args.compactedWindow,
			compactResponseId: args.compactResponseId,
			createdAt: nextTimestamp(),
		}),
	};
}

function createCompactionSummaryMessage(entry: TestSessionEntry): Record<string, unknown> {
	return {
		role: "compactionSummary",
		summary: entry.summary,
		tokensBefore: entry.tokensBefore,
		timestamp: new Date(entry.timestamp).getTime(),
	};
}

function toReplayMessage(entry: TestSessionEntry): Record<string, unknown> {
	if (entry.type !== "message" || !entry.message) {
		throw new Error(`Expected message entry, got ${entry.type}`);
	}
	return entry.message;
}

async function buildPiReplayPayload(args: {
	model?: TestModel;
	branchEntries: TestSessionEntry[];
	compactionEntry: TestSessionEntry;
	instructions: string;
	freshPreamble: string;
	trailingPreamble?: string[];
}): Promise<{
	model: string;
	instructions: string;
	input: unknown[];
}> {
	const model = args.model ?? defaultModel;
	const boundaryIndex = args.branchEntries.findIndex((entry) => entry.id === args.compactionEntry.id);
	if (boundaryIndex < 0) {
		throw new Error(`Missing compaction entry ${args.compactionEntry.id}`);
	}

	const postCompactionEntries = args.branchEntries.slice(boundaryIndex + 1);
	// After the public context hook removes retained copies, the provider sees [leading][summary item]
	// [all post-compaction messages]: pre-compaction messages never appear in the
	// payload (appendCompaction never persists entry.retainedTail), and trailing
	// provider prompts are ordinary input items after the live tail.
	const piReplayMessages = [createCompactionSummaryMessage(args.compactionEntry), ...postCompactionEntries.map(toReplayMessage)];

	return {
		model: model.id,
		instructions: args.instructions,
		input: [
			{
				role: model.reasoning ? "developer" : "system",
				content: args.freshPreamble,
			},
			...(await serializeResponsesInput(model, piReplayMessages)),
			...((args.trailingPreamble ?? []).map((text) => ({
				role: "developer",
				content: [{ type: "input_text", text }],
			}))),
		],
	};
}

function createContext(args: {
	branchEntries?: TestSessionEntry[];
	model?: TestModel;
	systemPrompt?: string;
	sessionContextMessages?: Record<string, unknown>[];
	registryModels?: TestModel[];
	resolveAuth?: (model: TestModel) => Promise<Record<string, unknown>> | Record<string, unknown>;
	onAbort?: () => void;
} = {}) {
	const branchEntries = args.branchEntries ?? [];
	const model = args.model ?? defaultModel;
	const sessionContextMessages =
		args.sessionContextMessages ?? branchEntries.filter((entry) => entry.type === "message").map(toReplayMessage);
	return {
		cwd: "/tmp/pi-openai-toolkit-validation",
		hasUI: false,
		abort: () => args.onAbort?.(),
		getSystemPrompt: () => args.systemPrompt ?? "Current instructions v1",
		model,
		modelRegistry: {
			find: (provider: string, modelId: string) =>
				(args.registryModels ?? []).find((entry) => entry.provider === provider && entry.id === modelId),
			getApiKeyAndHeaders: async (requestModel: TestModel) =>
				args.resolveAuth?.(requestModel) ?? {
					ok: true,
					apiKey: `sk-test-${requestModel.id}`,
				},
		},
		sessionManager: {
			getBranch: () => branchEntries,
			buildSessionContext: () => ({
				messages: sessionContextMessages,
				thinkingLevel: "off",
				model: null,
			}),
			getSessionId: () => "session-validation",
			getSessionFile: () => "/tmp/pi-openai-toolkit-validation/session.json",
			getSessionDir: () => "/tmp/pi-openai-toolkit-validation",
		},
	};
}

async function loadHookHarness(options: HookHarnessOptions = {}): Promise<{
	sessionStart: HookHandler;
	contextHook: HookHandler;
	sessionBeforeCompact: HookHandler;
	beforeProviderRequest: HookHandler;
	beforeProviderHeaders: HookHandler;
	compactCalls: Array<Record<string, unknown>>;
	fallbackCalls: Array<Record<string, unknown>>;
	abortCalls: { count: number };
}> {
	const compactCalls: Array<Record<string, unknown>> = [];
	const fallbackCalls: Array<Record<string, unknown>> = [];
	const abortCalls = { count: 0 };
	const registeredTools: Array<Record<string, unknown>> = [];
	let activeTools: string[] = [];

	const handlers = new Map<string, HookHandler>();
	const { default: extension } = await import("./extension-runtime");
	extension({
		on: (eventName: string, handler: HookHandler) => {
			handlers.set(eventName, handler);
		},
		registerTool: (tool: Record<string, unknown>) => {
			registeredTools.push(tool);
		},
		getAllTools: () => registeredTools,
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
	} as never, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: {
					...DEFAULT_COMPACTION_CONFIG,
					responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis],
					artifactRoot: options.config?.artifactRoot ?? testArtifactRoot,
					...(options.config ?? {}),
				},
				webSearch: { ...DEFAULT_WEB_SEARCH_CONFIG, models: [...DEFAULT_WEB_SEARCH_CONFIG.models] },
				imageGeneration: { ...DEFAULT_IMAGE_GENERATION_CONFIG },
			},
			source: undefined,
			warnings: [],
		}),
		nativeFallback: async (args) => {
			fallbackCalls.push(args);
			return (options.nativeFallbackResult ?? { ok: false, reason: "no-model-configured" }) as never;
		},
		remoteCompact: async (args) => {
			compactCalls.push(args);
			return (options.compactResult ?? {
				ok: true,
				status: 200,
				compactedWindow: [{ type: "compaction", encrypted_content: "opaque-default" }],
				compactResponseId: "resp_default",
				createdAt: nextTimestamp(),
				response: { id: "resp_default", status: "completed", output: [{ type: "compaction", encrypted_content: "opaque-default" }] },
			}) as never;
		},
	});
	// Pi owns scheduling. The compaction extension only supplies/replays results.
	expect([...handlers.keys()]).toEqual([
		"session_start",
		"context",
		"session_before_compact",
		"session_compact",
		"session_shutdown",
		"model_select",
		"before_agent_start",
		"before_provider_request",
		"before_provider_headers",
		"message_end",
	]);

	const sessionStart = handlers.get("session_start");
	const contextHook = handlers.get("context");
	const sessionBeforeCompact = handlers.get("session_before_compact");
	const beforeProviderRequest = handlers.get("before_provider_request");
	const beforeProviderHeaders = handlers.get("before_provider_headers");
	if (!sessionStart || !contextHook || !sessionBeforeCompact || !beforeProviderRequest || !beforeProviderHeaders) {
		throw new Error("Expected pi-openai-toolkit compaction hooks to register");
	}

	return {
		sessionStart,
		contextHook,
		sessionBeforeCompact,
		beforeProviderRequest,
		beforeProviderHeaders,
		compactCalls,
		fallbackCalls,
		abortCalls,
	};
}

afterEach(() => {
	timestampCounter = 0;
	clearRequestContextCache();
	fs.rmSync(testArtifactRoot, { recursive: true, force: true });
});

test("gateway Remote Context headers preserve session affinity and strip inherited credentials", async () => {
	const { sessionStart, beforeProviderHeaders } = await loadHookHarness({
		config: {
			contextManagement: "remote",
			gatewayContextModels: ["uwoacrimson/gpt-6-astra"],
		},
	});
	const gatewayModel: TestModel = {
		...defaultModel,
		provider: "uwoacrimson",
		api: "openai-responses",
		id: "gpt-6-astra",
		baseUrl: "https://newapi.example/v1",
	};
	const ctx = createContext({ model: gatewayModel });
	await sessionStart({ type: "session_start" }, ctx);

	const headers: Record<string, string | null> = {
		authorization: "Bearer stale",
		cookie: "stale",
		"chatgpt-account-id": "stale",
		"x-api-key": "stale",
		"session-id": "stale",
		"x-client-request-id": "stale",
	};
	await beforeProviderHeaders({ type: "before_provider_headers", headers }, ctx);

	expect(headers.authorization).toBe("Bearer sk-test-gpt-6-astra");
	expect(headers["session-id"]).toBe("session-validation");
	expect(headers["x-client-request-id"]).toBe("session-validation");
	expect(headers["x-codex-affinity-scope"]).toBe("codex-session-v1");
	expect(headers["x-codex-model"]).toBe("gpt-6-astra");
	expect(headers.cookie).toBeUndefined();
	expect(headers["chatgpt-account-id"]).toBeUndefined();
	expect(headers["x-api-key"]).toBeUndefined();
});

test("manual /compact preserves tool/result ordering + assistant phases and persists the native window", async () => {
	const compactedWindow = [
		{ type: "message", role: "assistant", status: "completed", id: "cmp_1", phase: "commentary", content: [] },
	];
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness({
		compactResult: {
			ok: true,
			status: 200,
			compactedWindow,
			compactResponseId: "resp_manual",
			createdAt: nextTimestamp(),
			response: {
				id: "resp_manual",
				created_at: nextTimestamp(),
				output: compactedWindow,
			},
		},
	});
	const model = { ...defaultModel };
	const toolCall = createToolCallBlock("call_docs", "search_docs", { query: "weekly release status" }, "fc_docs");
	const user = createUserEntry("entry_user", "Check the weekly release status.");
	const assistantCommentary = createAssistantEntry(
		"entry_assistant_commentary",
		[createTextBlock("Checking the docs first.", "commentary", "msg_commentary"), toolCall],
		model,
		"toolUse",
	);
	const toolResult = createToolResultEntry("entry_tool_result", toolCall.id, toolCall.name, "Release notes say green.");
	const assistantFinal = createAssistantEntry(
		"entry_assistant_final",
		[createTextBlock("The release is green.", "final_answer", "msg_final")],
		model,
		"stop",
	);
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [
				toReplayMessage(user),
				toReplayMessage(assistantCommentary),
				toReplayMessage(toolResult),
				toReplayMessage(assistantFinal),
			],
			turnPrefixMessages: [],
		},
	};
	const result = (await sessionBeforeCompact(
		event,
		createContext({
			model,
			systemPrompt: "Current instructions v1",
			sessionContextMessages: event.preparation.messagesToSummarize as Record<string, unknown>[],
		}),
	)) as {
		compaction: Record<string, unknown>;
	};

	expect(compactCalls).toHaveLength(1);
	const compactRequest = compactCalls[0]?.request as { model: string; instructions: string; input: unknown[] };
	expect(compactRequest.model).toBe(model.id);
	expect(compactRequest.instructions).toBe("Current instructions v1");
	expect(await createInputParitySignature(compactRequest.input)).toEqual([
		"input:user[1]",
		"message:assistant:commentary",
		"function_call:search_docs",
		"function_call_output",
		"message:assistant:final_answer",
	]);
	expect(result.compaction.summary).toBe(NATIVE_COMPACTION_FALLBACK_SUMMARY);
	expect(result.compaction.firstKeptEntryId).toBe(user.id);
	expect(result.compaction.tokensBefore).toBe(512);
	expect((result.compaction.details as { compactedWindow: unknown[] }).compactedWindow).toEqual(compactedWindow);
});

test("cache-stack activation survives compaction and reanchors additional tools after the opaque checkpoint", async () => {
	const model = {
		...defaultModel,
		compat: { supportsAdditionalTools: true },
	};
	const activationEntry: TestSessionEntry = {
		type: "custom",
		id: "activation-state",
		timestamp: nextTimestamp(),
		customType: "pi-cache-stack.activation-state.v1",
		data: {
			version: 1,
			activatedTools: ["search_docs"],
			catalogHash: "catalog-v1",
		},
	};
	const user = createUserEntry("carryover_user", "Keep the activated search tool available after compact.");
	const { sessionBeforeCompact, beforeProviderRequest, compactCalls } = await loadHookHarness();
	const compactResult = (await sessionBeforeCompact(
		{
			reason: "manual",
			signal: new AbortController().signal,
			customInstructions: undefined,
			branchEntries: [activationEntry, user],
			preparation: {
				tokensBefore: 512,
				firstKeptEntryId: user.id,
				previousSummary: undefined,
				messagesToSummarize: [toReplayMessage(user)],
				turnPrefixMessages: [],
			},
		},
		createContext({
			branchEntries: [activationEntry, user],
			model,
			sessionContextMessages: [toReplayMessage(user)],
		}),
	)) as { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: ReturnType<typeof createNativeCompactionDetails> } };

	expect(compactCalls).toHaveLength(1);
	expect(compactResult.compaction.details.deferredToolCarryover).toEqual({
		version: 1,
		source: "pi-cache-stack.activation-state.v1",
		toolNames: ["search_docs"],
		catalogHash: "catalog-v1",
	});

	const compactionEntry: TestSessionEntry = {
		type: "compaction",
		id: "carryover_compaction",
		timestamp: nextTimestamp(),
		summary: compactResult.compaction.summary,
		firstKeptEntryId: compactResult.compaction.firstKeptEntryId,
		tokensBefore: compactResult.compaction.tokensBefore,
		details: compactResult.compaction.details,
	};
	const currentUser = createUserEntry("carryover_tail", "Call search_docs directly; do not activate it again.");
	const branchEntries = [activationEntry, user, compactionEntry, currentUser];
	const replayPayload = {
		...(await buildPiReplayPayload({
			model,
			branchEntries,
			compactionEntry,
			instructions: "Current instructions after carryover",
			freshPreamble: "Fresh preamble after carryover",
		})),
		tools: [{ type: "function", name: "search_docs", parameters: { type: "object", properties: {} }, strict: false }],
		prompt_cache_key: "carryover-cache-key",
		unknown_field: { keep: true },
	};
	const rewritten = (await beforeProviderRequest(
		{ payload: replayPayload },
		createContext({ branchEntries, model, systemPrompt: replayPayload.instructions }),
	)) as { input: unknown[]; tools: unknown[]; prompt_cache_key: string; unknown_field: unknown };

	expect(rewritten.tools).toEqual([]);
	expect(rewritten.input[0]).toEqual(replayPayload.input[0]);
	expect(rewritten.input[1]).toEqual((compactResult.compaction.details.compactedWindow as unknown[])[0]);
	expect(rewritten.input[2]).toEqual({
		type: "additional_tools",
		role: "developer",
		tools: [replayPayload.tools[0]],
	});
	expect(rewritten.prompt_cache_key).toBe("carryover-cache-key");
	expect(rewritten.unknown_field).toEqual({ keep: true });
});

test("first native compaction sends the full current session context, including Pi's kept recent window", async () => {
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness();
	const model = { ...defaultModel };
	const summarizedUser = createUserEntry("summarized_user", "Older context slated for summarization.");
	const keptUser = createUserEntry("kept_recent_user", "Recent kept window context that must also be compacted.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 384,
			firstKeptEntryId: keptUser.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(summarizedUser)],
			turnPrefixMessages: [],
		},
	};

	await sessionBeforeCompact(
		event,
		createContext({
			model,
			systemPrompt: "Current instructions include the kept window too",
			sessionContextMessages: [toReplayMessage(summarizedUser), toReplayMessage(keptUser)],
		}),
	);

	const compactRequest = compactCalls[0]?.request as { model: string; instructions: string; input: unknown[] };
	expect(compactRequest.model).toBe(model.id);
	expect(compactRequest.instructions).toBe("Current instructions include the kept window too");
	expect(await createInputParitySignature(compactRequest.input)).toEqual(["input:user[1]", "input:user[1]"]);
	expect(JSON.stringify(compactRequest.input)).toContain("Recent kept window context that must also be compacted.");
});

test("repeated native compaction reuses the latest stored compacted window instead of Pi's shim summary", async () => {
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness();
	const model = { ...defaultModel };
	const oldKeptUser = createUserEntry("old_kept_user", "Original context before native compaction.");
	const compactedWindow = [
		{
			type: "message",
			role: "assistant",
			status: "completed",
			id: "cmp_repeat",
			phase: "commentary",
			content: [{ type: "output_text", text: "Opaque compacted window", annotations: [] }],
		},
	];
	const priorCompaction = createCompactionEntry({
		id: "compaction_repeat",
		firstKeptEntryId: oldKeptUser.id,
		model,
		compactedWindow,
		compactResponseId: "resp_repeat",
	});
	const tailUser = createUserEntry("repeat_tail_user", "New follow-up after the earlier native compaction.");
	const tailAssistant = createAssistantEntry(
		"repeat_tail_assistant",
		[createTextBlock("Follow-up answer after the earlier native compaction.", "final_answer", "msg_repeat_tail")],
		model,
		"stop",
	);
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 640,
			firstKeptEntryId: tailUser.id,
			previousSummary: NATIVE_COMPACTION_FALLBACK_SUMMARY,
			messagesToSummarize: [],
			turnPrefixMessages: [],
		},
	};

	await sessionBeforeCompact(
		event,
		createContext({
			branchEntries: [oldKeptUser, priorCompaction, tailUser, tailAssistant],
			model,
			systemPrompt: "Current instructions v-repeat",
			sessionContextMessages: [
				createCompactionSummaryMessage(priorCompaction),
				toReplayMessage(oldKeptUser),
				toReplayMessage(tailUser),
				toReplayMessage(tailAssistant),
			],
		}),
	);

	const compactRequest = compactCalls[0]?.request as { model: string; instructions: string; input: unknown[] };
	const expectedTail = await serializeResponsesInput(model, [toReplayMessage(tailUser), toReplayMessage(tailAssistant)]);
	expect(compactRequest.instructions).toBe("Current instructions v-repeat");
	expect(compactRequest.input).toEqual([...compactedWindow, ...expectedTail]);
	expect(JSON.stringify(compactRequest.input)).toContain("Opaque compacted window");
	expect(JSON.stringify(compactRequest.input)).not.toContain("The conversation history before this point was compacted");
	expect(JSON.stringify(compactRequest.input)).not.toContain("Original context before native compaction.");
});

test("session_before_compact falls through to the configured-model fallback when the latest compaction is not native", async () => {
	const { sessionBeforeCompact, compactCalls, fallbackCalls } = await loadHookHarness();
	const model = { ...defaultModel };
	const olderUser = createUserEntry("older_non_native_user", "Context from before a non-native compaction.");
	const nonNativeCompaction: TestSessionEntry = {
		type: "compaction",
		id: "non_native_compaction",
		timestamp: nextTimestamp(),
		summary: "Legacy Pi summary",
		firstKeptEntryId: olderUser.id,
		tokensBefore: 512,
	};
	const currentUser = createUserEntry("current_after_non_native", "Current context after a non-native compaction.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 768,
			firstKeptEntryId: currentUser.id,
			previousSummary: "Legacy Pi summary",
			messagesToSummarize: [],
			turnPrefixMessages: [],
		},
	};

	const result = await sessionBeforeCompact(
		event,
		createContext({
			branchEntries: [olderUser, nonNativeCompaction, currentUser],
			model,
			systemPrompt: "Current instructions after a non-native compaction",
			sessionContextMessages: [
				createCompactionSummaryMessage(nonNativeCompaction),
				toReplayMessage(olderUser),
				toReplayMessage(currentUser),
			],
		}),
	);

	expect(result).toBeUndefined();
	expect(compactCalls).toHaveLength(0);
	// Responses compact declined (non-native latest entry) → configured-model fallback is consulted.
	expect(fallbackCalls).toHaveLength(1);
});

test("continuity-break opt-in restarts native compaction from Pi's current session context", async () => {
	const { sessionBeforeCompact, compactCalls, fallbackCalls } = await loadHookHarness({
		config: { allowCompactionContinuityBreak: true },
	});
	const model = { ...defaultModel };
	const olderUser = createUserEntry("older_recovery_user", "Context retained by Pi after its earlier compaction.");
	const nonNativeCompaction: TestSessionEntry = {
		type: "compaction",
		id: "non_native_recovery_compaction",
		timestamp: nextTimestamp(),
		summary: "Legacy Pi summary used as the recovery baseline",
		firstKeptEntryId: olderUser.id,
		tokensBefore: 512,
	};
	const currentUser = createUserEntry("current_recovery_user", "Continue from the compacted Pi session.");
	const sessionContextMessages = [
		createCompactionSummaryMessage(nonNativeCompaction),
		toReplayMessage(olderUser),
		toReplayMessage(currentUser),
	];
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 768,
			firstKeptEntryId: currentUser.id,
			previousSummary: nonNativeCompaction.summary,
			messagesToSummarize: [],
			turnPrefixMessages: [],
		},
	};

	const result = (await sessionBeforeCompact(
		event,
		createContext({
			branchEntries: [olderUser, nonNativeCompaction, currentUser],
			model,
			systemPrompt: "Current instructions for continuity recovery",
			sessionContextMessages,
		}),
	)) as { compaction: Record<string, unknown> };

	expect(compactCalls).toHaveLength(1);
	expect(fallbackCalls).toHaveLength(0);
	const compactRequest = compactCalls[0]?.request as { model: string; instructions: string; input: unknown[] };
	expect(compactRequest.model).toBe(model.id);
	expect(compactRequest.instructions).toBe("Current instructions for continuity recovery");
	expect(compactRequest.input).toEqual(await serializeResponsesInput(model, sessionContextMessages));
	expect(JSON.stringify(compactRequest.input)).toContain("Legacy Pi summary used as the recovery baseline");
	expect(result.compaction.firstKeptEntryId).toBe(currentUser.id);
});

test("first post-compaction turn rewrites to fresh preamble + opaque compacted window + live tail without duplication", async () => {
	const { beforeProviderRequest } = await loadHookHarness();
	const model = { ...defaultModel };
	const keptUser = createUserEntry("kept_user", "Old user context that Pi should stop duplicating.");
	const keptAssistant = createAssistantEntry(
		"kept_assistant",
		[createTextBlock("Old assistant context that should disappear after native replay.", "commentary", "msg_kept")],
		model,
	);
	const compactedWindow = [
		{ type: "message", role: "assistant", status: "completed", id: "cmp_commentary", phase: "commentary", content: [] },
		{
			type: "function_call",
			id: "fc_weather",
			call_id: "call_weather",
			name: "weather_lookup",
			arguments: '{"city":"Berlin"}',
		},
		{
			type: "function_call_output",
			call_id: "call_weather",
			output: "18°C and sunny",
		},
	];
	const compactionEntry = createCompactionEntry({
		id: "compaction_1",
		firstKeptEntryId: keptUser.id,
		model,
		compactedWindow,
		compactResponseId: "resp_first_turn",
	});
	const currentUser = createUserEntry("post_compaction_user", "Now summarize only the deploy risk.");
	const branchEntries = [keptUser, keptAssistant, compactionEntry, currentUser];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry,
		instructions: "Current instructions v2",
		freshPreamble: "Fresh preamble v2",
	});
	const rewritten = (await beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };
	const expectedTail = await serializeResponsesInput(model, [toReplayMessage(currentUser)]);
	const expectedInput = [payload.input[0], ...compactedWindow, ...expectedTail];
	const liveSearch = transformWebSearchPayload({
		model,
		config: { ...DEFAULT_WEB_SEARCH_CONFIG, models: [`${model.provider}/${model.id}`] },
		payload: rewritten,
	});
	const finalPayload = liveSearch.payload as {
		input: unknown[];
		instructions: string;
		tools: unknown[];
		include: unknown[];
	};
	const cachedExtras = getCompactionRequestExtras({
		provider: model.provider,
		api: model.api,
		model: model.id,
		baseUrl: model.baseUrl,
		sessionId: "session-validation",
	});

	expect(rewritten.instructions).toBe("Current instructions v2");
	expect(rewritten.input).toEqual(expectedInput);
	expect(finalPayload.input).toEqual(expectedInput);
	expect(finalPayload.tools).toEqual([{ type: "web_search" }]);
	expect(finalPayload.include).toEqual([WEB_SEARCH_SOURCE_INCLUDE]);
	expect(cachedExtras?.tools).toBeUndefined();
	expect(JSON.stringify(rewritten.input)).not.toContain("Old user context that Pi should stop duplicating.");
	expect(JSON.stringify(rewritten.input)).not.toContain(
		"Old assistant context that should disappear after native replay.",
	);
	expect(JSON.stringify(rewritten.input)).not.toContain("The conversation history before this point was compacted");
});

test("replay succeeds with extension-injected tail messages absent from session entries", async () => {
	const { beforeProviderRequest, abortCalls } = await loadHookHarness();
	const model = { ...defaultModel };
	const keptUser = createUserEntry("kept_user_inj", "Kept user context that Pi should stop duplicating.");
	const keptAssistant = createAssistantEntry(
		"kept_assistant_inj",
		[createTextBlock("Old assistant context that should disappear after native replay.", "commentary", "msg_kept_inj")],
		model,
	);
	const compactedWindow = [{ type: "compaction", encrypted_content: "opaque-injected-tail" }];
	const compactionEntry = createCompactionEntry({
		id: "compaction_inj",
		firstKeptEntryId: keptUser.id,
		model,
		compactedWindow,
		compactResponseId: "resp_inj",
	});
	const currentUser = createUserEntry("post_compaction_inj", "Continue after the opaque replay.");
	const branchEntries = [keptUser, keptAssistant, compactionEntry, currentUser];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry,
		instructions: "Current instructions v-inj",
		freshPreamble: "Fresh preamble v-inj",
	});

	// Simulate another extension injecting a transient context message that has no
	// corresponding session entry. It lands between the live tail and the trailing
	// developer prompt, exactly where the old whole-payload parity check failed.
	const injected = { role: "user", content: [{ type: "input_text", text: "extension-injected transient guidance" }] };
	const trailingPrompt = { role: "developer", content: [{ type: "input_text", text: "Trailing provider hint" }] };
	payload.input.push(injected);
	payload.input.push(trailingPrompt);

	const rewritten = (await beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };

	const expectedTail = await serializeResponsesInput(model, [toReplayMessage(currentUser)]);
	const expectedInput = [payload.input[0], ...compactedWindow, ...expectedTail, injected, trailingPrompt];

	expect(abortCalls.count).toBe(0);
	expect(rewritten.instructions).toBe("Current instructions v-inj");
	expect(rewritten.input).toEqual(expectedInput);
	expect(JSON.stringify(rewritten.input)).toContain("opaque-injected-tail");
	expect(JSON.stringify(rewritten.input)).toContain("extension-injected transient guidance");
	expect(JSON.stringify(rewritten.input)).toContain("Trailing provider hint");
	expect(JSON.stringify(rewritten.input)).not.toContain("The conversation history before this point was compacted");
	expect(JSON.stringify(rewritten.input)).not.toContain("Kept user context that Pi should stop duplicating.");
});

test("replay tolerates post-sentinel content unrelated to session entries (after retained-context filtering)", async () => {
	const { beforeProviderRequest } = await loadHookHarness();
	const model = { ...defaultModel };
	const keptUser = createUserEntry("kept_user_pass", "Kept user context that Pi never re-renders after compaction.");
	const compactedWindow = [{ type: "compaction", encrypted_content: "opaque-pass-through" }];
	const compactionEntry = createCompactionEntry({
		id: "compaction_pass",
		firstKeptEntryId: keptUser.id,
		model,
		compactedWindow,
	});
	const currentUser = createUserEntry("post_compaction_pass", "Continue after compaction.");
	const branchEntries = [keptUser, compactionEntry, currentUser];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry,
		instructions: "Current instructions v-pass",
		freshPreamble: "Fresh preamble v-pass",
	});

	// Anything after the sentinel is preserved verbatim, no matter how it differs
	// from session entries: the context hook already removed the verified retained copies.
	payload.input.push({ role: "user", content: [{ type: "input_text", text: "injected guidance with no session entry" }] });
	const rewritten = (await beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };

	expect(rewritten.input[0]).toEqual(payload.input[0]);
	expect(rewritten.input[1]).toEqual(compactedWindow[0]);
	expect(JSON.stringify(rewritten.input)).toContain("Continue after compaction.");
	expect(JSON.stringify(rewritten.input)).toContain("injected guidance with no session entry");
	expect(JSON.stringify(rewritten.input)).not.toContain("Kept user context that Pi never re-renders");
	expect(JSON.stringify(rewritten.input)).not.toContain("The conversation history before this point was compacted");
});

test("missing compaction summary sentinel aborts instead of sending the payload", async () => {
	const { beforeProviderRequest, abortCalls } = await loadHookHarness();
	const model = { ...defaultModel };
	const keptUser = createUserEntry("kept_user_no_sentinel", "Kept user context.");
	const compactedWindow = [{ type: "compaction", encrypted_content: "opaque-no-sentinel" }];
	const compactionEntry = createCompactionEntry({
		id: "compaction_no_sentinel",
		firstKeptEntryId: keptUser.id,
		model,
		compactedWindow,
	});
	const currentUser = createUserEntry("post_compaction_no_sentinel", "Continue after compaction.");
	const branchEntries = [keptUser, compactionEntry, currentUser];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry,
		instructions: "Current instructions v-no-sentinel",
		freshPreamble: "Fresh preamble v-no-sentinel",
	});

	// Remove the compaction summary item entirely; nothing may be replaced.
	payload.input.splice(1, 1);

	const result = await beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions, onAbort: () => abortCalls.count++ }),
	);

	expect(result).toBeUndefined();
	expect(abortCalls.count).toBe(1);
});

test("trailing provider-authored developer prompts survive native replay in place", async () => {
	const { beforeProviderRequest } = await loadHookHarness();
	const model = { ...defaultModel, reasoning: true };
	const keptUser = createUserEntry("kept_for_trailing_prompt", "Older replay context that should disappear.");
	const compactedWindow = [
		{
			type: "compaction",
			encrypted_content: "opaque-compact-window",
		},
	];
	const compactionEntry = createCompactionEntry({
		id: "compaction_with_trailing_prompt",
		firstKeptEntryId: keptUser.id,
		model,
		compactedWindow,
	});
	const currentUser = createUserEntry("trailing_prompt_user", "Continue with the trailing developer hint preserved.");
	const branchEntries = [keptUser, compactionEntry, currentUser];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry,
		instructions: "Current instructions with trailing provider hint",
		freshPreamble: "Fresh preamble before replay",
		trailingPreamble: ["# Juice: 0 !important"],
	});
	const rewritten = (await beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };
	const expectedTail = await serializeResponsesInput(model, [toReplayMessage(currentUser)]);
	const trailingPrompt = payload.input[payload.input.length - 1];

	expect(rewritten.instructions).toBe("Current instructions with trailing provider hint");
	expect(rewritten.input).toEqual([payload.input[0], ...compactedWindow, ...expectedTail, trailingPrompt]);
	expect(rewritten.input[rewritten.input.length - 1]).toEqual(trailingPrompt);
});

test("multi-turn follow-up survives restart/resume while preserving tool/result pairing and assistant phases", async () => {
	const model = { ...defaultModel };
	const keptUser = createUserEntry("resume_kept_user", "Remember the earlier migration context.");
	const compactedWindow = [
		{
			type: "message",
			role: "assistant",
			status: "completed",
			id: "cmp_resume",
			phase: "commentary",
			content: [{ type: "output_text", text: "Compacted reasoning survives here.", annotations: [] }],
		},
	];
	const compactionEntry = createCompactionEntry({
		id: "resume_compaction",
		firstKeptEntryId: keptUser.id,
		model,
		compactedWindow,
		compactResponseId: "resp_resume",
	});
	const reviewCall = createToolCallBlock("call_review", "review_branch", { branch: "feature/native-compaction" }, "fc_review");
	const tailUser = createUserEntry("resume_tail_user", "Review the branch and call out risks.");
	const tailAssistantCommentary = createAssistantEntry(
		"resume_tail_assistant_commentary",
		[createTextBlock("Reviewing the branch now.", "commentary", "msg_tail_commentary"), reviewCall],
		model,
		"toolUse",
	);
	const tailToolResult = createToolResultEntry(
		"resume_tail_tool_result",
		reviewCall.id,
		reviewCall.name,
		"Found one medium-severity risk.",
	);
	const tailAssistantFinal = createAssistantEntry(
		"resume_tail_assistant_final",
		[createTextBlock("The main risk is stale replay state.", "final_answer", "msg_tail_final")],
		model,
	);
	const currentUser = createUserEntry("resume_current_user", "Which regression should I test first?");
	const branchEntries = [
		keptUser,
		compactionEntry,
		tailUser,
		tailAssistantCommentary,
		tailToolResult,
		tailAssistantFinal,
		currentUser,
	];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry,
		instructions: "Current instructions after restart",
		freshPreamble: "Fresh preamble after restart",
	});
	const firstHarness = await loadHookHarness();
	const resumedHarness = await loadHookHarness();
	const firstRewrite = (await firstHarness.beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };
	const resumedRewrite = (await resumedHarness.beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };
	const parity = await createInputParitySignature(firstRewrite.input);

	expect(resumedRewrite).toEqual(firstRewrite);
	expect(firstRewrite.instructions).toBe("Current instructions after restart");
	expect(parity).toEqual([
		"input:developer",
		"message:assistant:commentary",
		"input:user[1]",
		"message:assistant:commentary",
		"function_call:review_branch",
		"function_call_output",
		"message:assistant:final_answer",
		"input:user[1]",
	]);
});

test("a second compaction replays only the latest compacted window and keeps fresh instructions authoritative", async () => {
	const { beforeProviderRequest } = await loadHookHarness();
	const model = { ...defaultModel };
	const initialKeptUser = createUserEntry("initial_kept_user", "Initial context before the first compaction.");
	const firstCompaction = createCompactionEntry({
		id: "compaction_first",
		firstKeptEntryId: initialKeptUser.id,
		model,
		compactedWindow: [
			{
				type: "message",
				role: "assistant",
				status: "completed",
				id: "cmp_first",
				phase: "commentary",
				content: [{ type: "output_text", text: "First compaction window", annotations: [] }],
			},
		],
	});
	const interimUser = createUserEntry("interim_user", "Interim question between compactions.");
	const interimAssistant = createAssistantEntry(
		"interim_assistant",
		[createTextBlock("Interim answer between compactions.", "final_answer", "msg_interim")],
		model,
	);
	const secondCompactionWindow = [
		{
			type: "message",
			role: "assistant",
			status: "completed",
			id: "cmp_second",
			phase: "commentary",
			content: [{ type: "output_text", text: "Second compaction window", annotations: [] }],
		},
	];
	const secondCompaction = createCompactionEntry({
		id: "compaction_second",
		firstKeptEntryId: interimUser.id,
		model,
		compactedWindow: secondCompactionWindow,
	});
	const currentUser = createUserEntry("post_second_compaction_user", "What changed after the second compaction?");
	const branchEntries = [
		initialKeptUser,
		firstCompaction,
		interimUser,
		interimAssistant,
		secondCompaction,
		currentUser,
	];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry: secondCompaction,
		instructions: "Newest instructions win",
		freshPreamble: "Newest preamble wins too",
	});
	const rewritten = (await beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };

	expect(rewritten.instructions).toBe("Newest instructions win");
	expect(rewritten.input).toEqual([
		payload.input[0],
		...secondCompactionWindow,
		...(await serializeResponsesInput(model, [toReplayMessage(currentUser)])),
	]);
	expect(JSON.stringify(rewritten.input)).toContain("Second compaction window");
	expect(JSON.stringify(rewritten.input)).not.toContain("First compaction window");
	expect(JSON.stringify(rewritten.input)).not.toContain("Interim question between compactions.");
});

test("a different latest endpoint blocks remote compaction and replay without searching older checkpoints", async () => {
	const { sessionBeforeCompact, beforeProviderRequest, compactCalls } = await loadHookHarness();
	const matchingModel = { ...defaultModel };
	const switchedModel = {
		...defaultModel,
		id: "gpt-5-nano",
		baseUrl: "https://other-gateway.example/v1",
	};
	const unsupportedProviderModel = {
		...defaultModel,
		provider: "anthropic",
		api: "anthropic-messages",
		id: "claude-sonnet-4",
	};
	const keptUser = createUserEntry("switch_kept_user", "Original context before switching models.");
	const olderMatchingCompaction = createCompactionEntry({
		id: "switch_compaction_old",
		firstKeptEntryId: keptUser.id,
		model: matchingModel,
		compactedWindow: [{ type: "message", role: "assistant", status: "completed", id: "cmp_old", content: [] }],
	});
	const newerMismatchedCompaction = createCompactionEntry({
		id: "switch_compaction_new",
		firstKeptEntryId: keptUser.id,
		model: switchedModel,
		compactedWindow: [{ type: "message", role: "assistant", status: "completed", id: "cmp_new", content: [] }],
	});
	const branchEntries = [keptUser, olderMatchingCompaction, newerMismatchedCompaction];
	const matchingPayload = {
		model: matchingModel.id,
		instructions: "Instructions after switching back",
		input: [{ role: "developer", content: "Fresh preamble after switching back" }],
	};
	const context = createContext({
		branchEntries,
		model: matchingModel,
		systemPrompt: matchingPayload.instructions,
		sessionContextMessages: [toReplayMessage(keptUser)],
	});
	const compactResult = await sessionBeforeCompact(
		{
			reason: "manual",
			signal: new AbortController().signal,
			customInstructions: undefined,
			preparation: {
				tokensBefore: 512,
				firstKeptEntryId: keptUser.id,
				previousSummary: undefined,
				messagesToSummarize: [toReplayMessage(keptUser)],
				turnPrefixMessages: [],
			},
		},
		context,
	);
	const mismatchedLatestResult = await beforeProviderRequest({ payload: matchingPayload }, context);
	const unsupportedProviderResult = await beforeProviderRequest(
		{ payload: { ...matchingPayload, model: unsupportedProviderModel.id } },
		createContext({ branchEntries, model: unsupportedProviderModel, systemPrompt: matchingPayload.instructions }),
	);

	expect(compactResult).toBeUndefined();
	expect(compactCalls).toHaveLength(0);
	expect(mismatchedLatestResult).toBeUndefined();
	expect(unsupportedProviderResult).toBeUndefined();
});

test("same-endpoint switching reuses the latest opaque checkpoint despite provider, API, and model metadata changes", async () => {
	const sol = {
		...defaultModel,
		provider: "legacy-sol-provider",
		api: "openai-codex-responses",
		id: "gpt-5.6-sol",
	};
	const luna = {
		...defaultModel,
		id: "gpt-5.6-luna",
	};
	const opaqueWindow = [{ type: "compaction", encrypted_content: "opaque-sol-checkpoint" }];
	const user = createUserEntry("cross-model-user", "Continue from the Sol checkpoint.");
	const priorCompaction = createCompactionEntry({
		id: "cross-model-compaction",
		firstKeptEntryId: user.id,
		model: sol,
		compactionModel: sol,
		compactedWindow: opaqueWindow,
	});
	const branchEntries = [user, priorCompaction];
	const { sessionBeforeCompact, beforeProviderRequest, compactCalls } = await loadHookHarness({
		config: { remoteCompactModel: "openai/gpt-5.6-luna" },
	});
	const context = createContext({
		branchEntries,
		model: luna,
		registryModels: [luna],
		sessionContextMessages: [toReplayMessage(user)],
	});
	const result = (await sessionBeforeCompact(
		{
			reason: "manual",
			signal: new AbortController().signal,
			customInstructions: undefined,
			preparation: {
				tokensBefore: 512,
				firstKeptEntryId: user.id,
				previousSummary: undefined,
				messagesToSummarize: [toReplayMessage(user)],
				turnPrefixMessages: [],
			},
		},
		context,
	)) as { compaction: { details: Record<string, unknown> } };

	expect(compactCalls).toHaveLength(1);
	expect((compactCalls[0]?.request as { model: string }).model).toBe(luna.id);
	expect((compactCalls[0]?.request as { input: unknown[] }).input).toContainEqual(opaqueWindow[0]);
	expect(result.compaction.details).toEqual(
		expect.objectContaining({
			provider: luna.provider,
			api: luna.api,
			model: luna.id,
			baseUrl: luna.baseUrl,
			compactionModel: {
				provider: luna.provider,
				api: luna.api,
				model: luna.id,
				baseUrl: luna.baseUrl,
			},
		}),
	);

	const payload = await buildPiReplayPayload({
		model: luna,
		branchEntries,
		compactionEntry: priorCompaction,
		instructions: "Current Luna instructions",
		freshPreamble: "Fresh Luna preamble",
	});
	const rewritten = (await beforeProviderRequest({ payload }, context)) as { input: unknown[] };
	expect(rewritten.input).toContainEqual(opaqueWindow[0]);
});

test("a failed remote v2 request is compacted natively by remoteCompactModel", async () => {
	const fallbackResult = {
		summary: "## Goal\nFinish the compaction refactor.",
		firstKeptEntryId: "entry_user",
		tokensBefore: 512,
		details: { readFiles: ["src/extension-runtime.ts"], modifiedFiles: [] },
	};
	const { sessionBeforeCompact, compactCalls, fallbackCalls } = await loadHookHarness({
		compactResult: { ok: false, reason: "non-2xx", status: 404 },
		// nativeFallback.model must be ignored once a remote request was attempted.
		nativeFallbackResult: {
			ok: true,
			result: fallbackResult,
			model: { provider: "openai", id: "gpt-5.6-luna" },
		},
		config: {
			remoteCompactModel: "openai/gpt-5.6-luna",
			nativeFallback: { enabled: true, model: "google/gemini-2.5-flash", thinkingLevel: "off" },
		},
	});
	const model = { ...defaultModel };
	const luna = { ...defaultModel, id: "gpt-5.6-luna" };
	const user = createUserEntry("entry_user", "Compact this conversation.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};

	const result = (await sessionBeforeCompact(
		event,
		createContext({
			model,
			registryModels: [luna],
			systemPrompt: "Current instructions v1",
			sessionContextMessages: [toReplayMessage(user)],
		}),
	)) as { compaction: Record<string, unknown> };

	// The remote endpoint was attempted once, then the remote producer compacted natively.
	expect(compactCalls).toHaveLength(1);
	expect(fallbackCalls).toHaveLength(1);
	expect(fallbackCalls[0]).toMatchObject({ modelSpec: "openai/gpt-5.6-luna" });
	expect(result.compaction).toEqual(fallbackResult);
});

test("a failed remote v2 request without an override keeps the active model", async () => {
	const { sessionBeforeCompact, compactCalls, fallbackCalls } = await loadHookHarness({
		// nativeFallback.model must not be borrowed just because no remote override exists.
		config: { nativeFallback: { enabled: true, model: "google/gemini-2.5-flash", thinkingLevel: "off" } },
		compactResult: { ok: false, reason: "non-2xx", status: 404 },
		nativeFallbackResult: { ok: false, reason: "no-model-configured" },
	});
	const model = { ...defaultModel };
	const user = createUserEntry("entry_no_override", "Compact this without a remote override.");
	const event = {
		reason: "manual",
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};

	const result = await sessionBeforeCompact(
		event,
		createContext({
			model,
			systemPrompt: "Current instructions v1",
			sessionContextMessages: [toReplayMessage(user)],
		}),
	);

	// No override means no explicit native model, so Pi compacts with the active model itself.
	expect(compactCalls).toHaveLength(1);
	expect(fallbackCalls).toHaveLength(1);
	expect(fallbackCalls[0]).toMatchObject({ modelSpec: undefined });
	expect(result).toBeUndefined();
});

test("nativeFallback disabled leaves a successful remote v2 compaction intact", async () => {
	const opaqueWindow = [{ type: "compaction", encrypted_content: "opaque-remote-checkpoint" }];
	const { sessionBeforeCompact, compactCalls, fallbackCalls } = await loadHookHarness({
		config: { nativeFallback: { enabled: false, model: "google/gemini-2.5-flash", thinkingLevel: "off" } },
		compactResult: {
			ok: true,
			status: 200,
			compactedWindow: opaqueWindow,
			compactResponseId: "resp_remote_ok",
			createdAt: nextTimestamp(),
			response: {
				id: "resp_remote_ok",
				status: "completed",
				output: opaqueWindow,
			},
		},
	});
	const model = { ...defaultModel };
	const user = createUserEntry("entry_remote_ok", "Compact this remotely.");
	const event = {
		reason: "manual",
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};

	const result = (await sessionBeforeCompact(
		event,
		createContext({
			model,
			systemPrompt: "Current instructions v1",
			sessionContextMessages: [toReplayMessage(user)],
		}),
	)) as { compaction: { details: { compactedWindow: unknown[] } } };

	// The switch only governs the native chain; remote v2 still runs and still wins.
	expect(compactCalls).toHaveLength(1);
	expect(fallbackCalls).toHaveLength(0);
	expect(result.compaction.details.compactedWindow).toEqual(opaqueWindow);
});

test("nativeFallback disabled sends a failed remote v2 straight to Pi's default path", async () => {
	const { sessionBeforeCompact, compactCalls, fallbackCalls } = await loadHookHarness({
		config: {
			remoteCompactModel: "openai/gpt-5.6-luna",
			nativeFallback: { enabled: false, model: "google/gemini-2.5-flash", thinkingLevel: "off" },
		},
		compactResult: { ok: false, reason: "non-2xx", status: 404 },
		nativeFallbackResult: { ok: false, reason: "disabled" },
	});
	const model = { ...defaultModel };
	const luna = { ...defaultModel, id: "gpt-5.6-luna" };
	const user = createUserEntry("entry_remote_fail", "Compact this remotely and fail.");
	const event = {
		reason: "manual",
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};

	const result = await sessionBeforeCompact(
		event,
		createContext({
			model,
			registryModels: [luna],
			systemPrompt: "Current instructions v1",
			sessionContextMessages: [toReplayMessage(user)],
		}),
	);

	// Remote v2 was still attempted once with the override; only the native step is switched off.
	expect(compactCalls).toHaveLength(1);
	expect((compactCalls[0] as { runtime: { model: string } }).runtime.model).toBe(luna.id);
	expect(fallbackCalls).toHaveLength(1);
	expect(fallbackCalls[0]).toMatchObject({ modelSpec: "openai/gpt-5.6-luna" });
	expect(result).toBeUndefined();
});

test("non-Responses model routes straight to the native-method fallback", async () => {
	const anthropicModel = {
		provider: "anthropic",
		api: "anthropic-messages",
		id: "claude-fable-5",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		reasoning: true,
	};
	const fallbackResult = {
		summary: "## Goal\nAnthropic-side summary.",
		firstKeptEntryId: "entry_user",
		tokensBefore: 256,
		details: { readFiles: [], modifiedFiles: [] },
	};
	const { sessionBeforeCompact, compactCalls, fallbackCalls } = await loadHookHarness({
		nativeFallbackResult: {
			ok: true,
			result: fallbackResult,
			model: { provider: "google", id: "gemini-2.5-flash" },
		},
		// A remote producer must never drive the native chain for a non-Responses model.
		config: {
			remoteCompactModel: "openai/gpt-5.6-luna",
			nativeFallback: { enabled: true, model: "google/gemini-2.5-flash", thinkingLevel: "off" },
		},
	});
	const user = createUserEntry("entry_user", "Compact this Anthropic conversation.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 256,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};

	const result = (await sessionBeforeCompact(
		event,
		createContext({
			model: anthropicModel,
			systemPrompt: "Current instructions v1",
			sessionContextMessages: [toReplayMessage(user)],
		}),
	)) as { compaction: Record<string, unknown> };

	// The compact endpoint is never touched for a non-Responses API.
	expect(compactCalls).toHaveLength(0);
	expect(fallbackCalls).toHaveLength(1);
	expect(fallbackCalls[0]).toMatchObject({ modelSpec: "google/gemini-2.5-flash" });
	expect(result.compaction).toEqual(fallbackResult);
});

test("remoteCompactModel uses Luna only for compaction, persists producer identity, and replays to Sol", async () => {
	const sol = {
		...defaultModel,
		provider: "uwoacrimson",
		id: "gpt-5.6-sol",
		baseUrl: "https://gateway.example/v1",
	};
	const luna = { ...sol, id: "gpt-5.6-luna" };
	const opaqueWindow = [{ type: "compaction", encrypted_content: "opaque-luna-checkpoint" }];
	const { sessionBeforeCompact, beforeProviderRequest, compactCalls } = await loadHookHarness({
		config: { remoteCompactModel: "uwoacrimson/gpt-5.6-luna" },
		compactResult: {
			ok: true,
			status: 200,
			compactedWindow: opaqueWindow,
			compactResponseId: "resp_luna",
			createdAt: nextTimestamp(),
			response: { id: "resp_luna", status: "completed", output: opaqueWindow },
		},
	});
	const user = createUserEntry("sol_user", "Remember this Sol-authored context.");
	const event = {
		reason: "manual",
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};
	const context = createContext({
		model: sol,
		registryModels: [luna],
		sessionContextMessages: [toReplayMessage(user)],
		resolveAuth: (model) => ({
			ok: true,
			apiKey: model.id === luna.id ? "sk-luna" : "sk-sol",
			headers: { "x-runtime-model": model.id },
		}),
	});
	const livePayload = {
		model: sol.id,
		input: [],
		tools: [{ type: "function", name: "read" }],
		parallel_tool_calls: true,
		reasoning: { effort: "high", summary: "auto" },
		service_tier: "flex",
		prompt_cache_key: "session-sol",
		text: { verbosity: "low" },
	};

	await beforeProviderRequest({ payload: livePayload }, context);
	const result = (await sessionBeforeCompact(event, context)) as { compaction: TestSessionEntry };

	expect(context.model).toBe(sol);
	expect(compactCalls).toHaveLength(1);
	const compactCall = compactCalls[0] as {
		runtime: { model: string; apiKey: string; currentModel: TestModel; headers?: Record<string, string> };
		request: Record<string, unknown>;
	};
	expect(compactCall.runtime.model).toBe(luna.id);
	expect(compactCall.runtime.currentModel).toBe(luna);
	expect(compactCall.runtime.apiKey).toBe("sk-luna");
	expect(compactCall.runtime.headers).toEqual({ "x-runtime-model": luna.id });
	expect(compactCall.request).toEqual(
		expect.objectContaining({
			model: luna.id,
			tools: [{ type: "function", name: "read" }],
			parallel_tool_calls: true,
			reasoning: { effort: "high", summary: "auto" },
			service_tier: "flex",
			prompt_cache_key: "session-sol",
			text: { verbosity: "low" },
		}),
	);
	const details = result.compaction.details!;
	expect(details).toEqual(
		expect.objectContaining({
			provider: sol.provider,
			api: sol.api,
			model: sol.id,
			baseUrl: sol.baseUrl,
			compactionModel: {
				provider: luna.provider,
				api: luna.api,
				model: luna.id,
				baseUrl: luna.baseUrl,
			},
			compactedWindow: opaqueWindow,
		}),
	);

	const compactionEntry: TestSessionEntry = {
		type: "compaction",
		id: "luna_compaction_entry",
		timestamp: nextTimestamp(),
		summary: result.compaction.summary,
		firstKeptEntryId: result.compaction.firstKeptEntryId,
		tokensBefore: result.compaction.tokensBefore,
		details,
	};
	const currentUser = createUserEntry("sol_after_luna", "Continue with Sol after the Luna checkpoint.");
	const branchEntries = [user, compactionEntry, currentUser];
	const replayPayload = await buildPiReplayPayload({
		model: sol,
		branchEntries,
		compactionEntry,
		instructions: "Sol remains active",
		freshPreamble: "Fresh Sol preamble",
	});
	const rewritten = (await beforeProviderRequest(
		{ payload: replayPayload },
		createContext({
			branchEntries,
			model: sol,
			registryModels: [luna],
			systemPrompt: replayPayload.instructions,
		}),
	)) as { model: string; input: unknown[] };

	expect(rewritten.model).toBe(sol.id);
	expect(rewritten.input).toEqual([
		replayPayload.input[0],
		...opaqueWindow,
		...(await serializeResponsesInput(sol, [toReplayMessage(currentUser)])),
	]);
});

test("Luna recursively compacts the latest consumer checkpoint and can take over a legacy Sol checkpoint", async () => {
	const sol = {
		...defaultModel,
		provider: "uwoacrimson",
		id: "gpt-5.6-sol",
		baseUrl: "https://gateway.example/v1",
	};
	const luna = { ...sol, id: "gpt-5.6-luna" };

	for (const priorProducer of [luna, undefined]) {
		const { sessionBeforeCompact, compactCalls } = await loadHookHarness({
			config: { remoteCompactModel: "uwoacrimson/gpt-5.6-luna" },
		});
		const oldUser = createUserEntry(
			priorProducer ? "recursive_old_user" : "handoff_old_user",
			"Context already sealed in the previous checkpoint.",
		);
		const oldWindow = [
			{
				type: "compaction",
				encrypted_content: priorProducer ? "opaque-luna-prior" : "opaque-sol-prior",
			},
		];
		const priorCompaction = createCompactionEntry({
			id: priorProducer ? "recursive_prior" : "handoff_prior",
			firstKeptEntryId: oldUser.id,
			model: sol,
			compactionModel: priorProducer,
			compactedWindow: oldWindow,
		});
		const tailUser = createUserEntry(
			priorProducer ? "recursive_tail" : "handoff_tail",
			"Live tail that Luna must append to the opaque checkpoint.",
		);
		const branchEntries = [oldUser, priorCompaction, tailUser];
		const event = {
			reason: "threshold",
			signal: new AbortController().signal,
			customInstructions: undefined,
			preparation: {
				tokensBefore: 768,
				firstKeptEntryId: tailUser.id,
				previousSummary: NATIVE_COMPACTION_FALLBACK_SUMMARY,
				messagesToSummarize: [],
				turnPrefixMessages: [],
			},
		};

		const result = (await sessionBeforeCompact(
			event,
			createContext({ branchEntries, model: sol, registryModels: [luna] }),
		)) as { compaction: TestSessionEntry };

		expect(compactCalls).toHaveLength(1);
		const request = compactCalls[0]?.request as { model: string; input: unknown[] };
		expect(request.model).toBe(luna.id);
		expect(request.input).toEqual([
			...oldWindow,
			...(await serializeResponsesInput(luna, [toReplayMessage(tailUser)])),
		]);
		expect(result.compaction.details).toEqual(
			expect.objectContaining({
				provider: sol.provider,
				model: sol.id,
				compactionModel: expect.objectContaining({ provider: luna.provider, model: luna.id }),
			}),
		);
	}
});

test("manual, threshold, and overflow compaction reasons share the remote override route", async () => {
	const sol = {
		...defaultModel,
		provider: "uwoacrimson",
		id: "gpt-5.6-sol",
		baseUrl: "https://gateway.example/v1",
	};
	const luna = { ...sol, id: "gpt-5.6-luna" };
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness({
		config: { remoteCompactModel: "uwoacrimson/gpt-5.6-luna" },
	});
	const user = createUserEntry("reason_user", "Compact for every Pi reason.");
	const context = createContext({
		model: sol,
		registryModels: [luna],
		sessionContextMessages: [toReplayMessage(user)],
	});

	for (const reason of ["manual", "threshold", "overflow"]) {
		await sessionBeforeCompact(
			{
				reason,
				signal: new AbortController().signal,
				customInstructions: undefined,
				preparation: {
					tokensBefore: 256,
					firstKeptEntryId: user.id,
					previousSummary: undefined,
					messagesToSummarize: [toReplayMessage(user)],
					turnPrefixMessages: [],
				},
			},
			context,
		);
	}

	expect(compactCalls).toHaveLength(3);
	expect(compactCalls.map((call) => (call.request as { model: string }).model)).toEqual([
		luna.id,
		luna.id,
		luna.id,
	]);
});

test("an unusable explicit remote override enters native fallback without retrying remote v2 with Sol", async () => {
	const sol = {
		...defaultModel,
		provider: "uwoacrimson",
		id: "gpt-5.6-sol",
		baseUrl: "https://gateway.example/v1",
	};
	const { sessionBeforeCompact, compactCalls, fallbackCalls } = await loadHookHarness({
		config: { remoteCompactModel: "uwoacrimson/missing-luna" },
	});
	const user = createUserEntry("missing_override_user", "Do not silently retry with Sol.");
	const result = await sessionBeforeCompact(
		{
			reason: "manual",
			signal: new AbortController().signal,
			customInstructions: undefined,
			preparation: {
				tokensBefore: 256,
				firstKeptEntryId: user.id,
				previousSummary: undefined,
				messagesToSummarize: [toReplayMessage(user)],
				turnPrefixMessages: [],
			},
		},
		createContext({ model: sol, sessionContextMessages: [toReplayMessage(user)] }),
	);

	expect(result).toBeUndefined();
	expect(compactCalls).toHaveLength(0);
	expect(fallbackCalls).toHaveLength(1);
});

test("remote v2 stores an opaque checkpoint marker instead of inventing a readable summary", async () => {
	const compactedWindow = [
		{ type: "compaction", encrypted_content: "opaque" },
	];
	const { sessionBeforeCompact } = await loadHookHarness({
		compactResult: {
			ok: true,
			status: 200,
			compactedWindow,
			compactResponseId: "resp_summary",
			createdAt: nextTimestamp(),
			response: { id: "resp_summary", status: "completed", output: compactedWindow },
		},
	});
	const model = { ...defaultModel };
	const user = createUserEntry("entry_user", "Compact with a real summary.");
	const event = {
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(user)],
			turnPrefixMessages: [],
		},
	};

	const result = (await sessionBeforeCompact(
		event,
		createContext({ model, sessionContextMessages: [toReplayMessage(user)] }),
	)) as { compaction: Record<string, unknown> };

	expect(result.compaction.summary).toBe(NATIVE_COMPACTION_FALLBACK_SUMMARY);
});

test("first and recursive compaction preserve Pi cache policy and complete a trailing partial tool batch", async () => {
	const model = { ...defaultModel, id: "gpt-6-astra", compat: { supportsExplicitPromptCacheMode: true } };
	for (const recursive of [false, true]) {
		for (const cache of [{ ttl: "30m" }, { mode: "explicit" }]) {
			const { sessionBeforeCompact, beforeProviderRequest, compactCalls } = await loadHookHarness();
			const old = createUserEntry("old", "Old context");
			const previous = createCompactionEntry({ id: "checkpoint", firstKeptEntryId: old.id, model, compactedWindow: [{ type: "compaction", encrypted_content: "opaque-prior" }] });
			const a = createToolCallBlock("call_a", "read", { path: "a" }, "fc_a");
			const b = createToolCallBlock("call_b", "read", { path: "b" }, "fc_b");
			const assistant = createAssistantEntry("assistant", [a, b], model, "toolUse");
			const real = createToolResultEntry("result", a.id, "read", "real-a");
			const branchEntries = recursive ? [old, previous, assistant, real] : [old, assistant, real];
			const context = createContext({ model, branchEntries });
			const payload = { model: model.id, input: [], prompt_cache_options: cache };
			// No need to invent a replay payload just to seed the cache; the first
			// request in this session supplies the actual live cache selection.
			await beforeProviderRequest({ payload }, createContext({ model }));
			const before = structuredClone(branchEntries);
			await sessionBeforeCompact({ signal: new AbortController().signal, preparation: { tokensBefore: 100,
				firstKeptEntryId: old.id, messagesToSummarize: [], turnPrefixMessages: [] } }, context);
			expect(compactCalls).toHaveLength(1);
			const request = compactCalls[0].request as { input: Array<Record<string, unknown>>; prompt_cache_options: unknown };
			expect(request.prompt_cache_options).toEqual(cache);
			const results = request.input.filter((item) => item.type === "function_call_output");
			expect(results).toEqual([{ type: "function_call_output", call_id: "call_a", output: "real-a" },
				{ type: "function_call_output", call_id: "call_b", output: "No result provided" }]);
			if (recursive) expect(request.input[0]).toEqual({ type: "compaction", encrypted_content: "opaque-prior" });
			expect(branchEntries).toEqual(before);
			expect(payload.prompt_cache_options).toEqual(cache);
		}
	}
});

test("remote model override filters cache fields by the producer, not the consumer", async () => {
	const cases = [
		{ source: { supportsExplicitPromptCacheMode: true }, target: {}, fields: { prompt_cache_options: { ttl: "30m" } }, expected: {} },
		{ source: {}, target: { supportsExplicitPromptCacheMode: true }, fields: { prompt_cache_retention: "24h" }, expected: {} },
		{ source: { supportsExplicitPromptCacheMode: true }, target: { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: false }, fields: { prompt_cache_options: { ttl: "30m" } }, expected: {} },
		{ source: {}, target: {}, fields: { prompt_cache_retention: "24h" }, expected: { prompt_cache_retention: "24h" } },
	] as const;
	for (const scenario of cases) {
		const consumer = { ...defaultModel, id: "consumer", compat: scenario.source };
		const producer = { ...defaultModel, id: "producer", compat: scenario.target };
		const { sessionBeforeCompact, beforeProviderRequest, compactCalls } = await loadHookHarness({
			config: { remoteCompactModel: "openai/producer" },
		});
		const payload = { model: consumer.id, input: [], prompt_cache_key: "cache-identity", ...scenario.fields };
		const snapshot = structuredClone(payload);
		await beforeProviderRequest({ payload }, createContext({ model: consumer }));
		const user = createUserEntry("user", "Compact this history.");
		await sessionBeforeCompact({ signal: new AbortController().signal, preparation: {
			tokensBefore: 100, firstKeptEntryId: user.id, messagesToSummarize: [], turnPrefixMessages: [],
		} }, createContext({ model: consumer, registryModels: [producer], branchEntries: [user] }));
		expect(compactCalls).toHaveLength(1);
		const request = compactCalls[0].request as Record<string, unknown>;
		expect(request.model).toBe(producer.id);
		expect(Object.fromEntries(Object.entries(request).filter(([key]) => key.startsWith("prompt_cache_"))))
			.toEqual({ prompt_cache_key: "cache-identity", ...scenario.expected });
		expect(payload).toEqual(snapshot);
	}
});

test("context filtering honors effective auth endpoints and aborts partial retained matches", async () => {
	const { contextHook } = await loadHookHarness();
	const keptUser = createUserEntry("kept-user", "Covered user message");
	const keptAssistant = createAssistantEntry("kept-assistant", [createTextBlock("Covered answer")]);
	const checkpoint = createCompactionEntry({ id: "checkpoint", firstKeptEntryId: keptUser.id,
		compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }] });
	const post = createUserEntry("post", "New message");
	const branchEntries = [keptUser, keptAssistant, checkpoint, post];
	const summary = createCompactionSummaryMessage(checkpoint);
	const transient = { role: "user", content: "Transient extension content", timestamp: 999 };
	const messages = [summary, toReplayMessage(keptUser), transient, toReplayMessage(keptAssistant), toReplayMessage(post)];
	const before = structuredClone({ messages, branchEntries });
	let aborts = 0;
	const context = createContext({ branchEntries, model: { ...defaultModel, baseUrl: "https://configured.invalid/v1" },
		resolveAuth: () => ({ ok: true, apiKey: "test-only", baseUrl: defaultModel.baseUrl }), onAbort: () => { aborts++; } });
	const result = await contextHook({ messages }, context);
	expect(result).toEqual({ messages: [summary, transient, toReplayMessage(post)] });
	expect({ messages, branchEntries }).toEqual(before);
	expect(aborts).toBe(0);
	const otherEndpoint = createContext({ branchEntries,
		resolveAuth: () => ({ ok: true, apiKey: "test-only", baseUrl: "https://other.invalid/v1" }) });
	expect(await contextHook({ messages }, otherEndpoint)).toBeUndefined();
	const modified = structuredClone(messages);
	modified[3].content = [{ type: "text", text: "Modified retained answer" }];
	expect(await contextHook({ messages: modified }, context)).toBeUndefined();
	expect(aborts).toBe(1);
	expect({ messages, branchEntries }).toEqual(before);
});
