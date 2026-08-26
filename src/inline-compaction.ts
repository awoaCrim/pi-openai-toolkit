import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type {
	AgentLoopTurnUpdate,
	AgentMessage,
	PrepareNextTurnContext,
	ShouldStopAfterTurnContext,
} from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type {
	CompactionContinuationMode,
	CompactionConfig,
	LoadedToolkitConfig,
} from "./types";

export const SUPPORTED_OFFICIAL_PI_VERSION = "0.84.3";
export const INLINE_COMPACTION_FOLLOW_UP_TYPE = "pi-openai-toolkit.inline-compaction-follow-up.v1";
const DEFAULT_RESERVE_TOKENS = 16_384;
const ADAPTER_MARKER = Symbol.for("pi-openai-toolkit.inline-compaction.adapter.v1");

type ConfigLoader = () => LoadedToolkitConfig;
type UnknownRecord = Record<string, unknown>;
type PrepareNextTurnHandler = (
	context: PrepareNextTurnContext,
	signal?: AbortSignal,
) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
type ShouldStopAfterTurnHandler = (
	context: ShouldStopAfterTurnContext,
	signal?: AbortSignal,
) => boolean | Promise<boolean>;
type EmitExtensionEventHandler = (this: object, event: unknown) => Promise<void>;
type CompactHandler = (customInstructions?: string) => Promise<unknown>;
type AbortHandler = () => Promise<void>;
type CreateExtensionContextHandler = () => ExtensionContext;

type HostAgent = {
	state: {
		messages: AgentMessage[];
		pendingToolCalls?: ReadonlySet<string>;
	};
	prepareNextTurnWithContext?: PrepareNextTurnHandler;
	shouldStopAfterTurn?: ShouldStopAfterTurnHandler;
	signal?: AbortSignal;
};

type HostSession = {
	raw: UnknownRecord;
	agent: HostAgent;
	compact: CompactHandler;
	abort: AbortHandler;
	abortCompaction: () => void;
	extensionRunner: {
		createContext: CreateExtensionContextHandler;
	};
	sessionManager: {
		getBranch: () => readonly unknown[];
	};
	settingsManager: {
		getCompactionSettings: () => {
			enabled: boolean;
			reserveTokens: number;
			keepRecentTokens: number;
		};
	};
};

type HostConstructor = {
	prototype: object;
};

type HostTurnEndEvent = {
	type: "turn_end";
	message: AgentMessage;
	toolResults: ToolResultMessage[];
};

type PendingInline = {
	turnId: string;
	message: AgentMessage;
	beforeMessages: AgentMessage[];
	compactedMessages?: AgentMessage[];
	compactionIdBefore?: string;
	compactionIdAfter?: string;
	contextTokens: number;
};

type PublicPending = {
	turnId: string;
};

type PublicSessionState = {
	pending?: PublicPending;
	lastHandledTurnId?: string;
};

type GlobalAdapterMarker = {
	version: string;
	originalEmitExtensionEvent: EmitExtensionEventHandler;
	runtime?: InlineCompactionRuntime;
	adapters: WeakMap<object, {
		runtime: InlineCompactionRuntime;
		adapter: InlineCompactionCoordinator;
	}>;
};

export type HostPreflightResult = {
	ok: boolean;
	version: string;
	supportsInline: boolean;
	supportsFollowUp: boolean;
	reason?: string;
};

export type TurnBoundaryInput = {
	enabled: boolean;
	continuation: CompactionContinuationMode;
	message: unknown;
	toolResults: readonly unknown[];
	contextUsage?: {
		tokens: number | null;
		contextWindow: number;
	};
	reserveTokens: number;
	toolResultsIncluded?: boolean;
	pendingToolCalls?: number;
	alreadyCompacted?: boolean;
	externalAborted?: boolean;
};

export type TurnBoundaryDecision = {
	compact: boolean;
	reason:
		| "disabled"
		| "continuation-off"
		| "aborted"
		| "not-assistant"
		| "terminal-turn"
		| "no-tool-calls"
		| "incomplete-tool-pairing"
		| "pending-tool-calls"
		| "unknown-usage"
		| "invalid-context-window"
		| "already-compacted"
		| "below-threshold"
		| "threshold-exceeded";
	contextTokens?: number;
	threshold?: number;
};

export type CompactabilityDecision = {
	compactable: boolean;
	reason:
		| "compactable"
		| "already-compacted"
		| "invalid-branch"
		| "missing-first-kept-entry"
		| "nothing-to-summarize";
};

export type InlineCompactionState = {
	installed: boolean;
	inFlight: boolean;
	pendingTurnId?: string;
	lastCompactedBaseline?: number;
	lastFailureReason?: string;
	lastSkipReason?: CompactabilityDecision["reason"];
	adapterStatus: "supported" | "unsupported" | "failed";
};

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCallable(value: unknown): value is (...args: never[]) => unknown {
	return typeof value === "function";
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getTurnToolCallIds(message: unknown): string[] {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
		return [];
	}

	const ids: string[] = [];
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall") continue;
		const id = getString(block.id);
		if (id) ids.push(id);
	}
	return ids;
}

function getToolResultCallIds(toolResults: readonly unknown[]): string[] {
	const ids: string[] = [];
	for (const result of toolResults) {
		if (!isRecord(result) || result.role !== "toolResult") continue;
		const id = getString(result.toolCallId);
		if (id) ids.push(id);
	}
	return ids;
}

