import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { CompactionEntry, CompactionResult, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export const TOOLKIT_ID = "pi-openai-toolkit";
export const COMPACTION_EXTENSION_ID = `${TOOLKIT_ID}:compaction`;
export const WEB_SEARCH_EXTENSION_ID = `${TOOLKIT_ID}:web-search`;
export const IMAGE_GENERATION_EXTENSION_ID = `${TOOLKIT_ID}:image-generation`;
export const AUTO_MODE_EXTENSION_ID = `${TOOLKIT_ID}:auto-mode`;
export const DEFAULT_ARTIFACT_ROOT = "~/.pi/agent/artifacts/pi-openai-toolkit/compaction";
export const REDACTED_VALUE = "[REDACTED]";
/**
 * APIs the extension knows how to build a `/responses/compact` URL for.
 * `compaction.responsesApis` in config.json may only narrow this set.
 */
export const RESPONSES_COMPACT_CAPABLE_APIS = ["openai-responses", "openai-codex-responses"] as const;
export const LEGACY_NATIVE_COMPACTION_STRATEGY = "openai-native-compact-v1";
export const REMOTE_V2_COMPACTION_STRATEGY = "openai-remote-compaction-v2";
export const NATIVE_COMPACTION_STRATEGY = REMOTE_V2_COMPACTION_STRATEGY;
/**
 * Pi currently requires CompactionResult.summary to be text. This marker is only a
 * replay shim; the provider receives the opaque item from details.compactedWindow.
 */
export const NATIVE_COMPACTION_FALLBACK_SUMMARY = "[OpenAI remote v2 opaque compaction checkpoint]";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export type DebugArtifactKind =
	| "provider-request"
	| "compact-response"
	| "compaction-event"
	| "lifecycle";

export type ContextManagementMode = "off" | "remote";

/** Native-method fallback compaction: which model runs pi's compact() and how deeply. */
export type NativeFallbackConfig = {
	enabled: boolean;
	/**
	 * "provider/model-id" used for native-method fallback compaction when the active model
	 * cannot use remote v2 at all. A failed remote request is instead summarized by
	 * `remoteCompactModel`; the two sources never substitute for each other. Unset means the
	 * active model via pi's default path.
	 */
	model?: string;
	/** Thinking level passed to pi's native compact() when the fallback model runs. */
	thinkingLevel: ThinkingLevel;
};

export type CompactionConfig = {
	enabled: boolean;
	/** Optional Codex Remote Context management. Disabled by default for compatibility. */
	contextManagement: ContextManagementMode;
	/** Exact provider/model specs allowed to use the extension's CPA-backed Codex gateway. */
	codexGatewayModels: string[];
	/**
	 * Allow a Responses session whose latest compaction was not created by this extension
	 * to restart native compaction from Pi's current serialized session context.
	 */
	allowCompactionContinuityBreak: boolean;
	/**
	 * "provider/model-id" used only for remote_compaction_v2. The active session model
	 * remains the checkpoint consumer and continues handling normal requests.
	 */
	remoteCompactModel?: string;
	/** Native-method fallback compaction policy (non-Responses APIs, or when the compact endpoint fails). */
	nativeFallback: NativeFallbackConfig;
	/**
	 * Subset of RESPONSES_COMPACT_CAPABLE_APIS that should use remote compaction.
	 */
	responsesApis: string[];
	/**
	 * Percentage of the context window that, when remaining tokens drop below it,
	 * triggers a checkpoint/new_context reminder (0-100; 0 disables reminders).
	 */
	contextReminderThresholdPercent: number;
	notifyOnLoad: boolean;
	debug: boolean;
	logProviderPayloads: boolean;
	logCompactResponses: boolean;
	redactSensitiveData: boolean;
	artifactRoot: string;
};

export type WebSearchConfig = {
	enabled: boolean;
	/** Exact provider/model keys allowed to use toolkit-native Web Search. */
	models: string[];
};

export type ImageGenerationConfig = {
	enabled: boolean;
};

export type CodexAstraConfig = {
	enabled: boolean;
	/** Exact provider/model keys that receive the stable-effort `configuration_update` rewrite. */
	models: string[];
};

/** `side-effect` reviews bash/write/edit plus extras; `all` reviews every tool call. */
export type AutoModeGate = "side-effect" | "all";

export type AutoModeConfig = {
	enabled: boolean;
	/** Exact provider/model keys whose sessions may engage auto mode. */
	models: string[];
	/** "provider/model-id" that approves gated tool calls while auto mode is engaged. */
	reviewerModel?: string;
	gate: AutoModeGate;
	/** Extra tool names reviewed on top of the side-effect default set. */
	extraTools: string[];
	/** Reviewer deadline in ms; expiry degrades to human confirmation or fail-closed. */
	timeoutMs: number;
	/** Give the reviewer a bounded transcript so it can judge user authorization. */
	transcript: boolean;
	/** Let the reviewer spend read-only tool calls establishing facts before deciding. */
	evidenceTools: boolean;
	maxEvidenceRounds: number;
	/** Non-blocking trajectory pre-scorer that can satisfy ordinary gated calls. */
	classifier: AutoModeClassifierConfig;
	/** End a turn that keeps getting denied instead of negotiating forever. */
	circuitBreaker: AutoModeCircuitBreakerConfig;
};

export type AutoModeClassifierConfig = {
	enabled: boolean;
	/** "provider/model-id"; falls back to `autoMode.reviewerModel` when unset. */
	model?: string;
	timeoutMs: number;
	/** How many tool calls may elapse between scoring and use before a score is stale. */
	maxLag: number;
};

export type AutoModeCircuitBreakerConfig = {
	/** Consecutive reviewer denials in one turn that end the turn. 0 disables. */
	consecutiveDenials: number;
	/** Denials inside `windowSize` reviewed calls that end the turn. 0 disables. */
	recentDenials: number;
	windowSize: number;
};

export const REVIEWER_TIMEOUT_MIN_MS = 1_000;
export const REVIEWER_TIMEOUT_MAX_MS = 120_000;

/** Read-only investigation rounds the reviewer may spend before it must answer. */
export const EVIDENCE_ROUNDS_MIN = 0;
export const EVIDENCE_ROUNDS_MAX = 8;

export const CLASSIFIER_MAX_LAG_MIN = 0;
export const CLASSIFIER_MAX_LAG_MAX = 20;

export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 15_000;

/** Denial counts are small integers; 0 disables the matching trigger. */
export const BREAKER_LIMIT_MIN = 0;
export const BREAKER_LIMIT_MAX = 100;
export const BREAKER_WINDOW_MIN = 1;
export const BREAKER_WINDOW_MAX = 200;

export type ToolkitConfig = {
	compaction: CompactionConfig;
	webSearch: WebSearchConfig;
	imageGeneration: ImageGenerationConfig;
	autoMode: AutoModeConfig;
	codexAstra: CodexAstraConfig;
};

export type LoadedToolkitConfig = {
	config: ToolkitConfig;
	/** Path of the config file that was applied, if it existed and parsed. */
	source?: string;
	warnings: string[];
};

export type ArtifactPaths = {
	rootDir: string;
	sessionDir: string;
	providerRequestsDir: string;
	compactResponsesDir: string;
	compactionDir: string;
	lifecycleDir: string;
};

export type ArtifactSessionInfo = {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	sessionDir?: string;
};

export type ArtifactContext = ArtifactSessionInfo | Pick<ExtensionContext, "cwd" | "sessionManager">;

export type DebugArtifactEnvelope = {
	extension: string;
	kind: DebugArtifactKind;
	timestamp: string;
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	sessionDir?: string;
	redaction: {
		enabled: boolean;
	};
	data: unknown;
};

export type RedactOptions = {
	placeholder?: string;
};

export type NativeCompactionStrategy =
	| typeof LEGACY_NATIVE_COMPACTION_STRATEGY
	| typeof REMOTE_V2_COMPACTION_STRATEGY;

export type NativeCompactionRequestMeta = {
	tokensBefore?: number;
	previousSummaryPresent?: boolean;
};

export type NativeCompactionIdentity = {
	provider: string;
	api: string;
	model: string;
	baseUrl: string;
};

export const CACHE_STACK_ACTIVATION_ENTRY_TYPE = "pi-cache-stack.activation-state.v1" as const;

export type DeferredToolCarryoverV1 = {
	version: 1;
	source: typeof CACHE_STACK_ACTIVATION_ENTRY_TYPE;
	toolNames: string[];
	catalogHash?: string;
};

export type NativeCompactionDetails = NativeCompactionIdentity & {
	strategy: NativeCompactionStrategy;
	/** Actual producer of the opaque checkpoint; absent on legacy same-model entries. */
	compactionModel?: NativeCompactionIdentity;
	/** Cache-stack activation state captured at this opaque checkpoint. */
	deferredToolCarryover?: DeferredToolCarryoverV1;
	compactedWindow: unknown[];
	compactResponseId?: string;
	createdAt: string;
	requestMeta?: NativeCompactionRequestMeta;
};

export type NativeCompactionEntry = CompactionEntry<NativeCompactionDetails>;

export type CreateNativeCompactionDetailsInput = NativeCompactionIdentity & {
	compactionModel?: NativeCompactionIdentity;
	deferredToolCarryover?: DeferredToolCarryoverV1;
	compactedWindow: unknown[];
	compactResponseId?: string;
	createdAt?: string;
	requestMeta?: NativeCompactionRequestMeta;
};

export type CreateNativeCompactionResultInput = {
	firstKeptEntryId: string;
	tokensBefore: number;
	details: NativeCompactionDetails;
	/**
	 * Summary text extracted from the compact response. Stored as the entry summary so
	 * pi's default replay still has real context after switching to an unsupported model.
	 */
	summary?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeString(value: string): string {
	return value.trim();
}

function isStructuredValue(value: unknown): boolean {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true;
	}

	if (Array.isArray(value)) {
		return value.every(isStructuredValue);
	}

	if (isRecord(value)) {
		return Object.values(value).every(isStructuredValue);
	}

	return false;
}

function cloneStructuredValue(value: unknown): unknown {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map(cloneStructuredValue);
	}

	if (isRecord(value)) {
		const clone: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			clone[key] = cloneStructuredValue(nested);
		}
		return clone;
	}

	throw new Error(`Unsupported structured value: ${typeof value}`);
}

