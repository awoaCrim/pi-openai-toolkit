import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { assertConfigValid, loadToolkitConfig, resolveToolkitConfig, type ResolvedToolkitConfig } from "../config";
import { notifyConfigIssues } from "../config/notifications";
import { resolveResponsesEnvironment, type ResponsesEnvironmentResolution } from "../runtime";
import {
	requestAlphaSearch,
	normalizeStandaloneWebRunCommands,
	sanitizeAlphaDiagnostic,
	STANDALONE_WEB_RUN_PARAMETERS,
	StandaloneWebRunError,
	type AlphaSearchDetails,
	type AlphaSearchClientResult,
	type StandaloneWebRunParameters,
} from "./alpha-client";
import { transformWebSearchPayload } from "./payload";
import { appendWebSearchPrompt } from "./prompt";
import {
	LOCAL_WEB_SEARCH_TOOL_NAME,
	resolveWebSearchRoute,
	WEB_RUN_TOOL_NAME,
	WEB_SEARCH_CAPABLE_APIS,
	type WebSearchModel,
	type WebSearchRouteResolution,
} from "./types";

const registeredApis = new WeakSet<object>();

const WEB_RUN_LABEL = WEB_RUN_TOOL_NAME;
const WEB_RUN_DESCRIPTION =
	"Run sequential standalone Web Search commands through the provider's CPA/Codex alpha-search endpoint. " +
	"Use only when the current Web Search route explicitly selects standalone-alpha.";
const WEB_RUN_PROMPT_SNIPPET =
	"Run search, image, page, finance, weather, sports, or time commands through CPA/Codex standalone Web Search.";
const WEB_RUN_PROMPT_GUIDELINES = [
	`Use ${WEB_RUN_TOOL_NAME} only when the configured Web Search route is standalone-alpha; do not assume it is available for an unconfigured model.`,
	"Choose exactly the command fields needed for the current request and preserve ref_id values for open, click, find, and screenshot follow-ups.",
	"Supported commands are search_query, image_query, open, click, find, screenshot, finance, weather, sports, and time; response_length may tune the result size.",
	"The route requires a CPA/Codex gateway that exposes /alpha/search and supports standalone web search; a failed request is not retried or redirected to another search implementation.",
];

const DEFAULT_TOOL_STATE = {
	wasActiveBeforeOwnership: undefined as boolean | undefined,
	toolkitOwnsTool: false,
};

type ToolOwnershipState = {
	wasActiveBeforeOwnership?: boolean;
	toolkitOwnsTool: boolean;
};

type WebRunExecutorDependencies = {
	loadConfig: typeof loadToolkitConfig;
	resolveRuntime: typeof resolveResponsesEnvironment;
	requestSearch: typeof requestAlphaSearch;
	isRegistered: () => boolean;
};

function cloneToolState(): ToolOwnershipState {
	return { ...DEFAULT_TOOL_STATE };
}

function sanitizeMessage(message: string): string {
	return sanitizeAlphaDiagnostic(message, "Standalone Web Search failed.");
}

function activeToolsApi(pi: ExtensionAPI): {
	getActiveTools: () => string[];
	setActiveTools: (names: string[]) => void;
} | undefined {
	const api = pi as ExtensionAPI & {
		getActiveTools?: () => string[];
		setActiveTools?: (names: string[]) => void;
	};
	if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return undefined;
	return { getActiveTools: api.getActiveTools, setActiveTools: api.setActiveTools };
}

function canManageActiveTools(pi: ExtensionAPI): boolean {
	const api = activeToolsApi(pi);
	if (!api) return false;
	try {
		api.getActiveTools();
		return true;
	} catch {
		return false;
	}
}

function isActiveTool(pi: ExtensionAPI, name: string): boolean | undefined {
	const api = activeToolsApi(pi);
	if (!api) return undefined;
	try {
		return api.getActiveTools().includes(name);
	} catch {
		return undefined;
	}
}

function setActiveToolsIfChanged(
	api: { getActiveTools: () => string[]; setActiveTools: (names: string[]) => void },
	current: string[],
	next: string[],
): void {
	if (current.length === next.length && current.every((name, index) => name === next[index])) return;
	api.setActiveTools(next);
}