function hasCompleteToolPairing(message: unknown, toolResults: readonly unknown[]): boolean {
	const callIds = getTurnToolCallIds(message);
	const resultIds = getToolResultCallIds(toolResults);
	if (callIds.length === 0 || callIds.length !== resultIds.length) return false;

	const calls = new Set(callIds);
	if (calls.size !== callIds.length) return false;
	const results = new Set(resultIds);
	return (
		results.size === resultIds.length &&
		resultIds.every((id, index) => id === callIds[index] && calls.has(id))
	);
}

function hasPairedResultsInMessages(
	messages: readonly AgentMessage[],
	message: AgentMessage,
	toolResults: readonly ToolResultMessage[],
): boolean {
	if (!hasCompleteToolPairing(message, toolResults)) return false;
	const expected = new Set(getToolResultCallIds(toolResults));
	const found = new Set<string>();
	for (const candidate of messages) {
		if (!isRecord(candidate) || candidate.role !== "toolResult") continue;
		const callId = getString(candidate.toolCallId);
		if (callId && expected.has(callId)) found.add(callId);
	}
	return found.size === expected.size;
}

function getTurnId(message: unknown): string {
	if (!isRecord(message)) return "unknown";
	const role = getString(message.role) ?? "unknown";
	const timestamp = typeof message.timestamp === "number" ? String(message.timestamp) : "unknown";
	const model = getString(message.model) ?? "unknown";
	const stopReason = getString(message.stopReason) ?? "unknown";
	const callIds = getTurnToolCallIds(message).join(",");
	return `${role}:${timestamp}:${model}:${stopReason}:${callIds}`;
}

function isSameTurn(left: AgentMessage, right: AgentMessage, turnId: string): boolean {
	return left === right || getTurnId(left) === turnId || getTurnId(right) === turnId;
}

function isTerminalAssistantMessage(message: unknown): boolean {
	if (!isRecord(message) || message.role !== "assistant") return true;
	return (
		message.stopReason === "aborted" ||
		message.stopReason === "error" ||
		message.stopReason === "length" ||
		message.stopReason === "deferred" ||
		message.stopReason === "pending"
	);
}

function estimateToolResultTokens(toolResults: readonly unknown[]): number {
	const estimator = (PiCodingAgent as unknown as UnknownRecord).estimateTokens;
	let total = 0;
	for (const result of toolResults) {
		if (typeof estimator === "function") {
			try {
				total += (estimator as (message: AgentMessage) => number)(result as AgentMessage);
				continue;
			} catch {
				// Use the conservative structural estimate below.
			}
		}
		try {
			total += Math.ceil(JSON.stringify(result).length / 4);
		} catch {
			return Number.POSITIVE_INFINITY;
		}
	}
	return total;
}

/** Validate a completed tool batch before attempting automatic compaction. */
export function evaluateTurnBoundary(input: TurnBoundaryInput): TurnBoundaryDecision {
	if (!input.enabled) return { compact: false, reason: "disabled" };
	if (input.continuation === "off") return { compact: false, reason: "continuation-off" };
	if (input.externalAborted) return { compact: false, reason: "aborted" };
	if (!isRecord(input.message) || input.message.role !== "assistant") {
		return { compact: false, reason: "not-assistant" };
	}
	if (isTerminalAssistantMessage(input.message)) return { compact: false, reason: "terminal-turn" };
	if (getTurnToolCallIds(input.message).length === 0) return { compact: false, reason: "no-tool-calls" };
	if (!hasCompleteToolPairing(input.message, input.toolResults)) {
		return { compact: false, reason: "incomplete-tool-pairing" };
	}
	if ((input.pendingToolCalls ?? 0) > 0) return { compact: false, reason: "pending-tool-calls" };
	if (input.alreadyCompacted) return { compact: false, reason: "already-compacted" };
	if (!input.contextUsage || input.contextUsage.tokens === null || !Number.isFinite(input.contextUsage.tokens)) {
		return { compact: false, reason: "unknown-usage" };
	}
	if (!Number.isFinite(input.contextUsage.contextWindow) || input.contextUsage.contextWindow <= 0) {
		return { compact: false, reason: "invalid-context-window" };
	}

	const missingToolResultTokens = input.toolResultsIncluded === false
		? estimateToolResultTokens(input.toolResults)
		: 0;
	const contextTokens = input.contextUsage.tokens + missingToolResultTokens;
	if (!Number.isFinite(contextTokens)) return { compact: false, reason: "unknown-usage" };

	const reserveTokens = Number.isFinite(input.reserveTokens) && input.reserveTokens >= 0
		? input.reserveTokens
		: DEFAULT_RESERVE_TOKENS;
	const threshold = input.contextUsage.contextWindow - reserveTokens;
	if (contextTokens <= threshold) {
		return { compact: false, reason: "below-threshold", contextTokens, threshold };
	}
	return { compact: true, reason: "threshold-exceeded", contextTokens, threshold };
}

function toSessionEntries(branch: readonly unknown[]): SessionEntry[] | undefined {
	if (
		branch.some(
			(entry) =>
				!isRecord(entry) ||
				typeof entry.type !== "string" ||
				typeof entry.id !== "string",
		)
	) {
		return undefined;
	}
	return branch.slice() as SessionEntry[];
}

