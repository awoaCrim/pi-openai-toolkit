import { describe, expect, test } from "bun:test";
import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_TOOLKIT_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
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
		(() => ({ config, warnings: [] })) as never,
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

describe("standalone-alpha Web Search route", () => {
	test("removes the registered tool when no standalone route is selected", () => {
		const harness = createStandaloneHarness({
			activeTools: ["read", "web.run"],
			webSearch: {},
		});
		harness.handlers.get("session_start")!({}, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read"]);
	});

	test("exact route wins and leaves only web.run active", async () => {
		const harness = createStandaloneHarness({
			activeTools: ["read", "web_search", "web.run", "web.run"],
			webSearch: {
				defaultRoute: "hosted",
				models: ["gateway/gpt-6-astra"],
				routes: { "gateway/gpt-6-astra": "standalone-alpha" },
			},
		});
		harness.handlers.get("session_start")!({}, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read", "web.run"]);

		const prompt = harness.handlers.get("before_agent_start")!({ systemPrompt: "Base" }, harness.ctx) as { systemPrompt: string };
		expect(prompt.systemPrompt).toContain("`web.run`");
		expect(prompt.systemPrompt).not.toContain("The hosted `web_search` tool");

		const payload = {
			model: "gpt-6-astra",
			input: [],
			tools: [
				{ type: "function", name: "web_search" },
				{ type: "web_search" },
				{ type: "function", name: "web.run" },
				{ type: "function", name: "read" },
			],
			include: ["web_search_call.action.sources", "reasoning.encrypted_content"],
		};
		const transformed = harness.handlers.get("before_provider_request")!(
			{ payload },
			harness.ctx,
		) as { tools: unknown[]; include: unknown[] };
		expect(transformed.tools).toEqual([
			{ type: "function", name: "web.run" },
			{ type: "function", name: "read" },
		]);
		expect(transformed.include).toEqual(["reasoning.encrypted_content"]);
	});

	test("route switches restore local ownership and keep web.run independent", () => {
		const harness = createStandaloneHarness({
			activeTools: ["read", "web_search"],
			webSearch: { defaultRoute: "standalone-alpha" },
		});
		harness.handlers.get("session_start")!({}, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read", "web.run"]);

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
				tools: [{ type: "function", name: "web.run" }],
			},
		}, ctx)).toThrow(/not registered|aborted/i);
		expect(aborted).toBe(1);
	});

	test("registration conflicts fail closed without replacing another web.run definition", () => {
		const handlers = new Map<string, Handler>();
		let active = ["read", "web_search", "web.run"];
		const conflicting = { name: "web.run", description: "third-party", parameters: {} };
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
		const guard = handlers.get("tool_call")!({ toolName: "web.run", toolCallId: "c", input: {} }, ctx) as { block: boolean };
		expect(guard.block).toBe(true);
	});

	test("web.run execution revalidates route and maps all commands before dispatch", async () => {
		const harness = createStandaloneHarness({ webSearch: { defaultRoute: "standalone-alpha" } });
		harness.handlers.get("session_start")!({}, harness.ctx);
		const tool = harness.registered.find((candidate: { name: string }) => candidate.name === "web.run");
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
