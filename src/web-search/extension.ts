import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "../config";
import { transformWebSearchPayload } from "./payload";
import { appendWebSearchPrompt } from "./prompt";
import { isWebSearchEnabledForModel, type WebSearchModel } from "./types";

function syncLocalWebSearchTool(
	pi: ExtensionAPI,
	model: WebSearchModel | undefined,
	config: Parameters<typeof isWebSearchEnabledForModel>[1],
	state: { wasActiveBeforeOwnership?: boolean; toolkitOwnsTool: boolean },
): void {
	const eligible = isWebSearchEnabledForModel(model, config);
	const activeTools = pi.getActiveTools();

	if (eligible) {
		if (!state.toolkitOwnsTool) {
			state.wasActiveBeforeOwnership = activeTools.includes("web_search");
			state.toolkitOwnsTool = true;
		}

		if (activeTools.includes("web_search")) {
			pi.setActiveTools(activeTools.filter((name) => name !== "web_search"));
		}
		return;
	}

	if (!state.toolkitOwnsTool) return;

	if (state.wasActiveBeforeOwnership && !activeTools.includes("web_search")) {
		pi.setActiveTools([...activeTools, "web_search"]);
	}
	state.wasActiveBeforeOwnership = undefined;
	state.toolkitOwnsTool = false;
}

export function registerWebSearchExtension(
	pi: ExtensionAPI,
	loadConfig: typeof loadToolkitConfig = loadToolkitConfig,
): void {
	const toolState = { wasActiveBeforeOwnership: undefined as boolean | undefined, toolkitOwnsTool: false };

	pi.on("session_start", (_event, ctx) => {
		const { config } = loadConfig();
		syncLocalWebSearchTool(pi, ctx.model, config.webSearch, toolState);
	});

	pi.on("model_select", (event) => {
		const { config } = loadConfig();
		syncLocalWebSearchTool(pi, event.model, config.webSearch, toolState);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const { config } = loadConfig();
		syncLocalWebSearchTool(pi, ctx.model, config.webSearch, toolState);
		const systemPrompt = appendWebSearchPrompt({
			model: ctx.model,
			config: config.webSearch,
			systemPrompt: event.systemPrompt,
		});

		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});

	pi.on("before_provider_request", (event, ctx) => {
		const { config } = loadConfig();
		syncLocalWebSearchTool(pi, ctx.model, config.webSearch, toolState);
		const transformed = transformWebSearchPayload({
			model: ctx.model,
			config: config.webSearch,
			payload: event.payload,
		});

		return transformed.changed ? transformed.payload : undefined;
	});
}

export default function webSearchExtension(pi: ExtensionAPI): void {
	registerWebSearchExtension(pi);
}