function claimAndRemove(
	pi: ExtensionAPI,
	name: string,
	state: ToolOwnershipState,
): void {
	const api = activeToolsApi(pi);
	if (!api) return;
	try {
		const current = api.getActiveTools();
		if (!state.toolkitOwnsTool) {
			state.wasActiveBeforeOwnership = current.includes(name);
			state.toolkitOwnsTool = true;
		}
		const next = current.filter((toolName) => toolName !== name);
		setActiveToolsIfChanged(api, current, next);
	} catch {
		// An unavailable active-tool API is handled as an unavailable route by the
		// execution guard; it must never trigger a different search implementation.
	}
}

function activateOwned(pi: ExtensionAPI, name: string, state: ToolOwnershipState): void {
	const api = activeToolsApi(pi);
	if (!api) return;
	try {
		const current = api.getActiveTools();
		if (!state.toolkitOwnsTool) {
			state.wasActiveBeforeOwnership = current.includes(name);
			state.toolkitOwnsTool = true;
		}
		let keptName = false;
		const next = current.filter((toolName) => {
			if (toolName !== name) return true;
			if (keptName) return false;
			keptName = true;
			return true;
		});
		if (!keptName) next.push(name);
		setActiveToolsIfChanged(api, current, next);
	} catch {
		// The tool-call guard remains fail closed if active-tool mutation fails.
	}
}

function releaseOwnership(
	pi: ExtensionAPI,
	name: string,
	state: ToolOwnershipState,
): void {
	if (!state.toolkitOwnsTool) return;
	const api = activeToolsApi(pi);
	if (!api) {
		state.wasActiveBeforeOwnership = undefined;
		state.toolkitOwnsTool = false;
		return;
	}
	try {
		const current = api.getActiveTools();
		const withoutOwnedName = current.filter((toolName) => toolName !== name);
		const next = state.wasActiveBeforeOwnership ? [...withoutOwnedName, name] : withoutOwnedName;
		setActiveToolsIfChanged(api, current, next);
	} catch {
		// Do not claim that a failed release restored a third-party tool.
	}
	state.wasActiveBeforeOwnership = undefined;
	state.toolkitOwnsTool = false;
}

function describeRouteFailure(resolution: WebSearchRouteResolution): string {
	if (resolution.route === "none") {
		return resolution.reason === "disabled"
			? "Web Search is disabled."
			: "No Web Search route is configured for the current provider/model-id.";
	}
	return `Web Search route "${resolution.route}" is unavailable${resolution.reason ? ` (${resolution.reason})` : ""}.`;
}

function abortAndThrow(ctx: ExtensionContext, message: string): never {
	try {
		ctx.abort();
	} catch {
		// Test harnesses and older hosts may omit abort; throwing still prevents
		// Pi from sending a payload that violates the selected route.
	}
	throw new Error(sanitizeMessage(message));
}

function standaloneRuntimeFailure(resolution: ResponsesEnvironmentResolution): Error {
	if (resolution.ok) return new Error("Unexpected standalone Web Search runtime state.");
	const reason = resolution.reason;
	switch (reason) {
		case "missing-api-key":
		case "auth-resolution-failed":
			return new Error(
				sanitizeMessage(
					resolution.errorMessage ??
					"Standalone Web Search authentication could not be resolved for the current model.",
				),
			);
		case "missing-base-url":
			return new Error("Standalone Web Search has no usable provider base URL.");
		case "missing-session-id":
			return new Error("Standalone Web Search requires a session identity for this gateway route.");
		case "unsupported-api":
			return new Error("Standalone Web Search requires an openai-responses or openai-codex-responses model.");
		default:
			return new Error(`Standalone Web Search runtime is unavailable (${reason}).`);
	}
}

