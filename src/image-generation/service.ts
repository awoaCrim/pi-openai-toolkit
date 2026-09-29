import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertConfigValid, loadToolkitConfig, resolveToolkitConfig } from "../config";
import { notifyConfigIssues } from "../config/notifications";
import { resolveResponsesEnvironment } from "../runtime";
import {
	copyImageToExplicitPath,
	prepareExplicitOutputPath,
	saveCanonicalImage,
	type ExplicitOutputPlan,
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
	MAX_IMAGE_IDENTIFIER_CHARS,
	ImageGenerationError,
	sanitizeImageDiagnostic,
	type GenerateImageParams,
	type ImageGenerationBatchDetails,
	type ImageGenerationExecutionResult,
	type ImageGenerationFailureCode,
	type ImageGenerationDetails,
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
				"Unable to resolve the current model's Images endpoint for image generation.",
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

function asImageGenerationError(value: unknown): ImageGenerationError {
	if (value instanceof ImageGenerationError) {
		return new ImageGenerationError(
			value.code,
			sanitizeImageDiagnostic(value.message, "Image generation failed."),
		);
	}
	return new ImageGenerationError(
		"network",
		sanitizeImageDiagnostic(value instanceof Error ? value.message : value, "Image generation failed."),
	);
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

function formatBatchResultText(details: ImageGenerationBatchDetails): string {
	const lines = [`Generated ${details.succeededCount}/${details.requestedCount} PNG images.`];
	const failedIndexes = new Set((details.failures ?? []).map((failure) => failure.index));
	let imageIndex = 0;
	for (let batchIndex = 0; batchIndex < details.requestedCount; batchIndex += 1) {
		if (failedIndexes.has(batchIndex)) continue;
		const image = details.images[imageIndex++];
		if (image) lines.push(`Image ${batchIndex + 1}: ${image.artifactPath}`);
	}
	for (const failure of details.failures ?? []) {
		lines.push(`Image ${failure.index + 1} failed: ${failure.message}`);
	}
	return lines.join("\n");
}

function batchImageCallId(imageCallId: string, batchIndex: number, batchSize: number): string {
	if (batchSize === 1) return imageCallId;
	const suffix = `-batch-${batchIndex + 1}`;
	return `${imageCallId.slice(0, Math.max(1, MAX_IMAGE_IDENTIFIER_CHARS - suffix.length))}${suffix}`;
}

async function persistGeneratedImage(args: {
	generated: ParsedGeneratedImage;
	params: ReturnType<typeof normalizeGenerateImageParams>;
	batchIndex: number;
	toolCallId: string;
	batchSize: number;
	imageModel: string;
	routingModel: string;
	agentDir: string;
	sessionId: string;
	referencesCount: number;
	explicitOutput?: ExplicitOutputPlan;
	deps: ImageGenerationServiceDependencies;
}): Promise<ImageGenerationDetails> {
	const imageCallId = batchImageCallId(args.generated.imageCallId || args.toolCallId, args.batchIndex, args.batchSize);
	try {
		const artifactPath = await args.deps.saveCanonical({
			bytes: args.generated.bytes,
			agentDir: args.agentDir,
			sessionId: args.sessionId,
			imageCallId,
		});

		let outputPath: string | undefined;
		let warning: string | undefined;
		if (args.explicitOutput) {
			try {
				await args.deps.copyExplicit({ bytes: args.generated.bytes, plan: args.explicitOutput });
				outputPath = args.explicitOutput.path;
			} catch (error) {
				warning = sanitizeImageDiagnostic(
					error instanceof Error ? error.message : error,
					`The generated image was saved to the canonical artifact, but copying to ${args.explicitOutput.path} failed.`,
				);
			}
		}

		return {
			artifactPath,
			...(outputPath ? { outputPath } : {}),
			routingModel: args.routingModel,
			imageModel: args.imageModel,
			imageCallId,
			...(args.generated.responseId ? { responseId: args.generated.responseId } : {}),
			mimeType: IMAGE_GENERATION_MIME_TYPE,
			byteCount: args.generated.bytes.length,
			width: args.generated.width,
			height: args.generated.height,
			edited: args.params.action === "edit",
			referenceCount: args.referencesCount,
			...(args.generated.revisedPrompt ? { revisedPrompt: args.generated.revisedPrompt } : {}),
			...(warning ? { warning } : {}),
		};
	} finally {
		args.generated.bytes.fill(0);
	}
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
		const resolved = resolveToolkitConfig(deps.loadConfig(), args.ctx.model);
		notifyConfigIssues(args.ctx, resolved);
		assertConfigValid(resolved, "imageGeneration", "compatibility");
		const { config } = resolved;
		if (!isImageGenerationEnabledForModel(args.ctx.model, config.imageGeneration)) {
			throw new ImageGenerationError(
				"unsupported-model",
				"Image generation is not enabled for the current provider/model-id.",
			);
		}

		const imageModel = selectImageGenerationModel({
			requestedModel: params.model,
			configuredModels: resolved.policy.imageGeneration.allowedModels,
			defaultModel: resolved.policy.imageGeneration.defaultModel,
		});

		const runtimeResolution = await deps.resolveRuntime(args.ctx, {
			enabled: config.imageGeneration.enabled,
			responsesApis: IMAGE_GENERATION_CAPABLE_APIS,
			...(resolved.format === "v2" ? { codexGatewayModels: resolved.gatewayModelKeys } : {}),
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
		try {
			const jobs = Array.from({ length: params.batchSize }, (_, batchIndex) =>
				(async () => {
					throwIfAborted(args.signal);
					const body = buildImageGenerationRequest({
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
							sanitizeImageDiagnostic(response.errorMessage, "Image generation request failed."),
						);
					}
					return persistGeneratedImage({
						generated: response.image,
						params,
						batchIndex,
						toolCallId: args.toolCallId,
						batchSize: params.batchSize,
						imageModel,
						routingModel: `${runtimeResolution.runtime.provider}/${runtimeResolution.runtime.model}`,
						agentDir,
						sessionId: args.ctx.sessionManager.getSessionId(),
						referencesCount: references.length,
						explicitOutput,
						deps,
					});
				})(),
			);
			const settled = await Promise.allSettled(jobs);
			const images: ImageGenerationDetails[] = [];
			const failures: ImageGenerationBatchDetails["failures"] = [];
			for (const [index, result] of settled.entries()) {
				if (result.status === "fulfilled") {
					images.push(result.value);
				} else {
					const error = asImageGenerationError(result.reason);
					failures.push({ index, code: error.code, message: error.message });
				}
			}

			if (images.length === 0) {
				const firstFailure = settled.find((result) => result.status === "rejected");
				throw asImageGenerationError(firstFailure && firstFailure.status === "rejected" ? firstFailure.reason : "Image generation failed.");
			}

			if (params.batchSize === 1) {
				const details = images[0]!;
				return {
					details,
					text: formatResultText({
						artifactPath: details.artifactPath,
						outputPath: details.outputPath,
						warning: details.warning,
						edited: details.edited,
						width: details.width,
						height: details.height,
					}),
				};
			}

			const batchDetails: ImageGenerationBatchDetails = {
				batch: true,
				requestedCount: params.batchSize,
				succeededCount: images.length,
				failedCount: failures.length,
				images,
				...(failures.length > 0 ? { failures } : {}),
			};
			return { details: batchDetails, text: formatBatchResultText(batchDetails) };
		} finally {
			deps.clearReferences(references);
		}
	};
}

export const executeImageGeneration = createImageGenerationExecutor();
