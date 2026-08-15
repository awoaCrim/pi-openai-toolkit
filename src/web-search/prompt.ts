import type { WebSearchConfig } from "../types";
import { WEB_SEARCH_PROMPT_MARKER, isWebSearchEnabledForApi } from "./types";

export const WEB_SEARCH_PROMPT_SECTION = `${WEB_SEARCH_PROMPT_MARKER}
## Web Search

Native OpenAI Web Search is available for this turn. Use it for current or online information when freshness matters instead of guessing, and cite the returned sources in the answer.`;

export function appendWebSearchPrompt(args: {
	api: string | undefined;
	config: WebSearchConfig;
	systemPrompt: string;
	activeToolNames: readonly string[];
}): string {
	const { api, config, systemPrompt, activeToolNames } = args;
	if (
		!isWebSearchEnabledForApi(api, config) ||
		activeToolNames.includes("web_search") ||
		systemPrompt.includes(WEB_SEARCH_PROMPT_MARKER)
	) {
		return systemPrompt;
	}

	return `${systemPrompt.trimEnd()}\n\n${WEB_SEARCH_PROMPT_SECTION}`;
}