export async function executeStandaloneWebRun(args: {
	params: unknown;
	signal?: AbortSignal;
	ctx: ExtensionContext;
	loadConfig?: typeof loadToolkitConfig;
	resolveRuntime?: typeof resolveResponsesEnvironment;
	requestSearch?: typeof requestAlphaSearch;
	isRegistered?: () => boolean;
}): Promise<{ text: string; details: AlphaSearchDetails }> {
	const commands = normalizeStandaloneWebRunCommands(args.params);
	if (args.signal?.aborted) throw new StandaloneWebRunError(`${WEB_RUN_TOOL_NAME} was cancelled.`);

	const loadConfig = args.loadConfig ?? loadToolkitConfig;
	const resolveRuntime = args.resolveRuntime ?? resolveResponsesEnvironment;
	const requestSearch = args.requestSearch ?? requestAlphaSearch;
	if (args.isRegistered && !args.isRegistered()) {
		throw new Error(`${WEB_RUN_TOOL_NAME} is not registered by the toolkit; standalone Web Search is unavailable.`);
	}

	const resolved = resolveToolkitConfig(loadConfig(), args.ctx.model);
	notifyConfigIssues(args.ctx, resolved);
	assertConfigValid(resolved, "webSearch", "compatibility");
	const { config } = resolved;
	const route = resolveWebSearchRoute({ model: args.ctx.model, config: config.webSearch });
	if (route.route !== "standalone-alpha" || !route.available) {
		throw new Error(describeRouteFailure(route));
	}

	const runtime = await resolveRuntime(args.ctx, {
		enabled: config.webSearch.enabled,
		responsesApis: WEB_SEARCH_CAPABLE_APIS,
		codexGatewayModels: resolved.gatewayModelKeys,
	});
	if (!runtime.ok) throw standaloneRuntimeFailure(runtime);

	const result: AlphaSearchClientResult = await requestSearch({
		runtime: runtime.runtime,
		commands,
		signal: args.signal,
	});
	if (!result.ok) throw new Error(sanitizeMessage(result.errorMessage));
	return { text: result.output, details: result.details };
}

function createWebRunTool(deps: WebRunExecutorDependencies): ToolDefinition<
	typeof STANDALONE_WEB_RUN_PARAMETERS,
	AlphaSearchDetails
> {
	return {
		name: WEB_RUN_TOOL_NAME,
		label: WEB_RUN_LABEL,
		description: WEB_RUN_DESCRIPTION,
		promptSnippet: WEB_RUN_PROMPT_SNIPPET,
		promptGuidelines: WEB_RUN_PROMPT_GUIDELINES,
		parameters: STANDALONE_WEB_RUN_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params: StandaloneWebRunParameters, signal, _onUpdate, ctx) {
			try {
				const result = await executeStandaloneWebRun({
					params,
					signal,
					ctx,
					loadConfig: deps.loadConfig,
					resolveRuntime: deps.resolveRuntime,
					requestSearch: deps.requestSearch,
					isRegistered: deps.isRegistered,
				});
				return {
					content: [{ type: "text", text: result.text }],
					details: result.details,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(sanitizeMessage(message));
			}
		},
	};
}

function verifyStandaloneRegistration(
	pi: ExtensionAPI,
	definition: ToolDefinition<typeof STANDALONE_WEB_RUN_PARAMETERS, AlphaSearchDetails>,
): boolean {
	try {
		const api = pi as ExtensionAPI & {
			getAllTools?: () => Array<{
				name: string;
				description: string;
				parameters: unknown;
				promptGuidelines?: string[];
			}>;
		};
		if (typeof api.getAllTools !== "function") return false;
		const actual = api.getAllTools().find((tool) => tool.name === WEB_RUN_TOOL_NAME);
		return actual !== undefined &&
			actual.description === definition.description &&
			actual.parameters === definition.parameters &&
			actual.promptGuidelines === definition.promptGuidelines;
	} catch {
		return false;
	}
}

