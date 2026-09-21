import { v2Fixture } from "../config/test-helpers";
import type { loadToolkitConfig } from "../config";
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_TOOLKIT_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
	type WebSearchConfig,
} from "../types";
import { registerWebSearchExtension } from "./extension";
import { WEB_SEARCH_SOURCE_INCLUDE } from "./types";

type Handler = (event: any, ctx: any) => unknown;

function createHarness(args: {
	activeTools?: string[];
	webSearch?: Partial<typeof DEFAULT_WEB_SEARCH_CONFIG>;
} = {}) {
	const handlers = new Map<string, Handler>();
	let activeTools = [...(args.activeTools ?? [])];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
	};
	registerWebSearchExtension(
		pi as never,
		() => ({
			config: {
				compaction: {
					...DEFAULT_COMPACTION_CONFIG,
					responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis],
				},
				webSearch: {
					...DEFAULT_WEB_SEARCH_CONFIG,
					models: ["newapi/gpt-5.5"],
					...(args.webSearch ?? {}),
				},
				imageGeneration: { ...DEFAULT_IMAGE_GENERATION_CONFIG },
			},
			warnings: [],
		}),
	);
	const ctx = {
		hasUI: true,
		model: { provider: "newapi", api: "openai-responses", id: "gpt-5.5" },
		ui: {
			notify: () => undefined,
		},
	};
	return { handlers, ctx, getActiveTools: () => activeTools };
}

describe("Web Search extension", () => {
	test("gives toolkit ownership to an eligible model", () => {
		const { handlers, ctx, getActiveTools } = createHarness({ activeTools: ["read", "web_search"] });
		const sessionStart = handlers.get("session_start")!;
		sessionStart({ type: "session_start", reason: "startup" }, ctx);

		expect(getActiveTools()).toEqual(["read"]);

		const beforeAgentStart = handlers.get("before_agent_start")!;
		const beforeProviderRequest = handlers.get("before_provider_request")!;
		const promptResult = beforeAgentStart({ systemPrompt: "Base prompt" }, ctx) as {
			systemPrompt: string;
		};
		const payloadResult = beforeProviderRequest(
			{
				payload: {
					model: "gpt-5.5",
					input: [],
					tools: [{ type: "function", name: "web_search" }],
				},
			},
			ctx,
		) as Record<string, unknown>;

		expect(promptResult.systemPrompt).toContain("## Web Search");
		expect(payloadResult.tools).toEqual([{ type: "web_search" }]);
		expect(payloadResult.include).toEqual([WEB_SEARCH_SOURCE_INCLUDE]);
	});

	test("restores and reclaims the local tool when the model changes", () => {
		const { handlers, ctx, getActiveTools } = createHarness({ activeTools: ["read", "web_search"] });
		const sessionStart = handlers.get("session_start")!;
		const modelSelect = handlers.get("model_select")!;

		sessionStart({ type: "session_start", reason: "startup" }, ctx);
		expect(getActiveTools()).toEqual(["read"]);

		modelSelect(
			{
				model: { provider: "newapi", api: "openai-completions", id: "gpt-5.5" },
			},
			ctx,
		);
		expect(getActiveTools()).toEqual(["read", "web_search"]);

		modelSelect({ model: ctx.model }, ctx);
		expect(getActiveTools()).toEqual(["read"]);
	});

	test("does not activate a local tool that was initially inactive", () => {
		const { handlers, ctx, getActiveTools } = createHarness({ activeTools: ["read"] });
		const sessionStart = handlers.get("session_start")!;
		const modelSelect = handlers.get("model_select")!;

		sessionStart({ type: "session_start", reason: "startup" }, ctx);
		modelSelect(
			{
				model: { provider: "newapi", api: "openai-completions", id: "gpt-5.5" },
			},
			ctx,
		);

		expect(getActiveTools()).toEqual(["read"]);
	});

	test("leaves unlisted models and their local tools unchanged", () => {
		const { handlers, ctx, getActiveTools } = createHarness({
			activeTools: ["read", "web_search"],
			webSearch: { models: ["newapi/other-model"] },
		});
		const beforeAgentStart = handlers.get("before_agent_start")!;
		const beforeProviderRequest = handlers.get("before_provider_request")!;

		expect(beforeAgentStart({ systemPrompt: "Base prompt" }, ctx)).toBeUndefined();
		expect(
			beforeProviderRequest({
				payload: { model: "gpt-5.5", input: [], tools: [{ type: "function", name: "web_search" }] },
			}, ctx),
		).toBeUndefined();
		expect(getActiveTools()).toEqual(["read", "web_search"]);
	});
});

