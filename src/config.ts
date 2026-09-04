import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_TOOLKIT_CONFIG,
	DEFAULT_AUTO_COMPACTION_CONFIG,
	DEFAULT_AUTO_MODE_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_NATIVE_FALLBACK_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
	RESPONSES_COMPACT_CAPABLE_APIS,
	REVIEWER_TIMEOUT_MAX_MS,
	REVIEWER_TIMEOUT_MIN_MS,
	THINKING_LEVELS,
	TOOLKIT_ID,
	type AutoModeConfig,
	type AutoModeGate,
	type CompactionConfig,
	type ImageGenerationConfig,
	type LoadedToolkitConfig,
	type NativeFallbackConfig,
	type ToolkitConfig,
	type WebSearchConfig,
} from "./types";

export const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", TOOLKIT_ID);
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const TOP_LEVEL_FIELDS = new Set(["compaction", "webSearch", "imageGeneration", "autoMode"]);
const COMPACTION_FIELDS = new Set([
	"enabled",
	"allowCompactionContinuityBreak",
	"remoteCompactModel",
	"nativeFallback",
	"autoCompaction",
	"responsesApis",
	"notifyOnLoad",
	"debug",
	"logProviderPayloads",
	"logCompactResponses",
	"redactSensitiveData",
	"artifactRoot",
]);
const NATIVE_FALLBACK_FIELDS = new Set(["enabled", "model", "thinkingLevel"]);
const AUTO_COMPACTION_FIELDS = new Set(["enabled", "continuation", "unsupportedFallback", "reserveTokens"]);
const WEB_SEARCH_FIELDS = new Set(["enabled", "models"]);
const IMAGE_GENERATION_FIELDS = new Set(["enabled"]);
const AUTO_MODE_FIELDS = new Set(["enabled", "models", "reviewerModel", "gate", "extraTools", "timeoutMs"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFile(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function readJsonObject(filePath: string, warnings: string[]): Record<string, unknown> | undefined {
	if (!isFile(filePath)) return undefined;

	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (isRecord(parsed)) return parsed;
		warnings.push(`Ignoring ${filePath}: expected a JSON object at the top level.`);
		return undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnings.push(`Ignoring ${filePath}: ${message}`);
		return undefined;
	}
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

function toCompactionContinuation(
	value: unknown,
	fieldPath: string,
	warnings: string[],
): "inline" | "followUp" | "off" | undefined {
	if (value === undefined) return undefined;
	if (value === "inline" || value === "followUp" || value === "off") return value;
	warnings.push(`Ignoring ${fieldPath}: expected one of inline, followUp, off.`);
	return undefined;
}

function toUnsupportedFallback(
	value: unknown,
	fieldPath: string,
	warnings: string[],
): "followUp" | "off" | undefined {
	if (value === undefined) return undefined;
	if (value === "followUp" || value === "off") return value;
	warnings.push(`Ignoring ${fieldPath}: expected one of followUp, off.`);
	return undefined;
}

function toNonNegativeInteger(value: unknown, fieldPath: string, warnings: string[]): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= 0) {
		return value;
	}
	warnings.push(`Ignoring ${fieldPath}: expected a non-negative integer.`);
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
			autoCompaction: { ...DEFAULT_AUTO_COMPACTION_CONFIG },
			responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis],
		},
		webSearch: {
			...DEFAULT_WEB_SEARCH_CONFIG,
			models: [...DEFAULT_WEB_SEARCH_CONFIG.models],
		},
		imageGeneration: { ...DEFAULT_IMAGE_GENERATION_CONFIG },
		autoMode: {
			...DEFAULT_AUTO_MODE_CONFIG,
			models: [...DEFAULT_AUTO_MODE_CONFIG.models],
			extraTools: [...DEFAULT_AUTO_MODE_CONFIG.extraTools],
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

function applyAutoCompactionConfig(
	raw: Record<string, unknown>,
	resolved: CompactionConfig["autoCompaction"],
	warnings: string[],
): void {
	warnUnknownFields(raw, AUTO_COMPACTION_FIELDS, "compaction.autoCompaction", warnings);
	resolved.enabled = toBoolean(raw.enabled, "compaction.autoCompaction.enabled", warnings) ?? resolved.enabled;
	resolved.continuation =
		toCompactionContinuation(raw.continuation, "compaction.autoCompaction.continuation", warnings) ??
		resolved.continuation;
	resolved.unsupportedFallback =
		toUnsupportedFallback(
			raw.unsupportedFallback,
			"compaction.autoCompaction.unsupportedFallback",
			warnings,
		) ?? resolved.unsupportedFallback;
	const reserveTokens = toNonNegativeInteger(
		raw.reserveTokens,
		"compaction.autoCompaction.reserveTokens",
		warnings,
	);
	if (reserveTokens !== undefined) {
		resolved.reserveTokens = reserveTokens;
	}
}

function applyCompactionConfig(
	raw: Record<string, unknown>,
	resolved: CompactionConfig,
	warnings: string[],
): void {
	warnUnknownFields(raw, COMPACTION_FIELDS, "compaction", warnings);

	resolved.enabled = toBoolean(raw.enabled, "compaction.enabled", warnings) ?? resolved.enabled;
	resolved.allowCompactionContinuityBreak =
		toBoolean(
			raw.allowCompactionContinuityBreak,
			"compaction.allowCompactionContinuityBreak",
			warnings,
		) ?? resolved.allowCompactionContinuityBreak;
	resolved.notifyOnLoad =
		toBoolean(raw.notifyOnLoad, "compaction.notifyOnLoad", warnings) ?? resolved.notifyOnLoad;
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

	if (raw.nativeFallback !== undefined) {
		if (isRecord(raw.nativeFallback)) {
			applyNativeFallbackConfig(raw.nativeFallback, resolved.nativeFallback, warnings);
		} else {
			warnings.push("Ignoring compaction.nativeFallback: expected a JSON object.");
		}
	}

	if (raw.autoCompaction !== undefined) {
		if (isRecord(raw.autoCompaction)) {
			applyAutoCompactionConfig(raw.autoCompaction, resolved.autoCompaction, warnings);
		} else {
			warnings.push("Ignoring compaction.autoCompaction: expected a JSON object.");
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
}

function applyImageGenerationConfig(
	raw: Record<string, unknown>,
	resolved: ImageGenerationConfig,
	warnings: string[],
): void {
	warnUnknownFields(raw, IMAGE_GENERATION_FIELDS, "imageGeneration", warnings);
	resolved.enabled =
		toBoolean(raw.enabled, "imageGeneration.enabled", warnings) ?? resolved.enabled;
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
}

/**
 * Load the canonical toolkit config from
 * `~/.pi/agent/extensions/pi-openai-toolkit/config.json`.
 * A missing file silently yields defaults; legacy branded paths are never read.
 */
export function loadToolkitConfig(configPath: string = CONFIG_PATH): LoadedToolkitConfig {
	const warnings: string[] = [];
	const resolved = cloneDefaults();
	let source: string | undefined;

	const raw = readJsonObject(configPath, warnings);
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