function isCompactedWindowItem(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && Object.values(value).every(isStructuredValue);
}

export function isNativeCompactionRequestMeta(value: unknown): value is NativeCompactionRequestMeta {
	if (!isRecord(value)) {
		return false;
	}

	const { tokensBefore, previousSummaryPresent } = value;
	if (tokensBefore !== undefined && !isFiniteNonNegativeNumber(tokensBefore)) {
		return false;
	}

	if (previousSummaryPresent !== undefined && typeof previousSummaryPresent !== "boolean") {
		return false;
	}

	return true;
}

export function isNativeCompactionIdentity(value: unknown): value is NativeCompactionIdentity {
	if (!isRecord(value)) {
		return false;
	}

	return (
		isNonEmptyString(value.provider) &&
		isNonEmptyString(value.api) &&
		isNonEmptyString(value.model) &&
		isNonEmptyString(value.baseUrl)
	);
}

export function isDeferredToolCarryover(value: unknown): value is DeferredToolCarryoverV1 {
	if (!isRecord(value) || value.version !== 1 || value.source !== CACHE_STACK_ACTIVATION_ENTRY_TYPE) {
		return false;
	}

	return (
		Array.isArray(value.toolNames) &&
		value.toolNames.every((name) => isNonEmptyString(name)) &&
		(value.catalogHash === undefined || typeof value.catalogHash === "string")
	);
}

