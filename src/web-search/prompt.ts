import type { WebSearchConfig } from "../types";
import {
	resolveWebSearchRoute,
	WEB_RUN_TOOL_NAME,
	WEB_SEARCH_PROMPT_MARKER,
	type WebSearchModel,
} from "./types";

export const WEB_SEARCH_PROMPT_SECTION = `${WEB_SEARCH_PROMPT_MARKER}
## Web Search

The hosted \`web_search\` tool is part of your tool list for this model. The API executes it server-side: it is a real callable tool even though no client-side function schema or description accompanies it. Call it whenever current or online information matters instead of guessing, cite the returned sources in the answer, and never claim that web search or internet access is unavailable while this section is present.`;

export const LOCAL_WEB_SEARCH_PROMPT_SECTION = `${WEB_SEARCH_PROMPT_MARKER}
## Web Search

The local \`web_search\` tool is available for this model. Use it when current or online information matters, and cite the sources returned by that tool. Do not claim that the provider API executes this local tool server-side.`;

export const STANDALONE_ALPHA_WEB_SEARCH_PROMPT_SECTION = `${WEB_SEARCH_PROMPT_MARKER}
## Web Search

The \`${WEB_RUN_TOOL_NAME}\` tool is available for this model. It is a sequential local wrapper backed by CPA/Codex standalone search at the provider's \`/alpha/search\` endpoint. It supports \`search_query\`, \`image_query\`, \`open\`, \`click\`, \`find\`, \`screenshot\`, \`finance\`, \`weather\`, \`sports\`, and \`time\`. Use it for current or online information, preserve reference ids when following results, and cite the returned sources.`;

function removeToolkitWebSearchPrompt(systemPrompt: string): string {
	const markerIndex = systemPrompt.indexOf(WEB_SEARCH_PROMPT_MARKER);
	if (markerIndex < 0) return systemPrompt;
	return systemPrompt.slice(0, markerIndex).trimEnd();
}

function promptSectionForRoute(route: "local" | "hosted" | "standalone-alpha"): string {
	switch (route) {
		case "local":
			return LOCAL_WEB_SEARCH_PROMPT_SECTION;
		case "hosted":
			return WEB_SEARCH_PROMPT_SECTION;
		case "standalone-alpha":
			return STANDALONE_ALPHA_WEB_SEARCH_PROMPT_SECTION;
	}
}

export function appendWebSearchPrompt(args: {
	model: WebSearchModel | undefined;
	config: WebSearchConfig;
	systemPrompt: string;
	/** Lifecycle registration can override this when the selected local wrapper is unavailable. */
	routeAvailable?: boolean;
}): string {
	const { model, config, systemPrompt } = args;
	const basePrompt = removeToolkitWebSearchPrompt(systemPrompt);
	const resolution = resolveWebSearchRoute({ model, config });
	if (args.routeAvailable === false || resolution.route === "none" || !resolution.available) return basePrompt;

	const section = promptSectionForRoute(resolution.route);
	return `${basePrompt.trimEnd()}\n\n${section}`;
}

export const _promptTest = {
	removeToolkitWebSearchPrompt,
	promptSectionForRoute,
};