function syncWebSearchRoute(
	pi: ExtensionAPI,
	model: WebSearchModel | undefined,
	config: Parameters<typeof resolveWebSearchRoute>[0]["config"],
	states: { webSearch: ToolOwnershipState; webRun: ToolOwnershipState },
	standaloneReady: boolean,
): WebSearchRouteResolution {
	const resolution = resolveWebSearchRoute({ model, config });
	if (resolution.route === "local" && resolution.available) {
		releaseOwnership(pi, LOCAL_WEB_SEARCH_TOOL_NAME, states.webSearch);
		claimAndRemove(pi, WEB_RUN_TOOL_NAME, states.webRun);
		return resolution;
	}
	if (resolution.route === "standalone-alpha") {
		claimAndRemove(pi, LOCAL_WEB_SEARCH_TOOL_NAME, states.webSearch);
		if (resolution.available && standaloneReady) {
			activateOwned(pi, WEB_RUN_TOOL_NAME, states.webRun);
		} else {
			claimAndRemove(pi, WEB_RUN_TOOL_NAME, states.webRun);
		}
		return resolution;
	}
	if (resolution.route === "hosted") {
		claimAndRemove(pi, LOCAL_WEB_SEARCH_TOOL_NAME, states.webSearch);
		claimAndRemove(pi, WEB_RUN_TOOL_NAME, states.webRun);
		return resolution;
	}

	// `none`, and an explicit local route with no model, are fail-closed states:
	// release any toolkit ownership, but do not activate another implementation.
	if (resolution.route === "none" || (resolution.route === "local" && !resolution.available)) {
		releaseOwnership(pi, LOCAL_WEB_SEARCH_TOOL_NAME, states.webSearch);
		releaseOwnership(pi, WEB_RUN_TOOL_NAME, states.webRun);
	} else {
		claimAndRemove(pi, LOCAL_WEB_SEARCH_TOOL_NAME, states.webSearch);
		claimAndRemove(pi, WEB_RUN_TOOL_NAME, states.webRun);
	}
	return resolution;
}

function routeReadyForPrompt(
	resolution: WebSearchRouteResolution,
	standaloneReady: boolean,
): boolean {
	return resolution.route !== "none" && resolution.available &&
		(resolution.route !== "standalone-alpha" || standaloneReady);
}

