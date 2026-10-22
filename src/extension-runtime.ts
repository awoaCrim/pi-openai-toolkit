import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	BeforeProviderRequestEvent,
	ContextWithSystemEvent,
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { assertConfigValid, loadToolkitConfig, resolveToolkitConfig, type ResolvedToolkitConfig } from "./config";
import { notifyConfigIssues } from "./config/notifications";
import { registerToolkitConfigCommand } from "./config-command";
import { writeDebugArtifact, writeReplayFailureArtifact } from "./debug";
import {
	COMPACTION_CHECKPOINT_PROVENANCE_UNAVAILABLE,
	COMPACTION_CHECKPOINT_CONTEXT_EDITED,
	COMPACTION_PROJECTION_UNAVAILABLE,
	COMPACTION_SESSION_CONTEXT_UNAVAILABLE,
	COMPACTION_PROJECTED_CONTEXT_UNAVAILABLE,
	hasVerifiedCompactionInputProvenance,
	type UnprojectedCompactionReason,
} from "./compaction-projection";
import { buildResponsesRequestHeaders, CODEX_GATEWAY_FORWARD_HEADERS } from "./responses-headers";
import { isExactModelAllowed } from "./model-scope";
import { detectRetiredRemoteWindows, RETIRED_REMOTE_WINDOWS_MESSAGE } from "./retired-remote-windows";
import { executeNativeCompaction, type NativeCompactionClientResult } from "./compact-client";
import { qualifiesForStandaloneCompaction, type CompactionErrorInfo } from "./compaction-errors";
import { resolveLatestNativeCompactionEntry } from "./details-store";
import {
	getPiContextHookProjector,
	installPiContextHookPatch,
	reportPiContextHookFailure,
	type PiContextHookPatchResult,
} from "./pi-context-hook";
import { runNativeFallbackCompaction } from "./native-fallback";
import {
	rewriteResponsesPayloadWithNativeReplay,
	hasInvalidatedCompactionContext,
	removeNativeCompactionRetainedMessages,
	serializeLiveTailToResponsesInputWithLimits,
} from "./payload-rewrite";
import { getCompactionRequestExtras, rememberRequestContext } from "./request-context-cache";
import { resolveWebSearchRoute } from "./web-search/types";
import { executeRemoteV2Compaction } from "./remote-v2-client";
import {
	registerPhysicalModelObserver,
	resolveNativeCompactionEnvironment,
	resolveRemoteCompactionExecution,
	isStandaloneCompactionEligible,
	parseModelSpec,
	type RemoteCompactionExecution,
} from "./runtime";
import {
	serializeMessagesToCompactRequestWithLimits,
	serializeMessagesToResponsesInputWithLimits,
	type NativeCompactionRequestBody,
	type ResponsesInputItem,
} from "./serializer";
import {
	createNativeCompactionDetails,
	createNativeCompactionResult,
	COMPACTION_EXTENSION_ID,
	LEGACY_NATIVE_COMPACTION_STRATEGY,
	REMOTE_V2_COMPACTION_STRATEGY,
	getLatestDeferredToolCarryover,
	getRemoteV2InputProvenance,
	isNativeCompactionDetails,
	type CompactionConfig,
	type NativeCompactionDetails,
	type NativeCompactionRequestMeta,
} from "./types";

type CompactionContextProjection = (
	messages: readonly AgentMessage[],
	ctx: ExtensionContext,
) => readonly AgentMessage[] | undefined | Promise<readonly AgentMessage[] | undefined>;

function contextOperation(loadConfig: typeof loadToolkitConfig, ctx: ExtensionContext, model = ctx.model): ResolvedToolkitConfig {
	const loaded = loadConfig();
	const resolved = resolveToolkitConfig(loaded, model);
	notifyConfigIssues(ctx, resolved);
	return resolved;
}

function requireContextPolicy(resolved: ResolvedToolkitConfig, ctx: ExtensionContext): void {
	try {
		assertConfigValid(resolved, "context", "compatibility", "diagnostics");
	} catch (error) {
		if (typeof ctx.abort === "function") ctx.abort();
		throw error;
	}
}

type CompactionDependencies = {
	loadConfig: typeof loadToolkitConfig;
	remoteCompact: typeof executeRemoteV2Compaction;
	standaloneCompact: typeof executeNativeCompaction;
	nativeFallback: typeof runNativeFallbackCompaction;
	/** Revalidate operation ownership after awaits and at result consumption. */
	isCurrentCompaction?: () => boolean;
	/** Test seam for the same ordered projection exposed by the Pi host patch. */
	projectCompactionContext?: CompactionContextProjection;
	piContextHookPatch: PiContextHookPatchResult;
};

// Notices are bounded, but every boundary freshly reads the current branch.
const retirementNotices = new WeakMap<object, string>();
function retirementReason(ctx: ExtensionContext): string | undefined {
	try { return detectRetiredRemoteWindows(ctx.sessionManager.getBranch()); }
	catch { return "branch-unavailable"; }
}