function createStandaloneHarness(args: {
	activeTools?: string[];
	webSearch?: Partial<typeof DEFAULT_WEB_SEARCH_CONFIG>;
	loadConfig?: typeof loadToolkitConfig;
} = {}) {
	const handlers = new Map<string, Handler>();
	const registered: any[] = [];
	let activeTools = [...(args.activeTools ?? ["read"])] as string[];
	let aborted = 0;
	const config = {
		...DEFAULT_TOOLKIT_CONFIG,
		compaction: {
			...DEFAULT_COMPACTION_CONFIG,
			responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis],
			gatewayContextModels: [],
		},
		webSearch: {
			...DEFAULT_WEB_SEARCH_CONFIG,
			models: [],
			...(args.webSearch ?? {}),
		},
		imageGeneration: { ...DEFAULT_IMAGE_GENERATION_CONFIG },
	};
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: (tool: unknown) => registered.push(tool),
		getAllTools: () => registered,
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
	};
	const searchCalls: any[] = [];
	const requestSearch = async (args: any) => {
		searchCalls.push(args);
		return {
			ok: true,
			status: 200,
			output: "standalone result",
			details: { status: 200, responseId: "alpha-test" },
		};
	};
	const resolveRuntime = async () => ({
		ok: true,
		runtime: {
			provider: "gateway",
			api: "openai-responses",
			model: "gpt-6-astra",
			baseUrl: "https://gateway.example/v1",
			apiKey: "key",
			responsesPath: "responses",
			responsesUrl: "https://gateway.example/v1/responses",
			currentModel: { headers: {} },
		},
	});
	registerWebSearchExtension(
		pi as never,
		(args.loadConfig ?? (() => ({ config, warnings: [] }))) as never,
		requestSearch as never,
		resolveRuntime as never,
	);
	const ctx = {
		model: { provider: "gateway", api: "openai-responses", id: "gpt-6-astra" },
		hasUI: true,
		abort: () => { aborted += 1; },
		ui: { notify: () => undefined },
	};
	return {
		pi,
		handlers,
		ctx,
		config,
		registered,
		searchCalls,
		getActiveTools: () => activeTools,
		getAborted: () => aborted,
	};
}

type RouteCycleStateKey = "standalone" | "local" | "hosted" | "disabled" | "unconfigured";

const DOTTED_WEB_RUN_ALIAS = "web.run";
const ROUTE_LOCAL_TOOL_FIXTURE = {
	type: "function",
	name: "web_search",
	description: "third-party local search",
	parameters: { type: "object" },
};
const ROUTE_READ_TOOL_FIXTURE = { type: "function", name: "read", parameters: { type: "object" } };

type RouteCycleExpectation = {
	configure: (config: WebSearchConfig) => void;
	activeTools: string[];
	guidance: "none" | { contains: string; excludes: string[] };
	/** `undefined` means the provider hook must leave the caller payload untouched. */
	payload?: { tools: unknown[]; include: unknown[] };
	blockWebRun: boolean;
	blockLocalSearch: boolean;
};

