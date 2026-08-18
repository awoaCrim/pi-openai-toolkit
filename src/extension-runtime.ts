import type {
	BeforeProviderRequestEvent,
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "./config";
import { writeDebugArtifact } from "./debug";
import { resolveLatestNativeCompactionEntry } from "./details-store";
import { runNativeFallbackCompaction } from "./native-fallback";
import {
	rewriteResponsesPayloadWithNativeReplay,
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
	isNativeCompactionDetails,
	type CompactionConfig,
	type NativeCompactionDetails,
	type NativeCompactionRequestMeta,
} from "./types";

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
): Promise<ResponsesCompactOutcome> {
	const { consumer, compactor } = execution;
	const instructions = buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions);
	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: consumer.provider,
		api: consumer.api,
		model: consumer.model,
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
	});
	if (extras) {
		request = { ...request, ...extras };
	}

	const compactResult = await executeRemoteV2Compaction({
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

async function handleSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
	const { config: toolkitConfig } = loadToolkitConfig();
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

	// Branch 1: Responses-family APIs use remote_compaction_v2 on the normal Responses stream.
	const resolution = await resolveRemoteCompactionExecution(
		ctx,
		{
			enabled: config.enabled,
			responsesApis: config.responsesApis,
		},
		config.remoteCompactModel,
	);
	if (resolution.ok) {
		const responsesOutcome = await runResponsesNativeCompact(event, ctx, config, resolution.execution);
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

	// Branch 2: run pi's native compaction method with the configured model.
	const fallback = await runNativeFallbackCompaction({ ctx, event, config });
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

	// Intentional pi-default paths: no configured model, or it matches the current one.
	if (fallback.reason !== "no-model-configured" && fallback.reason !== "same-as-current-model") {
		notifyWarning(
			ctx,
			`compaction model "${fallback.modelSpec}" unusable (${fallback.reason}${fallback.errorMessage ? `: ${fallback.errorMessage}` : ""}); using pi's default compaction`,
		);
	}

	// Branch 3: pi's default native compaction with the current model.
	return undefined;
}

async function handleBeforeProviderRequest(event: BeforeProviderRequestEvent, ctx: ExtensionContext) {
	const { config: toolkitConfig } = loadToolkitConfig();
	const config = toolkitConfig.compaction;
	if (!config.enabled) {
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
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
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
			freshPreambleItems: rewrite.segments.freshPreamble.length,
			trailingPreambleItems: rewrite.segments.trailingPreamble.length,
			compactionSummaryItems: rewrite.segments.compactionSummary.length,
			preCompactionKeptItems: rewrite.segments.preCompactionKeptWindow.input.length,
			compactedItems: rewrite.segments.compactedWindow.length,
			postCompactionTailItems: rewrite.segments.postCompactionTail.input.length,
			payload: rewrite.rewrittenPayload,
			originalPayload: payload,
		},
		config,
		ctx,
	);

	return rewrite.rewrittenPayload;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const { config: toolkitConfig, source, warnings } = loadToolkitConfig();
		const config = toolkitConfig.compaction;
		if (!config.enabled) return;

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

	pi.on("session_before_compact", handleSessionBeforeCompact);
	pi.on("before_provider_request", handleBeforeProviderRequest);
}
