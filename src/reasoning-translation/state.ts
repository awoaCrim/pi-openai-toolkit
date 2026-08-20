import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModelSpec } from "../runtime";
import type { ReasoningTranslationConfig } from "../types";
import {
	resolveTranslator,
	translateSegment,
	type ResolvedTranslator,
	type TranslateSegmentResult,
} from "./client";
import {
	createReasoningTranslationEntry,
	hashThinkingMarkdown,
	projectThinkingRuns,
	replayReasoningTranslations,
	type ThinkingRunProjection,
} from "./persistence";
import { flushThinkingSource, segmentThinkingSource } from "./segmenter";
import {
	IDLE_FLUSH_MS,
	REASONING_TRANSLATION_ENTRY_TYPE,
	TRANSLATING_LABEL,
	type ReasoningTranslationEntryV1,
} from "./types";

export type ReasoningTranslationStateOptions = {
	resolveTranslator?: typeof resolveTranslator;
	translateSegment?: typeof translateSegment;
	setTimeout?: typeof globalThis.setTimeout;
	clearTimeout?: typeof globalThis.clearTimeout;
	onDisplayChanged?: () => void;
	appendEntry?: (customType: string, data: ReasoningTranslationEntryV1) => void;
};

type ThinkingRunState = {
	runKey: number;
	sourceMarkdown: string;
	pendingSource: string;
	displayedText: string;
	usage?: Usage;
	idleTimer?: ReturnType<typeof setTimeout>;
	/** A natural/idle/final flush requested before the translator was ready. */
	flushRequested: boolean;
};

type ActiveTranslation = {
	generation: number;
	sourceModelKey: string;
	targetLanguage: string;
	translator?: ResolvedTranslator;
	translatorReady: boolean;
	translatorFailed: boolean;
	translatorPromise?: Promise<void>;
	abortController: AbortController;
	queue: Promise<void>;
	runs: Map<number, ThinkingRunState>;
	ctx: ExtensionContext;
	finalized: boolean;
};

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function getModelKey(ctx: ExtensionContext): string | undefined {
	return ctx.model?.provider && ctx.model.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function isEligible(ctx: ExtensionContext, config: ReasoningTranslationConfig): boolean {
	const modelKey = getModelKey(ctx);
	return (
		ctx.mode === "tui" &&
		config.enabled &&
		modelKey !== undefined &&
		config.models.includes(modelKey) &&
		config.model !== undefined &&
		parseModelSpec(config.model) !== undefined
	);
}

function preserveSourceWhitespace(source: string, translated: string): string {
	const leading = source.match(/^\s*/u)?.[0] ?? "";
	const trailing = source.match(/\s*$/u)?.[0] ?? "";
	const core = translated.trim();
	return `${leading}${core}${trailing}`;
}

function addUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
	if (!left) return right;
	if (!right) return left;
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined
			? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }
			: {}),
		...(left.reasoning !== undefined || right.reasoning !== undefined
			? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }
			: {}),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

function findRunForContentIndex(runs: readonly ThinkingRunProjection[], contentIndex: number): ThinkingRunProjection | undefined {
	let selected: ThinkingRunProjection | undefined;
	for (const run of runs) {
		if (run.runKey <= contentIndex) selected = run;
		else break;
	}
	return selected;
}

/**
 * Lifecycle-local state for one translation extension instance. It owns no Pi
 * session data; persisted projections are rebuilt from the active branch.
 */
export class ReasoningTranslationState {
	private readonly options: Required<Pick<ReasoningTranslationStateOptions, "resolveTranslator" | "translateSegment" | "setTimeout" | "clearTimeout">> &
		Pick<ReasoningTranslationStateOptions, "onDisplayChanged" | "appendEntry">;
	private generation = 0;
	private active: ActiveTranslation | undefined;
	private persisted = new Map<string, ReasoningTranslationEntryV1>();
	private displayEnabled = false;

	constructor(options: ReasoningTranslationStateOptions = {}) {
		this.options = {
			resolveTranslator: options.resolveTranslator ?? resolveTranslator,
			translateSegment: options.translateSegment ?? translateSegment,
			setTimeout: options.setTimeout ?? globalThis.setTimeout,
			clearTimeout: options.clearTimeout ?? globalThis.clearTimeout,
			onDisplayChanged: options.onDisplayChanged,
			appendEntry: options.appendEntry,
		};
	}

