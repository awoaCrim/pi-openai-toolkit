import type { WebSearchConfig } from "../types";
import { isWebSearchEnabledForModel, WEB_SEARCH_PROMPT_MARKER, type WebSearchModel } from "./types";

export const WEB_SEARCH_PROMPT_SECTION = `${WEB_SEARCH_PROMPT_MARKER}
## Web Search

Native OpenAI Web Search is available for this turn. Use it for current or online information when freshness matters instead of guessing, and cite the returned sources in the answer.`;

export function appendWebSearchPrompt(args: {
	model: WebSearchModel | undefined;
	config: WebSearchConfig;
	systemPrompt: string;
}): string {
	const { model, config, systemPrompt } = args;
	if (!isWebSearchEnabledForModel(model, config) || systemPrompt.includes(WEB_SEARCH_PROMPT_MARKER)) {
		return systemPrompt;
	}

	return `${systemPrompt.trimEnd()}\n\n${WEB_SEARCH_PROMPT_SECTION}`;
}
