import { describe, expect, test } from "bun:test";
import {
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
} from "../types";
import { registerImageGenerationExtension } from "./extension";
import { IMAGE_GENERATION_TOOL_NAME, type ImageGenerationDetails } from "./types";

type Handler = (event: any, ctx: any) => unknown;

function createHarness(eligible = true) {
	const handlers = new Map<string, Handler[]>();
	let activeTools = ["read", IMAGE_GENERATION_TOOL_NAME];
	let registeredTool: any;
	let registerCount = 0;
	const pi = {
		on: (event: string, handler: Handler) => {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		registerTool: (tool: unknown) => {
			registerCount += 1;
			registeredTool = tool;
		},
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
	};
	const loadConfig = () => ({
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
				models: eligible ? ["newapi/gpt-5.5"] : ["newapi/other"],
			},
		},
		warnings: [],
	});
	const details: ImageGenerationDetails = {
		artifactPath: "/agent/generated-images/session/ig.png",
		routingModel: "newapi/gpt-5.5",
		imageModel: "gpt-image-2",
		imageCallId: "ig_test",
		mimeType: "image/png",
		byteCount: 100,
		width: 1024,
		height: 1024,
		edited: false,
		referenceCount: 0,
	};
	const executeImage = async () => ({
		text: "Generated PNG.\nArtifact: /agent/generated-images/session/ig.png",
		details,
	});
	const ctx = {
		model: { provider: "newapi", api: "openai-responses", id: "gpt-5.5" },
	};
	return {
		pi,
		handlers,
		loadConfig,
		executeImage,
		ctx,
		details,
		getActiveTools: () => activeTools,
		getRegisteredTool: () => registeredTool,
		getRegisterCount: () => registerCount,
	};
}

describe("image generation extension", () => {
	test("registers once and activates only for eligible exact models", () => {
		const harness = createHarness(true);
		registerImageGenerationExtension(
			harness.pi as never,
			harness.loadConfig as never,
			harness.executeImage as never,
		);
		registerImageGenerationExtension(
			harness.pi as never,
			harness.loadConfig as never,
			harness.executeImage as never,
		);
		expect(harness.getRegisterCount()).toBe(1);
		expect(harness.handlers.get("session_start")).toHaveLength(1);
		expect(harness.handlers.has("before_provider_request")).toBe(false);

		harness.handlers.get("session_start")![0]!({}, harness.ctx);
		expect(harness.getActiveTools()).toContain(IMAGE_GENERATION_TOOL_NAME);

		harness.handlers.get("model_select")![0]!(
			{ model: { provider: "newapi", api: "openai-completions", id: "gpt-5.5" } },
			harness.ctx,
		);
		expect(harness.getActiveTools()).not.toContain(IMAGE_GENERATION_TOOL_NAME);

		harness.handlers.get("model_select")![0]!({ model: harness.ctx.model }, harness.ctx);
		expect(harness.getActiveTools()).toContain(IMAGE_GENERATION_TOOL_NAME);
	});

	test("removes the tool for an unlisted model", () => {
		const harness = createHarness(false);
		registerImageGenerationExtension(
			harness.pi as never,
			harness.loadConfig as never,
			harness.executeImage as never,
		);
		harness.handlers.get("before_agent_start")![0]!({}, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read"]);
	});

	test("registers nullable optional path schemas and explicit absence guidance", () => {
		const harness = createHarness(true);
		registerImageGenerationExtension(
			harness.pi as never,
			harness.loadConfig as never,
			harness.executeImage as never,
		);
		const tool = harness.getRegisteredTool();
		const parameters = tool.parameters;
		expect(parameters.required).toEqual(["prompt"]);
		expect(parameters.properties.referenceImagePaths.anyOf.map((schema: { type: string }) => schema.type)).toEqual([
			"null",
			"array",
		]);
		expect(parameters.properties.outputPath.anyOf.map((schema: { type: string }) => schema.type)).toEqual([
			"null",
			"string",
		]);
		expect(parameters.properties.referenceImagePaths.description).toContain("Use null");
		expect(parameters.properties.outputPath.description).toContain("Use null");
		expect(tool.promptGuidelines.some((guideline: string) => guideline.includes("never invent paths"))).toBe(true);
		expect(tool.promptGuidelines.some((guideline: string) => guideline.includes("never invent a destination"))).toBe(true);
	});

	test("returns path-only content and bounded details", async () => {
		const harness = createHarness(true);
		registerImageGenerationExtension(
			harness.pi as never,
			harness.loadConfig as never,
			harness.executeImage as never,
		);
		const tool = harness.getRegisteredTool();
		expect(tool.name).toBe(IMAGE_GENERATION_TOOL_NAME);
		expect(tool.executionMode).toBe("sequential");
		const result = await tool.execute(
			"tool-call-1",
			{ prompt: "draw a cat" },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(result).toEqual({
			content: [
				{
					type: "text",
					text: "Generated PNG.\nArtifact: /agent/generated-images/session/ig.png",
				},
			],
			details: harness.details,
		});
		expect(result.content.some((block: { type: string }) => block.type === "image")).toBe(false);
		expect(JSON.stringify(result)).not.toContain("base64");
		expect(JSON.stringify(result)).not.toContain("data:image");
	});
});
