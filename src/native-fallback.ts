import {
	compact,
	convertToLlm,
	DEFAULT_COMPACTION_SETTINGS,
	serializeConversation,
	type CompactionResult,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { mergeProviderHeaders } from "./provider-headers";
import { parseModelSpec } from "./runtime";
import type { CompactionConfig } from "./types";

export { parseModelSpec } from "./runtime";

export type NativeFallbackFailureReason =
	| "disabled"
	| "no-model-configured"
	| "invalid-model-spec"
	| "model-not-found"
	| "same-as-current-model"
	| "auth-failed"
	| "aborted"
	| "empty-summary"
	| "compact-failed"
	/** The configured summary model cannot fit the request it would have to send. */
	| "model-window-too-small";

export type NativeFallbackResult =
	| {
			ok: true;
			result: CompactionResult;
			model: { provider: string; id: string };
	  }
	| {
			ok: false;
			reason: NativeFallbackFailureReason;
			modelSpec?: string;
			errorMessage?: string;
			estimatedTokens?: number;
			contextWindow?: number;
	  };

/** pi's exported native compact(); injectable for tests. */
export type NativeCompactFn = typeof compact;

type ResolvedAuth =
	| { ok: true; apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> }
	| { ok: false; error: string };

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR"))
	);
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Summarization instructions plus the framing around the serialized transcript. */
const SUMMARIZATION_TEMPLATE_TOKENS = 1024;
const HISTORY_OUTPUT_RESERVE_RATIO = 0.8;
const TURN_PREFIX_OUTPUT_RESERVE_RATIO = 0.5;

export type SummarizationRequestSize = {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
};

function estimateTextTokens(text: string | undefined): number {
	return text ? Math.ceil(String(text).length / 4) : 0;
}

function estimateSerializedConversationTokens(
	messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"],
): number {
	const serialized = serializeConversation(convertToLlm(messages));
	return estimateTextTokens(serialized);
}

function getEffectiveReserveTokens(preparation: SessionBeforeCompactEvent["preparation"]): number {
	const reserveTokens = preparation.settings?.reserveTokens;
	return typeof reserveTokens === "number" && Number.isFinite(reserveTokens) && reserveTokens >= 0
		? reserveTokens
		: DEFAULT_COMPACTION_SETTINGS.reserveTokens;
}

function getOutputReserveTokens(
	reserveTokens: number,
	model: { maxTokens?: number },
	ratio: number,
): number {
	const outputTokens = Math.floor(ratio * reserveTokens);
	return typeof model.maxTokens === "number" && model.maxTokens > 0
		? Math.min(outputTokens, model.maxTokens)
		: outputTokens;
}

