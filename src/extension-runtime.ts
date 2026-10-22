import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { declarationsEqual, getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "./context-management/responses-tools";
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
import { rewriteContextNamespaceCalls, rewriteContextNamespaceTools, routeContextNamespaceToolMessage } from "./context-management/namespace-tools";
import { rewriteEncryptedToolOutputs } from "./context-management/window-request";
import { loadHistoryNotesThreadHint } from "./context-management/history-notes";
import { CodexContextWindowManager } from "./context-management/window-manager";
import { ManagedManualCompact } from "./context-management/manual-compact";
import { prepareScopedNativeCompaction } from "./context-management/scoped-compaction";
import type { RemoteWindowCompactionInput } from "./context-management/window-manager";
import { CONTEXT_WINDOW_COMPACTION_SUMMARY, isSystemTranscriptMessage } from "./context-management/messages";
import { isRecord } from "./context-management/types";
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
	NATIVE_COMPACTION_FALLBACK_SUMMARY,
	STANDALONE_COMPACTION_FALLBACK_SUMMARY,
	getLatestDeferredToolCarryover,
	getRemoteV2InputProvenance,
	isNativeCompactionDetails,
	type CompactionConfig,
	type DeferredToolCarryoverV1,
	type NativeCompactionDetails,
	type NativeCompactionEntry,
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
	/** Read-only fence shared by all scoped producer tiers. */
	isCurrentCompaction?: () => boolean;
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
	canonicalMessages?: readonly AgentMessage[],
): Promise<CompactionProjectionResult> {
	const messages = canonicalMessages ? structuredClone([...canonicalMessages]) : readSessionContextMessages(ctx);
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

type ScopedResponsesCompactInput = {
	request: NativeCompactionRequestBody;
	firstKeptEntryId: string;
	deferredToolCarryover?: DeferredToolCarryoverV1;
	requestSource: "session-context" | "non-native-session-context" | "latest-native-replay";
	isCurrent: () => boolean;
};

/** Reject incomplete/ambiguous tool batches rather than let serialization invent results. */
function requireCompleteCompactionToolPairs(messages: readonly AgentMessage[]): ReadonlyMap<string, string | undefined> {
	const calls = new Map<string, string | undefined>();
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			if (pending.size) throw new Error("compaction-tool-pair-mismatch");
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const callId = block.id.split("|")[0];
				if (!callId || calls.has(callId)) throw new Error("compaction-tool-pair-mismatch");
				calls.set(callId, block.namespace);
				pending.add(block.id);
			}
		} else if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) throw new Error("compaction-tool-pair-mismatch");
		} else if (pending.size && !isSystemTranscriptMessage(message)) {
			throw new Error("compaction-tool-pair-mismatch");
		}
	}
	if (pending.size) throw new Error("compaction-tool-pair-mismatch");
	return calls;
}

/** Serialization must preserve every verified pair, with unique provider call IDs. */
function requireCompactionWireToolPairs(input: readonly unknown[], namespaces: ReadonlyMap<string, string | undefined>): void {
	const calls = new Set<string>();
	const pending = new Set<string>();
	for (const item of input) {
		if (!isRecord(item)) throw new Error("compaction-tool-pair-mismatch");
		if (item.type === "function_call") {
			if (typeof item.call_id !== "string" || !namespaces.has(item.call_id) || calls.has(item.call_id)) {
				throw new Error("compaction-tool-pair-mismatch");
			}
			calls.add(item.call_id);
			pending.add(item.call_id);
		} else if (item.type === "function_call_output") {
			if (typeof item.call_id !== "string" || !pending.delete(item.call_id)) throw new Error("compaction-tool-pair-mismatch");
		}
	}
	if (pending.size || calls.size !== namespaces.size) throw new Error("compaction-tool-pair-mismatch");
}

