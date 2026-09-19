import type { WebSearchConfig } from "../types";
import {
	LOCAL_WEB_SEARCH_TOOL_NAME,
	resolveWebSearchRoute,
	WEB_RUN_TOOL_NAME,
	WEB_SEARCH_SOURCE_INCLUDE,
	isWebSearchRoute,
	type WebSearchModel,
	type WebSearchPayloadTransform,
} from "./types";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isLocalWebSearchFunction(tool: unknown): boolean {
	return isRecord(tool) && tool.type === "function" && tool.name === LOCAL_WEB_SEARCH_TOOL_NAME;
}

function isStandaloneWebRunFunction(tool: unknown): boolean {
	return isRecord(tool) && tool.type === "function" && tool.name === WEB_RUN_TOOL_NAME;
}

function isNativeWebSearchTool(tool: unknown): boolean {
	return isRecord(tool) && (tool.type === "web_search" || tool.type === "web_search_preview");
}

function explicitRouteFailure(resolution: ReturnType<typeof resolveWebSearchRoute>): WebSearchPayloadTransform {
	const reason = resolution.route === "none" ? resolution.reason : resolution.reason;
	return {
		payload: undefined,
		outcome: "unavailable-route",
		changed: false,
		fatal: true,
		errorMessage: `Web Search route is unavailable${reason ? ` (${reason})` : ""}; request aborted without fallback.`,
	};
}

function unavailableRouteTransform(
	payload: unknown,
	resolution: ReturnType<typeof resolveWebSearchRoute>,
): WebSearchPayloadTransform {
	const base = explicitRouteFailure(resolution);
	return { ...base, payload };
}

function transformStandalonePayload(args: {
	payload: JsonObject;
	resolution: ReturnType<typeof resolveWebSearchRoute>;
}): WebSearchPayloadTransform {
	const { payload, resolution } = args;
	const toolsValue = payload.tools;
	if (toolsValue !== undefined && !Array.isArray(toolsValue)) {
		return {
			payload,
			outcome: "invalid-tools",
			changed: false,
			fatal: resolution.source !== "legacy",
			errorMessage: "Standalone Web Search requires a provider payload tools array.",
		};
	}
	const includeValue = payload.include;
	if (includeValue !== undefined && !Array.isArray(includeValue)) {
		return {
			payload,
			outcome: "invalid-include",
			changed: false,
			fatal: resolution.source !== "legacy",
			errorMessage: "Standalone Web Search requires a provider payload include array.",
		};
	}

	const tools = toolsValue ?? [];
	let standaloneToolCount = 0;
	const normalizedTools = tools.filter((tool) => {
		if (isLocalWebSearchFunction(tool) || isNativeWebSearchTool(tool)) return false;
		if (!isStandaloneWebRunFunction(tool)) return true;
		standaloneToolCount += 1;
		return standaloneToolCount === 1;
	});
	const include = includeValue ?? [];
	const normalizedInclude = include.filter((item) => item !== WEB_SEARCH_SOURCE_INCLUDE);
	const toolsChanged = normalizedTools.length !== tools.length;
	const includeChanged = normalizedInclude.length !== include.length;
	if (toolsValue !== undefined && !normalizedTools.some(isStandaloneWebRunFunction)) {
		return {
			payload,
			outcome: "unavailable-route",
			changed: false,
			fatal: resolution.source !== "legacy",
			errorMessage: "Standalone Web Search requires the registered web.run tool in the provider payload.",
		};
	}
	if (!toolsChanged && !includeChanged) {
		return { payload, outcome: "standalone-route", changed: false };
	}

	return {
		payload: {
			...payload,
			...(toolsChanged ? { tools: normalizedTools } : {}),
			...(includeChanged ? { include: normalizedInclude } : {}),
		},
		outcome: "removed-conflicting-tools",
		changed: true,
	};
}