function rangeHasContextMessages(entries: SessionEntry[], start: number, end: number): boolean {
	for (let index = start; index < end; index += 1) {
		const entry = entries[index];
		if (entry?.type === "compaction") continue;
		if (PiCodingAgent.sessionEntryToContextMessages(entry).length > 0) return true;
	}
	return false;
}

/**
 * Mirror official Pi 0.84.3's `prepareCompaction()` eligibility test using its
 * exported cut-point and session-entry helpers. This is a gate only; the actual
 * compaction still runs through AgentSession.compact() and its normal hooks.
 */
export function evaluateCompactionCompactability(
	branch: readonly unknown[],
	keepRecentTokens: number,
): CompactabilityDecision {
	const entries = toSessionEntries(branch);
	if (!entries) return { compactable: false, reason: "invalid-branch" };
	if (entries.at(-1)?.type === "compaction") {
		return { compactable: false, reason: "already-compacted" };
	}

	let previousCompactionIndex = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index]?.type === "compaction") {
			previousCompactionIndex = index;
			break;
		}
	}

	let boundaryStart = 0;
	if (previousCompactionIndex >= 0) {
		const previousCompaction = entries[previousCompactionIndex];
		if (previousCompaction?.type !== "compaction") {
			return { compactable: false, reason: "invalid-branch" };
		}
		const firstKeptEntryIndex = entries.findIndex(
			(entry) => entry.id === previousCompaction.firstKeptEntryId,
		);
		boundaryStart = firstKeptEntryIndex >= 0
			? firstKeptEntryIndex
			: previousCompactionIndex + 1;
	}

	const effectiveKeepRecentTokens =
		Number.isFinite(keepRecentTokens) && keepRecentTokens >= 0
			? keepRecentTokens
			: PiCodingAgent.DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
	try {
		const cutPoint = PiCodingAgent.findCutPoint(
			entries,
			boundaryStart,
			entries.length,
			effectiveKeepRecentTokens,
		);
		const firstKeptEntry = entries[cutPoint.firstKeptEntryIndex];
		if (!firstKeptEntry?.id) {
			return { compactable: false, reason: "missing-first-kept-entry" };
		}

		const historyEnd = cutPoint.isSplitTurn
			? cutPoint.turnStartIndex
			: cutPoint.firstKeptEntryIndex;
		const hasHistory = rangeHasContextMessages(entries, boundaryStart, historyEnd);
		const hasTurnPrefix =
			cutPoint.isSplitTurn &&
			cutPoint.turnStartIndex >= boundaryStart &&
			rangeHasContextMessages(entries, cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex);
		return hasHistory || hasTurnPrefix
			? { compactable: true, reason: "compactable" }
			: { compactable: false, reason: "nothing-to-summarize" };
	} catch {
		return { compactable: false, reason: "invalid-branch" };
	}
}

function getOfficialRuntimeVersion(): string {
	return getString((PiCodingAgent as unknown as UnknownRecord).VERSION) ?? "unknown";
}

function getHostConstructor(): HostConstructor | undefined {
	const candidate = (PiCodingAgent as unknown as UnknownRecord).AgentSession;
	if (typeof candidate !== "function") return undefined;
	const prototype = (candidate as { prototype?: unknown }).prototype;
	if (!isRecord(prototype)) return undefined;
	return candidate as unknown as HostConstructor;
}

function canAssign(object: object, property: string): boolean {
	if (!Object.isExtensible(object)) return false;
	let current: object | null = object;
	while (current) {
		const descriptor = Object.getOwnPropertyDescriptor(current, property);
		if (descriptor) return descriptor.writable === true || descriptor.set !== undefined;
		current = Object.getPrototypeOf(current);
	}
	return true;
}

function toHostSession(value: unknown): HostSession | undefined {
	if (!isRecord(value) || !isRecord(value.agent) || !isRecord(value.agent.state)) return undefined;
	if (!Array.isArray(value.agent.state.messages)) return undefined;
	if (!isCallable(value.compact) || !isCallable(value.abort) || !isCallable(value.abortCompaction)) return undefined;
	if (!isRecord(value.extensionRunner) || !isCallable(value.extensionRunner.createContext)) return undefined;
	if (!isRecord(value.sessionManager) || !isCallable(value.sessionManager.getBranch)) return undefined;
	if (!isRecord(value.settingsManager) || !isCallable(value.settingsManager.getCompactionSettings)) return undefined;

	const rawRunner = value.extensionRunner as UnknownRecord;
	return {
		raw: value,
		agent: value.agent as unknown as HostAgent,
		compact: (value.compact as CompactHandler).bind(value),
		abort: (value.abort as AbortHandler).bind(value),
		abortCompaction: (value.abortCompaction as () => void).bind(value),
		extensionRunner: {
			createContext: (rawRunner.createContext as CreateExtensionContextHandler).bind(value.extensionRunner),
		},
		sessionManager: {
			getBranch: (value.sessionManager.getBranch as () => readonly unknown[]).bind(value.sessionManager),
		},
		settingsManager: {
			getCompactionSettings: (value.settingsManager.getCompactionSettings as HostSession["settingsManager"]["getCompactionSettings"]).bind(value.settingsManager),
		},
	};
}

