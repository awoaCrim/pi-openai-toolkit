import type { WebSearchConfig } from "../types";
import {
	WEB_SEARCH_SOURCE_INCLUDE,
	isWebSearchEnabledForModel,
	type WebSearchModel,
	type WebSearchPayloadTransform,
} from "./types";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isLocalWebSearchFunction(tool: unknown): boolean {
	return isRecord(tool) && tool.type === "function" && tool.name === "web_search";
}

function isNativeWebSearchTool(tool: unknown): boolean {
	return isRecord(tool) && (tool.type === "web_search" || tool.type === "web_search_preview");
}

export function transformWebSearchPayload(args: {
	model: WebSearchModel | undefined;
	config: WebSearchConfig;
	payload: unknown;
}): WebSearchPayloadTransform {
	const { model, config, payload } = args;
	if (!config.enabled) {
		return { payload, outcome: "disabled", changed: false };
	}
	if (!isWebSearchEnabledForModel(model, config)) {
		return { payload, outcome: "unsupported-model", changed: false };
	}
	if (!isRecord(payload)) {
		return { payload, outcome: "non-object-payload", changed: false };
	}

	const toolsValue = payload.tools;
	if (toolsValue !== undefined && !Array.isArray(toolsValue)) {
		return { payload, outcome: "invalid-tools", changed: false };
	}
	const tools = toolsValue ?? [];
	const includeValue = payload.include;
	if (includeValue !== undefined && !Array.isArray(includeValue)) {
		return { payload, outcome: "invalid-include", changed: false };
	}
	const include = includeValue ?? [];
	const normalizedTools: unknown[] = [];
	let nativeToolCount = 0;
	let localToolRemoved = false;
	for (const tool of tools) {
		if (isLocalWebSearchFunction(tool)) {
			localToolRemoved = true;
			continue;
		}
		if (isNativeWebSearchTool(tool)) {
			nativeToolCount += 1;
			if (nativeToolCount > 1) continue;
		}
		normalizedTools.push(tool);
	}
	const hasNativeTool = nativeToolCount > 0;
	if (!hasNativeTool) {
		normalizedTools.push({ type: "web_search" });
	}

	const normalizedInclude: unknown[] = [];
	let sourceIncludeCount = 0;
	for (const item of include) {
		if (item === WEB_SEARCH_SOURCE_INCLUDE) {
			sourceIncludeCount += 1;
			if (sourceIncludeCount > 1) continue;
		}
		normalizedInclude.push(item);
	}
	if (sourceIncludeCount === 0) {
		normalizedInclude.push(WEB_SEARCH_SOURCE_INCLUDE);
	}

	const toolsChanged = localToolRemoved || !hasNativeTool || nativeToolCount > 1;
	const includeChanged = sourceIncludeCount !== 1;
	if (!toolsChanged && !includeChanged) {
		return { payload, outcome: "existing-native-tool", changed: false };
	}

	return {
		payload: {
			...payload,
			...(toolsChanged ? { tools: normalizedTools } : {}),
			...(includeChanged ? { include: normalizedInclude } : {}),
		},
		outcome: hasNativeTool ? "existing-native-tool" : "injected-native-tool",
		changed: true,
	};
}
