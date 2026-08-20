import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { buildTranslationPrompt, resolveTranslator, translateSegment } from "./client";

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { role: "assistant", content, api: "openai-responses", provider: "translator", model: "mini", usage: {
		input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}, stopReason, timestamp: Date.now() };
}

describe("reasoning translation client", () => {
	test("builds a strict no-explanation prompt", () => {
		const prompt = buildTranslationPrompt("Japanese");
		expect(prompt).toContain("Japanese");
		expect(prompt).toContain("Return only the faithful translation");
		expect(prompt).toContain("file paths");
	});

	test("preserves resolved auth base URL and disables translator reasoning", async () => {
		const model = { provider: "translator", id: "mini", api: "openai-responses", baseUrl: "https://model.example", reasoning: true, maxTokens: 5000 } as Model<any>;
		const provider = { streamSimple: () => ({ result: async () => message([{ type: "text", text: "ok" }]) }) } as unknown as Provider;
		const ctx = {
			modelRegistry: {
				find: () => model,
				getProvider: () => provider,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", baseUrl: "https://oauth.example" }),
			},
		} as never;

		const resolved = await resolveTranslator(ctx, "translator/mini");
		expect(resolved).toMatchObject({ model: { baseUrl: "https://oauth.example", reasoning: false } });
	});

	test("calls the configured provider directly without reasoning or tools", async () => {
		let received: { model: Model<any>; context: unknown; options: Record<string, unknown> | undefined } | undefined;
		const provider = {
			streamSimple(model, context, options) {
				received = { model, context, options };
				return { result: async () => message([{ type: "text", text: " translated " }]) } as never;
			},
		} as unknown as Provider;
		const model = { provider: "translator", id: "mini", baseUrl: "https://translator.example", reasoning: true, maxTokens: 5000 } as Model<any>;
		const result = await translateSegment({
			translator: { model, provider, apiKey: "key", headers: { "x-test": "yes" }, env: { REGION: "test" } },
			targetLanguage: "Japanese",
			sourceSegment: "Keep `src/file.ts`.",
			signal: new AbortController().signal,
		});
		expect(result).toEqual({ ok: true, text: "translated", usage: expect.any(Object) });
		expect(received?.model).toMatchObject({ baseUrl: "https://translator.example", reasoning: false });
		expect(received?.context).toMatchObject({ messages: [{ role: "user", content: "Keep `src/file.ts`." }] });
		expect(received?.options).toMatchObject({ apiKey: "key", maxTokens: 2048, timeoutMs: expect.any(Number) });
		expect(received?.options).not.toHaveProperty("reasoning");
	});

	test("falls back on empty and failed provider output", async () => {
		const model = { provider: "translator", id: "mini", maxTokens: 500 } as Model<any>;
		const emptyProvider = { streamSimple: () => ({ result: async () => message([]) }) } as unknown as Provider;
		expect(await translateSegment({ translator: { model, provider: emptyProvider }, targetLanguage: "Chinese", sourceSegment: "x", signal: new AbortController().signal })).toEqual({ ok: false, reason: "empty-output" });
		const failedProvider = { streamSimple: () => ({ result: async () => message([], "error") }) } as unknown as Provider;
		expect(await translateSegment({ translator: { model, provider: failedProvider }, targetLanguage: "Chinese", sourceSegment: "x", signal: new AbortController().signal })).toEqual({ ok: false, reason: "request-failed", errorMessage: undefined });
	});
});