	hydrate(ctx: ExtensionContext, config?: ReasoningTranslationConfig): void {
		this.persisted = replayReasoningTranslations(ctx.sessionManager.getBranch());
		this.displayEnabled = config ? isEligible(ctx, config) : false;
	}

	setDisplayEligibility(ctx: ExtensionContext, config: ReasoningTranslationConfig): void {
		this.displayEnabled = isEligible(ctx, config);
	}

	getPersistedDisplay(markdown: string): string | undefined {
		if (!this.displayEnabled) return undefined;
		return this.persisted.get(hashThinkingMarkdown(markdown))?.displayText;
	}

	getActiveDisplay(markdown: string): string | undefined {
		const active = this.active;
		if (!active || active.ctx.mode !== "tui") return undefined;
		for (const run of active.runs.values()) {
			if (run.sourceMarkdown !== markdown) continue;
			if (run.displayedText.length > 0) return run.displayedText;
			if (!active.translatorFailed) return TRANSLATING_LABEL;
		}
		return undefined;
	}

	lookupDisplay(markdown: string): string | undefined {
		return this.getActiveDisplay(markdown) ?? this.getPersistedDisplay(markdown);
	}

	beginMessage(message: AgentMessage, ctx: ExtensionContext, config: ReasoningTranslationConfig): void {
		const eligible = isEligible(ctx, config);
		this.displayEnabled = eligible;
		// message_start also fires for toolResult and user messages. They must not
		// cancel a finished assistant translation before its FIFO queue can settle.
		if (!isAssistantMessage(message)) return;
		this.abortActive();
		if (!eligible) return;

		const sourceModelKey = getModelKey(ctx);
		if (!sourceModelKey) return;
		const generation = ++this.generation;
		const abortController = new AbortController();
		const active: ActiveTranslation = {
			generation,
			sourceModelKey,
			targetLanguage: config.targetLanguage,
			translatorReady: false,
			translatorFailed: false,
			abortController,
			queue: Promise.resolve(),
			runs: new Map(),
			ctx,
			finalized: false,
		};
		this.active = active;

		if (ctx.signal) {
			if (ctx.signal.aborted) {
				this.abortActive();
				return;
			}
			ctx.signal.addEventListener("abort", () => {
				if (this.active?.generation === generation) this.abortActive();
			}, { once: true });
		}

		const resolve = this.options.resolveTranslator(ctx, config.model).then((result) => {
			if (this.active?.generation !== generation) return;
			if (!("model" in result) || !("provider" in result)) {
				active.translatorFailed = true;
				this.displayEnabled = false;
				this.abortActive();
				return;
			}
			active.translator = result;
			active.translatorReady = true;
			for (const run of active.runs.values()) this.enqueuePending(active, run, run.flushRequested);
		});
		active.translatorPromise = resolve.catch(() => {
			if (this.active?.generation === generation) {
				active.translatorFailed = true;
				this.displayEnabled = false;
				this.abortActive();
			}
		});
	}

	handleMessageUpdate(message: AgentMessage, updateType: string, contentIndex: number): void {
		const active = this.active;
		if (!active || !isAssistantMessage(message) || active.ctx.mode !== "tui") return;
		if (active.ctx.signal?.aborted) {
			this.abortActive();
			return;
		}

		const projections = projectThinkingRuns(message);
		for (const projection of projections) this.updateRunSource(active, projection);
		if (updateType === "thinking_end") {
			const projection = findRunForContentIndex(projections, contentIndex);
			if (projection) {
				const run = active.runs.get(projection.runKey);
				if (run) this.enqueuePending(active, run, true);
			}
		}
	}

	finishMessage(message: AgentMessage): void {
		if (isAssistantMessage(message) && (message.stopReason === "aborted" || message.stopReason === "error")) {
			this.abortActive();
			return;
		}
		const active = this.active;
		if (!active || !isAssistantMessage(message) || active.finalized) return;
		const projections = projectThinkingRuns(message);
		for (const projection of projections) this.updateRunSource(active, projection);
		for (const run of active.runs.values()) this.enqueuePending(active, run, true);
		active.finalized = true;

		const generation = active.generation;
		void (active.translatorPromise ?? Promise.resolve())
			.then(() => active.queue)
			.then(() => {
			if (this.active?.generation !== generation || !this.active || !active.translator) return;
			for (const run of active.runs.values()) {
				if (!run.sourceMarkdown || !run.displayedText) continue;
				const entry = createReasoningTranslationEntry({
					sourceMarkdown: run.sourceMarkdown,
					displayText: run.displayedText,
					targetLanguage: active.targetLanguage,
					translator: { provider: active.translator.model.provider, model: active.translator.model.id },
					usage: run.usage,
				});
				this.persisted.set(entry.sourceHash, entry);
				try {
					this.options.appendEntry?.(REASONING_TRANSLATION_ENTRY_TYPE, entry);
				} catch {
					// Persistence is additive and must not affect the completed response.
				}
			}
			});
	}