const ROUTE_CYCLE_STATES: Record<RouteCycleStateKey, RouteCycleExpectation> = {
	standalone: {
		configure: (config) => {
			config.enabled = true;
			config.models = [];
			config.defaultRoute = "standalone-alpha";
			config.routes = undefined;
		},
		activeTools: ["read", "web_run"],
		guidance: {
			contains: "The `web_run` tool is available",
			excludes: ["The hosted `web_search` tool", "The local `web_search` tool"],
		},
		payload: {
			tools: [{ type: "function", name: "web_run", parameters: { type: "object" } }, ROUTE_READ_TOOL_FIXTURE],
			include: ["reasoning.encrypted_content"],
		},
		blockWebRun: false,
		blockLocalSearch: true,
	},
	local: {
		configure: (config) => {
			config.enabled = true;
			config.models = [];
			config.defaultRoute = "local";
			config.routes = undefined;
		},
		activeTools: ["read", "web_search"],
		guidance: {
			contains: "The local `web_search` tool is available",
			excludes: ["The `web_run` tool is available", "The hosted `web_search` tool"],
		},
		payload: {
			tools: [ROUTE_LOCAL_TOOL_FIXTURE, ROUTE_READ_TOOL_FIXTURE],
			include: ["reasoning.encrypted_content"],
		},
		blockWebRun: true,
		blockLocalSearch: false,
	},
	hosted: {
		configure: (config) => {
			config.enabled = true;
			config.models = [];
			config.defaultRoute = "hosted";
			config.routes = undefined;
		},
		activeTools: ["read"],
		guidance: {
			contains: "The hosted `web_search` tool is part of your tool list",
			excludes: ["The `web_run` tool is available", "The local `web_search` tool"],
		},
		payload: {
			tools: [{ type: "web_search" }, ROUTE_READ_TOOL_FIXTURE],
			include: [WEB_SEARCH_SOURCE_INCLUDE, "reasoning.encrypted_content"],
		},
		blockWebRun: true,
		blockLocalSearch: true,
	},
	disabled: {
		configure: (config) => {
			config.enabled = false;
			config.models = [];
			config.defaultRoute = undefined;
			config.routes = undefined;
		},
		// A disabled route releases toolkit ownership. The local tool returns to
		// whatever third party owned it before, and no route owns an active tool.
		activeTools: ["read", "web_search"],
		guidance: "none",
		blockWebRun: false,
		blockLocalSearch: false,
	},
	unconfigured: {
		configure: (config) => {
			config.enabled = true;
			config.models = [];
			config.defaultRoute = undefined;
			config.routes = undefined;
		},
		activeTools: ["read", "web_search"],
		guidance: "none",
		blockWebRun: false,
		blockLocalSearch: false,
	},
};

function switchRouteCycleState(
	harness: ReturnType<typeof createStandaloneHarness>,
	key: RouteCycleStateKey,
): void {
	ROUTE_CYCLE_STATES[key].configure(harness.config.webSearch);
	harness.handlers.get("model_select")!({ model: harness.ctx.model }, harness.ctx);
}

function createRouteCyclePayload() {
	return {
		model: "gpt-6-astra",
		input: [],
		tools: [
			{ type: "function", name: "web_run", parameters: { type: "object" } },
			{ type: "function", name: "web_run" },
			ROUTE_LOCAL_TOOL_FIXTURE,
			{ type: "web_search" },
			{ type: "web_search_preview" },
			ROUTE_READ_TOOL_FIXTURE,
		],
		include: [WEB_SEARCH_SOURCE_INCLUDE, "reasoning.encrypted_content"],
		unrelated: "keep",
	};
}

function observeRouteCycle(harness: ReturnType<typeof createStandaloneHarness>, systemPrompt: string) {
	const payload = createRouteCyclePayload();
	const snapshot = structuredClone(payload);
	const beforeAgentStart = harness.handlers.get("before_agent_start")!({ systemPrompt }, harness.ctx);
	const beforeProviderRequest = harness.handlers.get("before_provider_request")!({ payload }, harness.ctx);
	const webRunGuard = harness.handlers.get("tool_call")!(
		{ toolName: "web_run", toolCallId: "cycle-web-run", input: {} },
		harness.ctx,
	);
	const localGuard = harness.handlers.get("tool_call")!(
		{ toolName: "web_search", toolCallId: "cycle-local-search", input: {} },
		harness.ctx,
	);
	return {
		activeTools: harness.getActiveTools(),
		payload,
		snapshot,
		beforeAgentStart,
		beforeProviderRequest,
		webRunGuard,
		localGuard,
	};
}