function transformLocalPayload(args: {
	payload: JsonObject;
	resolution: ReturnType<typeof resolveWebSearchRoute>;
}): WebSearchPayloadTransform {
	const { payload, resolution } = args;
	const toolsValue = payload.tools;
	if (toolsValue !== undefined && !Array.isArray(toolsValue)) {
		return {
			payload,
			outcome: "invalid-tools",
			changed: false,
			fatal: resolution.source !== "legacy",
			errorMessage: "Local Web Search requires a provider payload tools array.",
		};
	}
	const includeValue = payload.include;
	if (includeValue !== undefined && !Array.isArray(includeValue)) {
		return {
			payload,
			outcome: "invalid-include",
			changed: false,
			fatal: resolution.source !== "legacy",
			errorMessage: "Local Web Search requires a provider payload include array.",
		};
	}

	const tools = toolsValue ?? [];
	const normalizedTools = tools.filter(
		(tool) => !isStandaloneWebRunFunction(tool) && !isNativeWebSearchTool(tool),
	);
	const include = includeValue ?? [];
	const normalizedInclude = include.filter((item) => item !== WEB_SEARCH_SOURCE_INCLUDE);
	const toolsChanged = normalizedTools.length !== tools.length;
	const includeChanged = normalizedInclude.length !== include.length;
	if (!toolsChanged && !includeChanged) return { payload, outcome: "local-route", changed: false };

	return {
		payload: {
			...payload,
			...(toolsChanged ? { tools: normalizedTools } : {}),
			...(includeChanged ? { include: normalizedInclude } : {}),
		},
		outcome: "removed-conflicting-tools",
		changed: true,
	};
}

export function transformWebSearchPayload(args: {
	model: WebSearchModel | undefined;
	config: WebSearchConfig;
	payload: unknown;
}): WebSearchPayloadTransform {
	const { model, config, payload } = args;
	const resolution = resolveWebSearchRoute({ model, config });

	if (resolution.route === "none") {
		return {
			payload,
			outcome: resolution.reason === "disabled" ? "disabled" : "unsupported-model",
			changed: false,
		};
	}
	if (!resolution.available) {
		return unavailableRouteTransform(payload, resolution);
	}
	if (resolution.route === "local") {
		if (!isRecord(payload)) {
			return {
				payload,
				outcome: "non-object-payload",
				changed: false,
				fatal: resolution.source !== "legacy",
				errorMessage: "Local Web Search requires an object provider payload.",
			};
		}
		return transformLocalPayload({ payload, resolution });
	}
	if (resolution.route === "standalone-alpha") {
		if (!isRecord(payload)) {
			return {
				payload,
				outcome: "non-object-payload",
				changed: false,
				fatal: resolution.source !== "legacy",
				errorMessage: "Standalone Web Search requires an object provider payload.",
			};
		}
		return transformStandalonePayload({ payload, resolution });
	}

	if (!isRecord(payload)) {
		return {
			payload,
			outcome: "non-object-payload",
			changed: false,
			...(resolution.source !== "legacy"
				? { fatal: true, errorMessage: "Hosted Web Search requires an object provider payload." }
				: {}),
		};
	}

	const toolsValue = payload.tools;
	if (toolsValue !== undefined && !Array.isArray(toolsValue)) {
		return {
			payload,
			outcome: "invalid-tools",
			changed: false,
			...(resolution.source !== "legacy"
				? { fatal: true, errorMessage: "Hosted Web Search requires a provider payload tools array." }
				: {}),
		};
	}
	const tools = toolsValue ?? [];
	const includeValue = payload.include;
	if (includeValue !== undefined && !Array.isArray(includeValue)) {
		return {
			payload,
			outcome: "invalid-include",
			changed: false,
			...(resolution.source !== "legacy"
				? { fatal: true, errorMessage: "Hosted Web Search requires a provider payload include array." }
				: {}),
		};
	}
	const include = includeValue ?? [];
	const normalizedTools: unknown[] = [];
	let nativeToolCount = 0;
	let localToolRemoved = false;
	let standaloneToolRemoved = false;
	for (const tool of tools) {
		if (isLocalWebSearchFunction(tool)) {
			localToolRemoved = true;
			continue;
		}
		if (isStandaloneWebRunFunction(tool)) {
			standaloneToolRemoved = true;
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

	const toolsChanged = localToolRemoved || standaloneToolRemoved || !hasNativeTool || nativeToolCount > 1;
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

export const _payloadTest = {
	isLocalWebSearchFunction,
	isNativeWebSearchTool,
	isStandaloneWebRunFunction,
	isWebSearchRoute,
};
