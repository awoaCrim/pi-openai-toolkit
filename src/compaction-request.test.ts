import { describe, expect, test } from "bun:test";
import { buildEncodedCompactionRequest, compactionUsage } from "./compaction-request";
import type { NativeCompactionRuntime } from "./runtime";

const model = {
	id: "gpt-fixture", name: "fixture", provider: "fixture", api: "openai-responses",
	baseUrl: "https://fixture.invalid/v1", reasoning: true, input: ["text"],
	contextWindow: 100000, maxTokens: 4096,
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
} as const;
const runtime = {
	provider: model.provider, api: model.api, model: model.id, requestModel: model.id,
	baseUrl: model.baseUrl, apiKey: "synthetic", sessionId: "fixture-session", currentModel: model,
} as unknown as NativeCompactionRuntime;
const payload = {
	model: model.id,
	input: [
		{ type: "additional_tools", role: "developer", tools: [{ type: "function", name: "lookup" }] },
		{ role: "developer", content: "original instructions" },
		{ role: "user", content: "original task" },
		{ type: "reasoning", id: "rs_1", encrypted_content: "opaque-reasoning" },
	],
	tools: [{ type: "web_search" }], reasoning: { effort: "low" },
	prompt_cache_key: "fixture-session", service_tier: "default",
};

function encoder(body: unknown, seen: Record<string, unknown> = {}) {
	return ((_model: unknown, _context: unknown, options: any) => ({
		result: async () => {
			Object.assign(seen, { transport: options.transport, sessionId: options.sessionId });
			try { await options.onPayload(structuredClone(body), model); }
			catch { return { stopReason: "error" }; }
			throw new Error("The encoder must stop before dispatch");
		},
	})) as any;
}

describe("prefix-preserving compaction request", () => {
	test("uses the ordinary encoder and final payload transforms, without dispatch", async () => {
		const seen = {};
		const result = await buildEncodedCompactionRequest({
			runtime, messages: [], thinkingLevel: "low",
			projectPayload: async (body) => ({ ...body as object, tools: payload.tools }),
			stream: encoder({ ...payload, tools: [] }, seen),
		});
		expect(result).toEqual(payload);
		expect(result).not.toHaveProperty("instructions");
		expect(seen).toEqual({ transport: "sse", sessionId: "fixture-session" });
	});
	test("manual guidance is appended, never prepended or substituted for instructions", async () => {
		const result = await buildEncodedCompactionRequest({
			runtime, messages: [], customInstructions: "Preserve open tasks",
			projectPayload: async (x) => x, stream: encoder(payload),
		});
		expect(result.input.slice(0, payload.input.length)).toEqual(payload.input);
		expect(result.input.at(-1)).toMatchObject({ role: "developer", content: expect.stringContaining("Preserve open tasks") });
		expect(payload.input).toHaveLength(4);
	});
	test("preserves both an explicit cache policy and intentionally absent cache fields", async () => {
		for (const cache of [{ prompt_cache_key: "original", prompt_cache_retention: "24h" as const }, {}]) {
			const result = await buildEncodedCompactionRequest({
				runtime, messages: [], cache, projectPayload: async (x) => x, stream: encoder(payload),
			});
			expect(result.prompt_cache_key).toBe(cache.prompt_cache_key);
			expect(result.prompt_cache_retention).toBe(cache.prompt_cache_retention);
		}
	});
	test("a failed transform, aborted operation or mismatched producer cannot produce a request", async () => {
		await expect(buildEncodedCompactionRequest({
			runtime, messages: [], projectPayload: async () => { throw new Error("transform failed"); },
			stream: encoder(payload),
		})).rejects.toThrow("transform failed");
		await expect(buildEncodedCompactionRequest({
			runtime, messages: [], signal: AbortSignal.abort(),
			projectPayload: async (x) => x, stream: encoder(payload),
		})).rejects.toThrow();
		await expect(buildEncodedCompactionRequest({
			runtime, messages: [], projectPayload: async (x) => x,
			stream: encoder({ ...payload, model: "different" }),
		})).rejects.toThrow("model");
	});
	test("network escape and missing onPayload are errors, not ordinary model calls", async () => {
		await expect(buildEncodedCompactionRequest({
			runtime, messages: [], projectPayload: async (x) => x,
			stream: ((_m: unknown, _c: unknown, options: any) => ({
				result: async () => { await options.fetch("https://fixture.invalid"); },
			})) as any,
		})).rejects.toThrow("dispatch");
		await expect(buildEncodedCompactionRequest({
			runtime, messages: [], projectPayload: async (x) => x,
			stream: (() => ({ result: async () => ({ stopReason: "stop" }) })) as any,
		})).rejects.toThrow("payload");
	});
	test("invalid replay anchors and continuation-only payloads fail closed", async () => {
		for (const body of [{ ...payload, input: "bad" }, { ...payload, previous_response_id: "resp_delta" }]) {
			await expect(buildEncodedCompactionRequest({
				runtime, messages: [], projectPayload: async () => body, stream: encoder(payload),
			})).rejects.toThrow();
		}
	});
});

describe("remote compaction usage", () => {
	test("accounts for cache reads/writes exactly once and prices the producer", () => {
		const usage = compactionUsage({
			input_tokens: 10000, output_tokens: 200, total_tokens: 10200,
			input_tokens_details: { cached_tokens: 8000, cache_write_tokens: 500 },
			output_tokens_details: { reasoning_tokens: 30 },
		}, runtime.currentModel);
		expect(usage).toMatchObject({ input: 1500, output: 200, cacheRead: 8000, cacheWrite: 500, totalTokens: 10200 });
		expect(usage?.cost.total).toBeCloseTo(0.03925);
	});
	test("missing, incomplete and invalid usage remains unknown", () => {
		for (const raw of [undefined, {}, { input_tokens: 3 }, { input_tokens: -1, output_tokens: 1 },
			{ input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 2 } }]) {
			expect(compactionUsage(raw, runtime.currentModel)).toBeUndefined();
		}
	});
});