function refuseRetiredSession(ctx: ExtensionContext, request = false): boolean {
	const reason = retirementReason(ctx);
	const owner = ctx.sessionManager;
	if (!reason) {
		retirementNotices.delete(owner);
		return false;
	}
	const fingerprint = `${getSessionId(ctx) ?? ""}:${reason}`;
	if (ctx.hasUI && retirementNotices.get(owner) !== fingerprint) {
		retirementNotices.set(owner, fingerprint);
		try {
			ctx.ui.notify(
				reason === "branch-unavailable"
					? `${COMPACTION_EXTENSION_ID}: Cannot verify the active session branch; request blocked. Reopen the session before continuing.`
					: `${COMPACTION_EXTENSION_ID}: ${RETIRED_REMOTE_WINDOWS_MESSAGE}`,
				"error",
			);
		} catch {
			// A detached UI must not prevent abort or turn compact refusal into fallback.
		}
	}
	if (request) {
		reportPiContextHookFailure(ctx, `retired-remote-windows:${reason}`);
		ctx.abort();
	}
	return true;
}

type ResponsesCompactOutcome =
	| { outcome: "success"; compaction: CompactionResult<NativeCompactionDetails> }
	| { outcome: "aborted" }
	| { outcome: "failed"; remoteFailure?: CompactionErrorInfo & { reason: string; status?: number }; protocol?: string }
	| {
			outcome: "unprojected-input";
			reason: UnprojectedCompactionReason;
	  };

function buildCompactionRequestMeta(event: SessionBeforeCompactEvent): NativeCompactionRequestMeta {
	return {
		tokensBefore: event.preparation.tokensBefore,
		previousSummaryPresent: Boolean(event.preparation.previousSummary),
	};
}

function getCurrentModelDebugInfo(ctx: ExtensionContext) {
	return ctx.model
		? {
			provider: ctx.model.provider,
			id: ctx.model.id,
		}
		: undefined;
}

function getCompactionIdentityDebugInfo(entry: { details?: unknown } | undefined) {
	return isNativeCompactionDetails(entry?.details)
		? {
			provider: entry.details.provider,
			api: entry.details.api,
			model: entry.details.model,
			baseUrl: entry.details.baseUrl,
			compactionModel: entry.details.compactionModel,
		}
		: undefined;
}

function getSessionId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

function notifyWarning(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(`${COMPACTION_EXTENSION_ID}: ${message}`, "warning");
	}
}

function cloneOpaqueWindow(window: readonly unknown[]): unknown[] {
	return window.map((item) => structuredClone(item));
}

function buildCompactionInstructions(systemPrompt: string, customInstructions?: string): string {
	const guidance = customInstructions?.trim();
	if (!guidance) {
		return systemPrompt;
	}

	return `${systemPrompt}\n\nAdditional user guidance for this manual /compact request:\n${guidance}`;
}

function findLatestProjectedCompactionSummaryIndex(
	messages: readonly AgentMessage[],
	summary: string,
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "compactionSummary" && message.summary === summary) {
			return index;
		}
	}

	return -1;
}

function readSessionContextMessages(ctx: ExtensionContext): AgentMessage[] | undefined {
	try {
		const projection = ctx.sessionManager.buildSessionProjection();
		if (!projection || !Array.isArray(projection.messages)) return undefined;
		return structuredClone(projection.messages);
	} catch {
		return undefined;
	}
}

type CompactionProjectionResult =
	| { ok: true; messages: readonly AgentMessage[] }
	| { ok: false; reason: typeof COMPACTION_PROJECTION_UNAVAILABLE | typeof COMPACTION_SESSION_CONTEXT_UNAVAILABLE };

async function projectSessionContextForCompaction(
	ctx: ExtensionContext,
	projectCompactionContext: CompactionContextProjection | undefined,
): Promise<CompactionProjectionResult> {
	const messages = readSessionContextMessages(ctx);
	if (!messages) {
		return { ok: false, reason: COMPACTION_SESSION_CONTEXT_UNAVAILABLE };
	}

	const projector = projectCompactionContext ?? getPiContextHookProjector(ctx);
	if (!projector) {
		return { ok: false, reason: COMPACTION_PROJECTION_UNAVAILABLE };
	}

	try {
		const projected = await projector(messages, ctx);
		return Array.isArray(projected)
			? { ok: true, messages: projected }
			: { ok: false, reason: COMPACTION_PROJECTION_UNAVAILABLE };
	} catch {
		return { ok: false, reason: COMPACTION_PROJECTION_UNAVAILABLE };
	}
}

function getLegacySessionContextMessages(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): AgentMessage[] {
	return readSessionContextMessages(ctx) ?? [
		...event.preparation.messagesToSummarize,
		...event.preparation.turnPrefixMessages,
	];
}

