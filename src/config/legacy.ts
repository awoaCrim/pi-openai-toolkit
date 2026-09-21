import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_TOOLKIT_CONFIG,
	DEFAULT_AUTO_MODE_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_IMAGE_GENERATION_MODEL,
	DEFAULT_NATIVE_FALLBACK_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
	RESPONSES_COMPACT_CAPABLE_APIS,
	BREAKER_LIMIT_MAX,
	BREAKER_LIMIT_MIN,
	BREAKER_WINDOW_MAX,
	BREAKER_WINDOW_MIN,
	CLASSIFIER_MAX_LAG_MAX,
	CLASSIFIER_MAX_LAG_MIN,
	DEFAULT_CLASSIFIER_TIMEOUT_MS,
	EVIDENCE_ROUNDS_MAX,
	EVIDENCE_ROUNDS_MIN,
	REVIEWER_TIMEOUT_MAX_MS,
	REVIEWER_TIMEOUT_MIN_MS,
	THINKING_LEVELS,
	TOOLKIT_ID,
	type AutoModeCircuitBreakerConfig,
	type AutoModeClassifierConfig,
	type AutoModeConfig,
	type AutoModeGate,
	type CompactionConfig,
	type ContextManagementMode,
	type LeaveManagedModePolicy,
	type ImageGenerationConfig,
	type RemoteV2ContextSource,
	type LoadedToolkitConfig,
	type NativeFallbackConfig,
	type ToolkitConfig,
	type WebSearchConfig,
	type WebSearchRoute,
} from "../types";
import { MAX_IMAGE_MODEL_ID_CHARS } from "../image-generation/types";

export const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", TOOLKIT_ID);
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const TOP_LEVEL_FIELDS = new Set(["compaction", "webSearch", "imageGeneration", "autoMode"]);
const COMPACTION_FIELDS = new Set([
	"enabled",
	"leaveManagedMode",
	"contextManagement",
	"allowCompactionContinuityBreak",
	"remoteCompactModel",
	"remoteV2ContextSource",
	"nativeFallback",
	"responsesApis",
	"gatewayContextModels",
	"contextReminderThresholdPercent",
	"notifyOnLoad",
	"debug",
	"logProviderPayloads",
	"logCompactResponses",
	"redactSensitiveData",
	"artifactRoot",
]);
const NATIVE_FALLBACK_FIELDS = new Set(["enabled", "model", "thinkingLevel"]);
const WEB_SEARCH_FIELDS = new Set(["enabled", "models", "defaultRoute", "routes"]);
const IMAGE_GENERATION_FIELDS = new Set(["enabled", "models"]);
const AUTO_MODE_FIELDS = new Set([
	"enabled",
	"models",
	"reviewerModel",
	"gate",
	"extraTools",
	"timeoutMs",
	"transcript",
	"evidenceTools",
	"maxEvidenceRounds",
	"classifier",
	"circuitBreaker",
]);
const AUTO_MODE_CLASSIFIER_FIELDS = new Set(["enabled", "model", "timeoutMs", "maxLag"]);
const AUTO_MODE_BREAKER_FIELDS = new Set(["consecutiveDenials", "recentDenials", "windowSize"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveConfiguredPath(rawPath: string, baseDir: string): string {
	if (rawPath.startsWith("~/")) {
		return path.join(os.homedir(), rawPath.slice(2));
	}
	if (path.isAbsolute(rawPath)) {
		return path.resolve(rawPath);
	}
	return path.resolve(baseDir, rawPath);
}

function warnUnknownFields(
	value: Record<string, unknown>,
	knownFields: ReadonlySet<string>,
	fieldPath: string,
	warnings: string[],
): void {
	for (const key of Object.keys(value)) {
		if (!knownFields.has(key)) {
			warnings.push(`Ignoring ${fieldPath ? `${fieldPath}.` : ""}${key}: unknown field.`);
		}
	}
}

function toBoolean(value: unknown, fieldPath: string, warnings: string[]): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	warnings.push(`Ignoring ${fieldPath}: expected a boolean.`);
	return undefined;
}

function toLeaveManagedMode(
	value: unknown,
	fieldPath: string,
	warnings: string[],
): LeaveManagedModePolicy | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const normalized = value.trim();
		if (normalized === "warn" || normalized === "compact") return normalized;
	}
	warnings.push(`Ignoring ${fieldPath}: expected one of warn, compact.`);
	return undefined;
}

