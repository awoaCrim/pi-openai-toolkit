import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "../config";
import { resolveResponsesEnvironment } from "../runtime";
import {
	copyImageToExplicitPath,
	prepareExplicitOutputPath,
	saveCanonicalImage,
} from "./artifacts";
import { requestGeneratedImage } from "./client";
import { isImageGenerationEnabledForModel } from "./eligibility";
import {
	buildImageGenerationRequest,
	normalizeGenerateImageParams,
	selectImageGenerationModel,
} from "./protocol";
import {
	clearPreparedReferences,
	prepareReferenceImages,
} from "./references";
import {
	IMAGE_GENERATION_CAPABLE_APIS,
	IMAGE_GENERATION_MIME_TYPE,
	ImageGenerationError,
	sanitizeImageDiagnostic,
	type GenerateImageParams,
	type ImageGenerationExecutionResult,
	type ImageGenerationFailureCode,
	type ParsedGeneratedImage,
} from "./types";

export type ImageGenerationServiceDependencies = {
	loadConfig: typeof loadToolkitConfig;
	resolveRuntime: typeof resolveResponsesEnvironment;
	getAgentDir: typeof getAgentDir;
	prepareOutput: typeof prepareExplicitOutputPath;
	prepareReferences: typeof prepareReferenceImages;
	requestImage: typeof requestGeneratedImage;
	saveCanonical: typeof saveCanonicalImage;
	copyExplicit: typeof copyImageToExplicitPath;
	clearReferences: typeof clearPreparedReferences;
};

const DEFAULT_SERVICE_DEPS: ImageGenerationServiceDependencies = {
	loadConfig: loadToolkitConfig,
	resolveRuntime: resolveResponsesEnvironment,
	getAgentDir,
	prepareOutput: prepareExplicitOutputPath,
	prepareReferences: prepareReferenceImages,
	requestImage: requestGeneratedImage,
	saveCanonical: saveCanonicalImage,
	copyExplicit: copyImageToExplicitPath,
	clearReferences: clearPreparedReferences,
};

function runtimeFailure(
	reason: string,
	errorMessage?: string,
): ImageGenerationError {
	switch (reason) {
		case "disabled":
			return new ImageGenerationError("disabled", "Image generation is disabled.");
		case "unsupported-api":
		case "missing-model":
			return new ImageGenerationError(
				"unsupported-model",
				"Image generation is unavailable for the current model.",
			);
		case "missing-api-key":
		case "auth-resolution-failed":
			return new ImageGenerationError(
				"authentication",
				sanitizeImageDiagnostic(
					errorMessage,
					"Unable to resolve authentication for image generation with the current model.",
				),
			);
		default:
			return new ImageGenerationError(
				"missing-runtime",
				"Unable to resolve the current model's Responses endpoint for image generation.",
			);
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new ImageGenerationError("aborted", "Image generation was cancelled.");
	}
}

function clientFailureCode(reason: string): ImageGenerationFailureCode {
	switch (reason) {
		case "aborted":
		case "timeout":
		case "authentication":
		case "rate-limit":
		case "request-rejected":
		case "backend-unavailable":
		case "network":
		case "oversized-response":
		case "malformed-response":
		case "no-image":
			return reason;
		default:
			return "network";
	}
}

function formatResultText(args: {
	artifactPath: string;
	outputPath?: string;
	warning?: string;
	edited: boolean;
	width: number;
	height: number;
}): string {
	const lines = [
		`${args.edited ? "Edited" : "Generated"} PNG image (${args.width}x${args.height}).`,
		`Artifact: ${args.artifactPath}`,
	];
	if (args.outputPath) lines.push(`Copied to: ${args.outputPath}`);
	if (args.warning) lines.push(`Warning: ${args.warning}`);
	return lines.join("\n");
}

export function createImageGenerationExecutor(
	deps: ImageGenerationServiceDependencies = DEFAULT_SERVICE_DEPS,
): (args: {
	params: GenerateImageParams;
	toolCallId: string;
	signal?: AbortSignal;
	ctx: ExtensionContext;
}) => Promise<ImageGenerationExecutionResult> {
	return async (args) => {
		const params = normalizeGenerateImageParams(args.params);
		throwIfAborted(args.signal);
		const { config } = deps.loadConfig();
		if (!isImageGenerationEnabledForModel(args.ctx.model, config.imageGeneration)) {
			throw new ImageGenerationError(
				"unsupported-model",
				"Image generation is not enabled for the current provider/model-id.",
			);
		}

		const imageModel = selectImageGenerationModel({
			requestedModel: params.model,
			configuredModels: config.imageGeneration.models,
		});

		const runtimeResolution = await deps.resolveRuntime(args.ctx, {
			enabled: config.imageGeneration.enabled,
			responsesApis: IMAGE_GENERATION_CAPABLE_APIS,
		});
		if (!runtimeResolution.ok) {
			throw runtimeFailure(runtimeResolution.reason, runtimeResolution.errorMessage);
		}

		const agentDir = deps.getAgentDir();
		const explicitOutput = await deps.prepareOutput({
			rawPath: params.outputPath,
			agentDir,
			ctx: args.ctx,
			signal: args.signal,
		});

		const references = await deps.prepareReferences({
			paths: params.referenceImagePaths,
			ctx: args.ctx,
			signal: args.signal,
		});
		let generated: ParsedGeneratedImage | undefined;
		try {
			throwIfAborted(args.signal);
			const body = buildImageGenerationRequest({
				routingModel: runtimeResolution.runtime.model,
				imageModel,
				params,
				references,
			});
			const response = await deps.requestImage({
				runtime: runtimeResolution.runtime,
				body,
				signal: args.signal,
			});
			if (!response.ok) {
				throw new ImageGenerationError(
					clientFailureCode(response.reason),
					response.errorMessage,
				);
			}
			generated = response.image;

			const artifactPath = await deps.saveCanonical({
				bytes: generated.bytes,
				agentDir,
				sessionId: args.ctx.sessionManager.getSessionId(),
				imageCallId: generated.imageCallId || args.toolCallId,
			});

			let outputPath: string | undefined;
			let warning: string | undefined;
			if (explicitOutput) {
				try {
					await deps.copyExplicit({ bytes: generated.bytes, plan: explicitOutput });
					outputPath = explicitOutput.path;
				} catch (error) {
					warning = sanitizeImageDiagnostic(
						error instanceof Error ? error.message : error,
						`The generated image was saved to the canonical artifact, but copying to ${explicitOutput.path} failed.`,
					);
				}
			}

			const edited = references.length > 0;
			const details = {
				artifactPath,
				...(outputPath ? { outputPath } : {}),
				routingModel: `${runtimeResolution.runtime.provider}/${runtimeResolution.runtime.model}`,
				imageModel,
				imageCallId: generated.imageCallId,
				...(generated.responseId ? { responseId: generated.responseId } : {}),
				mimeType: IMAGE_GENERATION_MIME_TYPE,
				byteCount: generated.bytes.length,
				width: generated.width,
				height: generated.height,
				edited,
				referenceCount: references.length,
				...(generated.revisedPrompt ? { revisedPrompt: generated.revisedPrompt } : {}),
				...(warning ? { warning } : {}),
			};
			return {
				details,
				text: formatResultText({
					artifactPath,
					outputPath,
					warning,
					edited,
					width: generated.width,
					height: generated.height,
				}),
			};
		} finally {
			deps.clearReferences(references);
			generated?.bytes.fill(0);
		}
	};
}

export const executeImageGeneration = createImageGenerationExecutor();
