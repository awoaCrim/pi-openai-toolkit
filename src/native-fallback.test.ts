import { describe, expect, test } from "bun:test";
import { compact, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { parseModelSpec, runNativeFallbackCompaction } from "./native-fallback";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_NATIVE_FALLBACK_CONFIG } from "./types";

type FakeModel = { provider: string; id: string; contextWindow?: number; maxTokens?: number };
const currentModel: FakeModel = { provider: "test", id: "deepseek", contextWindow: 400_000 };
const summaryModel: FakeModel = { provider: "test", id: "luna", contextWindow: 272_000, maxTokens: 32_768 };

function fixture() {
	const authCalls: unknown[] = [];
	const ctx = {
		model: currentModel,
		modelRegistry: {
			find: (provider: string, id: string) => [currentModel, summaryModel].find(m => m.provider === provider && m.id === id),
			getApiKeyAndHeaders: async (model: unknown): Promise<unknown> => {
				authCalls.push(model);
				return { ok: true, apiKey: "test-key", headers: { "x-keep": "1", "x-delete": null }, env: { E: "1" } };
			},
		},
	};
	const event = {
		preparation: {
			firstKeptEntryId: "keep", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false,
			tokensBefore: 272_907, fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		},
		customInstructions: "focus on the task", signal: new AbortController().signal,
	} as unknown as SessionBeforeCompactEvent;
	const config = { ...DEFAULT_COMPACTION_CONFIG, nativeFallback: { ...DEFAULT_NATIVE_FALLBACK_CONFIG, model: "test/luna", thinkingLevel: "low" as const } };
	const result = { summary: "## Goal\nContinue the task.", firstKeptEntryId: "keep", tokensBefore: 272_907, details: {} };
	const compactCalls: unknown[][] = [];
	const args = {
		ctx: ctx as never, event, config, modelSpec: "test/luna",
		compactFn: (async (...values: unknown[]) => { compactCalls.push(values); return result; }) as typeof compact,
	};
	return { args, ctx, authCalls, compactCalls, result };
}

function textMessage(chars: number): SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number] {
	return { role: "user", content: [{ type: "text", text: "x".repeat(chars) }], timestamp: 1 };
}

describe("native summary model selection", () => {
	test("parses provider/model references including slashes and whitespace", () => {
		expect(parseModelSpec(" openrouter/deepseek/chat ")).toEqual({ provider: "openrouter", modelId: "deepseek/chat" });
		for (const value of ["", "luna", "/luna", "test/"]) expect(parseModelSpec(value)).toBeUndefined();
	});

	for (const [name, modelSpec, enabled, reason] of [
		["disabled", "test/luna", false, "disabled"],
		["unset", undefined, true, "no-model-configured"],
		["blank", "  ", true, "no-model-configured"],
		["invalid", "luna", true, "invalid-model-spec"],
		["missing", "test/missing", true, "model-not-found"],
		["same", "test/deepseek", true, "same-as-current-model"],
	] as const) {
		test(`${name} selection returns its reason without auth or summary calls`, async () => {
			const f = fixture();
			f.args.config.nativeFallback.enabled = enabled;
			const result = await runNativeFallbackCompaction({ ...f.args, modelSpec });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe(reason);
			expect(f.authCalls).toHaveLength(0);
			expect(f.compactCalls).toHaveLength(0);
		});
	}

	test("only the caller-selected source determines the model", async () => {
		const f = fixture();
		f.args.config.remoteCompactModel = "test/missing";
		expect(await runNativeFallbackCompaction({ ...f.args, modelSpec: undefined })).toEqual({ ok: false, reason: "no-model-configured" });
		expect((await runNativeFallbackCompaction(f.args)).ok).toBe(true);
		expect(f.compactCalls[0][1]).toBe(summaryModel);
	});

	test("passes preparation, auth, abort and thinking unchanged to Pi without switching current model", async () => {
		const f = fixture();
		expect(await runNativeFallbackCompaction(f.args)).toEqual({ ok: true, result: f.result, model: { provider: "test", id: "luna" } });
		expect(f.authCalls).toEqual([summaryModel]);
		expect(f.compactCalls).toEqual([[f.args.event.preparation, summaryModel, "test-key", { "x-keep": "1" },
			"focus on the task", f.args.event.signal, "low", undefined, { E: "1" }]]);
		expect(f.compactCalls[0][0]).toBe(f.args.event.preparation);
		expect(f.ctx.model).toBe(currentModel);
	});

	for (const split of [false, true]) {
		test(`does not veto the explicit model for a large ${split ? "split-turn prefix" : "history"} character estimate`, async () => {
			const f = fixture();
			const prep = f.args.event.preparation;
			prep.isSplitTurn = split;
			prep.messagesToSummarize = [textMessage(split ? 40 : 1_500_000)];
			prep.turnPrefixMessages = split ? [textMessage(1_500_000)] : [];
			prep.previousSummary = "previous checkpoint";
			const before = structuredClone(prep);
			expect((await runNativeFallbackCompaction(f.args)).ok).toBe(true);
			expect(f.authCalls).toEqual([summaryModel]);
			expect(f.compactCalls).toHaveLength(1);
			expect(f.compactCalls[0][0]).toBe(prep);
			expect(prep).toEqual(before);
		});
	}
});

