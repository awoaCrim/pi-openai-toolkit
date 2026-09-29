import { describe, expect, test } from "bun:test";
import type { ResponsesRuntime } from "../runtime";
import { DEFAULT_IMAGE_GENERATION_MODEL } from "../types";
import { _clientTest, requestGeneratedImage } from "./client";
import { buildImageGenerationRequest, normalizeGenerateImageParams } from "./protocol";
import { completedImageResponse, validPng } from "./test-helpers";

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

function body(overrides: Parameters<typeof normalizeGenerateImageParams>[0] = {}) {
	return buildImageGenerationRequest({
		imageModel: DEFAULT_IMAGE_GENERATION_MODEL,
		params: normalizeGenerateImageParams({ prompt: "draw a cat", ...overrides }),
		references: [],
	});
}

describe("image generation client", () => {
	test("preserves provider headers and supports omitting content-type for multipart", () => {
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

		const multipartHeaders = _clientTest.buildRequestHeaders(runtime(), null);
		expect(multipartHeaders.has("content-type")).toBe(false);
	});

	test("adds the established Codex headers for a current Codex model", () => {
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

	test("builds API-family-specific image endpoints", () => {
		expect(_clientTest.buildImagesEndpoint(runtime(), "generate")).toBe(
			"https://gateway.example/v1/images/generations",
		);
		expect(_clientTest.buildImagesEndpoint(runtime(), "edit")).toBe("https://gateway.example/v1/images/edits");
		expect(
			_clientTest.buildImagesEndpoint(
				runtime({ api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }),
				"generate",
			),
		).toBe("https://chatgpt.com/backend-api/codex/images/generations");
		expect(
			_clientTest.buildImagesEndpoint(
				runtime({ api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api/codex" }),
				"edit",
			),
		).toBe("https://chatgpt.com/backend-api/codex/images/edits");
		expect(() => _clientTest.buildImagesEndpoint(runtime({ baseUrl: "https://gateway.example/v1/responses" }), "generate"))
			.toThrow("provider base URL");
	});

	test("sends one independent JSON Images request without Responses tool fields", async () => {
		let calls = 0;
		let capturedUrl = "";
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
		expect(capturedUrl).toBe("https://gateway.example/v1/images/generations");
		expect(capturedInit?.method).toBe("POST");
		const requestBody = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
		expect(requestBody).toEqual({
			model: DEFAULT_IMAGE_GENERATION_MODEL,
			prompt: "draw a cat",
			n: 1,
			size: "auto",
			quality: "auto",
			output_format: "png",
			response_format: "b64_json",
		});
		expect(requestBody).not.toHaveProperty("tools");
		expect(requestBody).not.toHaveProperty("tool_choice");
		expect(requestBody).not.toHaveProperty("input");
	});

	test("uses multipart for a standard-provider edit request", async () => {
		const reference = { path: "ref.png", mimeType: "image/png" as const, bytes: validPng() };
		const editBody = buildImageGenerationRequest({
			imageModel: "gpt-image-2.5",
			params: normalizeGenerateImageParams({ prompt: "edit", referenceImagePaths: ["ref.png"] }),
			references: [reference],
		});
		let capturedInit: RequestInit | undefined;
		const result = await requestGeneratedImage({
			runtime: runtime(),
			body: editBody,
			fetchFn: async (_input, init) => {
				capturedInit = init;
				return new Response(JSON.stringify(completedImageResponse()), { status: 200 });
			},
		});
		expect(result.ok).toBe(true);
		expect(capturedInit?.body).toBeInstanceOf(FormData);
		expect((capturedInit?.body as FormData).get("model")).toBe("gpt-image-2.5");
		expect((capturedInit?.body as FormData).get("prompt")).toBe("edit");
		expect((capturedInit?.body as FormData).getAll("image")).toHaveLength(1);
		expect((capturedInit?.headers as Headers).has("content-type")).toBe(false);
	});

	test("uses the Codex Images JSON edit shape", async () => {
		const reference = { path: "ref.png", mimeType: "image/png" as const, bytes: validPng() };
		const editBody = buildImageGenerationRequest({
			imageModel: "gpt-image-2",
			params: normalizeGenerateImageParams({ prompt: "edit", referenceImagePaths: ["ref.png"] }),
			references: [reference],
		});
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const result = await requestGeneratedImage({
			runtime: runtime({ api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }),
			body: editBody,
			fetchFn: async (input, init) => {
				capturedUrl = String(input);
				capturedInit = init;
				return new Response(JSON.stringify(completedImageResponse()), { status: 200 });
			},
		});
		expect(result.ok).toBe(true);
		expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/images/edits");
		const requestBody = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
		expect(requestBody).toMatchObject({ model: "gpt-image-2", prompt: "edit", n: 1 });
		expect(requestBody.images).toEqual([{ image_url: `data:image/png;base64,${validPng().toString("base64")}` }]);
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

	test("fails closed on oversized responses and preserves cancellation", async () => {
		const oversized = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			fetchFn: async () => new Response("{}", { status: 200, headers: { "content-length": String(49 * 1024 * 1024) } }),
		});
		expect(oversized).toEqual(expect.objectContaining({ ok: false, reason: "oversized-response", status: 200 }));

		const controller = new AbortController();
		controller.abort();
		const cancelled = await requestGeneratedImage({
			runtime: runtime(),
			body: body(),
			signal: controller.signal,
			fetchFn: async () => { throw new DOMException("aborted", "AbortError"); },
		});
		expect(cancelled).toEqual({ ok: false, reason: "aborted", errorMessage: "Image generation was cancelled." });
	});
});
