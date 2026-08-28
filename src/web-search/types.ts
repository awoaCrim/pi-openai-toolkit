import { getExactModelKey, isExactModelAllowed } from "../model-scope";
import type { WebSearchConfig } from "../types";

export const WEB_SEARCH_CAPABLE_APIS = ["openai-responses", "openai-codex-responses"] as const;
export const WEB_SEARCH_SOURCE_INCLUDE = "web_search_call.action.sources";
export const WEB_SEARCH_PROMPT_MARKER = "<!-- pi-openai-toolkit:web-search -->";

export type WebSearchCapableApi = (typeof WEB_SEARCH_CAPABLE_APIS)[number];

export type WebSearchModel = {
	api?: string;
	provider?: string;
	id?: string;
};

export type WebSearchPayloadOutcome =
	| "disabled"
	| "unsupported-model"
	| "non-object-payload"
	| "invalid-tools"
	| "invalid-include"
	| "existing-native-tool"
	| "injected-native-tool";

export type WebSearchPayloadTransform = {
	payload: unknown;
	outcome: WebSearchPayloadOutcome;
	changed: boolean;
};

export function getWebSearchModelKey(model: WebSearchModel | undefined): string | undefined {
	return getExactModelKey(model);
}

export function isWebSearchEnabledForModel(
	model: WebSearchModel | undefined,
	config: WebSearchConfig,
): boolean {
	return (
		config.enabled &&
		typeof model?.api === "string" &&
		(WEB_SEARCH_CAPABLE_APIS as readonly string[]).includes(model.api) &&
		isExactModelAllowed(model, config.models)
	);
}
