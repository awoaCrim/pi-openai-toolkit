import type { WebSearchConfig } from "../types";
import { isWebSearchEnabledForModel, WEB_SEARCH_PROMPT_MARKER, type WebSearchModel } from "./types";

export const WEB_SEARCH_PROMPT_SECTION = `${WEB_SEARCH_PROMPT_MARKER}
## Web Search

The hosted \`web_search\` tool is part of your tool list for this model. The API executes it server-side: it is a real callable tool even though no client-side function schema or description accompanies it. Call it whenever current or online information matters instead of guessing, cite the returned sources in the answer, and never claim that web search or internet access is unavailable while this section is present.`;

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