async function runResponsesNativeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: CompactionConfig,
	execution: RemoteCompactionExecution,
	remoteCompact: typeof executeRemoteV2Compaction,
	projectCompactionContext: CompactionContextProjection | undefined,
	standaloneCompact: typeof executeNativeCompaction,
	isCurrent: () => boolean,
): Promise<ResponsesCompactOutcome> {
	const { consumer, compactor } = execution;
	const instructions = buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions);
	const branchEntries = event.branchEntries ?? ctx.sessionManager.getBranch();
	const deferredToolCarryover = getLatestDeferredToolCarryover(branchEntries);
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		baseUrl: consumer.baseUrl,
	});

	const inputProvenance = getRemoteV2InputProvenance(config.remoteV2ContextSource);
	let requestSource: "session-context" | "non-native-session-context" | "latest-native-replay";
	let request: NativeCompactionRequestBody;
	if (latestNativeCompaction.ok) {
		if (hasInvalidatedCompactionContext(branchEntries, latestNativeCompaction.entry.id)) {
			return { outcome: "unprojected-input", reason: COMPACTION_CHECKPOINT_CONTEXT_EDITED };
		}
		const details = latestNativeCompaction.entry.details;
		if (!details) {
			return { outcome: "failed" };
		}
		if (!hasVerifiedCompactionInputProvenance(details, inputProvenance)) {
			return {
				outcome: "unprojected-input",
				reason: COMPACTION_CHECKPOINT_PROVENANCE_UNAVAILABLE,
			};
		}
		requestSource = "latest-native-replay";

		if (config.remoteV2ContextSource === "pi-context-hook") {
			const projection = await projectSessionContextForCompaction(ctx, projectCompactionContext);
			if (!projection.ok) {
				return { outcome: "unprojected-input", reason: projection.reason };
			}
			const summaryIndex = findLatestProjectedCompactionSummaryIndex(
				projection.messages,
				latestNativeCompaction.entry.summary,
			);
			if (summaryIndex < 0) {
				return {
					outcome: "unprojected-input",
					reason: COMPACTION_PROJECTED_CONTEXT_UNAVAILABLE,
				};
			}
			const input: ResponsesInputItem[] = [
				...(cloneOpaqueWindow(details.compactedWindow) as ResponsesInputItem[]),
				...(await serializeMessagesToResponsesInputWithLimits(
					compactor.currentModel,
					[...projection.messages.slice(summaryIndex + 1)],
					{ firstSystemMessageIsUpdate: true },
				)),
			];
			request = {
				model: compactor.requestModel ?? compactor.model,
				input,
				instructions,
			};
		} else {
			const liveTailEntries = branchEntries.slice(latestNativeCompaction.index + 1);
			const input: ResponsesInputItem[] = [
				...(cloneOpaqueWindow(details.compactedWindow) as ResponsesInputItem[]),
				...(await serializeLiveTailToResponsesInputWithLimits({ model: compactor.currentModel, entries: liveTailEntries })),
			];
			request = {
				model: compactor.requestModel ?? compactor.model,
				input,
				instructions,
			};
		}
	} else if (
		latestNativeCompaction.reason === "no-compaction" ||
		(latestNativeCompaction.reason === "latest-compaction-not-native" &&
			config.allowCompactionContinuityBreak)
	) {
		requestSource =
			latestNativeCompaction.reason === "no-compaction" ? "session-context" : "non-native-session-context";
		if (config.remoteV2ContextSource === "pi-context-hook") {
			const projection = await projectSessionContextForCompaction(ctx, projectCompactionContext);
			if (!projection.ok) {
				return { outcome: "unprojected-input", reason: projection.reason };
			}
			const serialized = await serializeMessagesToCompactRequestWithLimits({
				model: compactor.currentModel,
				messages: [...projection.messages],
				instructions,
			});
			request = { ...serialized, model: compactor.requestModel ?? serialized.model };
		} else {
			const serialized = await serializeMessagesToCompactRequestWithLimits({
				model: compactor.currentModel,
				messages: getLegacySessionContextMessages(event, ctx),
				instructions,
			});
			request = { ...serialized, model: compactor.requestModel ?? serialized.model };
		}
	} else {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.remote-v2-skip",
				reason: latestNativeCompaction.reason,
				consumer: {
					provider: consumer.provider,
					api: consumer.api,
					model: consumer.model,
					baseUrl: consumer.baseUrl,
				},
				compactor: {
					provider: compactor.provider,
					api: compactor.api,
					model: compactor.model,
					baseUrl: compactor.baseUrl,
				},
				latestCompactionIndex: latestNativeCompaction.latestCompactionIndex,
				latestCompactionIdentity: getCompactionIdentityDebugInfo(latestNativeCompaction.latestCompaction),
			},
			config,
			ctx,
		);
		return { outcome: "failed" };
	}

	// Mirror the latest codex_rs CompactionInput fields captured from the most
	// recent live provider request for this model (tools, reasoning, etc.).
	const extras = getCompactionRequestExtras({
		provider: consumer.provider,
		api: consumer.api,
		model: consumer.requestModel ?? consumer.model,
		baseUrl: consumer.baseUrl,
		sessionId: getSessionId(ctx),
	}, compactor.currentModel);
	if (extras) {
		request = { ...request, ...extras };
	}

	if (event.signal?.aborted || !isCurrent() || refuseRetiredSession(ctx)) return { outcome: "aborted" };
	let protocol: "remote-v2" | "standalone-compact" = "remote-v2";
	let compactResult: Awaited<ReturnType<typeof executeRemoteV2Compaction>> | NativeCompactionClientResult = await remoteCompact({
		runtime: compactor,
		request,
		signal: event.signal,
		settings: config,
		context: ctx,
	});

	if (!isCurrent() || refuseRetiredSession(ctx)) return { outcome: "aborted" };
	if (!compactResult.ok) {
		if (compactResult.reason === "aborted" || event.signal?.aborted) return { outcome: "aborted" };
		const tryStandalone = !!standaloneCompact && isStandaloneCompactionEligible(compactor) && qualifiesForStandaloneCompaction(compactResult);
		writeDebugArtifact("compaction-event", {
			event: "session_before_compact.remote-v2-failure",
			protocol,
			reason: compactResult.reason,
			status: compactResult.status,
			errorCode: compactResult.errorCode,
			errorType: compactResult.errorType,
			errorParam: compactResult.errorParam,
			errorMessage: compactResult.errorMessage,
			nextStep: tryStandalone ? "standalone-compact" : "native-summary",
		}, config, ctx);
		if (tryStandalone && standaloneCompact) {
			if (event.signal?.aborted || !isCurrent() || refuseRetiredSession(ctx)) return { outcome: "aborted" };
			protocol = "standalone-compact";
			compactResult = await standaloneCompact({ runtime: compactor, request, signal: event.signal, settings: config, context: ctx });
		}
		if (!compactResult.ok) {
			if (compactResult.reason === "aborted" || event.signal?.aborted) return { outcome: "aborted" };
			const remoteFailure = {
				reason: compactResult.reason,
				status: compactResult.status,
				errorCode: compactResult.errorCode,
				errorType: compactResult.errorType,
				errorParam: compactResult.errorParam,
				errorMessage: compactResult.errorMessage,
			};
			if (protocol === "standalone-compact") writeDebugArtifact("compaction-event", {
				event: "session_before_compact.standalone-compact-failure", protocol, ...remoteFailure, nextStep: "native-summary",
			}, config, ctx);
			return { outcome: "failed", remoteFailure, protocol };
		}
	}

	let details: NativeCompactionDetails;
	try {
		details = createNativeCompactionDetails({
			strategy: protocol === "standalone-compact" ? LEGACY_NATIVE_COMPACTION_STRATEGY : REMOTE_V2_COMPACTION_STRATEGY,
			provider: consumer.provider,
			api: consumer.api,
			model: consumer.model,
			baseUrl: consumer.baseUrl,
			compactionModel: {
				provider: compactor.provider,
				api: compactor.api,
				model: compactor.model,
				baseUrl: compactor.baseUrl,
			},
			deferredToolCarryover,
			compactedWindow: compactResult.compactedWindow,
			compactResponseId: compactResult.compactResponseId,
			createdAt: compactResult.createdAt,
			requestMeta: buildCompactionRequestMeta(event),
			inputProvenance,
		});
	} catch (error) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.invalid-native-details",
				reason: error instanceof Error ? error.message : String(error),
				consumer: {
					provider: consumer.provider,
					api: consumer.api,
					model: consumer.model,
					baseUrl: consumer.baseUrl,
				},
				compactor: {
					provider: compactor.provider,
					api: compactor.api,
					model: compactor.model,
					baseUrl: compactor.baseUrl,
				},
			},
			config,
			ctx,
		);
		return { outcome: "failed", remoteFailure: { reason: "invalid-native-details" }, protocol };
	}

	const compaction = createNativeCompactionResult({
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details,
	});

	writeDebugArtifact(
		"compaction-event",
		{
			event: `session_before_compact.${protocol}-success`,
			protocol,
			consumer: {
				provider: consumer.provider,
				api: consumer.api,
				model: consumer.model,
				baseUrl: consumer.baseUrl,
			},
			compactor: {
				provider: compactor.provider,
				api: compactor.api,
				model: compactor.model,
				baseUrl: compactor.baseUrl,
			},
			requestSource,
			remoteV2ContextSource: config.remoteV2ContextSource,
			inputProvenance,
			requestInputItems: request.input.length,
			requestExtras: extras ? Object.keys(extras) : [],
			compactResponseId: compactResult.compactResponseId,
			compactedItems: compactResult.compactedWindow.length,
			firstKeptEntryId: compaction.firstKeptEntryId,
		},
		config,
		ctx,
	);

	if (!isCurrent() || refuseRetiredSession(ctx)) return { outcome: "aborted" };
	return { outcome: "success", compaction };
}

