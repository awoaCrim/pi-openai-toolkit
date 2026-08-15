import { describe, expect, test } from "bun:test";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_WEB_SEARCH_CONFIG } from "../types";
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