function requireCompactionHeadAndRetention(
	canonical: readonly AgentMessage[],
	projected: readonly AgentMessage[],
	retained: readonly AgentMessage[],
): void {
	const before = getCurrentTools(canonical);
	const after = getCurrentTools(projected);
	if (!getCurrentSystemMessage(projected) || before.length !== after.length
		|| before.some((tool, index) => !after[index] || !declarationsEqual(tool, after[index]!))) {
		throw new Error("compaction-system-tool-head-lost");
	}
	// These exact source contributions will accompany the new summary in Pi.
	// If a hook rewrites/omits one, future strict retained-copy removal cannot be proven.
	let cursor = 0;
	for (const message of retained) {
		if (message.role === "custom" || message.role === "compactionSummary" || isSystemTranscriptMessage(message)) continue;
		const index = projected.findIndex((candidate, index) => index >= cursor && isDeepStrictEqual(candidate, message));
		if (index < 0) throw new Error("compaction-retained-context-mismatch");
		cursor = index + 1;
	}
}

/** Apply only pure wire adapters, never ordinary turn/history-ingest hooks. */
function adaptCompactionWireInput(input: ResponsesInputItem[], namespaces: ReadonlyMap<string, string | undefined>): ResponsesInputItem[] {
	// The shared legacy serializer omits namespace. Restore it from the verified
	// canonical call before applying the existing context-router wire adapter.
	const namespaced = input.map((item: unknown) => {
		if (!isRecord(item) || item.type !== "function_call" || typeof item.call_id !== "string") return item;
		const namespace = namespaces.get(item.call_id);
		return namespace ? { ...item, namespace } : item;
	});
	const adapted = rewriteEncryptedToolOutputs(rewriteContextNamespaceCalls({ input: namespaced }));
	if (!isRecord(adapted) || !Array.isArray(adapted.input)) throw new Error("compaction-wire-adaptation-failed");
	// The adapters preserve the validated array shape, with native encrypted outputs.
	return adapted.input as ResponsesInputItem[];
}