async function handleSessionBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	dependencies: CompactionDependencies,
) {
	if (refuseRetiredSession(ctx)) return { cancel: true };
	const resolved = contextOperation(dependencies.loadConfig, ctx);
	if (resolved.invalidFeatures.some((feature) => ["context", "compatibility", "diagnostics"].includes(feature))) return { cancel: true };
	const config = resolved.config.compaction;
	if (config.enabled) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact",
				customInstructions: event.customInstructions,
				preparation: {
					tokensBefore: event.preparation.tokensBefore,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					previousSummaryPresent: Boolean(event.preparation.previousSummary),
					messagesToSummarizeCount: event.preparation.messagesToSummarize.length,
					turnPrefixMessagesCount: event.preparation.turnPrefixMessages.length,
				},
			},
			config,
			ctx,
		);
	}

	if (event.signal.aborted) {
		return { cancel: true };
	}

	const isCurrent = dependencies.isCurrentCompaction ?? (() => true);
	if (!isCurrent()) return { cancel: true };
	if (!config.enabled || resolved.policy.context.mode !== "remote-compaction") return undefined;

	// Resolve producer protocol policy from this operation's document, not a later disk read.
	if (resolved.format === "v2" && config.remoteCompactModel) {
		const producer = parseModelSpec(config.remoteCompactModel);
		if (producer) {
			const producerPolicy = resolveToolkitConfig(resolved.snapshot, { provider: producer.provider, id: producer.modelId });
			notifyConfigIssues(ctx, producerPolicy);
			if (producerPolicy.invalidFeatures.includes("compatibility")) return { cancel: true };
		}
	}
	// Branch 1: Responses-family APIs use remote_compaction_v2 on the normal Responses stream.
	let remoteAttempted = false;
	const resolution = await resolveRemoteCompactionExecution(
		ctx,
		{
			enabled: config.enabled,
			responsesApis: config.responsesApis,
			codexGatewayModels: resolved.gatewayModelKeys,
		},
		config.remoteCompactModel,
	);
	if (!isCurrent() || event.signal.aborted || refuseRetiredSession(ctx)) return { cancel: true };
	if (resolution.ok) {
		remoteAttempted = true;
		const responsesOutcome = await runResponsesNativeCompact(
			event,
			ctx,
			config,
			resolution.execution,
			dependencies.remoteCompact,
			dependencies.projectCompactionContext,
			dependencies.standaloneCompact,
			isCurrent,
		);
		if (!isCurrent() || refuseRetiredSession(ctx)) return { cancel: true };
		if (responsesOutcome.outcome === "success") {
			return { compaction: responsesOutcome.compaction };
		}
		if (responsesOutcome.outcome === "aborted") {
			return { cancel: true };
		}
		if (responsesOutcome.outcome === "unprojected-input") {
			const message = responsesOutcome.reason === COMPACTION_CHECKPOINT_CONTEXT_EDITED
				? "A context edit changed history sealed in the opaque checkpoint. Start a new session or navigate before that checkpoint; its encrypted content cannot be selectively rewritten."
				: responsesOutcome.reason === COMPACTION_PROJECTION_UNAVAILABLE
				? "Pi's ordered context-hook projection is unavailable; Remote V2 was not sent raw session history."
				: responsesOutcome.reason === COMPACTION_SESSION_CONTEXT_UNAVAILABLE
					? "Pi did not provide the current session context required by its context-hook projection."
					: responsesOutcome.reason === COMPACTION_PROJECTED_CONTEXT_UNAVAILABLE
						? "Pi's projected context did not include the current compaction summary anchor."
						: "The latest opaque checkpoint has no marker for the configured Remote V2 context source, or was created in the other mode.";
			writeDebugArtifact(
				"compaction-event",
				{
					event: "session_before_compact.remote-v2-unprojected-input",
					reason: responsesOutcome.reason,
					contextSource: config.remoteV2ContextSource,
					inputProvenance: getRemoteV2InputProvenance(config.remoteV2ContextSource),
					piContextHookPatch: dependencies.piContextHookPatch,
					message,
				},
				config,
				ctx,
			);
			notifyWarning(
				ctx,
				`Remote V2 compaction cancelled (${responsesOutcome.reason}); ${message} The existing checkpoint and session history were left unchanged.`,
			);
			return { cancel: true };
		}
		// Only an actual exhausted remote attempt warns, never an input/routing skip.
		if (event.signal?.aborted) return { cancel: true };
		if (responsesOutcome.remoteFailure) {
			const failure = responsesOutcome.remoteFailure;
			writeDebugArtifact("compaction-event", {
				event: "session_before_compact.remote-to-native-summary",
				protocol: responsesOutcome.protocol,
				...failure,
				nextStep: "native-summary",
			}, config, ctx);
			notifyWarning(ctx, `Remote compaction failed (${failure.reason}${failure.status ? `, HTTP ${failure.status}` : ""}${failure.errorCode ? `, ${failure.errorCode}` : ""}); continuing with a native text summary. No encrypted remote checkpoint was produced.${failure.errorMessage ? ` ${failure.errorMessage}` : ""}`);
		}
	} else {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.remote-v2-unavailable",
				reason: resolution.reason,
				provider: resolution.provider,
				api: resolution.api,
				model: resolution.model,
				baseUrl: resolution.baseUrl,
				modelSpec: resolution.modelSpec,
				errorMessage: resolution.errorMessage,
			},
			config,
			ctx,
		);
		const expectedConsumerCapabilityMiss =
			resolution.reason === "unsupported-api" && resolution.modelSpec === undefined;
		if (config.remoteCompactModel && !expectedConsumerCapabilityMiss) {
			notifyWarning(
				ctx,
				`remote compaction model "${config.remoteCompactModel}" unusable (${resolution.reason}); using the native fallback chain`,
			);
		}
	}

	// Branch 2: run pi's native compaction method. A failed remote request is compacted by the
	// remote producer itself; a model that cannot use remote v2 at all uses nativeFallback.model.
	const fallbackModelSpec = remoteAttempted ? config.remoteCompactModel : config.nativeFallback.model;
	if (!isCurrent() || event.signal.aborted || refuseRetiredSession(ctx)) return { cancel: true };
	const fallback = await dependencies.nativeFallback({ ctx, event, config, modelSpec: fallbackModelSpec, isCurrent });
	if (!isCurrent() || refuseRetiredSession(ctx)) return { cancel: true };
	if (fallback.ok) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`${COMPACTION_EXTENSION_ID}: compacted with ${fallback.model.provider}/${fallback.model.id} (native method)`,
				"info",
			);
		}
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.fallback-success",
				model: fallback.model,
			},
			config,
			ctx,
		);
		return { compaction: fallback.result };
	}

	if (fallback.reason === "aborted") {
		return { cancel: true };
	}

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact.fallback-skip",
			reason: fallback.reason,
			modelSpec: fallback.modelSpec,
			errorMessage: fallback.errorMessage,
		},
		config,
		ctx,
	);

	// Intentional pi-default paths: feature disabled, nothing configured, or it matches the current one.
	const intentionalSkip =
		fallback.reason === "disabled" ||
		fallback.reason === "no-model-configured" ||
		fallback.reason === "same-as-current-model";
	if (!intentionalSkip) {
		// An explicit summary model is authoritative: the active model may be
		// unable to summarize at all. Preserve context on failure, never reroute.
		notifyWarning(
			ctx,
			`compaction model "${fallback.modelSpec ?? fallbackModelSpec}" failed (${fallback.reason}${fallback.errorMessage ? `: ${fallback.errorMessage}` : ""}); compaction cancelled, context preserved; not switching to the current model`,
		);
		return { cancel: true };
	}

	return undefined;
}

