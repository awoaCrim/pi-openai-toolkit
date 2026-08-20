import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { DEFAULT_REASONING_TRANSLATION_CONFIG } from "../types";
import { createReasoningTranslationEntry } from "./persistence";
import { ReasoningTranslationState } from "./state";
import type { ResolvedTranslator } from "./client";

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

function context(mode: "tui" | "print" = "tui", branch: unknown[] = []) {
	const sourceModel = { provider: "source", api: "openai-responses", id: "gpt" } as Model<any>;
	return {
		mode,
		model: sourceModel,
		signal: undefined,
		sessionManager: { getBranch: () => branch },
		modelRegistry: {},
	} as never;
}

function translator(): ResolvedTranslator {
	return {
		model: { provider: "translator", id: "mini", maxTokens: 500 } as Model<any>,
		provider: {} as never,
	};
}

async function drain(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

const config = {
	...DEFAULT_REASONING_TRANSLATION_CONFIG,
	models: ["source/gpt"],
	model: "translator/mini",
};

describe("reasoning translation state", () => {
	test("only replays persisted display mappings while the current model is eligible", () => {
		const entry = createReasoningTranslationEntry({
			sourceMarkdown: "restored source",
			displayText: "restored translation",
			targetLanguage: "Japanese",
			translator: { provider: "translator", model: "mini" },
		});
		const branch = [{ type: "custom", customType: "pi-openai-toolkit:reasoning-translation", data: entry }] as unknown[];
		const state = new ReasoningTranslationState();
		const ctx = context("tui", branch);
		state.hydrate(ctx, config);
		expect(state.lookupDisplay("restored source")).toBe("restored translation");
		state.hydrate(ctx, { ...config, enabled: false });
		expect(state.lookupDisplay("restored source")).toBeUndefined();
	});

	test("does not await or block the main message update", async () => {
		let resolveTranslator!: (value: ResolvedTranslator) => void;
		let calls = 0;
		const state = new ReasoningTranslationState({
			resolveTranslator: () => new Promise((resolve) => { resolveTranslator = resolve; }),
			translateSegment: async ({ sourceSegment }) => {
				calls++;
				return { ok: true, text: `译:${sourceSegment}` };
			},
		});
		const ctx = context();
		state.beginMessage(assistant(""), ctx, config);
		state.handleMessageUpdate(assistant("First sentence."), "thinking_delta", 0);
		expect(calls).toBe(0);
		expect(state.lookupDisplay("First sentence.")).toBe("Translating…");

		resolveTranslator(translator());
		await drain();
		state.handleMessageUpdate(assistant("First sentence."), "thinking_end", 0);
		await drain();
		expect(calls).toBe(1);
		expect(state.lookupDisplay("First sentence.")).toBe("译:First sentence.");
	});

	test("flushes and persists when the translator becomes ready after message end", async () => {
		let resolveTranslator!: (value: ResolvedTranslator) => void;
		const appended: unknown[] = [];
		const state = new ReasoningTranslationState({
			resolveTranslator: () => new Promise((resolve) => { resolveTranslator = resolve; }),
			translateSegment: async ({ sourceSegment }) => ({ ok: true, text: `译:${sourceSegment}` }),
			appendEntry: (_type, data) => appended.push(data),
		});
		const ctx = context();
		const original = assistant("Final tail.");
		state.beginMessage(assistant(""), ctx, config);
		state.finishMessage(original);
		resolveTranslator(translator());
		await drain();
		expect(appended).toHaveLength(1);
		expect(state.lookupDisplay("Final tail.")).toBe("译:Final tail.");
	});

	test("does not cancel a finished assistant translation when a tool result starts", async () => {
		let resolveTranslation!: (value: { ok: true; text: string }) => void;
		const appended: unknown[] = [];
		const state = new ReasoningTranslationState({
			resolveTranslator: async () => translator(),
			translateSegment: () => new Promise((resolve) => { resolveTranslation = resolve; }),
			appendEntry: (_type, data) => appended.push(data),
		});
		const ctx = context();
		const original = assistant("Before tool.");
		state.beginMessage(assistant(""), ctx, config);
		await drain();
		state.finishMessage(original);
		await drain();
		state.beginMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "demo",
			content: [],
			isError: false,
			timestamp: Date.now(),
		} as never, ctx, config);
		resolveTranslation({ ok: true, text: "译:Before tool." });
		await drain();
		expect(appended).toHaveLength(1);
		expect(state.lookupDisplay("Before tool.")).toBe("译:Before tool.");
	});

	test("falls back to source text for a provider-reported abort in the active session", async () => {
		const state = new ReasoningTranslationState({
			resolveTranslator: async () => translator(),
			translateSegment: async () => ({ ok: false, reason: "aborted" }),
		});
		const ctx = context();
		state.beginMessage(assistant(""), ctx, config);
		await drain();
		state.finishMessage(assistant("Abort fallback."));
		await drain();
		expect(state.lookupDisplay("Abort fallback.")).toBe("Abort fallback.");
	});

	test("flushes a natural-language tail after the idle interval", async () => {
		let idleCallback: (() => void) | undefined;
		let calls = 0;
		const state = new ReasoningTranslationState({
			resolveTranslator: async () => translator(),
			setTimeout: (callback) => {
				idleCallback = callback;
				return 1 as ReturnType<typeof setTimeout>;
			},
			translateSegment: async ({ sourceSegment }) => {
				calls++;
				return { ok: true, text: `译:${sourceSegment}` };
			},
		});
		const ctx = context();
		state.beginMessage(assistant(""), ctx, config);
		await drain();
		state.handleMessageUpdate(assistant("unfinished tail"), "thinking_delta", 0);
		expect(calls).toBe(0);
		idleCallback?.();
		await drain();
		expect(calls).toBe(1);
		expect(state.lookupDisplay("unfinished tail")).toBe("译:unfinished tail");
	});

	test("serializes segments, preserves order, and falls back per segment", async () => {
		const seen: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const state = new ReasoningTranslationState({
			resolveTranslator: async () => translator(),
			translateSegment: async ({ sourceSegment }) => {
				seen.push(sourceSegment);
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await Promise.resolve();
				inFlight--;
				return sourceSegment.length === 400
					? { ok: false, reason: "request-failed" }
					: { ok: true, text: `译:${sourceSegment}` };
			},
		});
		const ctx = context();
		const source = "A.".repeat(250);
		state.beginMessage(assistant(""), ctx, config);
		await drain();
		state.handleMessageUpdate(assistant(source), "thinking_end", 0);
		await drain();
		expect(seen).toHaveLength(2);
		expect(seen[0]).toHaveLength(400);
		expect(seen[1]).toHaveLength(100);
		expect(maxInFlight).toBe(1);
		expect(state.lookupDisplay(source)).toBe(`${seen[0]}译:${seen[1]}`);
	});

	test("does not translate outside TUI", async () => {
		let calls = 0;
		const state = new ReasoningTranslationState({
			resolveTranslator: async () => translator(),
			translateSegment: async () => {
				calls++;
				return { ok: true, text: "translated" };
			},
		});
		const ctx = context("print");
		state.beginMessage(assistant(""), ctx, config);
		state.handleMessageUpdate(assistant("No translation."), "thinking_end", 0);
		await drain();
		expect(calls).toBe(0);
		expect(state.lookupDisplay("No translation.")).toBeUndefined();
	});

	test("cancels stale results when the active generation is replaced", async () => {
		let resolveTranslation!: (value: { ok: true; text: string }) => void;
		const state = new ReasoningTranslationState({
			resolveTranslator: async () => translator(),
			translateSegment: () => new Promise((resolve) => { resolveTranslation = resolve; }),
		});
		const ctx = context();
		state.beginMessage(assistant(""), ctx, config);
		await drain();
		state.handleMessageUpdate(assistant("Old."), "thinking_end", 0);
		await drain();
		state.abortActive();
		resolveTranslation({ ok: true, text: "late" });
		await drain();
		expect(state.lookupDisplay("Old.")).toBeUndefined();
	});

	test("persists completed display mappings without changing source", async () => {
		const appended: unknown[] = [];
		const state = new ReasoningTranslationState({
			resolveTranslator: async () => translator(),
			translateSegment: async ({ sourceSegment }) => ({ ok: true, text: `译:${sourceSegment}` }),
			appendEntry: (_type, data) => appended.push(data),
		});
		const ctx = context();
		const original = assistant("Keep source.");
		state.beginMessage(assistant(""), ctx, config);
		await drain();
		state.handleMessageUpdate(original, "thinking_end", 0);
		state.finishMessage(original);
		await drain();
		expect(appended).toHaveLength(1);
		expect(state.lookupDisplay("Keep source.")).toBe("译:Keep source.");
		expect(original.content).toEqual([{ type: "thinking", thinking: "Keep source." }]);
	});
});