describe("native summary failure reporting", () => {
	for (const throws of [false, true]) {
		test(`reports auth failure (${throws ? "throw" : "result"}) without running compact`, async () => {
			const f = fixture();
			f.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
				if (throws) throw new Error("auth unavailable");
				return { ok: false, error: "auth unavailable" };
			};
			expect(await runNativeFallbackCompaction(f.args)).toEqual({ ok: false, reason: "auth-failed", modelSpec: "test/luna", errorMessage: "auth unavailable" });
			expect(f.compactCalls).toHaveLength(0);
		});
	}

	for (const [error, reason] of [[new DOMException("cancelled", "AbortError"), "aborted"], [new Error("actual provider context limit"), "compact-failed"]] as const) {
		test(`preserves ${reason} instead of retrying with another model`, async () => {
			const f = fixture();
			let calls = 0;
			const result = await runNativeFallbackCompaction({ ...f.args, compactFn: async () => { calls++; throw error; } });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe(reason);
				if (reason === "compact-failed") expect(result.errorMessage).toBe(error.message);
			}
			expect(calls).toBe(1);
			expect(f.ctx.model).toBe(currentModel);
		});
	}

	test("rejects empty output and successful output arriving after cancellation", async () => {
		const f = fixture();
		expect(await runNativeFallbackCompaction({ ...f.args, compactFn: async () => ({ ...f.result, summary: "  " }) })).toEqual({ ok: false, reason: "empty-summary", modelSpec: "test/luna" });
		const abort = new AbortController();
		f.args.event.signal = abort.signal;
		expect(await runNativeFallbackCompaction({ ...f.args, compactFn: async () => { abort.abort(); return f.result; } })).toEqual({ ok: false, reason: "aborted", modelSpec: "test/luna" });
	});
});

describe("actual Pi native summary request", () => {
	for (const stopReason of ["stop", "length"] as const) {
		test(`Pi retains prompt construction and split requests, terminal=${stopReason}`, async () => {
			const f = fixture();
			const thinking = "historical reasoning ".repeat(65_000);
			f.args.event.preparation.messagesToSummarize = [
				textMessage(40),
				{ role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text: "history answer" }],
					api: "openai-completions", provider: "test", model: "deepseek", stopReason: "stop", timestamp: 2 } as never,
				{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "TOOL-START" + "z".repeat(100_000) + "TOOL-END" }], isError: false, timestamp: 3 },
			];
			f.args.event.preparation.isSplitTurn = true;
			f.args.event.preparation.turnPrefixMessages = [{ role: "user", content: "PREFIX-ONLY", timestamp: 4 }];
			f.args.event.preparation.previousSummary = "PREVIOUS-SUMMARY";
			const before = structuredClone(f.args.event.preparation);
			const requests: Array<{ model: unknown; text: string; maxTokens: unknown }> = [];
			const result = await runNativeFallbackCompaction({ ...f.args, compactFn: async (prep, model, key, headers, instructions, signal, thinkingLevel, _stream, env) => compact(
				prep, model, key, headers, instructions, signal, thinkingLevel,
				((_model, context, options) => {
					requests.push({ model: _model, text: JSON.stringify(context), maxTokens: options?.maxTokens });
					return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "Generated summary" }], stopReason,
						usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) };
				}) as Parameters<typeof compact>[7], env,
			) });
			expect(requests).toHaveLength(stopReason === "stop" ? 2 : 1);
			expect(requests[0].model).toBe(summaryModel);
			expect(requests[0].text).toContain(thinking);
			expect(requests[0].text).toContain("TOOL-START");
			expect(requests[0].text).not.toContain("TOOL-END");
			expect(requests[0].text).toContain("PREVIOUS-SUMMARY");
			expect(requests[0].text).not.toContain("PREFIX-ONLY");
			expect(requests[0].maxTokens).toBe(13_107);
			if (stopReason === "stop") {
				expect(result.ok).toBe(true);
				expect(requests[1].text).toContain("PREFIX-ONLY");
				expect(requests[1].text).not.toContain("PREVIOUS-SUMMARY");
				expect(requests[1].maxTokens).toBe(8_192);
			} else {
				expect(result.ok).toBe(false);
				if (!result.ok) { expect(result.reason).toBe("compact-failed"); expect(result.errorMessage).toContain("token cap"); }
			}
			expect(f.args.event.preparation).toEqual(before);
			expect(f.ctx.model).toBe(currentModel);
		});
	}
});