function toContextManagementMode(
	value: unknown,
	fieldPath: string,
	warnings: string[],
): ContextManagementMode | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const normalized = value.trim();
		if (normalized === "off" || normalized === "remote") return normalized;
	}
	warnings.push(`Ignoring ${fieldPath}: expected one of off, remote.`);
	return undefined;
}

function toRemoteV2ContextSource(
	value: unknown,
	fieldPath: string,
	warnings: string[],
): RemoteV2ContextSource | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const normalized = value.trim();
		if (normalized === "pi-context-hook" || normalized === "legacy") return normalized;
	}
	warnings.push(`Ignoring ${fieldPath}: expected one of pi-context-hook, legacy.`);
	return undefined;
}

function toModelSpec(value: unknown, fieldPath: string, warnings: string[]): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value === "string" && value.trim().length > 0) {
		return value.trim();
	}
	warnings.push(`Ignoring ${fieldPath}: expected "provider/model-id" or null.`);
	return undefined;
}

function toThinkingLevel(value: unknown, fieldPath: string, warnings: string[]): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
		return value as ThinkingLevel;
	}
	warnings.push(`Ignoring ${fieldPath}: expected one of ${THINKING_LEVELS.join(", ")}.`);
	return undefined;
}

function toBoundedInteger(
	value: unknown,
	fieldPath: string,
	warnings: string[],
	min: number,
	max: number,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= min && value <= max) {
		return value;
	}
	warnings.push(`Ignoring ${fieldPath}: expected an integer between ${min} and ${max}.`);
	return undefined;
}

function toSupportedApis(
	value: unknown,
	fieldPath: string,
	capableApis: readonly string[],
	warnings: string[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		warnings.push(`Ignoring ${fieldPath}: expected a string array.`);
		return undefined;
	}

	const capable = new Set(capableApis);
	const accepted: string[] = [];
	for (const item of new Set(value.map((entry) => entry.trim()).filter(Boolean))) {
		if (capable.has(item)) {
			accepted.push(item);
		} else {
			warnings.push(
				`Ignoring ${fieldPath} entry "${item}": only ${capableApis.join(", ")} are supported.`,
			);
		}
	}

	return accepted;
}

function toStringList(value: unknown, fieldPath: string, warnings: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		warnings.push(`Ignoring ${fieldPath}: expected a string array.`);
		return undefined;
	}

	return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function toImageGenerationModels(value: unknown, fieldPath: string, warnings: string[]): string[] | undefined {
	const models = toStringList(value, fieldPath, warnings);
	if (models === undefined) return undefined;
	if (models.some((model) => model.length > MAX_IMAGE_MODEL_ID_CHARS)) {
		warnings.push(
			`Ignoring ${fieldPath}: each model id must be at most ${MAX_IMAGE_MODEL_ID_CHARS} characters.`,
		);
		return undefined;
	}
	return models;
}

function toWebSearchRoute(
	value: unknown,
	fieldPath: string,
	warnings: string[],
): WebSearchRoute | undefined {
	if (value === undefined) return undefined;
	if (value === "local" || value === "hosted" || value === "standalone-alpha") {
		return value;
	}
	warnings.push(`Ignoring ${fieldPath}: expected one of local, hosted, standalone-alpha.`);
	return undefined;
}

function isExactWebSearchModelKey(value: string): boolean {
	const trimmed = value.trim();
	const separatorIndex = trimmed.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) return false;
	if (/[\s*?\[\]{}]/.test(trimmed)) return false;
	const provider = trimmed.slice(0, separatorIndex);
	const modelId = trimmed.slice(separatorIndex + 1);
	return provider.length > 0 && modelId.length > 0;
}