async function handleContextInternal(
	event: ContextWithSystemEvent,
	ctx: ExtensionContext,
	loadConfig: typeof loadToolkitConfig,
) {
	if (refuseRetiredSession(ctx, true)) return undefined;
	const resolved = contextOperation(loadConfig, ctx);
	requireContextPolicy(resolved, ctx);
	const config = resolved.config.compaction;
	if (!config.enabled) return undefined;
	const branchEntries = ctx.sessionManager.getBranch();
	const resolution = await resolveNativeCompactionEnvironment(ctx, {
		enabled: config.enabled,
		responsesApis: config.responsesApis,
		codexGatewayModels: resolved.gatewayModelKeys,
	});
	if (refuseRetiredSession(ctx, true)) return undefined;
	if (!resolution.ok) return undefined;
	const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: resolution.runtime.baseUrl });
	if (!latest.ok) return undefined;
	const result = removeNativeCompactionRetainedMessages({
		messages: event.messages,
		branchEntries,
		compactionEntry: latest.entry,
		expectedInputProvenance: getRemoteV2InputProvenance(config.remoteV2ContextSource),
	});
	if (!result.ok) {
		writeReplayFailureArtifact({ reason: result.reason, compactionEntryId: latest.entry.id }, config, ctx);
		if (ctx.hasUI) ctx.ui.notify(`${COMPACTION_EXTENSION_ID}: replay failed (${result.reason}); request aborted`, "error");
		reportPiContextHookFailure(ctx, `replay-failed:${result.reason}`);
		ctx.abort();
		return undefined;
	}
	return result.messages.length === event.messages.length && result.messages.every((message, index) => message === event.messages[index])
		? undefined : { messages: result.messages };
}

