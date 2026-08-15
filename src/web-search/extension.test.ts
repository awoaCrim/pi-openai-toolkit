import { describe, expect, test } from "bun:test";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_WEB_SEARCH_CONFIG } from "../types";
import { registerWebSearchExtension } from "./extension";
import { WEB_SEARCH_SOURCE_INCLUDE } from "./types";

type Handler = (event: any, ctx: any) => unknown;

function createHarness(args: {
	allTools?: Array<{ name: string }>;
	activeTools?: string[];
	webSearch?: Partial<typeof DEFAULT_WEB_SEARCH_CONFIG>;
} = {}) {
	const handlers = new Map<string, Handler>();
	const notifications: Array<[string, string]> = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getAllTools: () => args.allTools ?? [],
		getActiveTools: () => args.activeTools ?? [],
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
					apis: [...DEFAULT_WEB_SEARCH_CONFIG.apis],
					...(args.webSearch ?? {}),
				},
			},
			warnings: [],
		}),
	);
	const ctx = {
		hasUI: true,
		model: { api: "openai-responses" },
		ui: {
			notify: (message: string, level: string) => notifications.push([message, level]),
		},
	};
	return { handlers, notifications, ctx };
}

describe("Web Search extension", () => {
	test("warns once when a local web_search tool is registered", () => {
		const { handlers, notifications, ctx } = createHarness({
			allTools: [{ name: "read" }, { name: "web_search" }],
		});
		const sessionStart = handlers.get("session_start")!;

		sessionStart({ type: "session_start", reason: "startup" }, ctx);
		sessionStart({ type: "session_start", reason: "reload" }, ctx);

		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.[0]).toContain("local web_search tool detected");
		expect(notifications[0]?.[1]).toBe("warning");
	});

	test("registers prompt and payload hooks with raw replacement return shapes", () => {
		const { handlers, ctx } = createHarness();
		const beforeAgentStart = handlers.get("before_agent_start")!;
		const beforeProviderRequest = handlers.get("before_provider_request")!;

		const promptResult = beforeAgentStart({ systemPrompt: "Base prompt" }, ctx) as {
			systemPrompt: string;
		};
		const payloadResult = beforeProviderRequest(
			{ payload: { model: "gpt-5.5", input: [] } },
			ctx,
		) as Record<string, unknown>;

		expect(promptResult.systemPrompt).toContain("## Web Search");
		expect(payloadResult.tools).toEqual([{ type: "web_search" }]);
		expect(payloadResult.include).toEqual([WEB_SEARCH_SOURCE_INCLUDE]);
		expect(payloadResult).not.toHaveProperty("payload");
	});

	test("active and provider-payload conflicts suppress native behavior", () => {
		const { handlers, ctx } = createHarness({ activeTools: ["web_search"] });
		const beforeAgentStart = handlers.get("before_agent_start")!;
		const beforeProviderRequest = handlers.get("before_provider_request")!;
		const localPayload = {
			model: "gpt-5.5",
			input: [],
			tools: [{ type: "function", name: "web_search" }],
		};

		expect(beforeAgentStart({ systemPrompt: "Base prompt" }, ctx)).toBeUndefined();
		expect(beforeProviderRequest({ payload: localPayload }, ctx)).toBeUndefined();
	});
});