function estimateSummaryRequest(
	messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"],
	outputTokens: number,
	previousSummary?: string,
	customInstructions?: string,
): SummarizationRequestSize {
	const inputTokens =
		SUMMARIZATION_TEMPLATE_TOKENS
		+ estimateSerializedConversationTokens(messages)
		+ estimateTextTokens(previousSummary)
		+ estimateTextTokens(customInstructions);
	return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/**
 * Size of the individual request(s) Pi's `compact()` is about to send.
 *
 * Pi first converts messages with `convertToLlm()` and then applies
 * `serializeConversation()`, which truncates tool results before they enter the
 * summarization prompt. Split-turn compaction sends history and turn-prefix
 * summaries as separate requests, so this returns the largest individual request
 * rather than adding their inputs together. The fixed allowance remains
 * deliberately conservative for Pi's system prompt, tags, and instructions.
 *
 * A session driven by a wide-window model (400k) can produce a preparation that a
 * narrower summary model (272k) cannot accept. Callers must not attempt that request;
 * a missing `contextWindow` skips the check instead of guessing.
 */
export function estimateSummarizationRequest(
	preparation: SessionBeforeCompactEvent["preparation"],
	model: { contextWindow?: number; maxTokens?: number },
	customInstructions?: string,
): SummarizationRequestSize {
	const reserveTokens = getEffectiveReserveTokens(preparation);
	const historyMessages = preparation.messagesToSummarize ?? [];
	const turnPrefixMessages = preparation.turnPrefixMessages ?? [];
	const historyOutputTokens = getOutputReserveTokens(reserveTokens, model, HISTORY_OUTPUT_RESERVE_RATIO);
	const historyRequest = estimateSummaryRequest(
		historyMessages,
		historyOutputTokens,
		preparation.previousSummary,
		customInstructions,
	);

	if (!preparation.isSplitTurn || turnPrefixMessages.length === 0) {
		return historyRequest;
	}

	const requests = [
		...(historyMessages.length > 0 ? [historyRequest] : []),
		estimateSummaryRequest(
			turnPrefixMessages,
			getOutputReserveTokens(reserveTokens, model, TURN_PREFIX_OUTPUT_RESERVE_RATIO),
		),
	];
	return requests.reduce((largest, request) =>
		request.totalTokens > largest.totalTokens ? request : largest,
	);
}

/** Whether the summary model can accept this request at all; unknown windows always pass. */
export function fitsSummarizationRequest(
	size: SummarizationRequestSize,
	model: { contextWindow?: number },
): boolean {
	const contextWindow = model.contextWindow;
	if (typeof contextWindow !== "number" || contextWindow <= 0) return true;
	return size.totalTokens <= contextWindow;
}

/**
 * Run pi's native compaction method with a caller-resolved summary model.
 *
 * The two compaction chains stay separate: the caller passes `remoteCompactModel` only when a
 * remote v2 request was actually attempted and failed, and `nativeFallback.model` only when the
 * active model cannot use remote v2 at all. This function never inspects `remoteCompactModel`
 * itself, so a model that cannot compact remotely can never inherit the remote producer.
 *
 * Only the "resolved model differs from the current one" case is handled here: when the feature
 * is disabled, nothing is resolved, or it equals the current model, the caller returns undefined
 * from session_before_compact so pi runs the same native path itself, keeping its internal
 * streamFn/thinkingLevel wiring.
 */
export async function runNativeFallbackCompaction(args: {
	ctx: ExtensionContext;
	event: SessionBeforeCompactEvent;
	config: CompactionConfig;
	/** Model spec supplied by the caller for this specific fallback reason. */
	modelSpec?: string;
	compactFn?: NativeCompactFn;
}): Promise<NativeFallbackResult> {
	const { ctx, event, config } = args;
	const compactFn = args.compactFn ?? compact;
	const nativeFallback = config.nativeFallback;

	if (!nativeFallback.enabled) {
		return { ok: false, reason: "disabled" };
	}

	const spec = args.modelSpec?.trim() ?? "";
	if (!spec) {
		return { ok: false, reason: "no-model-configured" };
	}

	const parsed = parseModelSpec(spec);
	if (!parsed) {
		return { ok: false, reason: "invalid-model-spec", modelSpec: spec };
	}

	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		return { ok: false, reason: "model-not-found", modelSpec: spec };
	}

	if (ctx.model && ctx.model.provider === model.provider && ctx.model.id === model.id) {
		return { ok: false, reason: "same-as-current-model", modelSpec: spec };
	}

	const size = estimateSummarizationRequest(
		event.preparation,
		model as { contextWindow?: number; maxTokens?: number },
		event.customInstructions,
	);
	if (!fitsSummarizationRequest(size, model as { contextWindow?: number })) {
		return {
			ok: false,
			reason: "model-window-too-small",
			modelSpec: spec,
			estimatedTokens: size.totalTokens,
			contextWindow: (model as { contextWindow?: number }).contextWindow,
		};
	}

	let auth: ResolvedAuth;
	try {
		auth = (await ctx.modelRegistry.getApiKeyAndHeaders(model)) as ResolvedAuth;
	} catch (error) {
		return { ok: false, reason: "auth-failed", modelSpec: spec, errorMessage: toErrorMessage(error) };
	}
	if (!auth.ok) {
		return { ok: false, reason: "auth-failed", modelSpec: spec, errorMessage: auth.error };
	}

	try {
		const result = await compactFn(
			event.preparation,
			model,
			auth.apiKey,
			mergeProviderHeaders(auth.headers),
			event.customInstructions,
			event.signal,
			nativeFallback.thinkingLevel,
			undefined,
			auth.env,
		);

		if (event.signal.aborted) {
			return { ok: false, reason: "aborted", modelSpec: spec };
		}
		if (!result.summary || result.summary.trim().length === 0) {
			return { ok: false, reason: "empty-summary", modelSpec: spec };
		}

		return {
			ok: true,
			result,
			model: { provider: model.provider, id: model.id },
		};
	} catch (error) {
		if (event.signal.aborted || isAbortError(error)) {
			return { ok: false, reason: "aborted", modelSpec: spec };
		}
		return { ok: false, reason: "compact-failed", modelSpec: spec, errorMessage: toErrorMessage(error) };
	}
}