function expectRouteCycleState(
	harness: ReturnType<typeof createStandaloneHarness>,
	key: RouteCycleStateKey,
	previousPrompt = "Base prompt",
): string {
	const expected = ROUTE_CYCLE_STATES[key];
	const observed = observeRouteCycle(harness, previousPrompt);

	expect(observed.activeTools).toEqual(expected.activeTools);
	expect(observed.activeTools.filter((name) => name === "web_run")).toHaveLength(key === "standalone" ? 1 : 0);

	const guidance = observed.beforeAgentStart as { systemPrompt: string } | undefined;
	const systemPrompt = guidance?.systemPrompt ?? previousPrompt;
	if (expected.guidance === "none") {
		expect(systemPrompt).toBe("Base prompt");
	} else {
		expect(systemPrompt).toContain(expected.guidance.contains);
		for (const excluded of expected.guidance.excludes) expect(systemPrompt).not.toContain(excluded);
		// The standalone section must name the callable exactly once.
		if (key === "standalone") expect(systemPrompt.split("`web_run`")).toHaveLength(2);
	}

	const transformed = observed.beforeProviderRequest as
		| { tools?: unknown[]; include?: unknown[]; unrelated?: unknown }
		| undefined;
	if (expected.payload) {
		expect(transformed).toBeDefined();
		expect(transformed!.tools).toEqual(expected.payload.tools);
		expect(transformed!.include).toEqual(expected.payload.include);
		expect(transformed!.unrelated).toBe("keep");
	} else {
		expect(transformed).toBeUndefined();
	}
	// A disabled or unconfigured route releases ownership; it must not erase
	// third-party tools from the outgoing payload.
	expect(observed.payload).toEqual(observed.snapshot);

	const webRunGuard = observed.webRunGuard as { block?: boolean; reason?: string } | undefined;
	const localGuard = observed.localGuard as { block?: boolean; reason?: string } | undefined;
	expect(webRunGuard?.block ?? false).toBe(expected.blockWebRun);
	expect(localGuard?.block ?? false).toBe(expected.blockLocalSearch);
	if (expected.blockWebRun) expect(webRunGuard?.reason).toContain("blocked instead of falling back");
	if (expected.blockLocalSearch) expect(localGuard?.reason).toContain("blocked instead of falling back");

	// Issue #5 regression: no surface may reintroduce the dotted callable alias.
	expect(String(JSON.stringify(observed.activeTools))).not.toContain(DOTTED_WEB_RUN_ALIAS);
	expect(String(JSON.stringify(observed.beforeAgentStart))).not.toContain(DOTTED_WEB_RUN_ALIAS);
	expect(String(JSON.stringify(transformed))).not.toContain(DOTTED_WEB_RUN_ALIAS);
	return systemPrompt;
}

describe("standalone-alpha route round-trips", () => {
	for (const intermediate of ["local", "hosted", "disabled", "unconfigured"] as const) {
		test(`standalone -> ${intermediate} -> standalone stays consistent`, () => {
			const harness = createStandaloneHarness({
				activeTools: ["read", "web_search"],
				webSearch: { defaultRoute: "standalone-alpha" },
			});
			harness.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, harness.ctx);
			let prompt = expectRouteCycleState(harness, "standalone");

			switchRouteCycleState(harness, intermediate);
			prompt = expectRouteCycleState(harness, intermediate, prompt);

			switchRouteCycleState(harness, "standalone");
			expectRouteCycleState(harness, "standalone", prompt);
			// Returning must not register a second definition or a legacy alias.
			expect(harness.registered.map((tool) => tool.name)).toEqual(["web_run"]);
		});
	}
});