function normalizeDeferredToolCarryover(value: DeferredToolCarryoverV1): DeferredToolCarryoverV1 {
	if (!isDeferredToolCarryover(value)) {
		throw new Error("Invalid deferred tool carryover");
	}

	return {
		version: 1,
		source: CACHE_STACK_ACTIVATION_ENTRY_TYPE,
		toolNames: [...new Set(value.toolNames.map((name) => name.trim()).filter(Boolean))].sort(),
		...(typeof value.catalogHash === "string" ? { catalogHash: value.catalogHash } : {}),
	};
}

function decodeCacheStackActivationState(value: unknown): DeferredToolCarryoverV1 | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.catalogHash !== "string") {
		return undefined;
	}
	if (!Array.isArray(value.activatedTools) || !value.activatedTools.every((name) => typeof name === "string")) {
		return undefined;
	}

	return normalizeDeferredToolCarryover({
		version: 1,
		source: CACHE_STACK_ACTIVATION_ENTRY_TYPE,
		toolNames: value.activatedTools,
		catalogHash: value.catalogHash,
	});
}

/** Read only the latest valid cache-stack activation snapshot on this branch. */
export function getLatestDeferredToolCarryover(
	entries: readonly SessionEntry[],
): DeferredToolCarryoverV1 | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== CACHE_STACK_ACTIVATION_ENTRY_TYPE) {
			continue;
		}

		const decoded = decodeCacheStackActivationState(entry.data);
		if (decoded) return decoded;
	}

	return undefined;
}

