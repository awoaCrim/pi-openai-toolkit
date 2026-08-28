import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "../config";
import { executeImageGeneration } from "./service";
import { isImageGenerationEnabledForModel } from "./eligibility";
import { renderImageGenerationResult } from "./render";
import {
	IMAGE_GENERATION_QUALITIES,
	IMAGE_GENERATION_SIZES,
	IMAGE_GENERATION_TOOL_NAME,
	MAX_IMAGE_PATH_CHARS,
	MAX_IMAGE_PROMPT_CHARS,
	MAX_REFERENCE_IMAGE_COUNT,
	ImageGenerationError,
	sanitizeImageDiagnostic,
	type ImageGenerationDetails,
} from "./types";

const registeredApis = new WeakSet<object>();

const GenerateImageParameters = Type.Object(
	{
		prompt: Type.String({
			minLength: 1,
			maxLength: MAX_IMAGE_PROMPT_CHARS,
			description: "Image generation or edit prompt. Preserve the user's requested subject and constraints.",
		}),
		referenceImagePaths: Type.Optional(
			Type.Union(
				[
					Type.Null(),
					Type.Array(Type.String({ minLength: 1, maxLength: MAX_IMAGE_PATH_CHARS }), {
						minItems: 1,
						maxItems: MAX_REFERENCE_IMAGE_COUNT,
					}),
				],
				{
					description:
						"Use null when the user did not explicitly identify reference images; otherwise provide one to five user-identified local image paths.",
				},
			),
		),
		outputPath: Type.Optional(
			Type.Union(
				[
					Type.Null(),
					Type.String({
						minLength: 1,
						maxLength: MAX_IMAGE_PATH_CHARS,
					}),
				],
				{
					description:
						"Use null when the user did not explicitly request a destination; otherwise provide the requested explicit .png file path.",
				},
			),
		),
		size: Type.Optional(
			StringEnum(IMAGE_GENERATION_SIZES, {
				description: "Requested PNG dimensions, or auto.",
			}),
		),
		quality: Type.Optional(
			StringEnum(IMAGE_GENERATION_QUALITIES, {
				description: "Requested image quality, or auto.",
			}),
		),
	},
	{ additionalProperties: false },
);

type GenerateImageToolParams = Static<typeof GenerateImageParameters>;

function syncImageGenerationTool(
	pi: ExtensionAPI,
	model: Parameters<typeof isImageGenerationEnabledForModel>[0],
	config: Parameters<typeof isImageGenerationEnabledForModel>[1],
): void {
	const eligible = isImageGenerationEnabledForModel(model, config);
	const activeTools = pi.getActiveTools();
	const active = activeTools.includes(IMAGE_GENERATION_TOOL_NAME);
	if (eligible && !active) {
		pi.setActiveTools([...activeTools, IMAGE_GENERATION_TOOL_NAME]);
	} else if (!eligible && active) {
		pi.setActiveTools(activeTools.filter((name) => name !== IMAGE_GENERATION_TOOL_NAME));
	}
}

export function registerImageGenerationExtension(
	pi: ExtensionAPI,
	loadConfig: typeof loadToolkitConfig = loadToolkitConfig,
	executeImage: typeof executeImageGeneration = executeImageGeneration,
): void {
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	pi.registerTool<typeof GenerateImageParameters, ImageGenerationDetails, Record<string, never>>({
		name: IMAGE_GENERATION_TOOL_NAME,
		label: "OpenAI Generate Image",
		description:
			"Generate a PNG image, or edit from one to five user-approved local reference images, through the current allowlisted Responses model and the hosted gpt-image-2 image_generation tool. This is a paid provider operation.",
		promptSnippet: "Generate or edit PNG images through the current allowlisted Responses model and gpt-image-2.",
		promptGuidelines: [
			"Use openai_generate_image when the user explicitly asks to create, draw, render, or edit a raster image.",
			"Do not call openai_generate_image speculatively: it consumes the user's provider or gateway image quota.",
			"Keep the image prompt faithful to the user's requested subject and constraints; do not invent unrequested style details.",
			"Set referenceImagePaths to null unless the user explicitly identified local files; never invent paths or placeholder strings, and remember upload requires user approval.",
			"Set outputPath to null unless the user explicitly asks for a destination; never invent a destination or placeholder string, and otherwise use the default Pi agent artifact.",
			"Do not substitute Python, browser automation, shell scripts, or unrelated image tools for an eligible image request.",
		],
		parameters: GenerateImageParameters,
		executionMode: "sequential",
		async execute(toolCallId, params: GenerateImageToolParams, signal, _onUpdate, ctx) {
			try {
				const result = await executeImage({
					params,
					toolCallId,
					signal,
					ctx,
				});
				return {
					content: [{ type: "text", text: result.text }],
					details: result.details,
				};
			} catch (error) {
				if (error instanceof ImageGenerationError) {
					throw new Error(error.message);
				}
				throw new Error(
					sanitizeImageDiagnostic(error instanceof Error ? error.message : error, "Image generation failed."),
				);
			}
		},
		renderResult: renderImageGenerationResult,
	});

	pi.on("session_start", (_event, ctx) => {
		const { config } = loadConfig();
		syncImageGenerationTool(pi, ctx.model, config.imageGeneration);
	});

	pi.on("model_select", (event) => {
		const { config } = loadConfig();
		syncImageGenerationTool(pi, event.model, config.imageGeneration);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		const { config } = loadConfig();
		syncImageGenerationTool(pi, ctx.model, config.imageGeneration);
	});
}

export default function imageGenerationExtension(pi: ExtensionAPI): void {
	registerImageGenerationExtension(pi);
}

export const _extensionTest = {
	GenerateImageParameters,
	syncImageGenerationTool,
};
