import type {
	BeforeProviderRequestEvent,
	ContextEvent,
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "./config";
import {
	codexContextProviderHeaders,
	resolveCodexContextProvider,
	isCodexGatewayModel,
	isNativeCodexModel,
} from "./context-management/codex-provider";
import { routeContextNamespaceToolMessage } from "./context-management/namespace-tools";
import { CodexContextWindowManager } from "./context-management/window-manager";
import { registerContextManagementTools } from "./context-management/tools";
import { writeDebugArtifact, writeReplayFailureArtifact } from "./debug";
import { resolveLatestNativeCompactionEntry } from "./details-store";
import { runNativeFallbackCompaction } from "./native-fallback";
import {
	rewriteResponsesPayloadWithNativeReplay,
	removeNativeCompactionRetainedMessages,
	serializeLiveTailToResponsesInput,
} from "./payload-rewrite";
import { getCompactionRequestExtras, rememberRequestContext } from "./request-context-cache";
import { executeRemoteV2Compaction } from "./remote-v2-client";
import {
	resolveNativeCompactionEnvironment,
	resolveRemoteCompactionExecution,
	type RemoteCompactionExecution,
} from "./runtime";
import { serializeMessagesToCompactRequest, type NativeCompactionRequestBody, type ResponsesInputItem } from "./serializer";
import {
	createNativeCompactionDetails,
	createNativeCompactionResult,
	COMPACTION_EXTENSION_ID,
	getLatestDeferredToolCarryover,
	isNativeCompactionDetails,
	type CompactionConfig,
	type NativeCompactionDetails,
	type NativeCompactionRequestMeta,
} from "./types";

type CompactionDependencies = {
	loadConfig: typeof loadToolkitConfig;
	remoteCompact: typeof executeRemoteV2Compaction;
	nativeFallback: typeof runNativeFallbackCompaction;
	contextWindows: CodexContextWindowManager;
};

type RemoteContextActive = (
	ctx: ExtensionContext,
	config: CompactionConfig,
	model?: ExtensionContext["model"],
) => Promise<boolean>;

type ResponsesCompactOutcome =
	| { outcome: "success"; compaction: CompactionResult<NativeCompactionDetails> }
	| { outcome: "aborted" }
	| { outcome: "failed" };

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

async function isRemoteContextActive(
	ctx: ExtensionContext,
	config: CompactionConfig,
	model: ExtensionContext["model"] = ctx.model,
): Promise<boolean> {
	if (!config.enabled || config.contextManagement !== "remote") return false;
	const resolution = await resolveCodexContextProvider(ctx, model);
	return resolution.ok;
}

function isCodexContextModel(
	model: ExtensionContext["model"] | undefined,
	config: CompactionConfig,
): boolean {
	return config.contextManagement === "remote"
		&& (isNativeCodexModel(model) || isCodexGatewayModel(model));
}

function notifyRemoteContextFailure(ctx: ExtensionContext, reason: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(`${COMPACTION_EXTENSION_ID}: Remote Context management inactive (${reason})`, "warning");
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

async function runResponsesNativeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: CompactionConfig,
	execution: RemoteCompactionExecution,
	remoteCompact: typeof executeRemoteV2Compaction,
): Promise<ResponsesCompactOutcome> {
	const { consumer, compactor } = execution;
	const instructions = buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions);
	const branchEntries = event.branchEntries ?? ctx.sessionManager.getBranch();
	const deferredToolCarryover = getLatestDeferredToolCarryover(branchEntries);
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		baseUrl: consumer.baseUrl,
	});

	let requestSource: "session-context" | "non-native-session-context" | "latest-native-replay";
	let request: NativeCompactionRequestBody;
	if (latestNativeCompaction.ok) {
		const liveTailEntries = branchEntries.slice(latestNativeCompaction.index + 1);
		const details = latestNativeCompaction.entry.details;
		if (!details) {
			return { outcome: "failed" };
		}
		requestSource = "latest-native-replay";
		const input: ResponsesInputItem[] = [
			...(cloneOpaqueWindow(details.compactedWindow) as ResponsesInputItem[]),
			...serializeLiveTailToResponsesInput({ model: compactor.currentModel, entries: liveTailEntries }),
		];
		request = {
			model: compactor.model,
			input,
			instructions,
		};
	} else if (
		latestNativeCompaction.reason === "no-compaction" ||
		(latestNativeCompaction.reason === "latest-compaction-not-native" &&
			config.allowCompactionContinuityBreak)
	) {
		requestSource =
			latestNativeCompaction.reason === "no-compaction" ? "session-context" : "non-native-session-context";
		const sessionManagerWithContext = ctx.sessionManager as typeof ctx.sessionManager & {
			buildSessionContext?: () => { messages: Parameters<typeof serializeMessagesToCompactRequest>[0]["messages"] };
		};
		const messages = sessionManagerWithContext.buildSessionContext?.().messages ?? [
			...event.preparation.messagesToSummarize,
			...event.preparation.turnPrefixMessages,
		];
		request = serializeMessagesToCompactRequest({
			model: compactor.currentModel,
			messages,
			instructions,
		});
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
		model: consumer.model,
		baseUrl: consumer.baseUrl,
		sessionId: getSessionId(ctx),
	}, compactor.currentModel);
	if (extras) {
		request = { ...request, ...extras };
	}

	const compactResult = await remoteCompact({
		runtime: compactor,
		request,
		signal: event.signal,
		settings: config,
		context: ctx,
	});

	if (compactResult.ok === false) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.remote-v2-failure",
				reason: compactResult.reason,
				status: compactResult.status,
				errorMessage: compactResult.errorMessage,
			},
			config,
			ctx,
		);
		return compactResult.reason === "aborted" ? { outcome: "aborted" } : { outcome: "failed" };
	}

	let details: NativeCompactionDetails;
	try {
		details = createNativeCompactionDetails({
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
		return { outcome: "failed" };
	}

	const compaction = createNativeCompactionResult({
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details,
	});

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact.remote-v2-success",
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

async function handleSessionBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	dependencies: CompactionDependencies,
	remoteContextActive: RemoteContextActive,
) {
	const { config: toolkitConfig } = dependencies.loadConfig();
	const config = toolkitConfig.compaction;
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

	// Remote Context management owns this eligible Codex session. It persists a
	// no-summary boundary and deliberately never calls remote_compaction_v2.
	if (isCodexContextModel(ctx.model, config)) {
		if (await remoteContextActive(ctx, config)) {
			try {
				dependencies.contextWindows.synchronize(ctx);
				return dependencies.contextWindows.prepareCompaction(event);
			} catch {
				notifyRemoteContextFailure(ctx, "malformed-window-state");
				return { cancel: true };
			}
		}
		// A configured native Codex Remote session must never re-enter this
		// extension's Remote V2 compaction chain, and Pi's native compaction is
		// deliberately disabled for Remote-managed models: cancelling here keeps
		// the boundary the only rollover mechanism. The inactive reason is
		// surfaced so the user can fix activation instead of losing context to a
		// silent native summary.
		notifyRemoteContextFailure(ctx, "native-codex-context-unavailable");
		return { cancel: true };
	}

	// Branch 1: Responses-family APIs use remote_compaction_v2 on the normal Responses stream.
	let remoteAttempted = false;
	const resolution = await resolveRemoteCompactionExecution(
		ctx,
		{
			enabled: config.enabled,
			responsesApis: config.responsesApis,
		},
		config.remoteCompactModel,
	);
	if (resolution.ok) {
		remoteAttempted = true;
		const responsesOutcome = await runResponsesNativeCompact(event, ctx, config, resolution.execution, dependencies.remoteCompact);
		if (responsesOutcome.outcome === "success") {
			return { compaction: responsesOutcome.compaction };
		}
		if (responsesOutcome.outcome === "aborted") {
			return { cancel: true };
		}
		// failed: fall through to the configured-model fallback below.
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
		if (config.remoteCompactModel) {
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
		notifyWarning(
			ctx,
			`compaction model "${fallback.modelSpec}" unusable (${fallback.reason}${fallback.errorMessage ? `: ${fallback.errorMessage}` : ""}); using pi's default compaction`,
		);
	}

	// Branch 3: pi's default native compaction with the current model.
	return undefined;
}

async function handleContext(
	event: ContextEvent,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	loadConfig: typeof loadToolkitConfig,
	contextWindows: CodexContextWindowManager,
	remoteContextActive: RemoteContextActive,
) {
	const { config: { compaction: config } } = loadConfig();
	if (!config.enabled) {
		const visibleMessages = contextWindows.project(event.messages, "off");
		return visibleMessages.length === event.messages.length && visibleMessages.every((message, index) => message === event.messages[index])
			? undefined
			: { messages: visibleMessages };
	}

	if (config.contextManagement === "remote") {
		try {
			contextWindows.synchronize(ctx);
		} catch {
			notifyRemoteContextFailure(ctx, "malformed-window-state");
			ctx.abort();
			return undefined;
		}

		const remoteActive = await remoteContextActive(ctx, config);
		if (remoteActive) {
			try {
				contextWindows.recordBudget(
					pi,
					ctx,
					true,
					config.contextReminderThresholdPercent,
				);
				const projected = contextWindows.project(event.messages, "remote");
				return projected.length === event.messages.length && projected.every((message, index) => message === event.messages[index])
					? undefined
					: { messages: projected };
			} catch (error) {
				notifyRemoteContextFailure(ctx, "malformed-window-state");
				ctx.abort();
				return undefined;
			}
		}

		// An eligible Codex Remote session is never allowed to fall through to the
		// older compaction-replay path. Keep its internal markers hidden, but let
		// Pi's normal request construction handle the inactive session.
		if (isCodexContextModel(ctx.model, config)) {
			const visibleMessages = contextWindows.project(event.messages, "off");
			return visibleMessages.length === event.messages.length && visibleMessages.every((message, index) => message === event.messages[index])
				? undefined
				: { messages: visibleMessages };
		}
	}

	// Inactive/ineligible Remote mode must not expose internal window markers to a
	// gateway or another provider. The existing compaction replay path remains the
	// owner for this safe fallback.
	const visibleMessages = contextWindows.project(event.messages, "off");
	const replayEvent = visibleMessages === event.messages ? event : { ...event, messages: visibleMessages };
	const resolution = await resolveNativeCompactionEnvironment(ctx, {
		enabled: config.enabled,
		responsesApis: config.responsesApis,
	});
	if (!resolution.ok) return undefined;
	const branchEntries = ctx.sessionManager.getBranch();
	const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: resolution.runtime.baseUrl });
	if (!latest.ok) return undefined;
	const result = removeNativeCompactionRetainedMessages({ messages: replayEvent.messages, branchEntries, compactionEntry: latest.entry });
	if (!result.ok) {
		writeReplayFailureArtifact({ reason: result.reason, compactionEntryId: latest.entry.id }, config, ctx);
		if (ctx.hasUI) ctx.ui.notify(`${COMPACTION_EXTENSION_ID}: replay failed (${result.reason}); request aborted`, "error");
		ctx.abort();
		return undefined;
	}
	return result.messages === replayEvent.messages ? undefined : { messages: result.messages };
}