function toWebSearchRoutes(
	value: unknown,
	fieldPath: string,
	warnings: string[],
): Record<string, WebSearchRoute> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		warnings.push(`Ignoring ${fieldPath}: expected a JSON object.`);
		return undefined;
	}

	const routes: Record<string, WebSearchRoute> = {};
	for (const [rawKey, rawRoute] of Object.entries(value)) {
		const key = rawKey.trim();
		if (!isExactWebSearchModelKey(key)) {
			warnings.push(`Ignoring ${fieldPath}.${rawKey}: expected an exact "provider/model-id" key.`);
			continue;
		}
		const route = toWebSearchRoute(rawRoute, `${fieldPath}.${rawKey}`, warnings);
		if (route !== undefined) routes[key] = route;
	}
	return routes;
}

function toAutoModeGate(value: unknown, fieldPath: string, warnings: string[]): AutoModeGate | undefined {
	if (value === undefined) return undefined;
	if (value === "side-effect" || value === "all") return value;
	warnings.push(`Ignoring ${fieldPath}: expected one of side-effect, all.`);
	return undefined;
}

function toReviewerTimeoutMs(value: unknown, fieldPath: string, warnings: string[]): number | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= REVIEWER_TIMEOUT_MIN_MS &&
		value <= REVIEWER_TIMEOUT_MAX_MS
	) {
		return value;
	}
	warnings.push(
		`Ignoring ${fieldPath}: expected an integer between ${REVIEWER_TIMEOUT_MIN_MS} and ${REVIEWER_TIMEOUT_MAX_MS} ms.`,
	);
	return undefined;
}

function cloneDefaults(): ToolkitConfig {
	return {
		compaction: {
			...DEFAULT_COMPACTION_CONFIG,
			nativeFallback: { ...DEFAULT_NATIVE_FALLBACK_CONFIG },
			responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis],
			gatewayContextModels: [...DEFAULT_COMPACTION_CONFIG.gatewayContextModels],
		},
		webSearch: {
			...DEFAULT_WEB_SEARCH_CONFIG,
			models: [...DEFAULT_WEB_SEARCH_CONFIG.models],
			...(DEFAULT_WEB_SEARCH_CONFIG.defaultRoute
				? { defaultRoute: DEFAULT_WEB_SEARCH_CONFIG.defaultRoute }
				: {}),
			...(DEFAULT_WEB_SEARCH_CONFIG.routes
				? { routes: { ...DEFAULT_WEB_SEARCH_CONFIG.routes } }
				: {}),
		},
		imageGeneration: {
			...DEFAULT_IMAGE_GENERATION_CONFIG,
			models: [...DEFAULT_IMAGE_GENERATION_CONFIG.models],
		},
		autoMode: {
			...DEFAULT_AUTO_MODE_CONFIG,
			models: [...DEFAULT_AUTO_MODE_CONFIG.models],
			extraTools: [...DEFAULT_AUTO_MODE_CONFIG.extraTools],
			classifier: { ...DEFAULT_AUTO_MODE_CONFIG.classifier },
			circuitBreaker: { ...DEFAULT_AUTO_MODE_CONFIG.circuitBreaker },
		},
	};
}

function applyNativeFallbackConfig(
	raw: Record<string, unknown>,
	resolved: NativeFallbackConfig,
	warnings: string[],
): void {
	warnUnknownFields(raw, NATIVE_FALLBACK_FIELDS, "compaction.nativeFallback", warnings);
	resolved.enabled =
		toBoolean(raw.enabled, "compaction.nativeFallback.enabled", warnings) ?? resolved.enabled;

	const modelSpec = toModelSpec(raw.model, "compaction.nativeFallback.model", warnings);
	if (modelSpec !== undefined) {
		resolved.model = modelSpec === null ? undefined : modelSpec;
	}

	resolved.thinkingLevel =
		toThinkingLevel(raw.thinkingLevel, "compaction.nativeFallback.thinkingLevel", warnings) ??
		resolved.thinkingLevel;
}

