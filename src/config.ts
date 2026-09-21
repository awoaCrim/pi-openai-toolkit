import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getExactModelKey, type ExactModelScopeModel } from "./model-scope";
import { resolveWebSearchRoute, type WebSearchModel } from "./web-search/types";
import { CONFIG_PATH, normalizeLegacyConfig } from "./config/legacy";
import { resolveV2Config } from "./config/v2";
import {
	CONFIG_FEATURES,
	createPolicyDefaults,
	type ConfigDocumentSnapshot,
	type ConfigFeature,
	type ConfigIssue,
	type ConfigOrigin,
	type EffectiveToolkitPolicy,
	type ResolvedToolkitPolicy,
} from "./config/policy";
import type { LoadedToolkitConfig, ToolkitConfig } from "./types";

export { CONFIG_DIR, CONFIG_PATH } from "./config/legacy";
export { DEFAULT_TOOLKIT_CONFIG } from "./types";
export type { ConfigFeature, ConfigIssue, ConfigOrigin, EffectiveToolkitPolicy } from "./config/policy";

export type ResolvedToolkitConfig = ResolvedToolkitPolicy & {
	/** Narrow adapters for existing feature engines, never raw document sections. */
	config: ToolkitConfig;
	format: ConfigDocumentSnapshot["format"];
	source?: string;
	modelKey?: string;
	/** Cross-feature protocol policy, independent of context enablement. */
	gatewayModelKeys: string[];
	/** Same decoded document for resolving another identity within this operation. */
	snapshot: LoadedToolkitConfig;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function has(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value)) freeze(item);
	}
	return value;
}
function documentError(code: string): ConfigIssue {
	return { severity: "error", code, path: "$", feature: "document" };
}

/** Read exactly one global file. No project discovery, cache, writes or auth/network work. */
export function loadToolkitConfig(configPath: string = CONFIG_PATH): LoadedToolkitConfig {
	let raw: unknown;
	let format: ConfigDocumentSnapshot["format"] = "missing";
	const issues: ConfigIssue[] = [];
	const warnings: string[] = [];
	try {
		const text = fs.readFileSync(configPath, "utf8");
		try {
			raw = JSON.parse(text);
			if (!isRecord(raw)) {
				format = "invalid";
				issues.push(documentError("expected-object"));
			} else if (has(raw, "schemaVersion")) {
				format = raw.schemaVersion === 2 ? "v2" : "invalid";
				if (format === "invalid") issues.push(documentError("unsupported-schema-version"));
			} else if (has(raw, "defaults") || has(raw, "models") || has(raw, "diagnostics")) {
				format = "invalid";
				issues.push(documentError("missing-schema-version"));
			} else {
				format = "legacy";
			}
		} catch {
			format = "invalid";
			issues.push(documentError("invalid-json"));
		}
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") {
			format = "invalid";
			issues.push(documentError("unreadable-config"));
		}
	}
	for (const issue of issues) warnings.push(`Ignoring ${configPath}: ${issue.code}.`);
	const legacy = normalizeLegacyConfig(format === "legacy" && isRecord(raw) ? raw : undefined, configPath, warnings);
	return {
		...legacy,
		...(format === "v2" ? { source: configPath } : {}),
		document: freeze({ format, configPath, raw, issues }),
	};
}

function configuredPath(value: string, configPath: string): string {
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return path.resolve(path.dirname(configPath), value);
}