export function isNativeCompactionDetails(value: unknown): value is NativeCompactionDetails {
	if (!isRecord(value) || !isNativeCompactionIdentity(value)) {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	return (
		(candidate.strategy === LEGACY_NATIVE_COMPACTION_STRATEGY ||
			candidate.strategy === REMOTE_V2_COMPACTION_STRATEGY) &&
		(candidate.compactionModel === undefined || isNativeCompactionIdentity(candidate.compactionModel)) &&
		(candidate.deferredToolCarryover === undefined || isDeferredToolCarryover(candidate.deferredToolCarryover)) &&
		Array.isArray(candidate.compactedWindow) &&
		candidate.compactedWindow.every(isCompactedWindowItem) &&
		isNonEmptyString(candidate.createdAt) &&
		(candidate.compactResponseId === undefined || isNonEmptyString(candidate.compactResponseId)) &&
		(candidate.requestMeta === undefined || isNativeCompactionRequestMeta(candidate.requestMeta))
	);
}

export function isNativeCompactionEntry(value: unknown): value is NativeCompactionEntry {
	return isRecord(value) && value.type === "compaction" && isNativeCompactionDetails(value.details);
}

export function createNativeCompactionDetails(input: CreateNativeCompactionDetailsInput): NativeCompactionDetails {
	return {
		strategy: NATIVE_COMPACTION_STRATEGY,
		provider: normalizeString(input.provider),
		api: normalizeString(input.api),
		model: normalizeString(input.model),
		baseUrl: normalizeString(input.baseUrl),
		compactionModel: input.compactionModel
			? {
				provider: normalizeString(input.compactionModel.provider),
				api: normalizeString(input.compactionModel.api),
				model: normalizeString(input.compactionModel.model),
				baseUrl: normalizeString(input.compactionModel.baseUrl),
			}
			: undefined,
		deferredToolCarryover: input.deferredToolCarryover
			? normalizeDeferredToolCarryover(input.deferredToolCarryover)
			: undefined,
		compactedWindow: input.compactedWindow.map((item) => cloneStructuredValue(item)),
		compactResponseId: isNonEmptyString(input.compactResponseId) ? normalizeString(input.compactResponseId) : undefined,
		createdAt: isNonEmptyString(input.createdAt) ? normalizeString(input.createdAt) : new Date().toISOString(),
		requestMeta: input.requestMeta
			? {
				...(input.requestMeta.tokensBefore !== undefined ? { tokensBefore: input.requestMeta.tokensBefore } : {}),
				...(input.requestMeta.previousSummaryPresent !== undefined
					? { previousSummaryPresent: input.requestMeta.previousSummaryPresent }
					: {}),
			}
			: undefined,
	};
}

export function createNativeCompactionResult(
	input: CreateNativeCompactionResultInput,
): CompactionResult<NativeCompactionDetails> {
	const summary = input.summary?.trim();
	return {
		summary: summary && summary.length > 0 ? summary : NATIVE_COMPACTION_FALLBACK_SUMMARY,
		firstKeptEntryId: input.firstKeptEntryId,
		tokensBefore: input.tokensBefore,
		details: input.details,
	};
}

export const DEFAULT_NATIVE_FALLBACK_CONFIG: NativeFallbackConfig = {
	enabled: true,
	model: undefined,
	thinkingLevel: "off",
};

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
	enabled: true,
	contextManagement: "off",
	codexGatewayModels: [],
	allowCompactionContinuityBreak: false,
	remoteCompactModel: undefined,
	nativeFallback: { ...DEFAULT_NATIVE_FALLBACK_CONFIG },
	responsesApis: [...RESPONSES_COMPACT_CAPABLE_APIS],
	contextReminderThresholdPercent: 5,
	notifyOnLoad: false,
	debug: false,
	logProviderPayloads: false,
	logCompactResponses: false,
	redactSensitiveData: true,
	artifactRoot: DEFAULT_ARTIFACT_ROOT,
};

export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConfig = {
	enabled: true,
	models: [],
};

export const DEFAULT_IMAGE_GENERATION_CONFIG: ImageGenerationConfig = {
	enabled: false,
};

export const DEFAULT_CODEX_ASTRA_CONFIG: CodexAstraConfig = {
	enabled: false,
	models: [],
};

export const DEFAULT_AUTO_MODE_CONFIG: AutoModeConfig = {
	enabled: true,
	models: [],
	reviewerModel: undefined,
	gate: "side-effect",
	extraTools: [],
	timeoutMs: 30_000,
	transcript: true,
	evidenceTools: true,
	maxEvidenceRounds: 3,
	classifier: {
		enabled: false,
		model: undefined,
		timeoutMs: DEFAULT_CLASSIFIER_TIMEOUT_MS,
		maxLag: 2,
	},
	circuitBreaker: {
		consecutiveDenials: 3,
		recentDenials: 10,
		windowSize: 50,
	},
};

export const DEFAULT_TOOLKIT_CONFIG: ToolkitConfig = {
	compaction: DEFAULT_COMPACTION_CONFIG,
	webSearch: DEFAULT_WEB_SEARCH_CONFIG,
	imageGeneration: DEFAULT_IMAGE_GENERATION_CONFIG,
	autoMode: DEFAULT_AUTO_MODE_CONFIG,
	codexAstra: DEFAULT_CODEX_ASTRA_CONFIG,
};