function applyCompactionConfig(
	raw: Record<string, unknown>,
	resolved: CompactionConfig,
	warnings: string[],
): void {
	warnUnknownFields(raw, COMPACTION_FIELDS, "compaction", warnings);

	resolved.enabled = toBoolean(raw.enabled, "compaction.enabled", warnings) ?? resolved.enabled;
	resolved.contextManagement =
		toContextManagementMode(raw.contextManagement, "compaction.contextManagement", warnings) ??
		resolved.contextManagement;
	resolved.leaveManagedMode =
		toLeaveManagedMode(raw.leaveManagedMode, "compaction.leaveManagedMode", warnings) ??
		resolved.leaveManagedMode;
	resolved.allowCompactionContinuityBreak =
		toBoolean(
			raw.allowCompactionContinuityBreak,
			"compaction.allowCompactionContinuityBreak",
			warnings,
		) ?? resolved.allowCompactionContinuityBreak;
	resolved.notifyOnLoad =
		toBoolean(raw.notifyOnLoad, "compaction.notifyOnLoad", warnings) ?? resolved.notifyOnLoad;
	const reminderPercent = toBoundedInteger(
		raw.contextReminderThresholdPercent,
		"compaction.contextReminderThresholdPercent",
		warnings,
		0,
		100,
	);
	if (reminderPercent !== undefined) {
		resolved.contextReminderThresholdPercent = reminderPercent;
	}
	resolved.debug = toBoolean(raw.debug, "compaction.debug", warnings) ?? resolved.debug;
	resolved.logProviderPayloads =
		toBoolean(raw.logProviderPayloads, "compaction.logProviderPayloads", warnings) ??
		resolved.logProviderPayloads;
	resolved.logCompactResponses =
		toBoolean(raw.logCompactResponses, "compaction.logCompactResponses", warnings) ??
		resolved.logCompactResponses;
	resolved.redactSensitiveData =
		toBoolean(raw.redactSensitiveData, "compaction.redactSensitiveData", warnings) ??
		resolved.redactSensitiveData;

	const remoteCompactModelSpec = toModelSpec(
		raw.remoteCompactModel,
		"compaction.remoteCompactModel",
		warnings,
	);
	if (remoteCompactModelSpec !== undefined) {
		resolved.remoteCompactModel = remoteCompactModelSpec === null ? undefined : remoteCompactModelSpec;
	}

	resolved.remoteV2ContextSource =
		toRemoteV2ContextSource(raw.remoteV2ContextSource, "compaction.remoteV2ContextSource", warnings) ??
		resolved.remoteV2ContextSource;

	if (raw.nativeFallback !== undefined) {
		if (isRecord(raw.nativeFallback)) {
			applyNativeFallbackConfig(raw.nativeFallback, resolved.nativeFallback, warnings);
		} else {
			warnings.push("Ignoring compaction.nativeFallback: expected a JSON object.");
		}
	}

	const apis = toSupportedApis(
		raw.responsesApis,
		"compaction.responsesApis",
		RESPONSES_COMPACT_CAPABLE_APIS,
		warnings,
	);
	if (apis !== undefined) {
		resolved.responsesApis = apis;
	}

	const gatewayContextModels = toStringList(
		raw.gatewayContextModels,
		"compaction.gatewayContextModels",
		warnings,
	);
	if (gatewayContextModels !== undefined) {
		resolved.gatewayContextModels = gatewayContextModels;
	}

	if (typeof raw.artifactRoot === "string" && raw.artifactRoot.trim().length > 0) {
		resolved.artifactRoot = raw.artifactRoot.trim();
	} else if (raw.artifactRoot !== undefined) {
		warnings.push("Ignoring compaction.artifactRoot: expected a non-empty string.");
	}
}

function applyWebSearchConfig(
	raw: Record<string, unknown>,
	resolved: WebSearchConfig,
	warnings: string[],
): void {
	warnUnknownFields(raw, WEB_SEARCH_FIELDS, "webSearch", warnings);
	resolved.enabled = toBoolean(raw.enabled, "webSearch.enabled", warnings) ?? resolved.enabled;

	const models = toStringList(raw.models, "webSearch.models", warnings);
	if (models !== undefined) {
		resolved.models = models;
	}

	const defaultRoute = toWebSearchRoute(raw.defaultRoute, "webSearch.defaultRoute", warnings);
	if (defaultRoute !== undefined) {
		resolved.defaultRoute = defaultRoute;
	}

	const routes = toWebSearchRoutes(raw.routes, "webSearch.routes", warnings);
	if (routes !== undefined) {
		resolved.routes = routes;
	}

	if (defaultRoute !== undefined && resolved.models.length > 0) {
		warnings.push(
			"webSearch.defaultRoute overrides legacy webSearch.models for models without an exact webSearch.routes entry.",
		);
	}
	if (routes !== undefined) {
		for (const key of Object.keys(routes)) {
			if (resolved.models.includes(key)) {
				warnings.push(
					`webSearch.routes.${key} overrides the legacy webSearch.models entry for the same exact model.`,
				);
			}
		}
	}
}