function leafPaths(value: unknown, prefix = ""): string[] {
	if (!isRecord(value)) return [prefix];
	return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

const LEGACY_PATHS: Record<string, string> = {
	"context.mode": "compaction.contextManagement",
	"context.remoteCompaction.model": "compaction.remoteCompactModel",
	"context.remoteCompaction.inputSource": "compaction.remoteV2ContextSource",
	"context.remoteCompaction.allowContinuityBreak": "compaction.allowCompactionContinuityBreak",
	"context.remoteCompaction.apis": "compaction.responsesApis",
	"context.nativeFallback.enabled": "compaction.nativeFallback.enabled",
	"context.nativeFallback.model": "compaction.nativeFallback.model",
	"context.nativeFallback.thinkingLevel": "compaction.nativeFallback.thinkingLevel",
	"context.remoteWindows.leaveManagedMode": "compaction.leaveManagedMode",
	"context.remoteWindows.reminderThresholdPercent": "compaction.contextReminderThresholdPercent",
	"webSearch.route": "webSearch.models",
	"imageGeneration.enabled": "imageGeneration.enabled",
	"imageGeneration.defaultModel": "imageGeneration.models",
	"imageGeneration.allowedModels": "imageGeneration.models",
	"autoMode.available": "autoMode.models",
	"compatibility.transport": "compaction.gatewayContextModels",
	"diagnostics.level": "compaction.debug",
	"diagnostics.notifyOnLoad": "compaction.notifyOnLoad",
	"diagnostics.captureRequests": "compaction.logProviderPayloads",
	"diagnostics.captureResponses": "compaction.logCompactResponses",
	"diagnostics.redactSensitiveData": "compaction.redactSensitiveData",
	"diagnostics.artifactRoot": "compaction.artifactRoot",
};
function containsPath(value: unknown, fieldPath: string): boolean {
	for (const key of fieldPath.split(".")) {
		if (!isRecord(value) || !has(value, key)) return false;
		value = value[key];
	}
	return true;
}

function legacyRouteKey(raw: unknown, modelKey: string | undefined): string | undefined {
	if (!modelKey || !isRecord(raw) || !isRecord(raw.webSearch) || !isRecord(raw.webSearch.routes)) return undefined;
	return Object.keys(raw.webSearch.routes).find((key) => key.trim() === modelKey);
}

function legacyIssues(loaded: LoadedToolkitConfig, modelKey: string | undefined): ConfigIssue[] {
	const raw = loaded.document?.raw;
	const rawWeb = isRecord(raw) && isRecord(raw.webSearch) ? raw.webSearch : undefined;
	// Route keys may contain dots or colons. Never recover identity by splitting a warning.
	const routeIssues: ConfigIssue[] = [];
	if (isRecord(rawWeb?.routes)) {
		for (const [key, value] of Object.entries(rawWeb.routes)) {
			const normalized = key.trim();
			const separator = normalized.indexOf("/");
			const exact = separator > 0 && separator < normalized.length - 1 && !/[\s*?\[\]{}]/.test(normalized);
			if (exact && typeof value === "string" && ["local", "hosted", "standalone-alpha"].includes(value)) continue;
			routeIssues.push({ severity: "error", code: "invalid-legacy-value", feature: "webSearch",
				path: exact ? `webSearch.routes[${JSON.stringify(normalized).slice(0, 180)}]` : "webSearch.routes.[invalid-model-key]",
				modelKey: normalized });
		}
	}
	const issues = loaded.warnings.filter((warning) => !warning.startsWith("Ignoring webSearch.routes.")).map((warning): ConfigIssue => {
		const match = /^Ignoring ([^:]+):/.exec(warning);
		const field = warning.startsWith("Ignoring compaction.responsesApis entry ") ? "compaction.responsesApis" : match?.[1] ?? "$";
		const root = field.split(".")[0];
		const diagnostic = Object.entries(LEGACY_PATHS).some(([leaf, input]) => leaf.startsWith("diagnostics.") && input === field);
		const feature: ConfigFeature | "document" = diagnostic ? "diagnostics"
			: field === "compaction.gatewayContextModels" ? "compatibility" : root === "compaction" ? "context"
			: root === "webSearch" || root === "imageGeneration" || root === "autoMode" ? root : "document";
		const supersededDefault = field === "webSearch.defaultRoute" && legacyRouteKey(raw, modelKey) !== undefined;
		const warningOnly = warning.endsWith("unknown field.") || !match
			|| warning.includes("expected at least one model id") || supersededDefault;
		return {
			severity: warningOnly ? "warning" : "error",
			code: warning.endsWith("unknown field.") ? "unknown-legacy-field" : warningOnly ? "legacy-normalization" : "invalid-legacy-value",
			path: warning.endsWith("unknown field.") ? `${feature}.[unknown-field]` : field.slice(0, 220),
			feature,
		};
	});
	return [...issues, ...routeIssues];
}

function selectedInvalidFeatures(issues: ConfigIssue[], modelKey?: string): ConfigFeature[] {
	const invalid = new Set<ConfigFeature>();
	for (const issue of issues) {
		if (issue.severity !== "error" || (issue.modelKey !== undefined && issue.modelKey !== modelKey)) continue;
		if (issue.feature === "document") for (const feature of CONFIG_FEATURES) invalid.add(feature);
		else invalid.add(issue.feature);
	}
	return [...invalid];
}

function fromLegacy(loaded: LoadedToolkitConfig, model: WebSearchModel | undefined): ResolvedToolkitPolicy {
	const config = loaded.config;
	const compaction = config.compaction;
	const modelKey = getExactModelKey(model);
	const route = resolveWebSearchRoute({ model, config: config.webSearch });
	const policy = createPolicyDefaults();
	policy.context = {
		mode: !compaction.enabled ? "pi" : compaction.contextManagement === "remote" ? "remote-windows" : "remote-compaction",
		remoteCompaction: {
			model: compaction.remoteCompactModel ?? null,
			inputSource: compaction.remoteV2ContextSource,
			allowContinuityBreak: compaction.allowCompactionContinuityBreak,
			apis: [...compaction.responsesApis],
		},
		nativeFallback: { ...compaction.nativeFallback, model: compaction.nativeFallback.model ?? null },
		remoteWindows: { leaveManagedMode: compaction.leaveManagedMode, reminderThresholdPercent: compaction.contextReminderThresholdPercent },
	};
	policy.webSearch.route = route.route === "none" ? "unmanaged" : route.route;
	policy.imageGeneration = {
		enabled: config.imageGeneration.enabled,
		defaultModel: config.imageGeneration.models[0],
		allowedModels: [...config.imageGeneration.models],
	};
	const { enabled, models, reviewerModel, classifier, ...auto } = config.autoMode;
	policy.autoMode = {
		...structuredClone(auto),
		available: enabled && modelKey !== undefined && models.includes(modelKey),
		reviewerModel: reviewerModel ?? null,
		classifier: { ...classifier, model: classifier.model ?? null },
	};
	policy.compatibility.transport = modelKey && compaction.gatewayContextModels.includes(modelKey) ? "codex-gateway" : "standard";
	policy.diagnostics = {
		level: compaction.debug ? "debug" : "info",
		notifyOnLoad: compaction.notifyOnLoad,
		captureRequests: compaction.logProviderPayloads,
		captureResponses: compaction.logCompactResponses,
		redactSensitiveData: compaction.redactSensitiveData,
		artifactRoot: compaction.artifactRoot,
	};
	const origins: Record<string, ConfigOrigin> = Object.create(null);
	const raw = loaded.document?.raw;
	for (const leaf of leafPaths(policy)) {
		let input = LEGACY_PATHS[leaf] ?? leaf;
		if (leaf === "context.mode" && !compaction.enabled) input = "compaction.enabled";
		if (leaf === "autoMode.available" && !enabled) input = "autoMode.enabled";
		if (leaf === "webSearch.route") {
			if (!config.webSearch.enabled) input = "webSearch.enabled";
			else if (route.source === "exact") {
				const rawKey = legacyRouteKey(raw, modelKey);
				if (rawKey !== undefined) {
					origins[leaf] = { kind: "legacy", path: `webSearch.routes[${JSON.stringify(rawKey)}]`, source: loaded.source };
					continue;
				}
			}
			else if (route.source === "default") input = "webSearch.defaultRoute";
		}
		const ignored = loaded.warnings.some((warning) => warning.startsWith(`Ignoring ${input}:`));
		origins[leaf] = !ignored && ((raw && containsPath(raw, input)) || (!loaded.document && loaded.source))
			? { kind: "legacy", path: input, source: loaded.source } : { kind: "builtin" };
	}
	const issues = [...(loaded.document?.issues ?? []), ...legacyIssues(loaded, modelKey)];
	return { policy, origins, issues, invalidFeatures: selectedInvalidFeatures(issues, modelKey) };
}

/** Internal engine adapter. All interpretation of document names stays in this module. */
function engineConfig(policy: EffectiveToolkitPolicy, modelKey: string | undefined, gatewayKeys: string[]): ToolkitConfig {
	const { context, diagnostics, imageGeneration, autoMode } = policy;
	const { available, reviewerModel, classifier, ...auto } = autoMode;
	return {
		compaction: {
			enabled: context.mode !== "pi",
			contextManagement: context.mode === "remote-windows" ? "remote" : "off",
			remoteCompactModel: context.remoteCompaction.model ?? undefined,
			remoteV2ContextSource: context.remoteCompaction.inputSource,
			allowCompactionContinuityBreak: context.remoteCompaction.allowContinuityBreak,
			responsesApis: [...context.remoteCompaction.apis],
			gatewayContextModels: [...gatewayKeys],
			nativeFallback: { ...context.nativeFallback, model: context.nativeFallback.model ?? undefined },
			leaveManagedMode: context.remoteWindows.leaveManagedMode,
			contextReminderThresholdPercent: context.remoteWindows.reminderThresholdPercent,
			debug: diagnostics.level === "debug",
			notifyOnLoad: diagnostics.notifyOnLoad,
			logProviderPayloads: diagnostics.captureRequests,
			logCompactResponses: diagnostics.captureResponses,
			redactSensitiveData: diagnostics.redactSensitiveData,
			artifactRoot: diagnostics.artifactRoot,
		},
		webSearch: policy.webSearch.route === "unmanaged" ? { enabled: false, models: [] }
			: { enabled: true, models: [], defaultRoute: policy.webSearch.route },
		imageGeneration: { enabled: imageGeneration.enabled, models: [...imageGeneration.allowedModels] },
		autoMode: {
			...structuredClone(auto), enabled: available, models: available && modelKey ? [modelKey] : [],
			reviewerModel: reviewerModel ?? undefined, classifier: { ...classifier, model: classifier.model ?? undefined },
		},
	};
}

/** Resolve one immutable snapshot for one model. Never reads disk or a model registry. */
export function resolveToolkitConfig(loaded: LoadedToolkitConfig, model?: ExactModelScopeModel & { api?: string }): ResolvedToolkitConfig {
	// Injected readers are also decoded at the module seam; they may omit optional feature sections.
	if (!loaded.document) {
		const configPath = loaded.source ?? CONFIG_PATH;
		const normalized = normalizeLegacyConfig(loaded.config, configPath);
		loaded = { ...normalized, source: loaded.source, warnings: [...loaded.warnings, ...normalized.warnings],
			document: { format: "legacy", configPath, raw: loaded.config, issues: [] } };
	}
	const modelKey = getExactModelKey(model);
	const format = loaded.document?.format ?? "legacy";
	const v2 = format === "v2" ? resolveV2Config(loaded.document?.raw, modelKey) : undefined;
	const resolution = v2 ?? fromLegacy(loaded, model);
	const source = loaded.source;
	if (format === "v2") {
		resolution.policy.diagnostics.artifactRoot = configuredPath(resolution.policy.diagnostics.artifactRoot, loaded.document?.configPath ?? CONFIG_PATH);
		for (const origin of Object.values(resolution.origins)) if (origin.kind !== "builtin") origin.source = source;
	}
	const gatewayModelKeys = v2 ? v2.gatewayModelKeys : [...loaded.config.compaction.gatewayContextModels];
	const config = format === "v2" ? engineConfig(resolution.policy, modelKey, gatewayModelKeys) : structuredClone(loaded.config);
	return freeze({ ...resolution, config, format, source, modelKey, gatewayModelKeys, snapshot: structuredClone(loaded) });
}

export class ToolkitConfigurationError extends Error {
	constructor(readonly features: readonly ConfigFeature[]) {
		super(`Toolkit configuration is invalid for ${features.join(", ")}; use /toolkit-config validate. No fallback policy was selected.`);
		this.name = "ToolkitConfigurationError";
	}
}

export function assertConfigValid(resolved: ResolvedToolkitConfig, ...features: ConfigFeature[]): void {
	const invalid = features.filter((feature) => resolved.invalidFeatures.includes(feature));
	if (invalid.length > 0) throw new ToolkitConfigurationError(invalid);
}
