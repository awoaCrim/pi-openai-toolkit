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
import {
	codexContextProviderHeaders,
	resolveCodexContextProvider,
	isCodexGatewayModel,
	isNativeCodexModel,
} from "./context-management/codex-provider";
import { routeContextNamespaceToolMessage } from "./context-management/namespace-tools";
import { loadHistoryNotesThreadHint } from "./context-management/history-notes";
import { CodexContextWindowManager } from "./context-management/window-manager";
import { ManagedManualCompact } from "./context-management/manual-compact";
import {
	registerContextManagementTools,
	type ContextToolRegistrationState,
} from "./context-management/tools";
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
import { CODEX_GATEWAY_FORWARD_HEADERS } from "./responses-headers";
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
	rememberPhysicalModel,
	resolveEffectiveModel,
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

function compactGatewayModels(resolved: ResolvedToolkitConfig): readonly string[] {
	return resolved.format === "v2" || resolved.config.compaction.contextManagement === "remote"
		? resolved.gatewayModelKeys : [];
}

type CompactionDependencies = {
	loadConfig: typeof loadToolkitConfig;
	remoteCompact: typeof executeRemoteV2Compaction;
	standaloneCompact: typeof executeNativeCompaction;
	nativeFallback: typeof runNativeFallbackCompaction;
	contextWindows: CodexContextWindowManager;
	manualCompact?: ManagedManualCompact;
	/** Test seam for the same ordered projection exposed by the Pi host patch. */
	projectCompactionContext?: CompactionContextProjection;
	piContextHookPatch: PiContextHookPatchResult;
};

type RemoteContextActive = (
	ctx: ExtensionContext,
	config: CompactionConfig,
	model?: ExtensionContext["model"],
) => Promise<boolean>;
type ContextToolRegistrationStateReader = () => ContextToolRegistrationState;

type ContextToolSyncOutcome = {
	eligible: boolean;
	toolsSynced: boolean;
	registrationState: ContextToolRegistrationState;
	windowInitialized: boolean;
};

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

async function resolveContextCapabilityModel(
	ctx: ExtensionContext,
	model: ExtensionContext["model"] = ctx.model,
): Promise<ExtensionContext["model"]> {
	const effective = await resolveEffectiveModel(ctx, model);
	return effective.ok ? effective.model : undefined;
}

async function isRemoteContextActive(
	ctx: ExtensionContext,
	config: CompactionConfig,
	model: ExtensionContext["model"] = ctx.model,
): Promise<boolean> {
	if (!config.enabled || config.contextManagement !== "remote") return false;
	const resolution = await resolveCodexContextProvider(ctx, model, config.gatewayContextModels);
	return resolution.ok;
}

function isCodexContextModel(
	model: ExtensionContext["model"] | undefined,
	config: CompactionConfig,
): boolean {
	return config.contextManagement === "remote"
		&& (isNativeCodexModel(model) || isCodexGatewayModel(model, config.gatewayContextModels));
}

function isExcludedGatewayContext(
	model: ExtensionContext["model"] | undefined,
	config: CompactionConfig,
	registrationState: ContextToolRegistrationState,
): boolean {
	return registrationState === "excluded" && isCodexGatewayModel(model, config.gatewayContextModels);
}

function contextManagementFailureReason(registrationState: ContextToolRegistrationState): string {
	switch (registrationState) {
		case "excluded":
			return "context-tools-excluded";
		case "conflict":
			return "tool-name-conflict";
		case "unverified":
			return "tool-registration-pending";
		case "verified":
			return "context-management-unavailable";
	}
}

function notifyRemoteContextFailure(ctx: ExtensionContext, reason: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(`${COMPACTION_EXTENSION_ID}: Remote Context management inactive (${reason})`, "warning");
	}
}

/**
 * Surface every window trim that had to be refused to keep the tool loadout intact.
 *
 * The refusal itself is safe: the model keeps the previous turns instead of losing its
 * tools. It is still a continuity incident, so it is recorded once per window and reason
 * instead of being allowed to pass silently.
 */
