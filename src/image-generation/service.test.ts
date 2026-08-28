import { describe, expect, test } from "bun:test";
import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
} from "../types";
import { createImageGenerationExecutor, type ImageGenerationServiceDependencies } from "./service";
import { validPng } from "./test-helpers";

function config() {
	return {
		config: {
			compaction: {
				...DEFAULT_COMPACTION_CONFIG,
				autoCompaction: { ...DEFAULT_COMPACTION_CONFIG.autoCompaction },
				responsesApis: [...DEFAULT_COMPACTION_CONFIG.responsesApis],
			},
			webSearch: {
				...DEFAULT_WEB_SEARCH_CONFIG,
				models: [...DEFAULT_WEB_SEARCH_CONFIG.models],
			},
			imageGeneration: {
				...DEFAULT_IMAGE_GENERATION_CONFIG,
				models: ["newapi/gpt-5.5"],
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
			expect.objectContaining({ type: "image_generation", model: "gpt-image-2", action: "edit" }),
		);
		expect(result.details).toEqual(
			expect.objectContaining({
				artifactPath: "/agent/generated-images/session-test/ig_test.png",
				routingModel: "newapi/gpt-5.5",
				imageModel: "gpt-image-2",
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

	test("fails before dispatch for an ineligible model", async () => {
		let dispatched = false;
		const deps = {
			loadConfig: () => ({
				...config(),
				config: {
					...config().config,
					imageGeneration: { enabled: true, models: ["newapi/other"] },
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