describe("standalone-alpha Web Search route", () => {
	for (const tools of [undefined, [], [ROUTE_READ_TOOL_FIXTURE]]) {
		test(`host-filtered web_run permits ordinary requests with ${tools === undefined ? "omitted" : tools.length} tools`, async () => {
			const harness = createStandaloneHarness({ webSearch: { defaultRoute: "standalone-alpha" } });
			// Pi applies --tools/--exclude-tools/--no-tools before publishing its
			// registry. Registration succeeds, but excluded tools are not listed.
			harness.pi.getAllTools = () => [];
			harness.handlers.get("session_start")!({}, harness.ctx);
			const configSnapshot = structuredClone(harness.config);
			const payload = { model: harness.ctx.model.id, input: [], ...(tools ? { tools } : {}) };
			const snapshot = structuredClone(payload);

			expect(harness.handlers.get("before_agent_start")!({ systemPrompt: "Base" }, harness.ctx)).toBeUndefined();
			expect(harness.handlers.get("before_provider_request")!({ payload }, harness.ctx)).toBeUndefined();
			expect(harness.getAborted()).toBe(0);
			expect(payload).toEqual(snapshot);
			expect(harness.getActiveTools()).toEqual(["read"]);
			expect(harness.config).toEqual(configSnapshot);
			for (const toolName of ["web_run", "web_search"]) {
				expect(harness.handlers.get("tool_call")!({ toolName }, harness.ctx)).toMatchObject({ block: true });
			}
			await expect(harness.registered[0].execute("excluded", { search_query: [{ q: "blocked" }] }, undefined, undefined, harness.ctx))
				.rejects.toThrow(/not registered/);
			expect(harness.searchCalls).toHaveLength(0);
		});
	}

	test("host-filtered web_run removes stale search schemas and guidance without fallback", () => {
		const harness = createStandaloneHarness({
			activeTools: ["read", "web_search"], webSearch: { defaultRoute: "standalone-alpha" },
		});
		harness.handlers.get("session_start")!({}, harness.ctx);
		const prompt = harness.handlers.get("before_agent_start")!({ systemPrompt: "Base" }, harness.ctx) as { systemPrompt: string };
		expect(prompt.systemPrompt).toContain("The `web_run` tool is available");
		harness.pi.getAllTools = () => [];
		const payload = createRouteCyclePayload();
		const snapshot = structuredClone(payload);
		expect(harness.handlers.get("before_agent_start")!(prompt, harness.ctx)).toEqual({ systemPrompt: "Base" });
		expect(harness.handlers.get("before_provider_request")!({ payload }, harness.ctx)).toEqual({
			...payload, tools: [ROUTE_READ_TOOL_FIXTURE], include: ["reasoning.encrypted_content"],
		});
		expect(payload).toEqual(snapshot);
		expect(harness.getActiveTools()).toEqual(["read"]);
		expect(harness.getAborted()).toBe(0);
		expect(harness.searchCalls).toHaveLength(0);
	});

	test("host filtering is rechecked without changing configuration or registering extra tools", () => {
		const harness = createStandaloneHarness({ webSearch: { defaultRoute: "standalone-alpha" } });
		harness.pi.getAllTools = () => [];
		harness.handlers.get("session_start")!({}, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read"]);
		harness.pi.getAllTools = () => harness.registered;
		harness.handlers.get("model_select")!({ model: harness.ctx.model }, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read", "web_run"]);
		expect(harness.registered).toHaveLength(1);
		expect(harness.config.webSearch.defaultRoute).toBe("standalone-alpha");
	});

	test("an unreadable or conflicting registry is not treated as host exclusion", () => {
		for (const getAllTools of [
			() => { throw new Error("unbound API"); },
			() => [{ name: "web_run", description: "third-party", parameters: {} }],
		]) {
			const harness = createStandaloneHarness({ webSearch: { defaultRoute: "standalone-alpha" } });
			harness.pi.getAllTools = getAllTools;
			expect(() => harness.handlers.get("before_provider_request")!({
				payload: { input: [], tools: [ROUTE_READ_TOOL_FIXTURE] },
			}, harness.ctx)).toThrow(/not registered/);
			expect(harness.getAborted()).toBe(1);
		}
	});

	test("a published web_run missing from the payload still fails closed", () => {
		const harness = createStandaloneHarness({ webSearch: { defaultRoute: "standalone-alpha" } });
		expect(() => harness.handlers.get("before_provider_request")!({
			payload: { input: [], tools: [ROUTE_READ_TOOL_FIXTURE] },
		}, harness.ctx)).toThrow(/requires the registered web_run/);
		expect(harness.getAborted()).toBe(1);
	});

	test("registered standalone function keeps a provider-valid name through dispatch", async () => {
		const harness = createStandaloneHarness({ webSearch: { defaultRoute: "standalone-alpha" } });
		harness.handlers.get("session_start")!({}, harness.ctx);
		expect(harness.registered).toHaveLength(1);
		const tool = harness.registered[0];
		expect(tool.name).toBe("web_run");
		expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
		const payload = {
			model: harness.ctx.model.id,
			input: [],
			tools: [
				{ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters },
				{ type: "web_search" },
			],
		};
		const transformed = harness.handlers.get("before_provider_request")!({ payload }, harness.ctx) as typeof payload;
		expect(transformed.tools).toHaveLength(1);
		const outgoing = transformed.tools[0];
		expect(outgoing.name).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(outgoing.name).toBe(tool.name);
		expect(harness.getActiveTools()).toContain(outgoing.name);
		const prompt = harness.handlers.get("before_agent_start")!({ systemPrompt: "Base" }, harness.ctx) as { systemPrompt: string };
		expect(prompt.systemPrompt).toContain(`\`${outgoing.name}\``);
		const dispatched = harness.registered.find((candidate) => candidate.name === outgoing.name);
		const result = await dispatched.execute("search-1", { search_query: [{ q: "test" }] }, undefined, undefined, harness.ctx);
		expect(result.content).toEqual([{ type: "text", text: "standalone result" }]);
		expect(harness.searchCalls).toHaveLength(1);
	});

	test("removes the registered tool when no standalone route is selected", () => {
		const harness = createStandaloneHarness({
			activeTools: ["read", "web_run"],
			webSearch: {},
		});
		harness.handlers.get("session_start")!({}, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read"]);
	});

	test("exact route wins and leaves only web_run active", async () => {
		const harness = createStandaloneHarness({
			activeTools: ["read", "web_search", "web_run", "web_run"],
			webSearch: {
				defaultRoute: "hosted",
				models: ["gateway/gpt-6-astra"],
				routes: { "gateway/gpt-6-astra": "standalone-alpha" },
			},
		});
		harness.handlers.get("session_start")!({}, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read", "web_run"]);

		const prompt = harness.handlers.get("before_agent_start")!({ systemPrompt: "Base" }, harness.ctx) as { systemPrompt: string };
		expect(prompt.systemPrompt).toContain("`web_run`");
		expect(prompt.systemPrompt).not.toContain("The hosted `web_search` tool");

		const payload = {
			model: "gpt-6-astra",
			input: [],
			tools: [
				{ type: "function", name: "web_search" },
				{ type: "web_search" },
				{ type: "function", name: "web_run" },
				{ type: "function", name: "read" },
			],
			include: ["web_search_call.action.sources", "reasoning.encrypted_content"],
		};
		const transformed = harness.handlers.get("before_provider_request")!(
			{ payload },
			harness.ctx,
		) as { tools: unknown[]; include: unknown[] };
		expect(transformed.tools).toEqual([
			{ type: "function", name: "web_run" },
			{ type: "function", name: "read" },
		]);
		expect(transformed.include).toEqual(["reasoning.encrypted_content"]);
	});

	test("route switches restore local ownership and keep web_run independent", () => {
		const harness = createStandaloneHarness({
			activeTools: ["read", "web_search"],
			webSearch: { defaultRoute: "standalone-alpha" },
		});
		harness.handlers.get("session_start")!({}, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read", "web_run"]);

		harness.config.webSearch.defaultRoute = "local";
		harness.handlers.get("model_select")!({ model: harness.ctx.model }, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read", "web_search"]);

		harness.config.webSearch.defaultRoute = "hosted";
		harness.handlers.get("model_select")!({ model: harness.ctx.model }, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read"]);
	});

	test("explicit local route preserves the third-party tool and performs no hosted transform", () => {
		const harness = createStandaloneHarness({
			activeTools: ["read", "web_search"],
			webSearch: { defaultRoute: "local" },
		});
		harness.handlers.get("session_start")!({}, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read", "web_search"]);
		expect(harness.handlers.get("before_agent_start")!({ systemPrompt: "Base" }, harness.ctx)).toEqual({
			systemPrompt: "Base\n\n<!-- pi-openai-toolkit:web-search -->\n## Web Search\n\nThe local `web_search` tool is available for this model. Use it when current or online information matters, and cite the sources returned by that tool. Do not claim that the provider API executes this local tool server-side.",
	});
		const payload = { model: "gpt-6-astra", input: [], tools: [{ type: "web_search" }] };
		expect(harness.handlers.get("before_provider_request")!({ payload }, harness.ctx)).toEqual({
			model: "gpt-6-astra",
			input: [],
			tools: [],
		});
	});

	test("local route does not claim an inactive local tool", () => {
		const harness = createStandaloneHarness({
			activeTools: ["read"],
			webSearch: { defaultRoute: "local" },
		});
		harness.handlers.get("session_start")!({}, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read"]);
		expect(harness.handlers.get("before_agent_start")!({ systemPrompt: "Base" }, harness.ctx)).toBeUndefined();

		const guard = harness.handlers.get("tool_call")!({ toolName: "web_search", toolCallId: "local-1", input: {} }, harness.ctx) as {
			block: boolean;
			reason: string;
		};
		expect(guard.block).toBe(true);
		expect(guard.reason).toContain("not active");
	});

	test("an unavailable local route releases toolkit ownership without deleting the local tool", () => {
		const harness = createStandaloneHarness({
			activeTools: ["read", "web_search"],
			webSearch: { defaultRoute: "hosted" },
		});
		harness.handlers.get("session_start")!({}, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read"]);

		harness.config.webSearch.defaultRoute = "local";
		harness.handlers.get("model_select")!({ model: undefined }, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read", "web_search"]);
	});

	test("missing active-tool controls fail closed before a standalone provider request", () => {
		const handlers = new Map<string, Handler>();
		const registered: unknown[] = [];
		let aborted = 0;
		const pi = {
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			registerTool: (tool: unknown) => registered.push(tool),
			getAllTools: () => registered,
		};
		const config = {
			...DEFAULT_TOOLKIT_CONFIG,
			compaction: { ...DEFAULT_COMPACTION_CONFIG, responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis] },
			webSearch: { ...DEFAULT_WEB_SEARCH_CONFIG, defaultRoute: "standalone-alpha" as const },
			imageGeneration: { ...DEFAULT_IMAGE_GENERATION_CONFIG },
		};
		registerWebSearchExtension(pi as never, (() => ({ config, warnings: [] })) as never);
		const ctx = {
			model: { provider: "gateway", api: "openai-responses", id: "gpt-6-astra" },
			hasUI: true,
			abort: () => { aborted += 1; },
			ui: { notify: () => undefined },
		};
		handlers.get("session_start")!({}, ctx);
		expect(() => handlers.get("before_provider_request")!({
			payload: {
				model: "gpt-6-astra",
				input: [],
				tools: [{ type: "function", name: "web_run" }],
			},
		}, ctx)).toThrow(/not registered|aborted/i);
		expect(aborted).toBe(1);
	});

	test("registration conflicts fail closed without replacing another web_run definition", () => {
		const handlers = new Map<string, Handler>();
		let active = ["read", "web_search", "web_run"];
		const conflicting = { name: "web_run", description: "third-party", parameters: {} };
		const pi = {
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			registerTool: () => { throw new Error("conflict"); },
			getAllTools: () => [conflicting],
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => { active = [...names]; },
		};
		const ctx = {
			model: { provider: "gateway", api: "openai-responses", id: "gpt-6-astra" },
			hasUI: true,
			abort: () => undefined,
			ui: { notify: () => undefined },
		};
		registerWebSearchExtension(
			pi as never,
			(() => ({
				config: {
					...DEFAULT_TOOLKIT_CONFIG,
					compaction: { ...DEFAULT_COMPACTION_CONFIG, responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis] },
					webSearch: {
						...DEFAULT_WEB_SEARCH_CONFIG,
						defaultRoute: "standalone-alpha",
					},
					imageGeneration: { ...DEFAULT_IMAGE_GENERATION_CONFIG },
				},
				warnings: [],
			})) as never,
		);
		handlers.get("session_start")!({}, ctx);
		expect(active).toEqual(["read"]);
		const guard = handlers.get("tool_call")!({ toolName: "web_run", toolCallId: "c", input: {} }, ctx) as { block: boolean };
		expect(guard.block).toBe(true);
		// A rejected registration must not be mistaken for host filtering, even
		// when the conflicting definition is subsequently hidden from the catalog.
		pi.getAllTools = () => [];
		expect(() => handlers.get("before_provider_request")!({
			payload: { input: [], tools: [ROUTE_READ_TOOL_FIXTURE] },
		}, ctx)).toThrow(/not registered/);
	});

	test("web_run execution revalidates route and maps all commands before dispatch", async () => {
		const harness = createStandaloneHarness({ webSearch: { defaultRoute: "standalone-alpha" } });
		harness.handlers.get("session_start")!({}, harness.ctx);
		const tool = harness.registered.find((candidate: { name: string }) => candidate.name === "web_run");
		expect(tool.executionMode).toBe("sequential");
		const result = await tool.execute("call-1", {
			search_query: [{ q: "latest" }],
			image_query: [{ q: "kite" }],
			open: [{ ref_id: "ref-1", lineno: 2 }],
			click: [{ ref_id: "ref-1", id: 1 }],
			find: [{ ref_id: "ref-1", pattern: "price" }],
			screenshot: [{ ref_id: "ref-1", pageno: 0 }],
			finance: [{ ticker: "AAPL", type: "equity" }],
			weather: [{ location: "Seattle" }],
			sports: [{ fn: "schedule", league: "nfl" }],
			time: [{ utc_offset: "+00:00" }],
			response_length: "short",
		},
			undefined,
			undefined,
			harness.ctx,
		);
		expect(result.content).toEqual([{ type: "text", text: "standalone result" }]);
		expect(result.details).toEqual({ status: 200, responseId: "alpha-test" });
		expect(harness.searchCalls).toHaveLength(1);
		expect(harness.searchCalls[0].commands).toMatchObject({
			search_query: [{ q: "latest" }],
			sports: [{ fn: "schedule", league: "nfl" }],
		});

		harness.config.webSearch.defaultRoute = "hosted";
		await expect(tool.execute("call-2", { search_query: [{ q: "blocked" }] }, undefined, undefined, harness.ctx)).rejects.toThrow(/route/i);
		expect(harness.searchCalls).toHaveLength(1);
	});
});


test("invalid selected v2 search cannot leak local/standalone tools or dispatch a request", async () => {
	let raw: Record<string, unknown> = { models: { "gateway/gpt-6-astra": { webSearch: { route: "standalone-alpha" } } } };
	let reads = 0;
	const h = createStandaloneHarness({ activeTools: ["read", "web_search"], loadConfig: () => { reads++; return v2Fixture(raw); } });
	h.handlers.get("session_start")!({}, h.ctx);
	expect(reads).toBe(1);
	expect(h.getActiveTools()).toEqual(["read", "web_run"]);
	raw = { models: { "gateway/gpt-6-astra": { webSearch: { route: "typo" } } } };
	h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);
	expect(h.getActiveTools()).toEqual(["read"]);
	expect(() => h.handlers.get("before_provider_request")!({ payload: { input: [] } }, h.ctx)).toThrow("configuration is invalid");
	expect(h.getAborted()).toBe(1);
	expect(h.handlers.get("tool_call")!({ toolName: "web_search" }, h.ctx)).toMatchObject({ block: true });
	await expect(h.registered[0].execute("id", { search_query: [{ q: "fixture" }] }, undefined, undefined, h.ctx)).rejects.toThrow("configuration is invalid");
	expect(h.searchCalls).toHaveLength(0);
	raw = { defaults: { webSearch: { route: "hosted" } }, models: { "other/model": { webSearch: { route: "typo" } } } };
	const payload = h.handlers.get("before_provider_request")!({ payload: { input: [], tools: [] } }, h.ctx) as { tools: unknown[] };
	expect(payload.tools).toEqual([{ type: "web_search" }]);
});