function applyImageGenerationConfig(
	raw: Record<string, unknown>,
	resolved: ImageGenerationConfig,
	warnings: string[],
): void {
	warnUnknownFields(raw, IMAGE_GENERATION_FIELDS, "imageGeneration", warnings);
	resolved.enabled =
		toBoolean(raw.enabled, "imageGeneration.enabled", warnings) ?? resolved.enabled;

	const models = toImageGenerationModels(raw.models, "imageGeneration.models", warnings);
	if (models !== undefined) {
		// An empty or blank-only list cannot express a default, so keep the shipped model.
		if (models.length === 0) {
			warnings.push(
				`Ignoring imageGeneration.models: expected at least one model id; using ${DEFAULT_IMAGE_GENERATION_MODEL}.`,
			);
		} else {
			resolved.models = models;
		}
	}
}

function applyAutoModeConfig(
	raw: Record<string, unknown>,
	resolved: AutoModeConfig,
	warnings: string[],
): void {
	warnUnknownFields(raw, AUTO_MODE_FIELDS, "autoMode", warnings);
	resolved.enabled = toBoolean(raw.enabled, "autoMode.enabled", warnings) ?? resolved.enabled;

	const models = toStringList(raw.models, "autoMode.models", warnings);
	if (models !== undefined) {
		resolved.models = models;
	}

	const reviewerModel = toModelSpec(raw.reviewerModel, "autoMode.reviewerModel", warnings);
	if (reviewerModel !== undefined) {
		resolved.reviewerModel = reviewerModel === null ? undefined : reviewerModel;
	}

	resolved.gate = toAutoModeGate(raw.gate, "autoMode.gate", warnings) ?? resolved.gate;

	const extraTools = toStringList(raw.extraTools, "autoMode.extraTools", warnings);
	if (extraTools !== undefined) {
		resolved.extraTools = extraTools;
	}

	const timeoutMs = toReviewerTimeoutMs(raw.timeoutMs, "autoMode.timeoutMs", warnings);
	if (timeoutMs !== undefined) {
		resolved.timeoutMs = timeoutMs;
	}

	resolved.transcript = toBoolean(raw.transcript, "autoMode.transcript", warnings) ?? resolved.transcript;
	resolved.evidenceTools =
		toBoolean(raw.evidenceTools, "autoMode.evidenceTools", warnings) ?? resolved.evidenceTools;

	const maxEvidenceRounds = toBoundedInteger(
		raw.maxEvidenceRounds,
		"autoMode.maxEvidenceRounds",
		warnings,
		EVIDENCE_ROUNDS_MIN,
		EVIDENCE_ROUNDS_MAX,
	);
	if (maxEvidenceRounds !== undefined) {
		resolved.maxEvidenceRounds = maxEvidenceRounds;
	}

	if (raw.classifier !== undefined) {
		if (isRecord(raw.classifier)) {
			applyAutoModeClassifierConfig(raw.classifier, resolved.classifier, warnings);
		} else {
			warnings.push("Ignoring autoMode.classifier: expected a JSON object.");
		}
	}

	if (raw.circuitBreaker !== undefined) {
		if (isRecord(raw.circuitBreaker)) {
			applyAutoModeBreakerConfig(raw.circuitBreaker, resolved.circuitBreaker, warnings);
		} else {
			warnings.push("Ignoring autoMode.circuitBreaker: expected a JSON object.");
		}
	}
}