/**
 * Pi's emitContext() catches handler exceptions. Re-throw as usual for Pi, but
 * also report the failure so the compaction projector cannot mistake the
 * caught exception for a successful projection.
 */
async function handleContext(
	event: ContextWithSystemEvent,
	ctx: ExtensionContext,
	loadConfig: typeof loadToolkitConfig,
) {
	try {
		return await handleContextInternal(event, ctx, loadConfig);
	} catch (error) {
		reportPiContextHookFailure(ctx, error instanceof Error ? error.message : String(error));
		throw error;
	}
}

async function handleBeforeProviderRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
	loadConfig: typeof loadToolkitConfig,
) {
	if (refuseRetiredSession(ctx, true)) return undefined;
	const resolved = contextOperation(loadConfig, ctx);
	requireContextPolicy(resolved, ctx);
	const toolkitConfig = resolved.config;
	const config = toolkitConfig.compaction;
	if (!config.enabled) return undefined;
	const resolution = await resolveNativeCompactionEnvironment(ctx, {
		enabled: config.enabled,
		responsesApis: config.responsesApis,
		codexGatewayModels: resolved.gatewayModelKeys,
	}, event.payload);
	if (refuseRetiredSession(ctx, true)) return undefined;
	const branchEntries = ctx.sessionManager.getBranch();
	if (resolution.ok === false) {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.skip",
				reason: resolution.reason,
				provider: resolution.provider,
				api: resolution.api,
				model: resolution.model,
				baseUrl: resolution.baseUrl,
				errorMessage: resolution.errorMessage,
				currentModel: getCurrentModelDebugInfo(ctx),
				payload: event.payload,
			},
			config,
			ctx,
		);
		return undefined;
	}

	const runtime = resolution.runtime;
	const payload = runtime.payload;
	if (!payload) {
		return undefined;
	}

	// Capture compact-relevant request fields (tools, reasoning, ...) for the next
	// synthetic compact request using the active consumer's effective runtime identity.
	// This hook runs before the separate Web Search transform, so injected native search
	// tools are not copied into remote_compaction_v2.
	const webSearchRoute = resolveWebSearchRoute({ model: ctx.model, config: toolkitConfig.webSearch });
	rememberRequestContext(
		payload,
		{
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.requestModel ?? runtime.model,
			baseUrl: runtime.baseUrl,
			sessionId: getSessionId(ctx),
		},
		{
			excludeWebSearchTools: webSearchRoute.route === "standalone-alpha",
		},
	);

	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		baseUrl: runtime.baseUrl,
	});
	if (!latestNativeCompaction.ok) {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.no-native-compaction",
				reason: latestNativeCompaction.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				branchEntries: branchEntries.length,
				latestCompactionIndex: latestNativeCompaction.latestCompactionIndex,
				latestCompactionIdentity: getCompactionIdentityDebugInfo(latestNativeCompaction.latestCompaction),
				payload,
			},
			config,
			ctx,
		);
		return undefined;
	}

	const latestNativeCompactionEntry = latestNativeCompaction.entry;
	const rewrite = rewriteResponsesPayloadWithNativeReplay({
		model: runtime.currentModel,
		payload,
		branchEntries,
		compactionEntry: latestNativeCompactionEntry,
		expectedInputProvenance: getRemoteV2InputProvenance(config.remoteV2ContextSource),
	});
	if (!rewrite.ok) {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.rewrite-failed",
				reason: rewrite.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				compactionEntryId: latestNativeCompactionEntry.id,
				parity: rewrite.parity,
				payload,
			},
			config,
			ctx,
		);

		// Fail loud instead of letting Pi send the sentinel-only payload: the
		// compacted history would be silently lost while the request still succeeds.
		// A forced redacted failure record is written even when logProviderPayloads
		// is disabled so the incident is diagnosable without leaking content.
		writeReplayFailureArtifact(
			{
				reason: rewrite.reason,
				parity: rewrite.parity,
				compactionEntryId: latestNativeCompactionEntry.id,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
			},
			config,
			ctx,
		);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`${COMPACTION_EXTENSION_ID}: native compaction replay failed (${rewrite.reason}); provider request aborted`,
				"error",
			);
		}
		ctx.abort();
		return undefined;
	}

	writeDebugArtifact(
		"provider-request",
		{
			event: "before_provider_request.native-rewrite",
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			baseUrl: runtime.baseUrl,
			compactionEntryId: latestNativeCompactionEntry.id,
			boundaryIndex: rewrite.segments.boundaryIndex,
			firstKeptEntryIndex: rewrite.segments.firstKeptEntryIndex,
			originalInputItems: payload.input.length,
			rewrittenInputItems: rewrite.rewrittenPayload.input.length,
			leadingItems: rewrite.segments.leading.length,
			compactionSummaryItems: rewrite.segments.compactionSummary.length,
			compactedItems: rewrite.segments.compactedWindow.length,
			postItems: rewrite.segments.post.length,
			payload: rewrite.rewrittenPayload,
			originalPayload: payload,
		},
		config,
		ctx,
	);

	return rewrite.rewrittenPayload;
}

