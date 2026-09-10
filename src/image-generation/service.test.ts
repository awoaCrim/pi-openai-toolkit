import { describe, expect, test } from "bun:test";
import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
} from "../types";
import { createImageGenerationExecutor, type ImageGenerationServiceDependencies } from "./service";
import { isImageGenerationDetails } from "./types";
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

/**
 * Captures the outgoing request body so a test can compare the nested image model with the
 * details the service returns, without ever reaching the real transport.
 */
function modelProbeDeps(configuredModels: string[] | undefined): {
	deps: ImageGenerationServiceDependencies;
	calls: { body: Record<string, unknown>; dispatched: boolean };
} {
	const calls = { body: {} as Record<string, unknown>, dispatched: false };
	const base = config();
	const deps = {
		loadConfig: () => ({
			...base,
			config: {
				...base.config,
				imageGeneration: {
					...base.config.imageGeneration,
					models: configuredModels ?? [...base.config.imageGeneration.models],
				},
			},
		}),
		resolveRuntime: async () => ({
			ok: true,
			runtime: {
				provider: "newapi",
				api: "openai-responses",
				model: "gpt-5.5",
				baseUrl: "https://gateway.example/v1",
				apiKey: "sk-runtime",
				responsesPath: "responses",
				responsesUrl: "https://gateway.example/v1/responses",
				currentModel: model as never,
			},
		}),
		getAgentDir: () => "/agent",
		prepareOutput: async () => undefined,
		prepareReferences: async () => [],
		requestImage: async (args: { body: unknown }) => {
			calls.dispatched = true;
			calls.body = args.body as Record<string, unknown>;
			return {
				ok: true,
				status: 200,
				image: {
					bytes: validPng(),
					imageCallId: "ig_test",
					width: 1,
					height: 1,
				},
			};
		},
		saveCanonical: async () => "/agent/generated-images/session-test/ig_test.png",
		copyExplicit: async () => undefined,
		clearReferences: () => {},
	} as unknown as ImageGenerationServiceDependencies;
	return { deps, calls };
}

