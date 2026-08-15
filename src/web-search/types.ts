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
	if (!model?.provider || !model.id) return undefined;
	return `${model.provider}/${model.id}`;
}

export function isWebSearchEnabledForModel(
	model: WebSearchModel | undefined,
	config: WebSearchConfig,
): boolean {
	const modelKey = getWebSearchModelKey(model);
	return (
		config.enabled &&
		typeof model?.api === "string" &&
		(WEB_SEARCH_CAPABLE_APIS as readonly string[]).includes(model.api) &&
		modelKey !== undefined &&
		config.models.includes(modelKey)
	);
}
