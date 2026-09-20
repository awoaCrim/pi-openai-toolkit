import {
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
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

/**
 * Output budget Pi gives the summary itself: `generateSummary` caps `maxTokens` at
 * `min(floor(0.8 * reserveTokens), model.maxTokens)`.
 */
const SUMMARIZATION_OUTPUT_RESERVE_TOKENS = Math.floor(
	DEFAULT_COMPACTION_SETTINGS.reserveTokens * 0.8,
);

/** Summarization instructions plus the `<conversation>` framing around the transcript. */
const SUMMARIZATION_TEMPLATE_TOKENS = 1024;

export type SummarizationRequestSize = {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
};

/**
 * Size of the request Pi's `compact()` is about to send, measured the same way Pi
 * measures context (the exported `estimateTokens`, a conservative chars/4).
 *
 * A session driven by a wide-window model (400k) produces a preparation that a narrower
 * summary model (272k) cannot accept at all: the provider terminates the stream and the
 * first manual `/compact` fails. Callers must not attempt that request; the estimate is
 * deliberately an under-declaration of certainty, so a missing `contextWindow` skips the
 * check instead of guessing.
 */
export function estimateSummarizationRequest(
	preparation: SessionBeforeCompactEvent["preparation"],
	model: { contextWindow?: number; maxTokens?: number },
): SummarizationRequestSize {
	const conversation = [
		...(preparation.messagesToSummarize ?? []),
		...(preparation.turnPrefixMessages ?? []),
	];
	let inputTokens = SUMMARIZATION_TEMPLATE_TOKENS;
	for (const message of conversation) inputTokens += estimateTokens(message as never);
	if (preparation.previousSummary) {
		inputTokens += Math.ceil(String(preparation.previousSummary).length / 4);
	}
	const outputTokens = model.maxTokens && model.maxTokens > 0
		? Math.min(SUMMARIZATION_OUTPUT_RESERVE_TOKENS, model.maxTokens)
		: SUMMARIZATION_OUTPUT_RESERVE_TOKENS;
	return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
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

	const size = estimateSummarizationRequest(event.preparation, model as { contextWindow?: number; maxTokens?: number });
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