function createContextFromHost(value: unknown): ExtensionContext | undefined {
	if (!isRecord(value) || !isRecord(value.extensionRunner) || !isCallable(value.extensionRunner.createContext)) {
		return undefined;
	}
	try {
		return (value.extensionRunner.createContext as CreateExtensionContextHandler).call(value.extensionRunner);
	} catch {
		return undefined;
	}
}

/** Preflight the complete official 0.84.3 host shape before changing any host method. */
export function preflightInlineCompactionHost(
	host: unknown,
	version: string = getOfficialRuntimeVersion(),
): HostPreflightResult {
	const session = toHostSession(host);
	if (!session) {
		return {
			ok: false,
			version,
			supportsInline: false,
			supportsFollowUp: true,
			reason: "missing-agent-session-shape",
		};
	}
	if (version !== SUPPORTED_OFFICIAL_PI_VERSION) {
		return {
			ok: false,
			version,
			supportsInline: false,
			supportsFollowUp: true,
			reason: "unsupported-official-pi-version",
		};
	}

	const agentObject = session.raw.agent;
	if (
		!isRecord(agentObject) ||
		typeof session.agent.prepareNextTurnWithContext !== "function" ||
		!canAssign(agentObject, "prepareNextTurnWithContext") ||
		!canAssign(agentObject, "shouldStopAfterTurn") ||
		!canAssign(session.raw, "abort")
	) {
		return {
			ok: false,
			version,
			supportsInline: false,
			supportsFollowUp: true,
			reason: "missing-inline-seam",
		};
	}

	return {
		ok: true,
		version,
		supportsInline: true,
		supportsFollowUp: true,
	};
}

