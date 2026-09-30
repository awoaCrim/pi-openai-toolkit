import { v2Fixture } from "../config/test-helpers";
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
} from "../types";
import { createImageGenerationExecutor, type ImageGenerationServiceDependencies } from "./service";
import { isImageGenerationBatchDetails, isImageGenerationDetails } from "./types";
import { validPng } from "./test-helpers";

function config(models?: string[]) {
	return {
		config: {
			compaction: {
				...DEFAULT_COMPACTION_CONFIG,
				responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis],
			},
			webSearch: {
				...DEFAULT_WEB_SEARCH_CONFIG,
				models: [...DEFAULT_WEB_SEARCH_CONFIG.models],
			},
			imageGeneration: {
				...DEFAULT_IMAGE_GENERATION_CONFIG,
				enabled: true,
				models: models ?? [...DEFAULT_IMAGE_GENERATION_CONFIG.models],
			},
		},
		warnings: [],
	};
}

const model = {
	provider: "newapi",
	api: "openai-responses",
	id: "gpt-5.5",
	baseUrl: "https://gateway.example/v1",
};

function context() {
	return {
		model,
		sessionManager: { getSessionId: () => "session-test" },
	} as never;
}

function runtime() {
	return {
		provider: "newapi",
		api: "openai-responses",
		model: "gpt-5.5",
		baseUrl: "https://gateway.example/v1",
		apiKey: "sk-runtime",
		responsesPath: "responses",
		responsesUrl: "https://gateway.example/v1/responses",
		currentModel: model as never,
	};
}

function baseDeps(overrides: Partial<ImageGenerationServiceDependencies> = {}): ImageGenerationServiceDependencies {
	return {
		loadConfig: config as never,
		resolveRuntime: async () => ({ ok: true, runtime: runtime() }),
		getAgentDir: () => "/agent",
		prepareOutput: async () => undefined,
		prepareReferences: async () => [],
		requestImage: async () => ({
			ok: true,
			status: 200,
			image: { bytes: validPng(), mimeType: "image/png", imageCallId: "ig_test", responseId: "resp_test", width: 1, height: 1 },
		}),
		saveCanonical: async ({ imageCallId }) => `/agent/generated-images/session-test/${imageCallId}.png`,
		copyExplicit: async () => undefined,
		clearReferences: () => {},
		...overrides,
	};
}