async function prepareScopedResponsesCompaction(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: CompactionConfig,
	execution: RemoteCompactionExecution,
	dependencies: CompactionDependencies,
	isCurrent: () => boolean,
	prepared: RemoteWindowCompactionInput,
): Promise<ScopedResponsesCompactInput> {
	const windows = dependencies.contextWindows;
	const branch = ctx.sessionManager.getBranch();
	const provenance = getRemoteV2InputProvenance(config.remoteV2ContextSource);
	let checkpoint: NativeCompactionEntry | undefined;
	let requestSource: ScopedResponsesCompactInput["requestSource"] = "session-context";
	if (prepared.owningCompaction) {
		const latest = resolveLatestNativeCompactionEntry(branch, { baseUrl: execution.consumer.baseUrl });
		if (latest.ok) {
			if (latest.entry.id !== prepared.owningCompaction.id) throw new Error("compaction-owner-mismatch");
			if (hasInvalidatedCompactionContext(branch, latest.entry.id)) throw new Error(COMPACTION_CHECKPOINT_CONTEXT_EDITED);
			if (!hasVerifiedCompactionInputProvenance(latest.entry.details, provenance)) throw new Error(COMPACTION_CHECKPOINT_PROVENANCE_UNAVAILABLE);
			checkpoint = latest.entry;
			requestSource = "latest-native-replay";
		} else {
			if (latest.reason !== "latest-compaction-not-native" || !config.allowCompactionContinuityBreak) throw new Error("compaction-continuity-unavailable");
			requestSource = "non-native-session-context";
		}
	}
	let messages = prepared.messages;
	if (config.remoteV2ContextSource === "pi-context-hook") {
		const projection = await windows.withCompactionProjection(() => projectSessionContextForCompaction(
			ctx, dependencies.projectCompactionContext, messages,
		));
		if (!isCurrent()) throw new Error("compaction-operation-superseded");
		if (!projection.ok) throw new Error(projection.reason);
		messages = windows.projectCompactionContext(projection.messages);
	}
	if (!isCurrent()) throw new Error("compaction-operation-superseded");
	requireCompactionHeadAndRetention(prepared.messages, messages, prepared.retainedMessages);
	if (checkpoint) {
		// The synthetic Toolkit hook deliberately leaves these copies alone. Match
		// exactly once, BEFORE encrypted-output markers change the canonical values.
		const pruned = removeNativeCompactionRetainedMessages({
			messages, branchEntries: branch, compactionEntry: checkpoint, expectedInputProvenance: provenance,
		});
		if (!pruned.ok) throw new Error(pruned.reason);
		messages = pruned.messages;
	}
	const namespaces = requireCompleteCompactionToolPairs(messages);
	const tools = getCurrentTools(messages);
	const model = execution.compactor.currentModel;
	const compat = isRecord(model.compat) ? model.compat : {};
	const nativeCodex = model.api === "openai-codex-responses";
	const encoded = windows.projectCompactionContext(messages, true);
	let input: ResponsesInputItem[];
	if (checkpoint) {
		const summaryIndex = findLatestProjectedCompactionSummaryIndex(encoded, checkpoint.summary);
		if (summaryIndex < 0 || encoded.filter((message) => message.role === "compactionSummary").length !== 1) {
			throw new Error(COMPACTION_PROJECTED_CONTEXT_UNAVAILABLE);
		}
		const leading = await serializeMessagesToResponsesInputWithLimits(model, encoded.slice(0, summaryIndex));
		if (!isCurrent()) throw new Error("compaction-operation-superseded");
		const tail = await serializeMessagesToResponsesInputWithLimits(model, encoded.slice(summaryIndex + 1), { firstSystemMessageIsUpdate: true });
		requireCompactionWireToolPairs([...leading, ...tail], namespaces);
		const details = checkpoint.details;
		if (!details) throw new Error("compaction-owner-mismatch");
		input = [...adaptCompactionWireInput(leading, namespaces), ...(cloneOpaqueWindow(details.compactedWindow) as ResponsesInputItem[]), ...adaptCompactionWireInput(tail, namespaces)];
	} else {
		const serialized = await serializeMessagesToResponsesInputWithLimits(model, encoded);
		requireCompactionWireToolPairs(serialized, namespaces);
		input = adaptCompactionWireInput(serialized, namespaces);
	}
	if (!isCurrent()) throw new Error("compaction-operation-superseded");
	const toolPayload = rewriteContextNamespaceTools({ tools: convertResponsesTools(tools, {
		...(nativeCodex ? { strict: null } : {}),
		supportsStrictMode: typeof compat.supportsStrictMode === "boolean" ? compat.supportsStrictMode : nativeCodex,
		supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools === true,
	}) }, { encrypted: true });
	if (!isRecord(toolPayload) || !Array.isArray(toolPayload.tools)) throw new Error("compaction-wire-adaptation-failed");
	// Current cache-stack state is authoritative; never borrow deferred metadata
	// from an unrelated pre-window checkpoint. The canonical head proves which
	// of those schemas are still live, including tools activated before rollover.
	const activation = getLatestDeferredToolCarryover(branch.slice(prepared.windowBoundaryIndex)) ?? checkpoint?.details?.deferredToolCarryover;
	const names = new Set(tools.map((tool) => tool.name));
	const deferredToolCarryover = activation ? { ...activation, toolNames: activation.toolNames.filter((name) => names.has(name)) } : undefined;
	return {
		request: { model: execution.compactor.requestModel ?? execution.compactor.model, input,
			instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions), tools: toolPayload.tools },
		firstKeptEntryId: prepared.firstKeptEntryId,
		deferredToolCarryover: deferredToolCarryover?.toolNames.length ? deferredToolCarryover : undefined,
		requestSource, isCurrent,
	};
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
	/** Window scope is independent of the ordinary producer/fallback policy. */
	scopedInput?: ScopedResponsesCompactInput,
): Promise<ResponsesCompactOutcome> {
	const { consumer, compactor } = execution;
	const instructions = buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions);
	const branchEntries = event.branchEntries ?? ctx.sessionManager.getBranch();
	const deferredToolCarryover = scopedInput ? scopedInput.deferredToolCarryover : getLatestDeferredToolCarryover(branchEntries);
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		baseUrl: consumer.baseUrl,
	});

	const inputProvenance = getRemoteV2InputProvenance(config.remoteV2ContextSource);
	let requestSource: "session-context" | "non-native-session-context" | "latest-native-replay";
	let request: NativeCompactionRequestBody;
	if (scopedInput) {
		request = scopedInput.request;
		requestSource = scopedInput.requestSource;
	} else if (latestNativeCompaction.ok) {
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
		request = { ...request, ...extras, ...(scopedInput ? { tools: scopedInput.request.tools } : {}) };
	}

	if (event.signal?.aborted || (scopedInput && !scopedInput.isCurrent())) return { outcome: "aborted" };
	let protocol: "remote-v2" | "standalone-compact" = "remote-v2";
	let compactResult: Awaited<ReturnType<typeof executeRemoteV2Compaction>> | NativeCompactionClientResult = await remoteCompact({
		runtime: compactor,
		request,
		signal: event.signal,
		settings: config,
		context: ctx,
	});

	if (scopedInput && !scopedInput.isCurrent()) return { outcome: "aborted" };
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
		firstKeptEntryId: scopedInput?.firstKeptEntryId ?? event.preparation.firstKeptEntryId,
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

	if (scopedInput && !scopedInput.isCurrent()) return { outcome: "aborted" };
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

	// Window ownership survives model-policy changes, including Pi/disabled mode.
	// Resolve it before any ordinary or default compactor can receive this input.
	try {
		dependencies.contextWindows.synchronize(ctx);
	} catch {
		notifyRemoteContextFailure(ctx, "malformed-window-state");
		return { cancel: true };
	}

	// A rollover trim is owned maintenance, not user /compact.
	if (dependencies.manualCompact?.isMaintenance) return dependencies.contextWindows.prepareCompaction(event);

	// Preserve the existing automatic Remote Windows protocol. Manual operations
	// select their engine by current policy, never by persisted marker ownership.
	if (event.reason !== "manual" && config.enabled && config.contextManagement === "remote") {
		const contextModel = await resolveContextCapabilityModel(ctx);
		if (isCodexContextModel(contextModel, config)) {
			if (await remoteContextActive(ctx, config, contextModel)) return dependencies.contextWindows.prepareCompaction(event);
			return runUnavailableContextCompaction(event, ctx, dependencies, resolved, config, getContextToolRegistrationState());
		}
	}

	const isCurrent = dependencies.isCurrentCompaction ?? (() => !event.signal.aborted);
	let scope: RemoteWindowCompactionInput | undefined;
	if (dependencies.contextWindows.currentIdentity()) {
		scope = dependencies.contextWindows.prepareRemoteCompaction(event, ctx);
		requireCompleteCompactionToolPairs(scope.messages);
		event = prepareScopedNativeCompaction(event, scope);
		const keptIndex = event.branchEntries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
		scope = { ...scope, firstKeptEntryId: event.preparation.firstKeptEntryId,
			retainedMessages: scope.entries.filter((entry) => entry.sourceEntry.type !== "compaction"
				&& event.branchEntries.findIndex((raw) => raw.id === entry.sourceEntry.id) >= keptIndex)
				.flatMap((entry) => entry.messages) };
		if (!isCurrent()) return { cancel: true };
	}
	const nativeScopeSafe = () => {
		if (scope && !event.preparation.messagesToSummarize.length && !event.preparation.turnPrefixMessages.length && !event.preparation.previousSummary) {
			notifyWarning(ctx, "Current window has no eligible native summary span; context preserved.");
			return false;
		}
		const owner = scope?.owningCompaction;
		if (!owner) return true;
		const opaque = owner.summary === NATIVE_COMPACTION_FALLBACK_SUMMARY || owner.summary === STANDALONE_COMPACTION_FALLBACK_SUMMARY
			|| (isRecord(owner.details) && (owner.details.strategy === REMOTE_V2_COMPACTION_STRATEGY || owner.details.strategy === LEGACY_NATIVE_COMPACTION_STRATEGY));
		if (!opaque) return true;
		// Pi's text summarizer cannot interpret a Toolkit encrypted checkpoint.
		// Replacing it with a summary of its sentinel would silently lose history.
		notifyWarning(ctx, "Native compression cannot merge the current encrypted checkpoint; context preserved.");
		return false;
	};
	const nativeDefault = async () => {
		if (!scope) return undefined;
		if (!nativeScopeSafe()) return { cancel: true };
		const result = await dependencies.nativeFallback({ ctx, event, config, scoped: true, useCurrentModel: true, isCurrent });
		if (!isCurrent() || !result.ok) {
			if (!result.ok) notifyWarning(ctx, `Current-window native compression stopped (${result.reason}); context preserved.`);
			return { cancel: true };
		}
		return { compaction: result.result };
	};
	if (!config.enabled || resolved.policy.context.mode !== "remote-compaction") return nativeDefault();

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
	if (scope && !isCurrent()) return { cancel: true };
	if (resolution.ok) {
		const scopedInput = scope ? await prepareScopedResponsesCompaction(event, ctx, config, resolution.execution, dependencies, isCurrent, scope) : undefined;
		remoteAttempted = true;
		const responsesOutcome = await runResponsesNativeCompact(
			event,
			ctx,
			config,
			resolution.execution,
			dependencies.remoteCompact,
			dependencies.projectCompactionContext,
			dependencies.standaloneCompact,
			scopedInput,
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
	if (scope && !nativeScopeSafe()) return { cancel: true };
	const fallback = await dependencies.nativeFallback({ ctx, event, config, modelSpec: fallbackModelSpec, ...(scope ? { scoped: true, isCurrent } : {}) });
	if (scope && !isCurrent()) return { cancel: true };
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

	// An unscoped undefined handoff would reopen archived windows. A scoped
	// current-model selection uses the public native primitive instead.
	return nativeDefault();
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
	try {
		contextWindows.synchronize(ctx);
	} catch {
		notifyRemoteContextFailure(ctx, "malformed-window-state");
		reportPiContextHookFailure(ctx, "malformed-window-state");
		ctx.abort();
		return undefined;
	}

	// A synthetic compression projection is read-only in EVERY mode. The
	// caller performs the sole retained-copy match after all ordered hooks;
	// ordinary replay here would remove the same copies a second time.
	if (contextWindows.isPreparingCompaction) return { messages: contextWindows.projectCompactionContext(event.messages) };

	let localMessages: AgentMessage[] | undefined;
	let remoteReplayProjection = false;
	// Disabled and intentionally downgraded runtimes never enter opaque replay,
	// but still honor a window already owned by this session.
	let localProjectionOnly = !config.enabled;
	if (config.enabled && config.contextManagement === "remote") {
		const contextModel = await resolveContextCapabilityModel(ctx);
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
			if (!isExcludedGatewayContext(contextModel, config, registrationState)
				&& isCodexGatewayModel(contextModel, config.gatewayContextModels)) {
				const reason = contextManagementFailureReason(registrationState);
				notifyRemoteContextFailure(ctx, reason);
				reportPiContextHookFailure(ctx, reason);
				ctx.abort();
				return undefined;
			}
			localProjectionOnly = true;
		}
	}

	if (!remoteReplayProjection) {
		try {
			const projected = contextWindows.project(event.messages, "local");
			localMessages = projected;
			if (localProjectionOnly || contextWindows.hasEffectiveWindow()) {
				// A persisted boundary owns earlier history regardless of the selected
				// mode. Neither disabled policy nor ordinary replay may expand it.
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
	try {
		contextWindows.synchronize(ctx);
	} catch {
		notifyRemoteContextFailure(ctx, "malformed-window-state");
		ctx.abort();
		return undefined;
	}
	if (!config.enabled) {
		return undefined;
	}

	const contextModel = config.contextManagement === "remote"
		? await resolveContextCapabilityModel(ctx)
		: undefined;
	const remoteActive = config.contextManagement === "remote" && await remoteContextActive(ctx, config, contextModel);
	let remotePayload: unknown;
	let activeWindowPayload = false;
	if (remoteActive) {
		try {
			remotePayload = contextWindows.rewritePayload(event.payload, ctx);
			activeWindowPayload = contextWindows.hasEffectiveWindow() || !contextWindows.currentIdentity();
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
	if (contextWindows.hasEffectiveWindow() && !activeWindowPayload) return undefined;

	const branchEntries = ctx.sessionManager.getBranch();
	const inherited = !activeWindowPayload && config.contextManagement === "remote" && contextWindows.hasSupersededWindow()
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

	// Capture is pre-Web-Search metadata only. An effective Remote window still
	// owns this live payload and must NEVER enter ordinary opaque replay below.
	if (activeWindowPayload) return remotePayload;

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
	const manualCompact = new ManagedManualCompact(pi);
	let compactionGeneration = 0;
	const invalidateCompaction = () => { compactionGeneration++; };
	const dependencies: CompactionDependencies = {
		remoteCompact: executeRemoteV2Compaction,
		standaloneCompact: executeNativeCompaction,
		nativeFallback: runNativeFallbackCompaction,
		contextWindows,
		...overrides,
		manualCompact,
		loadConfig,
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
		invalidateCompaction();
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
	pi.on("session_before_compact", async (event, ctx) => {
		invalidateCompaction();
		const generation = compactionGeneration;
		const branch = structuredClone(event.branchEntries);
		const sessionId = getSessionId(ctx);
		const model = ctx.model ? { ...ctx.model } : undefined;
		const thinking = ctx.thinkingLevel;
		const isCurrent = () => generation === compactionGeneration && !event.signal.aborted
			&& getSessionId(ctx) === sessionId && isDeepStrictEqual(branch, ctx.sessionManager.getBranch())
			&& isDeepStrictEqual(model, ctx.model)
			&& thinking === ctx.thinkingLevel
			&& !(event.reason === "manual" && typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages());
		try {
			const result = await handleSessionBeforeCompact(event, ctx, { ...dependencies, isCurrentCompaction: isCurrent }, remoteContextActive, getContextToolRegistrationState);
			if (contextWindows.currentIdentity() && !manualCompact.isMaintenance && result && "compaction" in result && result.compaction
				&& result.compaction.summary !== CONTEXT_WINDOW_COMPACTION_SUMMARY) {
				// Pi consumes this after every later before-compact observer. Reject
				// stale work then, without broad aborts that can drain host queues.
				return { compaction: result.compaction, get cancel() { return !isCurrent(); } };
			}
			return result;
		} catch {
			// Pi treats a rejected hook as absent and can invoke its implicit summary.
			// Unexpected preparation/service failures must never authorize that work.
			try { notifyWarning(ctx, "Compaction stopped; existing context preserved. Resume manually."); } catch { /* stale UI */ }
			return { cancel: true };
		}
	});
	pi.on("session_compact", (event, ctx) => {
		contextWindows.synchronize(ctx);
		invalidateCompaction();
	});
	pi.on("session_compact_failed", invalidateCompaction);
	pi.on("session_shutdown", async (_event, ctx) => {
		invalidateCompaction();
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
		invalidateCompaction();
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
		invalidateCompaction();
		await syncTools(ctx, ctx.model, { notifyWindowFailure: true });
	});
	pi.on("agent_start", () => invalidateCompaction());
	pi.on("input", () => { invalidateCompaction(); });
	pi.on("thinking_level_select", (event, ctx) => {
		invalidateCompaction();
		manualCompact.thinkingSelected(event.level, ctx);
	});
	pi.on("message_start", invalidateCompaction);
	pi.on("turn_end", (_event, ctx) => manualCompact.turnEnded(ctx));
	pi.on("tool_call", (event) => {
		invalidateCompaction();
		return manualCompact.guardTool(event.toolName);
	});
	pi.on("session_before_switch", () => invalidateCompaction());
	pi.on("session_before_fork", () => invalidateCompaction());
	pi.on("session_before_tree", () => invalidateCompaction());
	pi.on("session_tree", async (_event, ctx) => {
		invalidateCompaction();
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