export default function registerCompactionExtension(
	pi: ExtensionAPI,
	overrides: Partial<CompactionDependencies> = {},
) {
	const loadConfig = overrides.loadConfig ?? loadToolkitConfig;
	registerToolkitConfigCommand(pi, loadConfig);
	registerPhysicalModelObserver(pi);
	const piContextHookPatch = installPiContextHookPatch();
	let compactionGeneration = 0;
	const invalidateCompaction = () => { compactionGeneration++; };
	const dependencies: CompactionDependencies = {
		remoteCompact: executeRemoteV2Compaction,
		standaloneCompact: executeNativeCompaction,
		nativeFallback: runNativeFallbackCompaction,
		...overrides,
		loadConfig,
		piContextHookPatch: overrides.piContextHookPatch ?? piContextHookPatch,
	};
	pi.on("session_start", (_event, ctx) => {
		invalidateCompaction();
		if (refuseRetiredSession(ctx)) return;
		const resolved = contextOperation(loadConfig, ctx);
		const config = resolved.config.compaction;
		if (resolved.invalidFeatures.length || !config.enabled) return;
		const artifactPath = writeDebugArtifact("lifecycle", {
			event: "session_start", config, configSource: resolved.source,
			warnings: resolved.issues.map((issue) => `${issue.path}: ${issue.code}`),
			piContextHookPatch: dependencies.piContextHookPatch,
		}, config, ctx);
		if (ctx.hasUI && ["info", "debug"].includes(resolved.policy.diagnostics.level) && (config.notifyOnLoad || config.debug)) {
			ctx.ui.notify(artifactPath ? `${COMPACTION_EXTENSION_ID} loaded • debug artifacts → ${artifactPath}` : `${COMPACTION_EXTENSION_ID} loaded`, "info");
		}
	});
	pi.on("session_tree", (_event, ctx) => {
		invalidateCompaction();
		refuseRetiredSession(ctx);
	});
	pi.on("context_with_system", (event, ctx) => handleContext(event, ctx, loadConfig));
	pi.on("before_provider_request", (event, ctx) => handleBeforeProviderRequest(event, ctx, loadConfig));
	pi.on("session_before_compact", async (event, ctx) => {
		invalidateCompaction();
		if (refuseRetiredSession(ctx)) return { cancel: true };
		try {
			const generation = compactionGeneration;
			const branch = structuredClone(ctx.sessionManager.getBranch());
			const sessionId = getSessionId(ctx);
			const model = ctx.model ? { ...ctx.model } : undefined;
			const thinking = ctx.thinkingLevel;
			// Clients classify aborts. This fence handles stale ownership: a
			// validated V2 terminal still wins over cleanup-triggered cancellation.
			const isCurrent = () => {
				try {
					return generation === compactionGeneration
						&& getSessionId(ctx) === sessionId && isDeepStrictEqual(branch, ctx.sessionManager.getBranch())
						&& isDeepStrictEqual(model, ctx.model) && thinking === ctx.thinkingLevel
						&& !retirementReason(ctx)
						&& !(event.reason === "manual" && typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages());
				} catch { return false; }
			};
			const result = await handleSessionBeforeCompact(event, ctx, { ...dependencies, isCurrentCompaction: isCurrent });
			if (!isCurrent()) return { cancel: true };
			if (result && "compaction" in result && result.compaction) {
				// Pi consumes results after later awaited observers. Never persist a
				// stale candidate or drain/consume the host's queues.
				return { compaction: result.compaction, get cancel() { return !isCurrent(); } };
			}
			if (result === undefined) {
				// Default summarization starts only after later observers finish too.
				// Keep the host handoff revocable without claiming its compaction.
				return { get cancel() { return !isCurrent(); } };
			}
			return result;
		} catch {
			// Pi can treat a rejected hook as absent and run its implicit summary.
			try { notifyWarning(ctx, "Compaction stopped; existing context preserved. Resume manually."); } catch { /* stale UI */ }
			return { cancel: true };
		}
	});
	pi.on("session_compact", invalidateCompaction);
	pi.on("session_compact_failed", invalidateCompaction);
	pi.on("session_shutdown", invalidateCompaction);
	pi.on("model_select", invalidateCompaction);
	pi.on("before_agent_start", invalidateCompaction);
	pi.on("agent_start", invalidateCompaction);
	pi.on("input", invalidateCompaction);
	pi.on("thinking_level_select", invalidateCompaction);
	pi.on("message_start", invalidateCompaction);
	pi.on("tool_call", invalidateCompaction);
	pi.on("session_before_switch", invalidateCompaction);
	pi.on("session_before_fork", invalidateCompaction);
	pi.on("session_before_tree", invalidateCompaction);

	// Exact gateway compatibility is shared transport policy, independent of
	// compaction enablement. No window identities or ingest headers are generated.
	pi.on("before_provider_headers", async (event, ctx) => {
		if (refuseRetiredSession(ctx, true)) return;
		const resolved = contextOperation(loadConfig, ctx);
		requireContextPolicy(resolved, ctx);
		if (!resolved.gatewayModelKeys.length) return;
		const resolution = await resolveNativeCompactionEnvironment(ctx, {
			responsesApis: ["openai-responses"], codexGatewayModels: resolved.gatewayModelKeys,
		});
		if (refuseRetiredSession(ctx, true)) return;
		if (!resolution.ok) {
			const selected = isExactModelAllowed(ctx.model, resolved.gatewayModelKeys);
			const physical = resolution.provider && resolution.model
				? isExactModelAllowed({ provider: resolution.provider, id: resolution.model }, resolved.gatewayModelKeys) : false;
			if (selected || physical) {
				notifyWarning(ctx, "Configured gateway transport is unavailable; provider request aborted.");
				ctx.abort();
			}
			return;
		}
		const runtime = resolution.runtime;
		if (!runtime.codexAffinity) return;
		const gatewayHeaders = buildResponsesRequestHeaders(runtime, { accept: "text/event-stream" });
		const allowed = new Set<string>(CODEX_GATEWAY_FORWARD_HEADERS);
		for (const existing of Object.keys(event.headers)) {
			if (!allowed.has(existing.toLowerCase())) delete event.headers[existing];
		}
		for (const name of ["authorization", "originator", "user-agent", "session-id", "x-client-request-id", "x-codex-affinity-scope", "x-codex-model"]) {
			for (const existing of Object.keys(event.headers)) {
				if (existing.toLowerCase() === name) delete event.headers[existing];
			}
			const value = gatewayHeaders.get(name);
			if (value) event.headers[name] = value;
		}
	});
}
