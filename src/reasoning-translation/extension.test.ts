import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_REASONING_TRANSLATION_CONFIG, DEFAULT_WEB_SEARCH_CONFIG } from "../types";
import { registerReasoningTranslationExtension } from "./extension";

type Handler = (event: any, ctx: any) => unknown;

function assistant(thinking: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
		api: "openai-responses",
		provider: "source",
		model: "gpt",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createHarness(mode: "tui" | "print" = "tui") {
	const handlers = new Map<string, Handler>();
	let transformer: ((markdown: string, context: { messageType: string }) => string) | undefined;
	let refreshes = 0;
	const hiddenLabels: Array<string | undefined> = [];
	let calls = 0;
	const sourceModel = { provider: "source", api: "openai-responses", id: "gpt" } as Model<any>;
	const translatorModel = { provider: "translator", api: "openai-completions", id: "mini", maxTokens: 500 } as Model<any>;
	const provider = {
		streamSimple: () => {
			calls++;
			return {
				result: async () => ({
					...assistant(""),
					content: [{ type: "text", text: "translated" }],
				}),
			} as never;
		},
	} as unknown as Provider;
		const ctx = {
			mode,
			hasUI: mode === "tui",
			model: sourceModel,
			signal: undefined,
			sessionManager: { getBranch: () => [] },
			ui: { setHiddenThinkingLabel: (label?: string) => { refreshes++; hiddenLabels.push(label); } },
			modelRegistry: {
				find: () => translatorModel,
				getProvider: () => provider,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
			},
		} as never;
		const pi = {
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			registerMarkdownTransformer: (handler: typeof transformer) => { transformer = handler; },
			appendEntry: () => undefined,
		};
	registerReasoningTranslationExtension(pi as never, () => ({
		config: {
			compaction: { ...DEFAULT_COMPACTION_CONFIG, responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis] },
			webSearch: { ...DEFAULT_WEB_SEARCH_CONFIG, models: [] },
			reasoningTranslation: { ...DEFAULT_REASONING_TRANSLATION_CONFIG, models: ["source/gpt"], model: "translator/mini" },
		},
		warnings: [],
	}));
	return {
		handlers,
		transformer: transformer!,
		ctx,
		getCalls: () => calls,
		getRefreshes: () => refreshes,
		getHiddenLabels: () => hiddenLabels,
	};
}

async function drain(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe("Reasoning Translation extension", () => {
	test("replaces only TUI thinking display and refreshes without mutating the source", async () => {
		const harness = createHarness();
		harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
		harness.handlers.get("message_start")!({ message: assistant("") }, harness.ctx);
		const original = assistant("Original.");
		harness.handlers.get("message_update")!({ message: original, assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } }, harness.ctx);
		await drain();
		expect(harness.getCalls()).toBe(1);
		expect(harness.transformer("Original.", { messageType: "assistant-thinking" })).toBe("translated");
		expect(harness.getRefreshes()).toBe(1);
		expect(harness.getHiddenLabels()).toEqual([undefined]);
		expect(original.content).toEqual([{ type: "thinking", thinking: "Original." }]);
	});

	test("does not call the translator or replace output outside TUI", async () => {
		const harness = createHarness("print");
		harness.handlers.get("message_start")!({ message: assistant("") }, harness.ctx);
		harness.handlers.get("message_update")!({ message: assistant("Original."), assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } }, harness.ctx);
		await drain();
		expect(harness.getCalls()).toBe(0);
		expect(harness.transformer("Original.", { messageType: "assistant-thinking" })).toBe("Original.");
	});

	test("returns non-thinking markdown unchanged", () => {
		const harness = createHarness();
		expect(harness.transformer("answer", { messageType: "assistant" })).toBe("answer");
	});

	test("registers cancellation hooks for session replacement and tree navigation", () => {
		const harness = createHarness();
		expect(harness.handlers.has("session_before_switch")).toBe(true);
		expect(harness.handlers.has("session_before_fork")).toBe(true);
		expect(harness.handlers.has("session_before_tree")).toBe(true);
		expect(harness.handlers.has("model_select")).toBe(true);
	});
});