export function registerWebSearchExtension(
	pi: ExtensionAPI,
	loadConfig: typeof loadToolkitConfig = loadToolkitConfig,
	requestSearch: typeof requestAlphaSearch = requestAlphaSearch,
	resolveRuntime: typeof resolveResponsesEnvironment = resolveResponsesEnvironment,
): void {
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	const states = { webSearch: cloneToolState(), webRun: cloneToolState() };
	let standaloneRegistrationSucceeded = false;

	const standaloneTool = createWebRunTool({
		loadConfig,
		resolveRuntime,
		requestSearch,
		isRegistered: () => standaloneReady(),
	});

	try {
		const api = pi as ExtensionAPI & { registerTool?: (tool: typeof standaloneTool) => void };
		if (typeof api.registerTool === "function") {
			api.registerTool(standaloneTool);
			standaloneRegistrationSucceeded = true;
			// Pi initially activates newly registered extension tools. Treat that
			// activation as toolkit-owned rather than as a third-party preference;
			// otherwise an unconfigured route would leak web_run into every prompt.
			states.webRun = { wasActiveBeforeOwnership: false, toolkitOwnsTool: true };
		}
	} catch {
		standaloneRegistrationSucceeded = false;
	}

	function standaloneReady(): boolean {
		if (!standaloneRegistrationSucceeded || !canManageActiveTools(pi)) return false;
		// Recheck on every lifecycle boundary so a later extension cannot replace
		// the definition after startup and leave a stale active name executable.
		// Do not use getAllTools() during extension loading; lifecycle callbacks
		// are the first point where Pi's action methods are bound.
		return verifyStandaloneRegistration(pi, standaloneTool);
	}

	function readConfig(model: WebSearchModel | undefined, ctx?: ExtensionContext): ResolvedToolkitConfig {
		const resolved = resolveToolkitConfig(loadConfig(), model);
		if (ctx) notifyConfigIssues(ctx, resolved);
		return resolved;
	}

	function synchronizeResolved(model: WebSearchModel | undefined, resolved: ResolvedToolkitConfig): WebSearchRouteResolution {
		if (resolved.invalidFeatures.some((feature) => feature === "webSearch" || feature === "compatibility")) {
			claimAndRemove(pi, LOCAL_WEB_SEARCH_TOOL_NAME, states.webSearch);
			claimAndRemove(pi, WEB_RUN_TOOL_NAME, states.webRun);
			return { route: "none", source: "none", modelKey: resolved.modelKey, reason: "unconfigured" };
		}
		return syncWebSearchRoute(pi, model, resolved.config.webSearch, states, standaloneReady());
	}

	function synchronize(model: WebSearchModel | undefined, ctx?: ExtensionContext): WebSearchRouteResolution {
		return synchronizeResolved(model, readConfig(model, ctx));
	}

	pi.on("session_start", (_event, ctx) => {
		synchronize(ctx.model, ctx);
	});

	pi.on("model_select", (event, ctx) => {
		synchronize(event.model, ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const resolved = readConfig(ctx.model, ctx);
		const { config } = resolved;
		const resolution = synchronizeResolved(ctx.model, resolved);
		const localToolIsActive = resolution.route === "local"
			? isActiveTool(pi, LOCAL_WEB_SEARCH_TOOL_NAME)
			: undefined;
		const promptRouteReady = routeReadyForPrompt(resolution, standaloneReady()) &&
			(resolution.route !== "local" || localToolIsActive === true);
		const systemPrompt = appendWebSearchPrompt({
			model: ctx.model,
			config: config.webSearch,
			systemPrompt: event.systemPrompt,
			...(promptRouteReady ? {} : { routeAvailable: false }),
		});
		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});

	pi.on("before_provider_request", (event, ctx) => {
		const resolved = readConfig(ctx.model, ctx);
		try { assertConfigValid(resolved, "webSearch", "compatibility"); }
		catch (error) { abortAndThrow(ctx, error instanceof Error ? error.message : "Invalid Web Search configuration."); }
		const { config } = resolved;
		const resolution = synchronizeResolved(ctx.model, resolved);
		if (resolution.route === "standalone-alpha" && resolution.available && !standaloneReady()) {
			abortAndThrow(ctx, `${WEB_RUN_TOOL_NAME} is not registered by the toolkit; standalone Web Search request aborted.`);
		}
		const transformed = transformWebSearchPayload({
			model: ctx.model,
			config: config.webSearch,
			payload: event.payload,
		});
		if (transformed.fatal) {
			abortAndThrow(ctx, transformed.errorMessage ?? "Web Search route request aborted.");
		}
		return transformed.changed ? transformed.payload : undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== LOCAL_WEB_SEARCH_TOOL_NAME && event.toolName !== WEB_RUN_TOOL_NAME) {
			return undefined;
		}
		const resolved = readConfig(ctx.model, ctx);
		const resolution = synchronizeResolved(ctx.model, resolved);
		try { assertConfigValid(resolved, "webSearch", "compatibility"); }
		catch (error) { return { block: true, reason: error instanceof Error ? error.message : "Invalid Web Search configuration." }; }
		if (event.toolName === LOCAL_WEB_SEARCH_TOOL_NAME) {
			if (resolution.route === "none") return undefined;
			if (resolution.route === "local" && resolution.available) {
				if (isActiveTool(pi, LOCAL_WEB_SEARCH_TOOL_NAME) === true) return undefined;
				return {
					block: true,
					reason: "The local web_search tool is not active for the selected local Web Search route; the call was blocked instead of falling back.",
				};
			}
			return {
				block: true,
				reason: `${describeRouteFailure(resolution)} The local web_search call was blocked instead of falling back.`,
			};
		}
		if (resolution.route === "none") return undefined;
		if (resolution.route === "standalone-alpha" && resolution.available && standaloneReady()) {
			return undefined;
		}
		return {
			block: true,
			reason: `${describeRouteFailure(resolution)} The ${WEB_RUN_TOOL_NAME} call was blocked instead of falling back.`,
		};
	});
}

export default function webSearchExtension(pi: ExtensionAPI): void {
	registerWebSearchExtension(pi);
}

export const _extensionTest = {
	createWebRunTool,
	verifyStandaloneRegistration,
	syncWebSearchRoute,
	standaloneRuntimeFailure,
};