describe("image generation service", () => {
	test("orchestrates an edit and returns path-only metadata while clearing buffers", async () => {
		const referenceBytes = validPng();
		const generatedBytes = validPng();
		let requestBody: Record<string, unknown> | undefined;
		const deps: ImageGenerationServiceDependencies = {
			loadConfig: config as never,
			resolveRuntime: async () => ({
				ok: true,
				runtime: {
					provider: "newapi",
					api: "openai-responses",
					model: "gpt-5.5",
					baseUrl: "https://gateway.example/v1",
					apiKey: "sk-runtime",
					responsesPath: "responses",
					responsesUrl: "https://gateway.example/v1/responses",
					currentModel: model as never,
				},
			}),
			getAgentDir: () => "/agent",
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
						imageCallId: "ig_test",
						responseId: "resp_test",
						revisedPrompt: "revised",
						width: 1,
						height: 1,
					},
				};
			},
			saveCanonical: async (args) => {
				expect(args.sessionId).toBe("session-test");
				expect(args.imageCallId).toBe("ig_test");
				return "/agent/generated-images/session-test/ig_test.png";
			},
			copyExplicit: async () => {
				throw new Error("copy failed with sk-12345678");
			},
			clearReferences: (references) => {
				for (const reference of references) reference.bytes.fill(0);
			},
		};
		const execute = createImageGenerationExecutor(deps);
		const result = await execute({
			params: {
				prompt: "edit this",
				referenceImagePaths: ["reference.png"],
				outputPath: "result.png",
			},
			toolCallId: "tool-call",
			ctx: context(),
		});

		expect((requestBody?.tools as Array<Record<string, unknown>>)[0]).toEqual(
			expect.objectContaining({ type: "image_generation", model: "gpt-image-2.5", action: "edit" }),
		);
		expect(result.details).toEqual(
			expect.objectContaining({
				artifactPath: "/agent/generated-images/session-test/ig_test.png",
				routingModel: "newapi/gpt-5.5",
				imageModel: "gpt-image-2.5",
				edited: true,
				referenceCount: 1,
				warning: "copy failed with [REDACTED]",
			}),
		);
		expect(result.details).not.toHaveProperty("outputPath");
		expect(JSON.stringify(result)).not.toContain("base64");
		expect(referenceBytes.every((byte) => byte === 0)).toBe(true);
		expect(generatedBytes.every((byte) => byte === 0)).toBe(true);
	});

	test("sends and records the configured default image model when the tool omits one", async () => {
		const probe = modelProbeDeps(["grok-imagine-image-2.0", "gpt-image-2"]);
		const execute = createImageGenerationExecutor(probe.deps);
		const result = await execute({
			params: { prompt: "draw a cat", model: null },
			toolCallId: "call",
			ctx: context(),
		});

		expect((probe.calls.body?.tools as Array<Record<string, unknown>>)[0]).toEqual(
			expect.objectContaining({ type: "image_generation", model: "grok-imagine-image-2.0" }),
		);
		// The nested image model never replaces the current Responses routing model.
		expect(probe.calls.body?.model).toBe("gpt-5.5");
		expect(result.details).toEqual(
			expect.objectContaining({ imageModel: "grok-imagine-image-2.0", routingModel: "newapi/gpt-5.5" }),
		);
		expect(isImageGenerationDetails(result.details)).toBe(true);
	});

	test("sends and records an explicitly selected configured image model", async () => {
		const probe = modelProbeDeps(["grok-imagine-image-2.0", "gpt-image-2"]);
		const execute = createImageGenerationExecutor(probe.deps);
		const result = await execute({
			params: { prompt: "draw a cat", model: " gpt-image-2 " },
			toolCallId: "call",
			ctx: context(),
		});

		expect((probe.calls.body?.tools as Array<Record<string, unknown>>)[0]).toEqual(
			expect.objectContaining({ type: "image_generation", model: "gpt-image-2" }),
		);
		expect(result.details.imageModel).toBe("gpt-image-2");
	});

	test("fails before dispatch when the requested image model is not configured", async () => {
		const probe = modelProbeDeps(["gpt-image-2"]);
		const execute = createImageGenerationExecutor(probe.deps);
		await expect(
			execute({
				params: { prompt: "draw a cat", model: "grok-imagine-image-2.0" },
				toolCallId: "call",
				ctx: context(),
			}),
		).rejects.toThrow('Unknown image generation model "grok-imagine-image-2.0"');
		expect(probe.calls.dispatched).toBe(false);
	});

	test("does not dispatch an already-cancelled paid request", async () => {
		let dispatched = false;
		const controller = new AbortController();
		controller.abort();
		const deps = {
			loadConfig: config,
			requestImage: async () => {
				dispatched = true;
				throw new Error("should not dispatch");
			},
		} as unknown as ImageGenerationServiceDependencies;
		const execute = createImageGenerationExecutor(deps);
		await expect(
			execute({
				params: { prompt: "draw" },
				toolCallId: "call",
				signal: controller.signal,
				ctx: context(),
			}),
		).rejects.toThrow("cancelled");
		expect(dispatched).toBe(false);
	});

	test("fails before dispatch when the feature is disabled", async () => {
		let dispatched = false;
		const deps = {
			loadConfig: () => ({
				...config(),
				config: {
					...config().config,
					imageGeneration: { enabled: false },
				},
			}),
			requestImage: async () => {
				dispatched = true;
				throw new Error("should not dispatch");
			},
		} as unknown as ImageGenerationServiceDependencies;
		const execute = createImageGenerationExecutor(deps);
		await expect(
			execute({ params: { prompt: "draw" }, toolCallId: "call", ctx: context() }),
		).rejects.toThrow("not enabled");
		expect(dispatched).toBe(false);
	});
});