function reportProjectionDiagnostics(
	contextWindows: CodexContextWindowManager,
	config: CompactionConfig,
	ctx: ExtensionContext,
): void {
	const diagnostics = contextWindows.takeProjectionDiagnostics();
	if (diagnostics.length === 0) return;
	writeDebugArtifact(
		"compaction-event",
		{ event: "context.projection.tool_loadout_shrink", diagnostics },
		config,
		ctx,
	);
	if (ctx.hasUI) {
		ctx.ui.notify(
			`${COMPACTION_EXTENSION_ID}: kept previous context to preserve tools (${diagnostics.join("; ")})`,
			"warning",
		);
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
	/** Only ordinary compaction supplies this; managed recovery remains V2-only. */
	standaloneCompact?: typeof executeNativeCompaction,
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

	if (event.signal?.aborted) return { outcome: "aborted" };
	let protocol: "remote-v2" | "standalone-compact" = "remote-v2";
	let compactResult: Awaited<ReturnType<typeof executeRemoteV2Compaction>> | NativeCompactionClientResult = await remoteCompact({
		runtime: compactor,
		request,
		signal: event.signal,
		settings: config,
		context: ctx,
	});

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
			if (event.signal?.aborted) return { outcome: "aborted" };
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
			firstKeptEntryId: event.preparation.firstKeptEntryId,
		},
		config,
		ctx,
	);

	return { outcome: "success", compaction };
}

type ContextUnavailableCompactionResult =
	| { compaction: CompactionResult<unknown> }
	| { cancel: true };

async function runUnavailableContextCompaction(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	dependencies: CompactionDependencies,
	resolved: ResolvedToolkitConfig,
	config: CompactionConfig,
	registrationState: ContextToolRegistrationState,
): Promise<ContextUnavailableCompactionResult> {
	const contextReason = contextManagementFailureReason(registrationState);
	const remoteModelSpec = config.remoteCompactModel?.trim();
	let remoteFailure: string | undefined;

	if (remoteModelSpec) {
		const resolution = await resolveRemoteCompactionExecution(
			ctx,
			{
				enabled: config.enabled,
				responsesApis: config.responsesApis,
				codexGatewayModels: compactGatewayModels(resolved),
			},
			remoteModelSpec,
		);
		if (resolution.ok) {
			const outcome = await runResponsesNativeCompact(
				event,
				ctx,
				config,
				resolution.execution,
				dependencies.remoteCompact,
				dependencies.projectCompactionContext,
			);
			if (outcome.outcome === "success") {
				writeDebugArtifact(
					"compaction-event",
					{
						event: "session_before_compact.context-fallback-success",
						contextReason,
						registrationState,
						compactor: remoteModelSpec,
					},
					config,
					ctx,
				);
				return { compaction: outcome.compaction };
			}
			if (outcome.outcome === "aborted" || outcome.outcome === "unprojected-input") {
				return { cancel: true };
			}
			remoteFailure = "remote-v2-failed";
		} else {
			remoteFailure = resolution.reason;
			writeDebugArtifact(
				"compaction-event",
				{
					event: "session_before_compact.context-fallback-unavailable",
					contextReason,
					registrationState,
					reason: resolution.reason,
					modelSpec: remoteModelSpec,
					errorMessage: resolution.errorMessage,
				},
				config,
				ctx,
			);
		}
	} else {
		remoteFailure = "missing-remote-compaction-model";
	}

	const nativeModelSpec = config.nativeFallback.model?.trim();
	if (config.nativeFallback.enabled && nativeModelSpec) {
		const fallback = await dependencies.nativeFallback({
			ctx,
			event,
			config,
			modelSpec: nativeModelSpec,
		});
		if (fallback.ok) {
			writeDebugArtifact(
				"compaction-event",
				{
					event: "session_before_compact.context-fallback-native-success",
					contextReason,
					registrationState,
					remoteFailure,
					fallbackModel: nativeModelSpec,
				},
				config,
				ctx,
			);
			return { compaction: fallback.result };
		}
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.context-fallback-native-failure",
				contextReason,
				registrationState,
				remoteFailure,
				fallbackReason: fallback.reason,
				fallbackModel: nativeModelSpec,
				errorMessage: fallback.errorMessage,
			},
			config,
			ctx,
		);
	} else {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.context-fallback-cancelled",
				contextReason,
				registrationState,
				remoteFailure,
				reason: config.nativeFallback.enabled ? "missing-native-fallback-model" : "native-fallback-disabled",
			},
			config,
			ctx,
		);
	}

	return { cancel: true };
}