function applyAutoModeClassifierConfig(
	raw: Record<string, unknown>,
	resolved: AutoModeClassifierConfig,
	warnings: string[],
): void {
	warnUnknownFields(raw, AUTO_MODE_CLASSIFIER_FIELDS, "autoMode.classifier", warnings);
	resolved.enabled =
		toBoolean(raw.enabled, "autoMode.classifier.enabled", warnings) ?? resolved.enabled;

	const model = toModelSpec(raw.model, "autoMode.classifier.model", warnings);
	if (model !== undefined) {
		resolved.model = model === null ? undefined : model;
	}

	const timeoutMs =
		toBoundedInteger(
			raw.timeoutMs,
			"autoMode.classifier.timeoutMs",
			warnings,
			REVIEWER_TIMEOUT_MIN_MS,
			REVIEWER_TIMEOUT_MAX_MS,
		) ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;
	if (raw.timeoutMs !== undefined) {
		resolved.timeoutMs = timeoutMs;
	}

	const maxLag = toBoundedInteger(
		raw.maxLag,
		"autoMode.classifier.maxLag",
		warnings,
		CLASSIFIER_MAX_LAG_MIN,
		CLASSIFIER_MAX_LAG_MAX,
	);
	if (maxLag !== undefined) {
		resolved.maxLag = maxLag;
	}
}

function applyAutoModeBreakerConfig(
	raw: Record<string, unknown>,
	resolved: AutoModeCircuitBreakerConfig,
	warnings: string[],
): void {
	warnUnknownFields(raw, AUTO_MODE_BREAKER_FIELDS, "autoMode.circuitBreaker", warnings);

	const consecutiveDenials = toBoundedInteger(
		raw.consecutiveDenials,
		"autoMode.circuitBreaker.consecutiveDenials",
		warnings,
		BREAKER_LIMIT_MIN,
		BREAKER_LIMIT_MAX,
	);
	if (consecutiveDenials !== undefined) {
		resolved.consecutiveDenials = consecutiveDenials;
	}

	const recentDenials = toBoundedInteger(
		raw.recentDenials,
		"autoMode.circuitBreaker.recentDenials",
		warnings,
		BREAKER_LIMIT_MIN,
		BREAKER_LIMIT_MAX,
	);
	if (recentDenials !== undefined) {
		resolved.recentDenials = recentDenials;
	}

	const windowSize = toBoundedInteger(
		raw.windowSize,
		"autoMode.circuitBreaker.windowSize",
		warnings,
		BREAKER_WINDOW_MIN,
		BREAKER_WINDOW_MAX,
	);
	if (windowSize !== undefined) {
		resolved.windowSize = windowSize;
	}
}

/**
 * Normalize the supported unversioned document without I/O or mutation.
 * Versioned decoding and operation resolution are owned by ../config.ts.
 */
export function normalizeLegacyConfig(
	raw: Record<string, unknown> | undefined,
	configPath: string = CONFIG_PATH,
	warnings: string[] = [],
): LoadedToolkitConfig {
	const resolved = cloneDefaults();
	let source: string | undefined;

	if (raw) {
		source = configPath;
		warnUnknownFields(raw, TOP_LEVEL_FIELDS, "", warnings);

		if (raw.compaction !== undefined) {
			if (isRecord(raw.compaction)) {
				applyCompactionConfig(raw.compaction, resolved.compaction, warnings);
			} else {
				warnings.push("Ignoring compaction: expected a JSON object.");
			}
		}

		if (raw.webSearch !== undefined) {
			if (isRecord(raw.webSearch)) {
				applyWebSearchConfig(raw.webSearch, resolved.webSearch, warnings);
			} else {
				warnings.push("Ignoring webSearch: expected a JSON object.");
			}
		}

		if (raw.imageGeneration !== undefined) {
			if (isRecord(raw.imageGeneration)) {
				applyImageGenerationConfig(raw.imageGeneration, resolved.imageGeneration, warnings);
			} else {
				warnings.push("Ignoring imageGeneration: expected a JSON object.");
			}
		}

		if (raw.autoMode !== undefined) {
			if (isRecord(raw.autoMode)) {
				applyAutoModeConfig(raw.autoMode, resolved.autoMode, warnings);
			} else {
				warnings.push("Ignoring autoMode: expected a JSON object.");
			}
		}
	}

	resolved.compaction.artifactRoot = resolveConfiguredPath(
		resolved.compaction.artifactRoot,
		path.dirname(configPath),
	);

	return {
		config: resolved,
		source,
		warnings,
	};
}

export { DEFAULT_TOOLKIT_CONFIG };
