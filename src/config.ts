import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_TOOLKIT_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
	RESPONSES_COMPACT_CAPABLE_APIS,
	THINKING_LEVELS,
	TOOLKIT_ID,
	type CompactionConfig,
	type LoadedToolkitConfig,
	type ToolkitConfig,
	type WebSearchConfig,
} from "./types";
import { WEB_SEARCH_CAPABLE_APIS } from "./web-search/types";

export const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", TOOLKIT_ID);
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const TOP_LEVEL_FIELDS = new Set(["compaction", "webSearch"]);
const COMPACTION_FIELDS = new Set([
	"enabled",
	"allowCompactionContinuityBreak",
	"model",
	"thinkingLevel",
	"responsesApis",
	"notifyOnLoad",
	"debug",
	"logProviderPayloads",
	"logCompactResponses",
	"redactSensitiveData",
	"artifactRoot",
]);
const WEB_SEARCH_FIELDS = new Set(["enabled", "apis"]);

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

function cloneDefaults(): ToolkitConfig {
	return {
		compaction: {
			...DEFAULT_COMPACTION_CONFIG,
			responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis],
		},
		webSearch: {
			...DEFAULT_WEB_SEARCH_CONFIG,
			apis: [...DEFAULT_WEB_SEARCH_CONFIG.apis],
		},
	};
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

	const modelSpec = toModelSpec(raw.model, "compaction.model", warnings);
	if (modelSpec !== undefined) {
		resolved.model = modelSpec === null ? undefined : modelSpec;
	}

	resolved.thinkingLevel =
		toThinkingLevel(raw.thinkingLevel, "compaction.thinkingLevel", warnings) ?? resolved.thinkingLevel;

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

	const apis = toSupportedApis(raw.apis, "webSearch.apis", WEB_SEARCH_CAPABLE_APIS, warnings);
	if (apis !== undefined) {
		resolved.apis = apis;
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
