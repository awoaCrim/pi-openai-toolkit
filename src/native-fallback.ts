import {
	compact,
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
	| "public-runtime-unavailable"
	| "missing-model";

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
	  };

/** pi's exported native compact(); injectable for tests. */
export type NativeCompactFn = typeof compact;

type ResolvedAuth =
	| { ok: true; apiKey?: string; headers?: ProviderHeaders; baseUrl?: string; env?: Record<string, string> }
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
 * Run pi's native compaction method with a caller-resolved summary model.
 *
 * The two compaction chains stay separate: the caller passes `remoteCompactModel` only when a
 * remote v2 request was actually attempted and failed, and `nativeFallback.model` only when the
 * active model cannot use remote v2 at all. This function never inspects `remoteCompactModel`
 * itself, so a model that cannot compact remotely can never inherit the remote producer.
 *
 * Ordinary no-boundary defaults stay with Pi. When a window constrains input,
 * useCurrentModel runs the same public native primitive with the public registry
 * stream, current thinking and auth, rather than reopening unscoped host history.
 * Host-private custom stream/retry callbacks are not exposed by ExtensionContext.
 */
export async function runNativeFallbackCompaction(args: {
	ctx: ExtensionContext;
	event: SessionBeforeCompactEvent;
	config: CompactionConfig;
	/** Model spec supplied by the caller for this specific fallback reason. */
	modelSpec?: string;
	compactFn?: NativeCompactFn;
	/** Scoped input cannot be handed back to an unscoped host default. */
	scoped?: boolean;
	/** Run current-model native policy, independently of Toolkit's fallback config. */
	useCurrentModel?: boolean;
	isCurrent?: () => boolean;
}): Promise<NativeFallbackResult> {
	const { ctx, event, config } = args;
	const compactFn = args.compactFn ?? compact;
	const nativeFallback = config.nativeFallback;
	const isCurrent = () => !event.signal.aborted && (args.isCurrent?.() ?? true);
	if (!isCurrent()) return { ok: false, reason: "aborted" };

	if (!args.useCurrentModel && !nativeFallback.enabled) return { ok: false, reason: "disabled" };
	const spec = args.useCurrentModel ? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "") : args.modelSpec?.trim() ?? "";
	if (!spec) return { ok: false, reason: args.useCurrentModel ? "missing-model" : "no-model-configured" };
	const parsed = parseModelSpec(spec);
	if (!parsed) return { ok: false, reason: "invalid-model-spec", modelSpec: spec };
	const model = args.useCurrentModel ? ctx.model : ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) return { ok: false, reason: "model-not-found", modelSpec: spec };
	if (!args.useCurrentModel && ctx.model && ctx.model.provider === model.provider && ctx.model.id === model.id) {
		return { ok: false, reason: "same-as-current-model", modelSpec: spec };
	}
	// The public registry preserves provider-native stream/auth wiring. Do not
	// silently use a compat-only transport for scoped current-model compression.
	if (args.scoped && typeof ctx.modelRegistry.streamSimple !== "function" && !args.compactFn) {
		return { ok: false, reason: "public-runtime-unavailable", modelSpec: spec };
	}

	// Pi owns prompt construction, tool-result truncation and split-turn requests.
	// A chars/4 estimate is not target-model token accounting and must not veto
	// the user's summary model. Surface actual provider failures to the caller.

	let auth: ResolvedAuth;
	try {
		auth = (await ctx.modelRegistry.getApiKeyAndHeaders(model)) as ResolvedAuth;
	} catch (error) {
		return { ok: false, reason: "auth-failed", modelSpec: spec, errorMessage: toErrorMessage(error) };
	}
	if (!auth.ok) {
		return { ok: false, reason: "auth-failed", modelSpec: spec, errorMessage: auth.error };
	}

	if (!isCurrent()) return { ok: false, reason: "aborted", modelSpec: spec };
	try {
		const result = await compactFn(
			event.preparation,
			auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
			auth.apiKey,
			mergeProviderHeaders(auth.headers),
			event.customInstructions,
			event.signal,
			args.useCurrentModel ? ctx.thinkingLevel : nativeFallback.thinkingLevel,
			args.scoped && typeof ctx.modelRegistry.streamSimple === "function" ? ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry) : undefined,
			auth.env,
		);

		if (!isCurrent()) {
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
