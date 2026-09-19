import { describe, expect, test } from "bun:test";
import {
	ALPHA_SEARCH_MAX_OUTPUT_TOKENS,
	_alphaClientTest,
	MAX_ALPHA_ACTIONS,
	MAX_ALPHA_COMMAND_CHARS,
	MAX_ALPHA_RESPONSE_BYTES,
	STANDALONE_WEB_RUN_PARAMETERS,
	buildAlphaSearchRequest,
	normalizeStandaloneWebRunCommands,
	requestAlphaSearch,
	type AlphaSearchFetch,
} from "./alpha-client";
import type { ResponsesRuntime } from "../runtime";

function runtime(overrides: Partial<ResponsesRuntime> = {}): ResponsesRuntime {
	return {
		provider: "gateway",
		api: "openai-responses",
		model: "gpt-6-astra",
		baseUrl: "https://gateway.example/v1",
		apiKey: "search-key",
		responsesPath: "responses",
		responsesUrl: "https://gateway.example/v1/responses",
		currentModel: { headers: {} } as never,
		...overrides,
	};
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function fetchOnce(response: Response, seen: Array<{ input: string; init?: RequestInit }>): AlphaSearchFetch {
	return async (input, init) => {
		seen.push({ input: String(input), init });
		return response;
	};
}

describe("standalone web.run protocol", () => {
	test("exposes nullable optional command fields and no required top-level properties", () => {
		expect(STANDALONE_WEB_RUN_PARAMETERS.required).toBeUndefined();
		for (const name of [
			"search_query",
			"image_query",
			"open",
			"click",
			"find",
			"screenshot",
			"finance",
			"weather",
			"sports",
			"time",
			"response_length",
		]) {
			expect(STANDALONE_WEB_RUN_PARAMETERS.properties[name]).toBeDefined();
		}
		expect(STANDALONE_WEB_RUN_PARAMETERS.additionalProperties).toBe(false);
	});

	test("normalizes every supported command family into the alpha commands envelope", () => {
		const commands = normalizeStandaloneWebRunCommands({
			search_query: [{ q: " latest news ", recency: 7, domains: [" example.com ", "example.com"] }],
			image_query: [{ q: "a red kite" }],
			open: [{ ref_id: " ref-1 ", lineno: 12 }],
			click: [{ ref_id: "ref-1", id: 3 }],
			find: [{ ref_id: "ref-1", pattern: "pricing" }],
			screenshot: [{ ref_id: "ref-1", pageno: 0 }],
			finance: [{ ticker: " AAPL ", type: "equity", market: "US" }],
			weather: [{ location: " Seattle ", start: "2026-09-16", duration: 3 }],
			sports: [{ tool: "sports", fn: "schedule", league: "nfl", team: "SEA", num_games: 5, locale: "en-US" }],
			time: [{ utc_offset: "+00:00" }],
			response_length: "short",
		});

		expect(commands).toEqual({
			search_query: [{ q: "latest news", recency: 7, domains: ["example.com"] }],
			image_query: [{ q: "a red kite" }],
			open: [{ ref_id: "ref-1", lineno: 12 }],
			click: [{ ref_id: "ref-1", id: 3 }],
			find: [{ ref_id: "ref-1", pattern: "pricing" }],
			screenshot: [{ ref_id: "ref-1", pageno: 0 }],
			finance: [{ ticker: "AAPL", type: "equity", market: "US" }],
			weather: [{ location: "Seattle", start: "2026-09-16", duration: 3 }],
			sports: [{ tool: "sports", fn: "schedule", league: "nfl", team: "SEA", num_games: 5, locale: "en-US" }],
			time: [{ utc_offset: "+00:00" }],
			response_length: "short",
		});
	});

	test("normalizes null optionals and rejects unknown fields and unsafe bounds", () => {
		expect(normalizeStandaloneWebRunCommands({
			search_query: [{ q: "q", recency: null, domains: null }],
			open: [{ ref_id: "id", lineno: null }],
			response_length: null,
		})).toEqual({ search_query: [{ q: "q" }], open: [{ ref_id: "id" }] });

		expect(() => normalizeStandaloneWebRunCommands({ search_query: [{ q: "q", extra: true }] })).toThrow(
			/Unexpected|unexpected|field/,
		);
		expect(() => normalizeStandaloneWebRunCommands({ search_query: [{ q: "q" }], unknown: [] })).toThrow();
		expect(() => normalizeStandaloneWebRunCommands({ search_query: [{ q: "q" }], click: [{ ref_id: "id", id: 0 }] })).toThrow();
		expect(() => normalizeStandaloneWebRunCommands({ search_query: [{ q: "q" }], sports: [{ fn: "schedule", league: "not-a-league" }] })).toThrow();
		expect(() => normalizeStandaloneWebRunCommands({ response_length: "short" })).toThrow();
		expect(() => normalizeStandaloneWebRunCommands({ search_query: [] })).toThrow();
		expect(() => normalizeStandaloneWebRunCommands({ search_query: Array.from({ length: MAX_ALPHA_ACTIONS + 1 }, () => ({ q: "q" })) })).toThrow();
		expect(() => normalizeStandaloneWebRunCommands({ search_query: [{ q: "x".repeat(MAX_ALPHA_COMMAND_CHARS + 1) }] })).toThrow();
	});

	test("redacts common credential forms from surfaced diagnostics", () => {
		const message = _alphaClientTest.sanitizeAlphaDiagnostic(
			'{"access_token":"secret-value","message":"Bearer another-secret"}',
			"fallback",
		);
		expect(message).not.toContain("secret-value");
		expect(message).not.toContain("another-secret");
	});

	test("builds the minimal request envelope with a fresh or explicit id", () => {
		const built = buildAlphaSearchRequest({
			model: "gpt-6-astra",
			id: "request-1",
			commands: { search_query: [{ q: "hello" }] },
		});
		expect(built.request).toEqual({
			id: "request-1",
			model: "gpt-6-astra",
			commands: { search_query: [{ q: "hello" }] },
			max_output_tokens: ALPHA_SEARCH_MAX_OUTPUT_TOKENS,
		});
		expect(JSON.parse(built.body)).toEqual(built.request);
		expect(built.request).not.toHaveProperty("input");
		expect(built.request).not.toHaveProperty("reasoning");
		expect(built.request).not.toHaveProperty("settings");
	});
});

describe("requestAlphaSearch", () => {
	test("sends one provider-relative request with shared auth and Codex gateway headers", async () => {
		const seen: Array<{ input: string; init?: RequestInit }> = [];
		const result = await requestAlphaSearch({
			runtime: runtime({
				codexAffinity: { model: "gpt-6-astra", scope: "codex-session-v1" },
				sessionId: "session-42",
				currentModel: {
					headers: { authorization: "Bearer inherited", "x-request": "kept" },
				} as never,
			}),
			commands: { search_query: [{ q: "hello" }] },
			requestId: "request-42",
			fetchFn: fetchOnce(
				jsonResponse({
					id: "alpha-1",
					output: "Search result text",
					encrypted_output: "opaque",
					results: [{ title: "one", unknown: { preserved: true } }],
				}),
				seen,
			),
		});

		expect(result).toEqual({
			ok: true,
			status: 200,
			output: "Search result text",
			details: {
				status: 200,
				responseId: "alpha-1",
				encryptedOutput: "opaque",
				results: [{ title: "one", unknown: { preserved: true } }],
			},
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.input).toBe("https://gateway.example/v1/alpha/search");
		const init = seen[0]?.init;
		expect(init?.method).toBe("POST");
		expect(init?.redirect).toBe("error");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer search-key");
		expect(new Headers(init?.headers).get("originator")).toBe("codex_cli_rs");
		expect(new Headers(init?.headers).get("x-codex-model")).toBe("gpt-6-astra");
		expect(new Headers(init?.headers).get("session-id")).toBe("session-42");
		expect(JSON.parse(String(init?.body))).toEqual({
			id: "request-42",
			model: "gpt-6-astra",
			commands: { search_query: [{ q: "hello" }] },
			max_output_tokens: ALPHA_SEARCH_MAX_OUTPUT_TOKENS,
		});
	});

	test("rejects malformed timeout settings before fetch", async () => {
		let calls = 0;
		const result = await requestAlphaSearch({
			runtime: runtime(),
			commands: { search_query: [{ q: "hello" }] },
			timeoutMs: Number.POSITIVE_INFINITY,
			fetchFn: async () => {
				calls += 1;
				return jsonResponse({ output: "unexpected" });
			},
		});
		expect(result).toMatchObject({ ok: false, reason: "invalid-parameters" });
		expect(calls).toBe(0);
	});

	test("rejects invalid endpoint before fetch", async () => {
		let calls = 0;
		const result = await requestAlphaSearch({
			runtime: runtime({ baseUrl: "https://gateway.example/v1/responses" }),
			commands: { search_query: [{ q: "hello" }] },
			fetchFn: async () => {
				calls += 1;
				return jsonResponse({ output: "unexpected" });
			},
		});
		expect(result).toMatchObject({ ok: false, reason: "invalid-url" });
		expect(calls).toBe(0);
	});

	test("does not retry non-2xx responses and sanitizes provider error text", async () => {
		const seen: Array<{ input: string; init?: RequestInit }> = [];
		const result = await requestAlphaSearch({
			runtime: runtime(),
			commands: { search_query: [{ q: "hello" }] },
			fetchFn: fetchOnce(
				jsonResponse({ error: { code: "invalid_request", message: "token=secret-value rejected" } }, 400),
				seen,
			),
		});
		expect(result).toMatchObject({ ok: false, reason: "request-rejected", status: 400 });
		expect(JSON.stringify(result)).not.toContain("secret-value");
		expect(seen).toHaveLength(1);
	});

	test("distinguishes malformed, oversized, cancelled, and timed-out responses", async () => {
		const malformed = await requestAlphaSearch({
			runtime: runtime(),
			commands: { search_query: [{ q: "hello" }] },
			fetchFn: async () => new Response("not-json", { status: 200 }),
		});
		expect(malformed).toMatchObject({ ok: false, reason: "malformed-response" });

		const oversized = await requestAlphaSearch({
			runtime: runtime(),
			commands: { search_query: [{ q: "hello" }] },
			fetchFn: async () => new Response("x", {
				status: 200,
				headers: { "content-length": String(MAX_ALPHA_RESPONSE_BYTES + 1) },
			}),
		});
		expect(oversized).toMatchObject({ ok: false, reason: "oversized-response" });

		const cancelledController = new AbortController();
		cancelledController.abort();
		let cancelledCalls = 0;
		const cancelled = await requestAlphaSearch({
			runtime: runtime(),
			commands: { search_query: [{ q: "hello" }] },
			signal: cancelledController.signal,
			fetchFn: async () => {
				cancelledCalls += 1;
				return jsonResponse({ output: "unexpected" });
			},
		});
		expect(cancelled).toMatchObject({ ok: false, reason: "aborted" });
		expect(cancelledCalls).toBe(0);

		const timedOut = await requestAlphaSearch({
			runtime: runtime(),
			commands: { search_query: [{ q: "hello" }] },
			timeoutMs: 1,
			fetchFn: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
				const guard = setTimeout(() => reject(new Error("timeout signal did not fire")), 100);
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(guard);
					reject(new Error("aborted"));
				}, { once: true });
			}),
		});
		expect(timedOut).toMatchObject({ ok: false, reason: "timeout" });
	});

	test("rejects a malformed successful response without fabricating output", async () => {
		const result = await requestAlphaSearch({
			runtime: runtime(),
			commands: { search_query: [{ q: "hello" }] },
			fetchFn: async () => jsonResponse({ status: "completed", results: [] }),
		});
		expect(result).toMatchObject({ ok: false, reason: "malformed-response" });
	});
});