describe("image generation service", () => {
	test("uses an independent edit request and returns path-only metadata while clearing buffers", async () => {
		const referenceBytes = validPng();
		const generatedBytes = validPng();
		let requestBody: Record<string, unknown> | undefined;
		const deps = baseDeps({
			prepareOutput: async () => ({ path: "/project/result.png" }),
			prepareReferences: async () => [
				{ path: "/project/reference.png", mimeType: "image/png", bytes: referenceBytes },
			],
			requestImage: async (args) => {
				requestBody = args.body as unknown as Record<string, unknown>;
				return {
					ok: true,
					status: 200,
					image: {
						bytes: generatedBytes,
						mimeType: "image/png",
						imageCallId: "ig_test",
						responseId: "resp_test",
						revisedPrompt: "revised",
						width: 1,
						height: 1,
					},
				};
			},
			copyExplicit: async () => { throw new Error("copy failed with sk-12345678"); },
			clearReferences: (references) => { for (const reference of references) reference.bytes.fill(0); },
		});
		const result = await createImageGenerationExecutor(deps)({
			params: { prompt: "edit this", referenceImagePaths: ["reference.png"], outputPath: "result.png" },
			toolCallId: "tool-call",
			ctx: context(),
		});

		expect(requestBody).toEqual(expect.objectContaining({ action: "edit", model: "grok-imagine-image-2.0", n: 1 }));
		expect(requestBody).not.toHaveProperty("tools");
		expect(requestBody).not.toHaveProperty("tool_choice");
		expect(result.details).toEqual(
			expect.objectContaining({
				artifactPath: "/agent/generated-images/session-test/ig_test.png",
				routingModel: "newapi/gpt-5.5",
				imageModel: "grok-imagine-image-2.0",
				edited: true,
				referenceCount: 1,
				warning: "copy failed with [REDACTED]",
			}),
		);
		expect(isImageGenerationDetails(result.details)).toBe(true);
		expect(JSON.stringify(result)).not.toContain("base64");
		expect(referenceBytes.every((byte) => byte === 0)).toBe(true);
		expect(generatedBytes.every((byte) => byte === 0)).toBe(true);
	});

	test("retains configured model selection in the independent request and details", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const deps = baseDeps({
			loadConfig: () => ({
				...config(),
				config: { ...config().config, imageGeneration: { ...config().config.imageGeneration, models: ["grok-imagine-image-2.0", "test-image-model"] } },
			}),
			requestImage: async (args) => {
				requestBody = args.body as unknown as Record<string, unknown>;
				return { ok: true, status: 200, image: { bytes: validPng(), mimeType: "image/png", imageCallId: "ig_model", width: 1, height: 1 } };
			},
		});
		const result = await createImageGenerationExecutor(deps)({
			params: { prompt: "draw a cat", model: " test-image-model " },
			toolCallId: "call",
			ctx: context(),
		});
		expect(requestBody?.model).toBe("test-image-model");
		expect(requestBody?.action).toBe("generate");
		expect(result.details).toEqual(expect.objectContaining({ imageModel: "test-image-model" }));
	});

	test("runs independent batch requests concurrently and preserves successful artifacts", async () => {
		let started = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		let saved = 0;
		const deps = baseDeps({
			requestImage: async ({ body }) => {
				started += 1;
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight -= 1;
				return {
					ok: true,
					status: 200,
					image: { bytes: validPng(), mimeType: "image/png", imageCallId: `ig_${body.model}_${started}`, width: 1, height: 1 },
				};
			},
			saveCanonical: async ({ imageCallId }) => {
				saved += 1;
				return `/agent/generated-images/session-test/${imageCallId}.png`;
			},
		});
		const result = await createImageGenerationExecutor(deps)({
			params: { prompt: "make variants", batchSize: 3 },
			toolCallId: "batch-call",
			ctx: context(),
		});
		expect(started).toBe(3);
		expect(maxInFlight).toBeGreaterThan(1);
		expect(saved).toBe(3);
		expect(isImageGenerationBatchDetails(result.details)).toBe(true);
		if (!isImageGenerationBatchDetails(result.details)) return;
		expect(result.details).toMatchObject({ batch: true, requestedCount: 3, succeededCount: 3, failedCount: 0 });
		expect(result.text).toContain("Generated 3/3 images.");
	});

	test("returns partial batch success and bounded failure details without retrying", async () => {
		let calls = 0;
		const deps = baseDeps({
			requestImage: async () => {
				const index = calls++;
				if (index === 1) return { ok: false, reason: "rate-limit", status: 429, errorMessage: "quota exhausted" };
				return { ok: true, status: 200, image: { bytes: validPng(), mimeType: "image/png", imageCallId: `ig_${index}`, width: 1, height: 1 } };
			},
		});
		const result = await createImageGenerationExecutor(deps)({
			params: { prompt: "make variants", batchSize: 3 },
			toolCallId: "batch-call",
			ctx: context(),
		});
		expect(calls).toBe(3);
		expect(isImageGenerationBatchDetails(result.details)).toBe(true);
		if (!isImageGenerationBatchDetails(result.details)) return;
		expect(result.details.succeededCount).toBe(2);
		expect(result.details.failures).toEqual([{ index: 1, code: "rate-limit", message: "quota exhausted" }]);
		expect(result.text).toContain("Image 1: /agent/generated-images/session-test/ig_0-batch-1.png");
		expect(result.text).toContain("Image 3: /agent/generated-images/session-test/ig_2-batch-3.png");
		expect(result.text).toContain("Image 2 failed: quota exhausted");
	});

	test("throws the first bounded failure when every batch item fails", async () => {
		let calls = 0;
		await expect(createImageGenerationExecutor(baseDeps({
			requestImage: async () => {
				calls += 1;
				return {
					ok: false,
					reason: "request-rejected",
					status: 400,
					errorMessage: "provider rejected image request\nBearer sk-secret-value",
				};
			},
		}))({
			params: { prompt: "make variants", batchSize: 3 },
			toolCallId: "batch-call",
			ctx: context(),
		})).rejects.toThrow("provider rejected image request Bearer [REDACTED]");
		expect(calls).toBe(3);
	});

	test("fails before dispatch when model is not configured or the request is cancelled", async () => {
		let dispatched = false;
		const deps = baseDeps({
			loadConfig: () => ({
				...config(),
				config: { ...config().config, imageGeneration: { ...config().config.imageGeneration, models: ["test-image-model"] } },
			}),
			requestImage: async () => { dispatched = true; throw new Error("should not dispatch"); },
		});
		await expect(createImageGenerationExecutor(deps)({
			params: { prompt: "draw", model: "grok-imagine-image-2.0" },
			toolCallId: "call",
			ctx: context(),
		})).rejects.toThrow("Unknown image generation model");
		expect(dispatched).toBe(false);

		const controller = new AbortController();
		controller.abort();
		await expect(createImageGenerationExecutor(baseDeps())({
			params: { prompt: "draw" },
			toolCallId: "call",
			signal: controller.signal,
			ctx: context(),
		})).rejects.toThrow("cancelled");
	});

	test("keeps the v2 explicit image default stable across an awaited runtime resolution", async () => {
		const raw = { defaults: { imageGeneration: { enabled: true, defaultModel: "second", allowedModels: ["first", "second"] } } };
		let reads = 0;
		const deps = baseDeps({
			loadConfig: () => { reads += 1; return v2Fixture(raw); },
			requestImage: async ({ body }) => ({ ok: true, status: 200, image: { bytes: validPng(), mimeType: "image/png", imageCallId: body.model, width: 1, height: 1 } }),
		});
		const originalResolve = deps.resolveRuntime;
		deps.resolveRuntime = async (...args) => {
			raw.defaults.imageGeneration.defaultModel = "first";
			return originalResolve(...args);
		};
		const first = await createImageGenerationExecutor(deps)({ params: { prompt: "draw" }, toolCallId: "first", ctx: context() });
		expect(first.details.imageModel).toBe("second");
		expect(reads).toBe(1);
	});
});
