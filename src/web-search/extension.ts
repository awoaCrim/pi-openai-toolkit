import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "../config";
import { WEB_SEARCH_EXTENSION_ID } from "../types";
import { transformWebSearchPayload } from "./payload";
import { appendWebSearchPrompt } from "./prompt";

export function registerWebSearchExtension(
	pi: ExtensionAPI,
	loadConfig: typeof loadToolkitConfig = loadToolkitConfig,
): void {
	let conflictWarningShown = false;

	pi.on("session_start", (_event, ctx) => {
		const { config } = loadConfig();
		if (!config.webSearch.enabled || conflictWarningShown) {
			return;
		}

		const hasRegisteredConflict = pi.getAllTools().some((tool) => tool.name === "web_search");
		if (hasRegisteredConflict && ctx.hasUI) {
			ctx.ui.notify(
				`${WEB_SEARCH_EXTENSION_ID}: local web_search tool detected; local tool takes precedence and native OpenAI Web Search will be skipped while active`,
				"warning",
			);
			conflictWarningShown = true;
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		const { config } = loadConfig();
		const systemPrompt = appendWebSearchPrompt({
			api: ctx.model?.api,
			config: config.webSearch,
			systemPrompt: event.systemPrompt,
			activeToolNames: pi.getActiveTools(),
		});

		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});

	pi.on("before_provider_request", (event, ctx) => {
		const { config } = loadConfig();
		const transformed = transformWebSearchPayload({
			api: ctx.model?.api,
			config: config.webSearch,
			payload: event.payload,
		});

		return transformed.changed ? transformed.payload : undefined;
	});
}

export default function webSearchExtension(pi: ExtensionAPI): void {
	registerWebSearchExtension(pi);
}
