import type { WebSearchConfig } from "../types";

export const WEB_SEARCH_CAPABLE_APIS = ["openai-responses"] as const;
export const WEB_SEARCH_SOURCE_INCLUDE = "web_search_call.action.sources";
export const WEB_SEARCH_PROMPT_MARKER = "<!-- pi-openai-toolkit:web-search -->";

export type WebSearchCapableApi = (typeof WEB_SEARCH_CAPABLE_APIS)[number];

export type WebSearchPayloadOutcome =
	| "disabled"
	| "unsupported-api"
	| "non-object-payload"
	| "invalid-tools"
	| "invalid-include"
	| "local-function-conflict"
	| "existing-native-tool"
	| "injected-native-tool";

export type WebSearchPayloadTransform = {
	payload: unknown;
	outcome: WebSearchPayloadOutcome;
	changed: boolean;
};

export function isWebSearchEnabledForApi(
	api: string | undefined,
	config: WebSearchConfig,
): api is WebSearchCapableApi {
	return (
		config.enabled &&
		typeof api === "string" &&
		(WEB_SEARCH_CAPABLE_APIS as readonly string[]).includes(api) &&
		config.apis.includes(api)
	);
}