	abortActive(): void {
		const active = this.active;
		if (!active) return;
		for (const run of active.runs.values()) {
			if (run.idleTimer !== undefined) this.options.clearTimeout(run.idleTimer);
		}
		active.abortController.abort();
		this.generation++;
		this.active = undefined;
	}

	private updateRunSource(active: ActiveTranslation, projection: ThinkingRunProjection): void {
		let run = active.runs.get(projection.runKey);
		if (!run) {
			run = {
				runKey: projection.runKey,
				sourceMarkdown: "",
				pendingSource: "",
				displayedText: "",
				flushRequested: false,
			};
			active.runs.set(projection.runKey, run);
		}

		if (projection.sourceMarkdown === run.sourceMarkdown) return;
		const previous = run.sourceMarkdown;
		const suffix = projection.sourceMarkdown.startsWith(previous)
			? projection.sourceMarkdown.slice(previous.length)
			: projection.sourceMarkdown.slice(commonPrefixLength(previous, projection.sourceMarkdown));
		run.sourceMarkdown = projection.sourceMarkdown;
		if (suffix.length > 0) run.pendingSource += suffix;
		this.scheduleIdleFlush(active, run);
		if (active.translatorReady) this.enqueuePending(active, run, false);
	}

	private scheduleIdleFlush(active: ActiveTranslation, run: ThinkingRunState): void {
		if (run.idleTimer !== undefined) this.options.clearTimeout(run.idleTimer);
		const generation = active.generation;
		run.idleTimer = this.options.setTimeout(() => {
			if (this.active?.generation !== generation) return;
			this.enqueuePending(active, run, true);
		}, IDLE_FLUSH_MS);
	}

	private enqueuePending(active: ActiveTranslation, run: ThinkingRunState, flush: boolean): void {
		if (flush) run.flushRequested = true;
		if (!active.translatorReady || !active.translator) return;

		const shouldFlush = run.flushRequested;
		const segmented = shouldFlush
			? flushThinkingSource(run.pendingSource)
			: segmentThinkingSource(run.pendingSource);
		run.pendingSource = segmented.remainder;
		if (shouldFlush && run.pendingSource.length === 0) run.flushRequested = false;
		for (const segment of segmented.segments) {
			const generation = active.generation;
			active.queue = active.queue
				.then(async () => {
					if (this.active?.generation !== generation || active.abortController.signal.aborted) return;
					const result = await this.options.translateSegment!({
						translator: active.translator!,
						targetLanguage: active.targetLanguage,
						sourceSegment: segment,
						signal: active.abortController.signal,
					});
					this.publishSegment(active, run, segment, result);
				})
				.catch(() => {
					if (this.active?.generation === generation && !active.abortController.signal.aborted) {
						this.publishSegment(active, run, segment, { ok: false, reason: "request-failed" });
					}
				});
		}
		if (shouldFlush && run.idleTimer !== undefined) {
			this.options.clearTimeout(run.idleTimer);
			run.idleTimer = undefined;
		}
	}

	private publishSegment(
		active: ActiveTranslation,
		run: ThinkingRunState,
		sourceSegment: string,
		result: TranslateSegmentResult,
	): void {
		if (this.active?.generation !== active.generation) return;
		if (result.ok) {
			run.displayedText += preserveSourceWhitespace(sourceSegment, result.text);
			run.usage = addUsage(run.usage, result.usage);
		} else {
			// A stale result is filtered by the generation check above. Any failure
			// that reaches this method is therefore a per-segment fallback, including
			// a provider-reported abort that did not abort this active session.
			run.displayedText += sourceSegment;
		}
		this.options.onDisplayChanged?.();
	}
}

function commonPrefixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index++;
	return index;
}

export function isReasoningTranslationEligible(
	ctx: ExtensionContext,
	config: ReasoningTranslationConfig,
): boolean {
	return isEligible(ctx, config);
}
