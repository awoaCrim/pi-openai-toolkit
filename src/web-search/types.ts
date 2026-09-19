import { getExactModelKey, isExactModelAllowed } from "../model-scope";
import type { WebSearchConfig, WebSearchRoute } from "../types";

export const WEB_SEARCH_CAPABLE_APIS = ["openai-responses", "openai-codex-responses"] as const;
export const WEB_SEARCH_SOURCE_INCLUDE = "web_search_call.action.sources";
export const WEB_SEARCH_PROMPT_MARKER = "<!-- pi-openai-toolkit:web-search -->";
export const WEB_RUN_TOOL_NAME = "web.run";
export const LOCAL_WEB_SEARCH_TOOL_NAME = "web_search";

export type WebSearchCapableApi = (typeof WEB_SEARCH_CAPABLE_APIS)[number];
export type WebSearchRouteSource = "exact" | "default" | "legacy" | "none";
export type WebSearchRouteUnavailableReason = "missing-model" | "unsupported-api" | "invalid-route";

export type WebSearchModel = {
	api?: string;
	provider?: string;
	id?: string;
};

export type WebSearchRouteResolution =
	| {
			route: "none";
			source: "none";
			modelKey?: string;
			reason: "disabled" | "unconfigured";
	  }
	| {
			route: WebSearchRoute;
			source: Exclude<WebSearchRouteSource, "none">;
			modelKey?: string;
			available: boolean;
			reason?: WebSearchRouteUnavailableReason;
	  };

export type WebSearchPayloadOutcome =
	| "disabled"
	| "unsupported-model"
	| "non-object-payload"
	| "invalid-tools"
	| "invalid-include"
	| "existing-native-tool"
	| "injected-native-tool"
	| "local-route"
	| "standalone-route"
	| "removed-conflicting-tools"
	| "unavailable-route";

export type WebSearchPayloadTransform = {
	payload: unknown;
	outcome: WebSearchPayloadOutcome;
	changed: boolean;
	/** Explicit route failures must abort rather than silently select another search path. */
	fatal?: boolean;
	errorMessage?: string;
};

export function getWebSearchModelKey(model: WebSearchModel | undefined): string | undefined {
	return getExactModelKey(model);
}

export function isWebSearchRoute(value: unknown): value is WebSearchRoute {
	return value === "local" || value === "hosted" || value === "standalone-alpha";
}

function selectedRoute(args: {
	route: WebSearchRoute;
	source: Exclude<WebSearchRouteSource, "none">;
	model: WebSearchModel | undefined;
	modelKey: string | undefined;
}): WebSearchRouteResolution {
	if (!args.modelKey) {
		return {
			route: args.route,
			source: args.source,
			available: false,
			reason: "missing-model",
		};
	}
	if (args.route !== "local" && !isWebSearchCapableApi(args.model?.api)) {
		return {
			route: args.route,
			source: args.source,
			modelKey: args.modelKey,
			available: false,
			reason: "unsupported-api",
		};
	}
	return {
		route: args.route,
		source: args.source,
		modelKey: args.modelKey,
		available: true,
	};
}

export function isWebSearchCapableApi(api: unknown): api is WebSearchCapableApi {
	return typeof api === "string" && (WEB_SEARCH_CAPABLE_APIS as readonly string[]).includes(api);
}

/**
 * Resolve exactly one configured Web Search route. The legacy model allowlist is
 * deliberately consulted only after explicit route fields so old configs retain
 * hosted behavior without becoming an implicit alpha-search opt-in.
 */
export function resolveWebSearchRoute(args: {
	model: WebSearchModel | undefined;
	config: WebSearchConfig;
}): WebSearchRouteResolution {
	const { model, config } = args;
	const modelKey = getWebSearchModelKey(model);
	if (!config.enabled) {
		return { route: "none", source: "none", modelKey, reason: "disabled" };
	}

	const exactRoute = modelKey ? config.routes?.[modelKey] : undefined;
	if (exactRoute !== undefined) {
		if (!isWebSearchRoute(exactRoute)) {
			return { route: "none", source: "none", modelKey, reason: "unconfigured" };
		}
		return selectedRoute({ route: exactRoute, source: "exact", model, modelKey });
	}

	if (config.defaultRoute !== undefined) {
		if (!isWebSearchRoute(config.defaultRoute)) {
			return { route: "none", source: "none", modelKey, reason: "unconfigured" };
		}
		return selectedRoute({ route: config.defaultRoute, source: "default", model, modelKey });
	}

	if (modelKey && isExactModelAllowed(model, config.models) && isWebSearchCapableApi(model?.api)) {
		return selectedRoute({ route: "hosted", source: "legacy", model, modelKey });
	}

	return { route: "none", source: "none", modelKey, reason: "unconfigured" };
}

/** Compatibility predicate for callers that specifically need the hosted path. */
export function isWebSearchEnabledForModel(
	model: WebSearchModel | undefined,
	config: WebSearchConfig,
): boolean {
	const resolution = resolveWebSearchRoute({ model, config });
	return resolution.route === "hosted" && resolution.available;
}
