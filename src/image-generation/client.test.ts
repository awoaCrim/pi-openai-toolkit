import { describe, expect, test } from "bun:test";
import type { ResponsesRuntime } from "../runtime";
import { _clientTest, requestGeneratedImage } from "./client";
import { buildImageGenerationRequest, normalizeGenerateImageParams } from "./protocol";
import { completedImageResponse } from "./test-helpers";

function runtime(overrides: Partial<ResponsesRuntime> = {}): ResponsesRuntime {
	return {
		provider: "newapi",
		api: "openai-responses",
		model: "gpt-5.5",
		baseUrl: "https://gateway.example/v1",
		apiKey: "sk-secret",
		headers: { "x-auth-header": "resolved" },
		responsesPath: "responses",
		responsesUrl: "https://gateway.example/v1/responses",
		currentModel: {
			provider: "newapi",
			api: "openai-responses",
			id: "gpt-5.5",
			baseUrl: "https://gateway.example/v1",
			headers: { "x-model-header": "model", "x-remove": "old" },
		} as never,
		...overrides,
	};
}

function codexToken(accountId: string): string {
	return [
		Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
		Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: accountId },
			}),
		).toString("base64url"),
		"signature",
	].join(".");
}

function body() {
	return buildImageGenerationRequest({
		routingModel: "gpt-5.5",
		params: normalizeGenerateImageParams({ prompt: "draw a cat" }),
		references: [],
	});
}

describe("image generation client", () => {
	test("preserves provider headers and only adds bearer auth when absent", () => {
		const headers = _clientTest.buildRequestHeaders(
			runtime({
				headers: {
					"X-Model-Header": "resolved-override",
					"x-remove": null,
					Authorization: "Custom auth",
				},
			}),
		);
		expect(headers.get("x-model-header")).toBe("resolved-override");
		expect(headers.has("x-remove")).toBe(false);
		expect(headers.get("authorization")).toBe("Custom auth");
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("accept")).toBe("application/json");

		const bearer = _clientTest.buildRequestHeaders(runtime());
		expect(bearer.get("authorization")).toBe("Bearer sk-secret");
	});

	test("adds the established Codex Responses headers for a current Codex model", () => {
		const token = codexToken("acct_image");
		const headers = _clientTest.buildRequestHeaders(
			runtime({
				api: "openai-codex-responses",
				apiKey: token,
				responsesPath: "codex/responses",
				responsesUrl: "https://chatgpt.com/backend-api/codex/responses",
				currentModel: {
					provider: "openai-codex",
					api: "openai-codex-responses",
					id: "gpt-5.5",
					baseUrl: "https://chatgpt.com/backend-api",
				} as never,
			}),
		);
		expect(headers.get("authorization")).toBe(`Bearer ${token}`);
		expect(headers.get("chatgpt-account-id")).toBe("acct_image");
		expect(headers.get("originator")).toBe("pi");
		expect(headers.get("openai-beta")).toBe("responses=experimental");
		expect(headers.get("user-agent")).toContain("pi (");
	});

	test("sends one non-streaming request and parses the completed image", async () => {
		let calls = 0;
		let capturedUrl: string | undefined;
		let capturedInit: RequestInit | undefined;
		const result = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			fetchFn: async (input, init) => {
				calls += 1;
				capturedUrl = String(input);
				capturedInit = init;
				return new Response(JSON.stringify(completedImageResponse()), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});

		expect(result.ok).toBe(true);
		expect(calls).toBe(1);
		expect(capturedUrl).toBe("https://gateway.example/v1/responses");
		expect(capturedInit?.method).toBe("POST");
		expect(JSON.parse(String(capturedInit?.body))).toEqual(body());
	});

	test("maps rate limits without exposing raw bodies and never retries", async () => {
		let calls = 0;
		const result = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			fetchFn: async () => {
				calls += 1;
				return new Response(
					JSON.stringify({ error: { message: "quota exhausted\nAuthorization: secret" } }),
					{ status: 429, headers: { "content-type": "application/json" } },
				);
			},
		});

		expect(result).toEqual({
			ok: false,
			reason: "rate-limit",
			status: 429,
			errorMessage: "quota exhausted Authorization: [REDACTED]",
		});
		expect(calls).toBe(1);
	});

	test("recognizes provider usage-limit errors even when returned as HTTP 400", async () => {
		const result = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			fetchFn: async () =>
				new Response(
					JSON.stringify({
						error: {
							code: "usage_limit_reached",
							message: "Monthly image usage limit reached.",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		});
		expect(result).toEqual({
			ok: false,
			reason: "rate-limit",
			status: 400,
			errorMessage: "Monthly image usage limit reached.",
		});
	});

	test("fails closed on oversized response bodies", async () => {
		const result = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			fetchFn: async () =>
				new Response("{}", {
					status: 200,
					headers: { "content-length": String(49 * 1024 * 1024) },
				}),
		});
		expect(result).toEqual(
			expect.objectContaining({ ok: false, reason: "oversized-response", status: 200 }),
		);
	});

	test("preserves caller cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			signal: controller.signal,
			fetchFn: async () => {
				throw new DOMException("aborted", "AbortError");
			},
		});
		expect(result).toEqual({
			ok: false,
			reason: "aborted",
			errorMessage: "Image generation was cancelled.",
		});
	});
});
