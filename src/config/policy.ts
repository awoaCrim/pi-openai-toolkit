import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_IMAGE_GENERATION_MODEL,
	type LeaveManagedModePolicy,
	type NativeFallbackConfig,
	type RemoteV2ContextSource,
} from "../types";

export type ConfigFeature = "context" | "webSearch" | "imageGeneration" | "compatibility" | "responsesWebSocket" | "diagnostics";
export type SearchRoute = "unmanaged" | "local" | "hosted" | "standalone-alpha";
export type DiagnosticsConfig = {
	level: "error" | "warn" | "info" | "debug";
	notifyOnLoad: boolean;
	captureRequests: boolean;
	/** Captures compact responses, not ordinary conversation responses. */
	captureResponses: boolean;
	redactSensitiveData: boolean;
	artifactRoot: string;
};
export type ContextPolicy = {
	mode: "pi" | "remote-compaction" | "remote-windows";
	remoteCompaction: {
		model: string | null;
		inputSource: RemoteV2ContextSource;
		allowContinuityBreak: boolean;
		apis: string[];
	};
	nativeFallback: Omit<NativeFallbackConfig, "model"> & { model: string | null };
	remoteWindows: {
		leaveManagedMode: LeaveManagedModePolicy;
		reminderThresholdPercent: number;
	};
};
export type EffectiveToolkitPolicy = {
	context: ContextPolicy;
	webSearch: { route: SearchRoute };
	imageGeneration: { enabled: boolean; defaultModel: string; allowedModels: string[] };
	responsesWebSocket: { enabled: boolean };
	compatibility: { transport: "standard" | "codex-gateway" };
	diagnostics: DiagnosticsConfig;
};
export type ConfigOrigin = {
	kind: "builtin" | "defaults" | "model" | "legacy";
	path?: string;
	source?: string;
};
export type ConfigIssue = {
	severity: "error" | "warning";
	/** Controlled code; do not include raw input values in messages. */
	code: string;
	path: string;
	feature: ConfigFeature | "document";
	/** Issues for a different model do not invalidate the selected model. */
	modelKey?: string;
};
/**
 * Stable code for a configuration section that was removed from the Toolkit. A retired section is
 * ignored in any shape and must never invalidate another feature, so it is reported as a warning.
 */
export const RETIRED_AUTO_MODE_ISSUE = "retired.autoMode" as const;
/** Controlled explanation of the retirement; never contains user-supplied values. */
export const RETIRED_AUTO_MODE_MESSAGE =
	"Auto Mode has been removed; these settings are ignored and tool calls are no longer reviewed by it.";
export type ResolvedToolkitPolicy = {
	policy: EffectiveToolkitPolicy;
	origins: Record<string, ConfigOrigin>;
	issues: ConfigIssue[];
	invalidFeatures: ConfigFeature[];
};
export type ConfigDocumentSnapshot = {
	format: "legacy" | "v2" | "missing" | "invalid";
	configPath: string;
	/** In-memory only; never render arbitrary raw configuration values. */
	raw?: unknown;
	issues: ConfigIssue[];
};
export const CONFIG_FEATURES: readonly ConfigFeature[] = [
	"context", "webSearch", "imageGeneration", "compatibility", "responsesWebSocket", "diagnostics",
];

/** Independent per-operation defaults, preserving the existing shipped policy. */
export function createPolicyDefaults(): EffectiveToolkitPolicy {
	const context = DEFAULT_COMPACTION_CONFIG;
	return {
		context: {
			mode: "remote-compaction",
			remoteCompaction: {
				model: null,
				inputSource: context.remoteV2ContextSource,
				allowContinuityBreak: context.allowCompactionContinuityBreak,
				apis: [...context.responsesApis],
			},
			nativeFallback: { ...context.nativeFallback, model: null },
			remoteWindows: {
				leaveManagedMode: context.leaveManagedMode,
				reminderThresholdPercent: context.contextReminderThresholdPercent,
			},
		},
		webSearch: { route: "unmanaged" },
		imageGeneration: {
			enabled: false,
			defaultModel: DEFAULT_IMAGE_GENERATION_MODEL,
			allowedModels: [DEFAULT_IMAGE_GENERATION_MODEL],
		},
		responsesWebSocket: { enabled: false },
		compatibility: { transport: "standard" },
		diagnostics: {
			level: "info",
			notifyOnLoad: context.notifyOnLoad,
			captureRequests: context.logProviderPayloads,
			captureResponses: context.logCompactResponses,
			redactSensitiveData: context.redactSensitiveData,
			artifactRoot: context.artifactRoot,
		},
	};
}