async function handleSessionBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	dependencies: CompactionDependencies,
	remoteContextActive: RemoteContextActive,
	getContextToolRegistrationState: ContextToolRegistrationStateReader,
) {
	const resolved = contextOperation(dependencies.loadConfig, ctx);
	if (resolved.invalidFeatures.some((feature) => ["context", "compatibility", "diagnostics"].includes(feature))) return { cancel: true };
	const config = resolved.config.compaction;
	if (!config.enabled) {
		return undefined;
	}

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

	if (event.signal.aborted) {
		return { cancel: true };
	}

	// Capability changes do not retire the persisted Remote session. Resolve its
	// branch boundary before deciding whether any compactor may see this input.
	if (config.contextManagement === "remote") {
		try {
			dependencies.contextWindows.synchronize(ctx);
		} catch {
			notifyRemoteContextFailure(ctx, "malformed-window-state");
			return { cancel: true };
		}
	}

	// Active and inactive covered Codex consumers retain their existing routing.
	const contextModel = await resolveContextCapabilityModel(ctx);
	if (isCodexContextModel(contextModel, config)) {
		if (await remoteContextActive(ctx, config, contextModel)) {
			try {
				if (event.reason === "manual" && dependencies.manualCompact && !dependencies.manualCompact.isMaintenance) {
					await dependencies.manualCompact.request(event, ctx, resolved);
					return { cancel: true };
				}
				return dependencies.contextWindows.prepareCompaction(event);
			} catch {
				notifyRemoteContextFailure(ctx, "malformed-window-state");
				return { cancel: true };
			}
		}

		const registrationState = getContextToolRegistrationState();
		const failureReason = contextManagementFailureReason(registrationState);
		if (failureReason !== "context-tools-excluded") {
			notifyRemoteContextFailure(ctx, failureReason);
		}
		return runUnavailableContextCompaction(
			event,
			ctx,
			dependencies,
			resolved,
			config,
			registrationState,
		);
	}

	if (config.contextManagement === "remote") {
		try {
			const detached = dependencies.contextWindows.prepareDetachedCompaction(event);
			// A local consumer cannot summarize history owned by a Remote window,
			// even through a configured Luna producer or Pi's default compactor.
			if (detached) return detached;
		} catch {
			notifyRemoteContextFailure(ctx, "malformed-window-state");
			return { cancel: true };
		}
	}

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
			codexGatewayModels: compactGatewayModels(resolved),
		},
		config.remoteCompactModel,
	);
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
		);
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
	const fallback = await dependencies.nativeFallback({ ctx, event, config, modelSpec: fallbackModelSpec });
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

	// Branch 3: pi's default native compaction with the current model.
	return undefined;
}

function rejectInheritedCheckpointReplay(
	ctx: ExtensionContext,
	config: CompactionConfig,
	compactionEntryId: string,
	reason: string,
): undefined {
	writeReplayFailureArtifact({ reason, compactionEntryId }, config, ctx);
	reportPiContextHookFailure(ctx, `replay-failed:${reason}`);
	if (ctx.hasUI) ctx.ui.notify(`${COMPACTION_EXTENSION_ID}: inherited checkpoint replay failed (${reason}); request aborted`, "error");
	ctx.abort();
	return undefined;
}