function getLatestCompactionId(host: HostSession): string | undefined {
	try {
		const branch = host.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			if (isRecord(entry) && entry.type === "compaction") return getString(entry.id);
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function getEffectiveCompactionSettings(
	host: HostSession,
	config: CompactionConfig,
): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
	try {
		const official = host.settingsManager.getCompactionSettings();
		return {
			enabled: official.enabled,
			reserveTokens: config.autoCompaction.reserveTokens ?? official.reserveTokens,
			keepRecentTokens: official.keepRecentTokens,
		};
	} catch {
		return {
			enabled: true,
			reserveTokens: config.autoCompaction.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
			keepRecentTokens: PiCodingAgent.DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
		};
	}
}

function toHostTurnEndEvent(event: unknown): HostTurnEndEvent | undefined {
	if (!isRecord(event) || event.type !== "turn_end" || !Array.isArray(event.toolResults)) return undefined;
	if (!isRecord(event.message)) return undefined;
	return event as unknown as HostTurnEndEvent;
}

export class InlineCompactionCoordinator {
	private readonly host: HostSession;
	private readonly originalPrepareNextTurnWithContext: PrepareNextTurnHandler;
	private readonly originalShouldStopAfterTurn?: ShouldStopAfterTurnHandler;
	private readonly wrappedPrepareNextTurnWithContext: PrepareNextTurnHandler;
	private readonly wrappedShouldStopAfterTurn: ShouldStopAfterTurnHandler;
	private pending: PendingInline | undefined;
	private forceStopTurnId: string | undefined;
	private lastCompactedTurnId: string | undefined;
	private lastSkippedTurnId: string | undefined;
	private disposed = false;
	private readonly mutableState: InlineCompactionState;

	constructor(hostValue: unknown, version = getOfficialRuntimeVersion()) {
		const preflight = preflightInlineCompactionHost(hostValue, version);
		const host = toHostSession(hostValue);
		if (!host || !preflight.supportsInline || !host.agent.prepareNextTurnWithContext) {
			throw new Error(preflight.reason ?? "Cannot install inline compaction host adapter");
		}
		this.host = host;
		this.originalPrepareNextTurnWithContext = host.agent.prepareNextTurnWithContext;
		this.originalShouldStopAfterTurn = host.agent.shouldStopAfterTurn;
		this.mutableState = {
			installed: false,
			inFlight: false,
			adapterStatus: "supported",
		};

		this.wrappedPrepareNextTurnWithContext = async (context, signal) => {
			const pending = this.pending;
			if (!pending) {
				return await this.originalPrepareNextTurnWithContext(context, signal);
			}
			if (signal?.aborted) {
				this.failClosed(getTurnId(context.message), "agent-run-aborted-before-next-turn");
				return undefined;
			}

			let update: AgentLoopTurnUpdate | undefined;
			try {
				update = await this.originalPrepareNextTurnWithContext(context, signal);
			} catch (error) {
				this.failClosed(getTurnId(context.message), `prepare-next-turn: ${toErrorMessage(error)}`);
				return undefined;
			}
			if (!isSameTurn(context.message, pending.message, pending.turnId)) {
				this.failClosed(getTurnId(context.message), "stale-next-turn-context");
				return update;
			}

			const messages = this.host.agent.state.messages;
			const latestCompactionId = getLatestCompactionId(this.host);
			if (
				!pending.compactedMessages ||
				messages !== pending.compactedMessages ||
				latestCompactionId === undefined ||
				latestCompactionId !== pending.compactionIdAfter
			) {
				this.failClosed(pending.turnId, "compacted-host-state-changed-before-next-turn");
				return update;
			}

			const baseContext = update?.context ?? context.context;
			this.mutableState.lastCompactedBaseline = pending.contextTokens;
			this.lastCompactedTurnId = pending.turnId;
			this.pending = undefined;
			this.mutableState.inFlight = false;
			this.mutableState.pendingTurnId = undefined;
			return {
				...update,
				context: {
					...baseContext,
					messages: messages.slice(),
				},
			};
		};

		this.wrappedShouldStopAfterTurn = async (context, signal) => {
			const turnId = getTurnId(context.message);
			if (this.forceStopTurnId && (this.forceStopTurnId === turnId || this.forceStopTurnId === "unknown")) {
				this.forceStopTurnId = undefined;
				return true;
			}
			return this.originalShouldStopAfterTurn
				? await this.originalShouldStopAfterTurn(context, signal)
				: false;
		};

		const agent = host.raw.agent as UnknownRecord;
		try {
			agent.prepareNextTurnWithContext = this.wrappedPrepareNextTurnWithContext;
			agent.shouldStopAfterTurn = this.wrappedShouldStopAfterTurn;
			this.mutableState.installed = true;
		} catch (error) {
			if (agent.prepareNextTurnWithContext === this.wrappedPrepareNextTurnWithContext) {
				agent.prepareNextTurnWithContext = this.originalPrepareNextTurnWithContext;
			}
			if (agent.shouldStopAfterTurn === this.wrappedShouldStopAfterTurn) {
				agent.shouldStopAfterTurn = this.originalShouldStopAfterTurn;
			}
			throw error;
		}
	}

	get state(): InlineCompactionState {
		return { ...this.mutableState };
	}

	matchesSessionManager(sessionManager: unknown): boolean {
		return sessionManager === this.host.raw.sessionManager;
	}

	/** Clear a successful continuation that had no next turn (for example, a terminal tool batch). */
	handleAgentEnd(): void {
		this.pending = undefined;
		this.forceStopTurnId = undefined;
		this.mutableState.inFlight = false;
		this.mutableState.pendingTurnId = undefined;
	}

	getPublicFallbackEnvironment(
		config: CompactionConfig,
	): {
		context: ExtensionContext;
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
		abortCompaction: () => void;
	} | undefined {
		try {
			const settings = getEffectiveCompactionSettings(this.host, config);
			return {
				context: this.host.extensionRunner.createContext(),
				enabled: settings.enabled,
				reserveTokens: settings.reserveTokens,
				keepRecentTokens: settings.keepRecentTokens,
				abortCompaction: this.host.abortCompaction,
			};
		} catch {
			return undefined;
		}
	}

	async handleTurnEnd(event: HostTurnEndEvent, config: CompactionConfig): Promise<void> {
		if (this.disposed || this.pending || this.mutableState.inFlight) return;
		let context: ExtensionContext;
		try {
			context = this.host.extensionRunner.createContext();
		} catch {
			return;
		}

		const officialSettings = getEffectiveCompactionSettings(this.host, config);
		const turnId = getTurnId(event.message);
		const decision = evaluateTurnBoundary({
			enabled: config.enabled && config.autoCompaction.enabled && officialSettings.enabled,
			continuation: config.autoCompaction.continuation,
			message: event.message,
			toolResults: event.toolResults,
			contextUsage: context.getContextUsage(),
			reserveTokens: officialSettings.reserveTokens,
			toolResultsIncluded: true,
			pendingToolCalls: this.host.agent.state.pendingToolCalls?.size ?? 0,
			alreadyCompacted:
				this.lastCompactedTurnId === turnId || this.lastSkippedTurnId === turnId,
			externalAborted: this.host.agent.signal?.aborted,
		});
		if (!decision.compact) return;

		const compactability = evaluateCompactionCompactability(
			this.host.sessionManager.getBranch(),
			officialSettings.keepRecentTokens,
		);
		if (!compactability.compactable) {
			this.skipInline(turnId, compactability.reason);
			return;
		}

		await this.runInline(
			event.message,
			event.toolResults,
			turnId,
			decision.contextTokens ?? 0,
			this.host.agent.signal,
		);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.pending = undefined;
		this.forceStopTurnId = undefined;
		this.lastSkippedTurnId = undefined;
		this.mutableState.inFlight = false;
		this.mutableState.pendingTurnId = undefined;
		const agent = this.host.raw.agent as UnknownRecord;
		if (agent.prepareNextTurnWithContext === this.wrappedPrepareNextTurnWithContext) {
			agent.prepareNextTurnWithContext = this.originalPrepareNextTurnWithContext;
		}
		if (agent.shouldStopAfterTurn === this.wrappedShouldStopAfterTurn) {
			agent.shouldStopAfterTurn = this.originalShouldStopAfterTurn;
		}
	}

	private async runInline(
		message: AgentMessage,
		toolResults: ToolResultMessage[],
		turnId: string,
		contextTokens: number,
		runSignal: AbortSignal | undefined,
	): Promise<void> {
		const beforeMessages = this.host.agent.state.messages;
		const pending: PendingInline = {
			turnId,
			message,
			beforeMessages,
			compactionIdBefore: getLatestCompactionId(this.host),
			contextTokens,
		};
		this.pending = pending;
		this.mutableState.inFlight = true;
		this.mutableState.pendingTurnId = turnId;
		const removeAbortListener = this.bindExternalAbort(runSignal);
		let abortPatch: { restore: () => void; suppressedCalls: () => number };
		try {
			abortPatch = this.suppressCompactOwnedAbort();
		} catch (error) {
			removeAbortListener();
			this.failClosed(turnId, `install-abort-seam: ${toErrorMessage(error)}`);
			return;
		}
		try {
			await this.host.compact();
			if (runSignal?.aborted || abortPatch.suppressedCalls() !== 1) {
				this.failClosed(
					turnId,
					runSignal?.aborted
						? "agent-run-aborted-during-compaction"
						: `unexpected-compact-abort-count:${abortPatch.suppressedCalls()}`,
				);
				return;
			}
			const afterMessages = this.host.agent.state.messages;
			const compactionIdAfter = getLatestCompactionId(this.host);
			if (
				!Array.isArray(afterMessages) ||
				afterMessages === beforeMessages ||
				compactionIdAfter === undefined ||
				compactionIdAfter === pending.compactionIdBefore ||
				!hasPairedResultsInMessages(afterMessages, message, toolResults)
			) {
				this.failClosed(turnId, "compacted-host-state-validation-failed");
				return;
			}
			pending.compactedMessages = afterMessages;
			pending.compactionIdAfter = compactionIdAfter;
			this.mutableState.inFlight = false;
			this.mutableState.lastFailureReason = undefined;
			this.mutableState.lastSkipReason = undefined;
		} catch (error) {
			const message = toErrorMessage(error);
			if (message === "Nothing to compact (session too small)") {
				this.skipInline(turnId, "nothing-to-summarize");
			} else {
				this.failClosed(turnId, `compact: ${message}`);
			}
		} finally {
			removeAbortListener();
			abortPatch.restore();
		}
	}

	private bindExternalAbort(signal: AbortSignal | undefined): () => void {
		if (!signal) return () => {};
		const listener = () => this.host.abortCompaction();
		signal.addEventListener("abort", listener, { once: true });
		return () => signal.removeEventListener("abort", listener);
	}

	private suppressCompactOwnedAbort(): { restore: () => void; suppressedCalls: () => number } {
		const hostObject = this.host.raw;
		const originalAbort = this.host.abort;
		let suppressedCalls = 0;
		let expectingCompactAbort = true;
		const replacement: AbortHandler = async () => {
			if (expectingCompactAbort) {
				expectingCompactAbort = false;
				suppressedCalls += 1;
				return;
			}
			await originalAbort();
		};
		const previous = Object.getOwnPropertyDescriptor(hostObject, "abort");
		Object.defineProperty(hostObject, "abort", {
			configurable: true,
			enumerable: previous?.enumerable ?? false,
			writable: true,
			value: replacement,
		});
		return {
			suppressedCalls: () => suppressedCalls,
			restore: () => {
				try {
					if (previous) Object.defineProperty(hostObject, "abort", previous);
					else delete hostObject.abort;
				} catch {
					this.mutableState.adapterStatus = "failed";
				}
			},
		};
	}

	private skipInline(turnId: string, reason: CompactabilityDecision["reason"]): void {
		this.pending = undefined;
		this.lastSkippedTurnId = turnId;
		this.mutableState.inFlight = false;
		this.mutableState.pendingTurnId = undefined;
		this.mutableState.lastFailureReason = undefined;
		this.mutableState.lastSkipReason = reason;
	}

	private failClosed(turnId: string, reason: string): void {
		this.pending = undefined;
		this.forceStopTurnId = turnId;
		this.mutableState.inFlight = false;
		this.mutableState.pendingTurnId = undefined;
		this.mutableState.lastFailureReason = reason;
		this.mutableState.adapterStatus = "failed";
	}
}

function getMarker(prototype: object): GlobalAdapterMarker | undefined {
	const value = (prototype as unknown as Record<PropertyKey, unknown>)[ADAPTER_MARKER];
	return isRecord(value) &&
		value.version === SUPPORTED_OFFICIAL_PI_VERSION &&
		isCallable(value.originalEmitExtensionEvent) &&
		value.adapters instanceof WeakMap
		? value as unknown as GlobalAdapterMarker
		: undefined;
}

function installHostBridge(runtime: InlineCompactionRuntime): HostPreflightResult {
	const version = getOfficialRuntimeVersion();
	if (version !== SUPPORTED_OFFICIAL_PI_VERSION) {
		return {
			ok: false,
			version,
			supportsInline: false,
			supportsFollowUp: true,
			reason: "unsupported-official-pi-version",
		};
	}
	const constructor = getHostConstructor();
	if (!constructor) {
		return {
			ok: false,
			version,
			supportsInline: false,
			supportsFollowUp: true,
			reason: "official-agent-session-not-exported",
		};
	}
	const existing = getMarker(constructor.prototype);
	if (existing) {
		existing.runtime = runtime;
		return {
			ok: true,
			version: existing.version,
			supportsInline: true,
			supportsFollowUp: true,
		};
	}

	const prototype = constructor.prototype as unknown as UnknownRecord;
	const original = prototype._emitExtensionEvent;
	if (!isCallable(original) || !canAssign(constructor.prototype, "_emitExtensionEvent")) {
		return {
			ok: false,
			version,
			supportsInline: false,
			supportsFollowUp: true,
			reason: "missing-extension-event-seam",
		};
	}

	const marker: GlobalAdapterMarker = {
		version,
		originalEmitExtensionEvent: original as EmitExtensionEventHandler,
		runtime,
		adapters: new WeakMap(),
	};
	const wrapped: EmitExtensionEventHandler = async function (this: object, event: unknown): Promise<void> {
		await marker.originalEmitExtensionEvent.call(this, event);
		const currentRuntime = marker.runtime;
		const turnEnd = toHostTurnEndEvent(event);
		const agentEnd = isRecord(event) && event.type === "agent_end";
		if (!currentRuntime || (!turnEnd && !agentEnd)) return;

		let entry = marker.adapters.get(this);
		if (agentEnd) {
			entry?.adapter.handleAgentEnd();
			return;
		}
		if (!turnEnd) return;
		if (entry && entry.runtime !== currentRuntime) {
			entry.adapter.dispose();
			marker.adapters.delete(this);
			entry = undefined;
		}
		if (!entry) {
			try {
				const adapter = new InlineCompactionCoordinator(this, marker.version);
				entry = { runtime: currentRuntime, adapter };
				marker.adapters.set(this, entry);
				currentRuntime.trackAdapter(this, adapter);
			} catch {
				const context = createContextFromHost(this);
				if (context) await currentRuntime.handleUnsupportedHostTurn(turnEnd, context);
				return;
			}
		}
		await currentRuntime.handlePrivateTurnEnd(entry.adapter, turnEnd);
	};

	const previousEmitDescriptor = Object.getOwnPropertyDescriptor(constructor.prototype, "_emitExtensionEvent");
	try {
		Object.defineProperty(constructor.prototype, "_emitExtensionEvent", {
			configurable: true,
			enumerable: previousEmitDescriptor?.enumerable ?? false,
			writable: true,
			value: wrapped,
		});
		Object.defineProperty(constructor.prototype, ADAPTER_MARKER, {
			configurable: true,
			enumerable: false,
			writable: false,
			value: marker,
		});
	} catch {
		try {
			if (previousEmitDescriptor) {
				Object.defineProperty(constructor.prototype, "_emitExtensionEvent", previousEmitDescriptor);
			} else {
				prototype._emitExtensionEvent = original;
			}
		} catch {
			// The caller receives a failed status and will use only public fallback APIs.
		}
		return {
			ok: false,
			version,
			supportsInline: false,
			supportsFollowUp: true,
			reason: "adapter-install-failed",
		};
	}

	return { ok: true, version, supportsInline: true, supportsFollowUp: true };
}

export class InlineCompactionRuntime {
	readonly installation: HostPreflightResult;
	private readonly pi: Pick<ExtensionAPI, "sendMessage">;
	private readonly loadConfig: ConfigLoader;
	private publicSessionStates = new WeakMap<object, PublicSessionState>();
	private readonly adapters = new Set<{ host: object; adapter: InlineCompactionCoordinator }>();
	private disposed = false;
	private unsupportedNotified = false;

	constructor(pi: Pick<ExtensionAPI, "sendMessage">, loadConfig: ConfigLoader) {
		this.pi = pi;
		this.loadConfig = loadConfig;
		this.installation = installHostBridge(this);
	}

	async handlePublicTurnEnd(event: TurnEndEvent, context: ExtensionContext): Promise<void> {
		if (this.disposed) return;
		const config = this.getConfig();
		if (!config) return;
		if (this.installation.supportsInline) return;
		if (
			config.autoCompaction.continuation === "inline" &&
			config.autoCompaction.unsupportedFallback === "off"
		) {
			this.notifyUnsupported(context, config, this.installation.reason ?? "unsupported host adapter");
			return;
		}
		await this.startPublicFallback(event, context, config);
	}

	async handlePrivateTurnEnd(
		adapter: InlineCompactionCoordinator,
		event: HostTurnEndEvent,
	): Promise<void> {
		if (this.disposed) return;
		const config = this.getConfig();
		if (!config || config.autoCompaction.continuation === "off") return;
		if (config.autoCompaction.continuation === "inline") {
			await adapter.handleTurnEnd(event, config);
			return;
		}

		const fallback = adapter.getPublicFallbackEnvironment(config);
		if (!fallback) return;
		await this.startPublicFallback(event, fallback.context, config, {
			enabled: fallback.enabled,
			reserveTokens: fallback.reserveTokens,
			keepRecentTokens: fallback.keepRecentTokens,
			abortCompaction: fallback.abortCompaction,
		});
	}

	async handleUnsupportedHostTurn(event: HostTurnEndEvent, context: ExtensionContext): Promise<void> {
		if (this.disposed) return;
		const config = this.getConfig();
		if (!config || config.autoCompaction.continuation === "off") return;
		if (
			config.autoCompaction.continuation === "inline" &&
			config.autoCompaction.unsupportedFallback === "off"
		) {
			this.notifyUnsupported(context, config, "unsupported AgentSession shape");
			return;
		}
		await this.startPublicFallback(event, context, config);
	}

	trackAdapter(host: object, adapter: InlineCompactionCoordinator): void {
		this.adapters.add({ host, adapter });
	}

	dispose(context?: ExtensionContext): void {
		if (context) {
			for (const entry of [...this.adapters]) {
				if (!entry.adapter.matchesSessionManager(context.sessionManager)) continue;
				entry.adapter.dispose();
				this.adapters.delete(entry);
			}
			const sessionState = this.publicSessionStates.get(context.sessionManager);
			if (sessionState) sessionState.pending = undefined;
			this.publicSessionStates.delete(context.sessionManager);
			return;
		}
		if (this.disposed) return;
		this.disposed = true;
		this.publicSessionStates = new WeakMap();
		for (const entry of this.adapters) entry.adapter.dispose();
		this.adapters.clear();
		const constructor = getHostConstructor();
		const marker = constructor ? getMarker(constructor.prototype) : undefined;
		if (marker?.runtime === this) marker.runtime = undefined;
	}

	private getConfig(): CompactionConfig | undefined {
		try {
			return this.loadConfig().config.compaction;
		} catch {
			return undefined;
		}
	}

	private async startPublicFallback(
		event: Pick<TurnEndEvent, "message" | "toolResults">,
		context: ExtensionContext,
		config: CompactionConfig,
		settings?: {
			enabled: boolean;
			reserveTokens: number;
			keepRecentTokens: number;
			abortCompaction?: () => void;
		},
	): Promise<void> {
		const sessionKey = context.sessionManager;
		let sessionState = this.publicSessionStates.get(sessionKey);
		if (!sessionState) {
			sessionState = {};
			this.publicSessionStates.set(sessionKey, sessionState);
		}
		if (sessionState.pending) return;
		const turnId = getTurnId(event.message);
		const decision = evaluateTurnBoundary({
			enabled: config.enabled && config.autoCompaction.enabled && (settings?.enabled ?? true),
			continuation: config.autoCompaction.continuation,
			message: event.message,
			toolResults: event.toolResults,
			contextUsage: context.getContextUsage(),
			reserveTokens:
				settings?.reserveTokens ??
				config.autoCompaction.reserveTokens ??
				DEFAULT_RESERVE_TOKENS,
			toolResultsIncluded: true,
			pendingToolCalls: 0,
			alreadyCompacted: sessionState.lastHandledTurnId === turnId,
			externalAborted: context.signal?.aborted,
		});
		if (!decision.compact) return;

		const compactability = evaluateCompactionCompactability(
			context.sessionManager.getBranch(),
			settings?.keepRecentTokens ?? PiCodingAgent.DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
		);
		if (!compactability.compactable) {
			sessionState.lastHandledTurnId = turnId;
			return;
		}

		const pending = { turnId };
		sessionState.pending = pending;
		let compactInvocationActive = true;
		let externallyAborted = false;
		let removeAbortListener = () => {};
		const onAbort = () => {
			// Official Pi's public compact() first aborts the active agent run. That
			// synchronous abort belongs to this fallback operation, not the user.
			if (compactInvocationActive) return;
			externallyAborted = true;
			if (sessionState.pending !== pending) return;
			sessionState.lastHandledTurnId = turnId;
			sessionState.pending = undefined;
			settings?.abortCompaction?.();
		};
		if (context.signal) {
			context.signal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () => context.signal?.removeEventListener("abort", onAbort);
		}
		const cleanup = () => {
			removeAbortListener();
			removeAbortListener = () => {};
		};
		try {
			context.compact({
				onComplete: () => {
					cleanup();
					if (this.disposed || sessionState.pending !== pending || externallyAborted) return;
					sessionState.lastHandledTurnId = turnId;
					sessionState.pending = undefined;
					this.sendHiddenFollowUp(turnId);
				},
				onError: () => {
					cleanup();
					if (this.disposed || sessionState.pending !== pending) return;
					sessionState.lastHandledTurnId = turnId;
					sessionState.pending = undefined;
					// Compaction failures fail closed. A hidden follow-up is only
					// valid after a successful host compaction.
				},
			});
		} catch {
			cleanup();
			if (sessionState.pending === pending) {
				sessionState.lastHandledTurnId = turnId;
				sessionState.pending = undefined;
			}
		} finally {
			compactInvocationActive = false;
		}
	}

	private sendHiddenFollowUp(turnId: string): void {
		try {
			this.pi.sendMessage(
				{
					customType: INLINE_COMPACTION_FOLLOW_UP_TYPE,
					content: "Continue the unfinished task from the completed tool batch. Do not treat this as new user intent.",
					display: false,
					details: {
						owner: "pi-openai-toolkit",
						turnId,
						mode: "followUp",
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// Extension reload/session replacement can stale the captured API. Pending
			// state was cleared before this call, so the failure cannot loop.
		}
	}

	private notifyUnsupported(context: ExtensionContext, config: CompactionConfig, reason: string): void {
		if (this.unsupportedNotified || !config.debug || !context.hasUI) return;
		this.unsupportedNotified = true;
		context.ui.notify(
			`pi-openai-toolkit: inline compaction unavailable (${reason}); automatic continuation is off`,
			"warning",
		);
	}
}

export function registerInlineCompactionRuntime(
	pi: Pick<ExtensionAPI, "sendMessage">,
	loadConfig: ConfigLoader,
): InlineCompactionRuntime {
	return new InlineCompactionRuntime(pi, loadConfig);
}