async function handleBeforeProviderRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
	loadConfig: typeof loadToolkitConfig,
	contextWindows: CodexContextWindowManager,
	remoteContextActive: RemoteContextActive,
) {
	const { config: toolkitConfig } = loadConfig();
	const config = toolkitConfig.compaction;
	if (!config.enabled) {
		return undefined;
	}

	if (config.contextManagement === "remote") {
		try {
			contextWindows.synchronize(ctx);
		} catch {
			notifyRemoteContextFailure(ctx, "malformed-window-state");
			ctx.abort();
			return undefined;
		}
	}
	if (config.contextManagement === "remote" && await remoteContextActive(ctx, config)) {
		try {
			return contextWindows.rewritePayload(event.payload, ctx);
		} catch {
			notifyRemoteContextFailure(ctx, "malformed-request-state");
			ctx.abort();
			return undefined;
		}
	}
	if (isCodexContextModel(ctx.model, config)) {
		// Keep Codex Remote mutually exclusive with the legacy replay
		// pipeline when authentication or tool ownership is unavailable.
		return undefined;
	}

	const resolution = await resolveNativeCompactionEnvironment(
		ctx,
		{
			enabled: config.enabled,
			responsesApis: config.responsesApis,
		},
		event.payload,
	);
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
	rememberRequestContext(payload, {
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
		baseUrl: runtime.baseUrl,
		sessionId: getSessionId(ctx),
	});

	const branchEntries = ctx.sessionManager.getBranch();
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
	const contextWindows = overrides.contextWindows ?? new CodexContextWindowManager();
	const dependencies: CompactionDependencies = {
		loadConfig,
		remoteCompact: executeRemoteV2Compaction,
		nativeFallback: runNativeFallbackCompaction,
		contextWindows,
		...overrides,
	};
	let tools!: ReturnType<typeof registerContextManagementTools>;
	tools = registerContextManagementTools(
		pi,
		contextWindows,
		async (ctx) => {
			const config = dependencies.loadConfig().config.compaction;
			return tools.isRegistered && await isRemoteContextActive(ctx, config);
		},
	);
	const remoteContextActive: RemoteContextActive = async (ctx, config, model = ctx.model) =>
		tools.isRegistered && await isRemoteContextActive(ctx, config, model);
	const syncTools = async (ctx: ExtensionContext, model = ctx.model): Promise<boolean> => {
		const config = dependencies.loadConfig().config.compaction;
		const active = await isRemoteContextActive(ctx, config, model);
		return tools.sync(active);
	};
	pi.on("session_start", async (_event, ctx) => {
		const active = await syncTools(ctx);
		const { config: toolkitConfig, source, warnings } = dependencies.loadConfig();
		const config = toolkitConfig.compaction;
		if (!config.enabled) return;

		let activationReason: string | undefined;
		if (config.contextManagement === "remote") {
			if (active) {
				try {
					contextWindows.ensureInitialized(pi, ctx, true);
				} catch {
					notifyRemoteContextFailure(ctx, "malformed-window-state");
				}
			} else if (!tools.isRegistered) {
				activationReason = "tool-name-conflict";
				notifyRemoteContextFailure(ctx, activationReason);
			} else {
				const remoteResolution = await resolveCodexContextProvider(ctx, ctx.model);
				activationReason = remoteResolution.ok ? "codex-context-unavailable" : remoteResolution.reason;
				notifyRemoteContextFailure(ctx, activationReason);
			}
		}

		if (warnings.length > 0 && ctx.hasUI && config.debug) {
			ctx.ui.notify(`${COMPACTION_EXTENSION_ID}: ${warnings[0]}`, "warning");
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
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					...(activationReason ? { reason: activationReason } : {}),
				},
			},
			config,
			ctx,
		);

		if (ctx.hasUI && (config.notifyOnLoad || config.debug)) {
			ctx.ui.notify(
				artifactPath
					? `${COMPACTION_EXTENSION_ID} loaded • debug artifacts → ${artifactPath}`
					: `${COMPACTION_EXTENSION_ID} loaded`,
				"info",
			);
		}
	});

	pi.on("context", (event, ctx) => handleContext(event, ctx, pi, dependencies.loadConfig, contextWindows, remoteContextActive));
	pi.on("session_before_compact", (event, ctx) => handleSessionBeforeCompact(event, ctx, dependencies, remoteContextActive));
	pi.on("session_compact", (event, _ctx) => contextWindows.recordCompaction(event.compactionEntry.details));
	pi.on("session_shutdown", () => {
		contextWindows.reset();
		tools.reset();
	});
	pi.on("model_select", async (event, ctx) => {
		await syncTools(ctx, event.model);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		await syncTools(ctx);
	});
	pi.on("before_provider_request", (event, ctx) => handleBeforeProviderRequest(event, ctx, dependencies.loadConfig, contextWindows, remoteContextActive));
	pi.on("before_provider_headers", async (event, ctx) => {
		const config = dependencies.loadConfig().config.compaction;
		if (!isCodexContextModel(ctx.model, config)) return;
		if (!(await remoteContextActive(ctx, config))) return;
		const provider = await resolveCodexContextProvider(ctx, ctx.model);
		if (provider.ok && provider.provider.kind === "codex-gateway") {
			const sessionId = getSessionId(ctx);
			const gatewayHeaders = codexContextProviderHeaders(provider.provider, {
				sessionId,
				clientRequestId: sessionId,
			});
			for (const name of [
				"authorization",
				"originator",
				"user-agent",
				"version",
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
			for (const existing of Object.keys(event.headers)) {
				if (["cookie", "chatgpt-account-id", "x-api-key"].includes(existing.toLowerCase())) delete event.headers[existing];
			}
		}
		contextWindows.rewriteHeaders(event.headers, ctx);
	});
	pi.on("message_end", (event, ctx) => {
		const config = dependencies.loadConfig().config.compaction;
		if (!isCodexContextModel(ctx.model, config) || !tools.isRegistered) return undefined;
		const message = routeContextNamespaceToolMessage(event.message);
		return message === event.message ? undefined : { message };
	});
}