async function handleContextInternal(
	event: ContextWithSystemEvent,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	loadConfig: typeof loadToolkitConfig,
	contextWindows: CodexContextWindowManager,
	remoteContextActive: RemoteContextActive,
	getContextToolRegistrationState: ContextToolRegistrationStateReader,
) {
	const resolved = contextOperation(loadConfig, ctx);
	requireContextPolicy(resolved, ctx);
	const config = resolved.config.compaction;
	if (!config.enabled) {
		const visibleMessages = contextWindows.project(event.messages, "off");
		return visibleMessages.length === event.messages.length && visibleMessages.every((message, index) => message === event.messages[index])
			? undefined
			: { messages: visibleMessages };
	}

	let localMessages: AgentMessage[] | undefined;
	let remoteReplayProjection = false;
	if (config.contextManagement === "remote") {
		const contextModel = await resolveContextCapabilityModel(ctx);
		try {
			contextWindows.synchronize(ctx);
		} catch {
			notifyRemoteContextFailure(ctx, "malformed-window-state");
			reportPiContextHookFailure(ctx, "malformed-window-state");
			ctx.abort();
			return undefined;
		}

		const remoteActive = await remoteContextActive(ctx, config, contextModel);
		if (remoteActive) {
			try {
				// Measure the provider-visible current window, not Pi's durable transcript.
				// The latter still contains retired remote windows and can be inflated by
				// an upstream error even though this request only carries the live window.
				let projected = contextWindows.project(event.messages, "remote", false);
				// Projection may observe the exact queued rollover before Pi persists
				// it. Decide replay ownership from this request, not the old branch.
				const ownsWindow = contextWindows.hasEffectiveWindow() || !contextWindows.currentIdentity();
				if (ownsWindow) projected = contextWindows.project(projected, "remote");
				contextWindows.recordBudget(
					pi,
					ctx,
					true,
					config.contextReminderThresholdPercent,
				);
				reportProjectionDiagnostics(contextWindows, config, ctx);
				if (ownsWindow) {
					return projected.length === event.messages.length && projected.every((message, index) => message === event.messages[index])
						? undefined
						: { messages: projected };
				}
				localMessages = projected;
				remoteReplayProjection = true;
			} catch (error) {
				notifyRemoteContextFailure(ctx, "malformed-window-state");
				reportPiContextHookFailure(ctx, "malformed-window-state");
				ctx.abort();
				return undefined;
			}
		}

		// An unavailable covered runtime must not silently become an ordinary
		// replay consumer. Explicit host exclusion remains the one intentional
		// downgrade; active Remote can replay a newer inherited checkpoint.
		if (!remoteActive && isCodexContextModel(contextModel, config)) {
			const registrationState = getContextToolRegistrationState();
			if (isExcludedGatewayContext(contextModel, config, registrationState)) {
				const visibleMessages = contextWindows.project(event.messages, "off");
				return visibleMessages.length === event.messages.length && visibleMessages.every((message, index) => message === event.messages[index])
					? undefined
					: { messages: visibleMessages };
			}
			if (isCodexGatewayModel(contextModel, config.gatewayContextModels)) {
				const reason = contextManagementFailureReason(registrationState);
				notifyRemoteContextFailure(ctx, reason);
				reportPiContextHookFailure(ctx, reason);
				ctx.abort();
				return undefined;
			}
			const visibleMessages = contextWindows.project(event.messages, "off");
			return visibleMessages.length === event.messages.length && visibleMessages.every((message, index) => message === event.messages[index])
				? undefined
				: { messages: visibleMessages };
		}

		if (!remoteActive) {
			try {
				const projected = contextWindows.project(event.messages, "local");
				localMessages = projected;
				if (contextWindows.hasEffectiveWindow()) {
					// This boundary owns earlier history, including any older Remote V2
					// checkpoint. A local request must not replay that history back in.
					return projected.length === event.messages.length && projected.every((message, index) => message === event.messages[index])
						? undefined
						: { messages: projected };
				}
			} catch (error) {
				notifyRemoteContextFailure(ctx, "malformed-window-state");
				reportPiContextHookFailure(ctx, error instanceof Error ? error.message : String(error));
				ctx.abort();
				return undefined;
			}
		}
	}

	// Without an effective Remote boundary, the latest checkpoint owns replay.
	// This also covers a newer checkpoint superseding a historical window.
	const visibleMessages = localMessages ?? contextWindows.project(event.messages, "off");
	const finishProjection = (messages: AgentMessage[]) => {
		// Compare canonical retained copies before Remote encrypted-output encoding.
		const projected = remoteReplayProjection ? contextWindows.project(messages, "remote") : messages;
		return projected.length === event.messages.length && projected.every((message, index) => message === event.messages[index])
			? undefined : { messages: projected };
	};
	const replayEvent = visibleMessages === event.messages ? event : { ...event, messages: visibleMessages };
	const branchEntries = ctx.sessionManager.getBranch();
	const inherited = config.contextManagement === "remote" && contextWindows.hasSupersededWindow()
		? resolveLatestNativeCompactionEntry(branchEntries) : undefined;
	const inheritedCheckpoint = inherited?.ok ? inherited.entry : undefined;
	const resolution = await resolveNativeCompactionEnvironment(ctx, {
		enabled: config.enabled,
		// Disabling checkpoint generation cannot turn an inherited opaque
		// checkpoint into a usable text summary. Replay checks transport support.
		responsesApis: inheritedCheckpoint ? undefined : config.responsesApis,
		codexGatewayModels: compactGatewayModels(resolved),
	});
	if (!resolution.ok) {
		return inheritedCheckpoint
			? rejectInheritedCheckpointReplay(ctx, config, inheritedCheckpoint.id, resolution.reason)
			: finishProjection(visibleMessages);
	}
	const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: resolution.runtime.baseUrl });
	if (!latest.ok) {
		return inheritedCheckpoint
			? rejectInheritedCheckpointReplay(ctx, config, inheritedCheckpoint.id, latest.reason)
			: finishProjection(visibleMessages);
	}
	const result = removeNativeCompactionRetainedMessages({
		messages: replayEvent.messages,
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
	return finishProjection(result.messages);
}

/**
 * Pi's emitContext() catches handler exceptions. Re-throw as usual for Pi, but
 * also report the failure so the compaction projector cannot mistake the
 * caught exception for a successful projection.
 */
async function handleContext(
	event: ContextWithSystemEvent,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	loadConfig: typeof loadToolkitConfig,
	contextWindows: CodexContextWindowManager,
	remoteContextActive: RemoteContextActive,
	getContextToolRegistrationState: ContextToolRegistrationStateReader,
) {
	try {
		return await handleContextInternal(event, ctx, pi, loadConfig, contextWindows, remoteContextActive, getContextToolRegistrationState);
	} catch (error) {
		reportPiContextHookFailure(ctx, error instanceof Error ? error.message : String(error));
		throw error;
	}
}

async function handleBeforeProviderRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
	loadConfig: typeof loadToolkitConfig,
	contextWindows: CodexContextWindowManager,
	remoteContextActive: RemoteContextActive,
	getContextToolRegistrationState: ContextToolRegistrationStateReader,
) {
	const resolved = contextOperation(loadConfig, ctx);
	requireContextPolicy(resolved, ctx);
	const toolkitConfig = resolved.config;
	const config = toolkitConfig.compaction;
	if (!config.enabled) {
		return undefined;
	}

	const contextModel = config.contextManagement === "remote"
		? await resolveContextCapabilityModel(ctx)
		: undefined;
	if (config.contextManagement === "remote") {
		try {
			contextWindows.synchronize(ctx);
		} catch {
			notifyRemoteContextFailure(ctx, "malformed-window-state");
			ctx.abort();
			return undefined;
		}
	}
	const remoteActive = config.contextManagement === "remote" && await remoteContextActive(ctx, config, contextModel);
	let remotePayload: unknown;
	if (remoteActive) {
		try {
			remotePayload = contextWindows.rewritePayload(event.payload, ctx);
			if (contextWindows.hasEffectiveWindow() || !contextWindows.currentIdentity()) return remotePayload;
			event = { ...event, payload: remotePayload };
		} catch {
			notifyRemoteContextFailure(ctx, "malformed-request-state");
			ctx.abort();
			return undefined;
		}
	}
	if (!remoteActive && isCodexContextModel(contextModel, config)) {
		const registrationState = getContextToolRegistrationState();
		// A readable empty registry is an intentional host exclusion. Do not
		// rewrite gateway identity or abort an ordinary child-session request.
		if (isExcludedGatewayContext(contextModel, config, registrationState)) return undefined;
		// Keep Codex Remote mutually exclusive with the legacy replay pipeline
		// when authentication or tool ownership is unavailable. Gateway traffic
		// cannot continue as an ordinary Responses request because that would
		// silently lose the required CPA session/account selection.
		if (isCodexGatewayModel(contextModel, config.gatewayContextModels)) {
			const reason = contextManagementFailureReason(registrationState);
			notifyRemoteContextFailure(ctx, reason);
			ctx.abort();
		}
		return undefined;
	}

	// Do not reintroduce a pre-window opaque checkpoint after local projection.
	// Request affinity/encrypted-output rewriting is reserved for active Remote.
	if (config.contextManagement === "remote" && contextWindows.hasEffectiveWindow()) return undefined;

	const branchEntries = ctx.sessionManager.getBranch();
	const inherited = config.contextManagement === "remote" && contextWindows.hasSupersededWindow()
		? resolveLatestNativeCompactionEntry(branchEntries) : undefined;
	const inheritedCheckpoint = inherited?.ok ? inherited.entry : undefined;
	const resolution = await resolveNativeCompactionEnvironment(
		ctx,
		{
			enabled: config.enabled,
			responsesApis: inheritedCheckpoint ? undefined : config.responsesApis,
			codexGatewayModels: compactGatewayModels(resolved),
		},
		event.payload,
	);
	if (resolution.ok === false) {
		if (inheritedCheckpoint) return rejectInheritedCheckpointReplay(ctx, config, inheritedCheckpoint.id, resolution.reason);
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
		return remotePayload;
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
		if (inheritedCheckpoint) return rejectInheritedCheckpointReplay(ctx, config, inheritedCheckpoint.id, latestNativeCompaction.reason);
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
		return remotePayload;
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
	const piContextHookPatch = installPiContextHookPatch();
	const contextWindows = overrides.contextWindows ?? new CodexContextWindowManager((ctx, signal, gatewayModels) =>
		loadHistoryNotesThreadHint(ctx, signal, gatewayModels)
	);
	const manualCompact = new ManagedManualCompact(pi, contextWindows);
	const dependencies: CompactionDependencies = {
		remoteCompact: executeRemoteV2Compaction,
		standaloneCompact: executeNativeCompaction,
		nativeFallback: runNativeFallbackCompaction,
		contextWindows,
		...overrides,
		manualCompact,
		loadConfig: () => manualCompact.snapshot ?? loadConfig(),
		piContextHookPatch: overrides.piContextHookPatch ?? piContextHookPatch,
	};
	let tools!: ReturnType<typeof registerContextManagementTools>;
	let contextWindowReady = false;
	const isContextRuntimeActive = async (
		ctx: ExtensionContext,
		config: CompactionConfig,
		model = ctx.model,
	): Promise<boolean> =>
		contextWindowReady && tools.isRegistered && await isRemoteContextActive(ctx, config, model);
	tools = registerContextManagementTools(
		pi,
		contextWindows,
		async (ctx) => {
			const resolved = contextOperation(dependencies.loadConfig, ctx);
			assertConfigValid(resolved, "context", "compatibility");
			return { active: await isContextRuntimeActive(ctx, resolved.config.compaction), gatewayModels: resolved.gatewayModelKeys };
		},
		undefined,
		manualCompact,
	);
	const remoteContextActive: RemoteContextActive = isContextRuntimeActive;
	const syncTools = async (
		ctx: ExtensionContext,
		model = ctx.model,
		options: { notifyWindowFailure?: boolean } = {},
		resolved = contextOperation(dependencies.loadConfig, ctx, model),
	): Promise<ContextToolSyncOutcome> => {
		// Until this call proves otherwise, do not let a previous session/window
		// identity make a failed activation look usable.
		contextWindowReady = false;
		const config = resolved.config.compaction;
		const eligible = !resolved.invalidFeatures.some((feature) => ["context", "compatibility"].includes(feature)) && await isRemoteContextActive(ctx, config, model);
		const toolSync = tools.sync(eligible);
		const outcome: ContextToolSyncOutcome = {
			eligible,
			toolsSynced: toolSync.synced,
			registrationState: toolSync.registrationState,
			windowInitialized: false,
		};
		if (!eligible || !toolSync.synced) return outcome;
		// Activation can succeed after `session_start` missed it, because Pi 0.86 may
		// reject the registration read while a session replacement is still binding.
		// The window lifecycle has to open on that later activation too, or requests
		// carry no window metadata and the backend never ingests the turns.
		try {
			contextWindows.ensureInitialized(pi, ctx, true);
			contextWindowReady = true;
			return { ...outcome, windowInitialized: true };
		} catch {
			// Do not leave tools exposed while the request path has no valid window
			// identity. The next lifecycle hook may retry once Pi is usable again.
			tools.sync(false);
			if (options.notifyWindowFailure) notifyRemoteContextFailure(ctx, "malformed-window-state");
			return outcome;
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		const resolved = contextOperation(dependencies.loadConfig, ctx);
		const syncOutcome = await syncTools(ctx, ctx.model, { notifyWindowFailure: true }, resolved);
		await manualCompact.recover(ctx);
		const active = syncOutcome.eligible && syncOutcome.toolsSynced && syncOutcome.windowInitialized;
		const { source } = resolved;
		const warnings = resolved.issues.map((issue) => `${issue.path}: ${issue.code}`);
		const config = resolved.config.compaction;
		if (resolved.invalidFeatures.length > 0) return;
		if (!config.enabled) return;
		const contextModel = await resolveContextCapabilityModel(ctx);

		let activationReason: string | undefined;
		// Only models the built-in Remote Context coverage targets may activate or
		// warn; everything else silently runs Pi's normal compaction path.
		if (config.contextManagement === "remote" && isCodexContextModel(contextModel, config) && !active) {
			if (syncOutcome.registrationState === "excluded") {
				activationReason = "context-tools-excluded";
			} else if (syncOutcome.registrationState === "conflict") {
				activationReason = "tool-name-conflict";
				notifyRemoteContextFailure(ctx, activationReason);
			} else if (syncOutcome.registrationState === "unverified" || !syncOutcome.toolsSynced) {
				// Transient: the runtime has not published or accepted our tools yet. A
				// later before_agent_start re-verifies, so do not report provider failure.
				activationReason = "tool-registration-pending";
			} else if (syncOutcome.eligible && !syncOutcome.windowInitialized) {
				activationReason = "malformed-window-state";
			} else {
				const remoteResolution = await resolveCodexContextProvider(ctx, ctx.model, config.gatewayContextModels);
				activationReason = remoteResolution.ok ? "codex-context-unavailable" : remoteResolution.reason;
				notifyRemoteContextFailure(ctx, activationReason);
			}
		}


		const artifactPath = writeDebugArtifact(
			"lifecycle",
			{
				event: "session_start",
				config,
				configSource: source,
				warnings,
				activation: {
					active,
					contextManagement: config.contextManagement,
					remoteV2ContextSource: config.remoteV2ContextSource,
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					...(activationReason ? { reason: activationReason } : {}),
				},
				piContextHookPatch: dependencies.piContextHookPatch,
			},
			config,
			ctx,
		);

		if (ctx.hasUI && ["info", "debug"].includes(resolved.policy.diagnostics.level) && (config.notifyOnLoad || config.debug)) {
			ctx.ui.notify(
				artifactPath
					? `${COMPACTION_EXTENSION_ID} loaded • debug artifacts → ${artifactPath}`
					: `${COMPACTION_EXTENSION_ID} loaded`,
				"info",
			);
		}
	});

	const getContextToolRegistrationState: ContextToolRegistrationStateReader = () => tools.registrationState;
	pi.on("context_with_system", (event, ctx) => {
		manualCompact.guardRequest(ctx);
		return handleContext(event, ctx, pi, dependencies.loadConfig, contextWindows, remoteContextActive, getContextToolRegistrationState);
	});
	pi.on("session_before_compact", (event, ctx) => handleSessionBeforeCompact(event, ctx, dependencies, remoteContextActive, getContextToolRegistrationState));
	pi.on("session_compact", (_event, ctx) => contextWindows.synchronize(ctx));
	pi.on("session_compact_failed", async (event, ctx) => {
		if (event.reason === "manual" && !manualCompact.isMaintenance) await manualCompact.compactFailed(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		await manualCompact.shutdown(ctx);
		contextWindowReady = false;
		contextWindows.reset();
		tools.reset();
	});
	pi.on("agent_settled", async (_event, ctx) => {
		// Only the owned manual handoff restores/continues here; Pi owns normal
		// compaction scheduling. Never compact retired windows on model changes.
		await manualCompact.settled(ctx);
	});
	pi.on("model_select", async (event, ctx) => {
		manualCompact.modelSelected(event.model, ctx);
		// Switching into a covered model mid-session must open the window
		// lifecycle immediately: without an identity the request rewrite skips
		// window metadata, the backend never ingests those turns, and the first
		// new_context would trim pre-switch history that no history can recover.
		// syncTools() activates and initializes the window when the model is covered.
		const resolved = contextOperation(dependencies.loadConfig, ctx, event.model);
		await syncTools(ctx, event.model, { notifyWindowFailure: true }, resolved);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		await syncTools(ctx, ctx.model, { notifyWindowFailure: true });
	});
	pi.on("thinking_level_select", (event, ctx) => manualCompact.thinkingSelected(event.level, ctx));
	pi.on("message_start", (event) => manualCompact.messageStarted(event.message));
	pi.on("turn_end", (_event, ctx) => manualCompact.turnEnded(ctx));
	pi.on("tool_call", (event) => manualCompact.guardTool(event.toolName));
	pi.on("session_tree", async (_event, ctx) => {
		contextWindows.synchronize(ctx);
		await manualCompact.recover(ctx);
		await syncTools(ctx);
	});
	pi.on("before_provider_request", (event, ctx) => {
		manualCompact.guardRequest(ctx);
		return handleBeforeProviderRequest(event, ctx, dependencies.loadConfig, contextWindows, remoteContextActive, getContextToolRegistrationState);
	});
	pi.on("before_provider_headers", async (event, ctx) => {
		const resolved = contextOperation(dependencies.loadConfig, ctx);
		requireContextPolicy(resolved, ctx);
		const config = resolved.config.compaction;
		const contextModel = await resolveContextCapabilityModel(ctx);
		if (!isCodexContextModel(contextModel, config)) return;
		const active = await remoteContextActive(ctx, config, contextModel);
		if (!active) {
			const registrationState = getContextToolRegistrationState();
			if (isExcludedGatewayContext(contextModel, config, registrationState)) return;
			if (isCodexGatewayModel(contextModel, config.gatewayContextModels)) {
				const reason = contextManagementFailureReason(registrationState);
				notifyRemoteContextFailure(ctx, reason);
				ctx.abort();
			}
			return;
		}
		const provider = await resolveCodexContextProvider(ctx, ctx.model, config.gatewayContextModels);
		if (provider.ok && provider.provider.kind === "codex-gateway") {
			const sessionId = getSessionId(ctx);
			const gatewayHeaders = codexContextProviderHeaders(provider.provider, {
				sessionId,
				clientRequestId: sessionId,
			});
			const allowedGatewayHeaders = new Set<string>(CODEX_GATEWAY_FORWARD_HEADERS);
			for (const existing of Object.keys(event.headers)) {
				if (!allowedGatewayHeaders.has(existing.toLowerCase())) delete event.headers[existing];
			}
			// Keep any caller-supplied version without forcing a Toolkit pin.
			// The gateway allowlist above already permits it.
			for (const name of [
				"authorization",
				"originator",
				"user-agent",
				"session-id",
				"x-client-request-id",
				"x-codex-affinity-scope",
				"x-codex-model",
			]) {
				for (const existing of Object.keys(event.headers)) {
					if (existing.toLowerCase() === name) delete event.headers[existing];
				}
				const value = gatewayHeaders.get(name);
				if (value) event.headers[name] = value;
			}
		}
		contextWindows.rewriteHeaders(event.headers, ctx);
	});
	pi.on("message_end", async (event, ctx) => {
		rememberPhysicalModel(ctx, event.message);
		const resolved = contextOperation(dependencies.loadConfig, ctx);
		requireContextPolicy(resolved, ctx);
		const config = resolved.config.compaction;
		const contextModel = await resolveContextCapabilityModel(ctx);
		if (!isCodexContextModel(contextModel, config) || !tools.isRegistered) return undefined;
		if (!(await remoteContextActive(ctx, config, contextModel))) return undefined;
		const message = routeContextNamespaceToolMessage(event.message);
		return message === event.message ? undefined : { message };
	});
}
