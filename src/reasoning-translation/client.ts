import type { Api, AssistantMessage, Context, Model, Provider, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModelSpec } from "../runtime";
import { MAX_TRANSLATION_OUTPUT_TOKENS, TRANSLATION_TIMEOUT_MS } from "./types";

export type TranslatorFailureReason =
	| "invalid-model-spec"
	| "model-not-found"
	| "provider-not-found"
	| "auth-failed"
	| "aborted"
	| "request-failed"
	| "empty-output";

export type TranslateSegmentResult =
	| { ok: true; text: string; usage?: Usage }
	| { ok: false; reason: TranslatorFailureReason; errorMessage?: string };

export type ResolvedTranslator = {
	model: Model<Api>;
	provider: Provider;
	apiKey?: string;
	headers?: Record<string, string | null>;
	env?: Record<string, string>;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR"))
	);
}

export function buildTranslationPrompt(targetLanguage: string): string {
	return [
		`Translate the following reasoning into ${targetLanguage}.`,
		"Return only the faithful translation, with no summary, explanation, commentary, or added content.",
		"Preserve code, commands, file paths, URLs, identifiers, formatting markers, and technical terms exactly unless they must be translated for grammatical context.",
	].join(" ");
}

export async function resolveTranslator(
	ctx: ExtensionContext,
	modelSpec: string | undefined,
): Promise<ResolvedTranslator | { ok: false; reason: TranslatorFailureReason; errorMessage?: string }> {
	if (!modelSpec) return { ok: false, reason: "invalid-model-spec" };
	const parsed = parseModelSpec(modelSpec);
	if (!parsed) return { ok: false, reason: "invalid-model-spec" };

	let model: Model<Api> | undefined;
	try {
		model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	} catch (error) {
		return { ok: false, reason: "model-not-found", errorMessage: errorMessage(error) };
	}
	if (!model) {
		return { ok: false, reason: "model-not-found" };
	}

	let provider: Provider | undefined;
	try {
		provider = ctx.modelRegistry.getProvider(parsed.provider);
	} catch (error) {
		return { ok: false, reason: "provider-not-found", errorMessage: errorMessage(error) };
	}
	if (!provider) {
		return { ok: false, reason: "provider-not-found" };
	}

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return { ok: false, reason: "auth-failed", errorMessage: auth.error };
		return {
			// Auth resolution may provide an OAuth-specific endpoint. The provider
			// receives the effective model directly, so preserve that base URL while
			// disabling reasoning on the cloned translator model.
			model: {
				...model,
				...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
				reasoning: false,
			},
			provider,
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
		};
	} catch (error) {
		return { ok: false, reason: "auth-failed", errorMessage: errorMessage(error) };
	}
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is Extract<AssistantMessage["content"][number], { type: "text" }> => content.type === "text")
		.map((content) => content.text)
		.join("")
		.trim();
}

export async function translateSegment(args: {
	translator: ResolvedTranslator;
	targetLanguage: string;
	sourceSegment: string;
	signal: AbortSignal;
}): Promise<TranslateSegmentResult> {
	if (args.signal.aborted) return { ok: false, reason: "aborted" };

	const context: Context = {
		systemPrompt: buildTranslationPrompt(args.targetLanguage),
		messages: [{ role: "user", content: args.sourceSegment, timestamp: Date.now() }],
	};

	const controller = new AbortController();
	let rejectAbort: ((reason?: unknown) => void) | undefined;
	let timedOut = false;
	const abortPromise = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	const onAbort = () => {
		controller.abort();
		rejectAbort?.(new DOMException("Translation request aborted", "AbortError"));
	};
	args.signal.addEventListener("abort", onAbort, { once: true });
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	try {
		// Keep the call safe even when a ResolvedTranslator is supplied by a test
		// seam or another internal caller instead of resolveTranslator().
		const effectiveModel = args.translator.model.reasoning
			? { ...args.translator.model, reasoning: false }
			: args.translator.model;
		const stream = args.translator.provider.streamSimple(effectiveModel, context, {
			apiKey: args.translator.apiKey,
			headers: args.translator.headers,
			env: args.translator.env,
			signal: controller.signal,
			timeoutMs: TRANSLATION_TIMEOUT_MS,
			maxTokens: Math.max(1, Math.min(args.translator.model.maxTokens, MAX_TRANSLATION_OUTPUT_TOKENS)),
		});
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				timedOut = true;
				controller.abort();
				reject(new Error(`Translation request timed out after ${TRANSLATION_TIMEOUT_MS} ms.`));
			}, TRANSLATION_TIMEOUT_MS);
		});
		const message = await Promise.race([stream.result(), abortPromise, timeoutPromise]);
		if (args.signal.aborted) return { ok: false, reason: "aborted" };
		if (timedOut) {
			return {
				ok: false,
				reason: "request-failed",
				errorMessage: `Translation request timed out after ${TRANSLATION_TIMEOUT_MS} ms.`,
			};
		}
		if (message.stopReason === "aborted") {
			return { ok: false, reason: "request-failed", errorMessage: "Translator aborted the request." };
		}
		if (message.stopReason !== "stop" && message.stopReason !== "length") {
			return { ok: false, reason: "request-failed", errorMessage: message.errorMessage };
		}
		const text = extractText(message);
		return text.length > 0
			? { ok: true, text, usage: message.usage }
			: { ok: false, reason: "empty-output" };
	} catch (error) {
		if (args.signal.aborted) return { ok: false, reason: "aborted" };
		if (timedOut) {
			return {
				ok: false,
				reason: "request-failed",
				errorMessage: `Translation request timed out after ${TRANSLATION_TIMEOUT_MS} ms.`,
			};
		}
		if (isAbortError(error)) {
			return { ok: false, reason: "request-failed", errorMessage: errorMessage(error) };
		}
		return { ok: false, reason: "request-failed", errorMessage: errorMessage(error) };
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
		args.signal.removeEventListener("abort", onAbort);
	}
}
