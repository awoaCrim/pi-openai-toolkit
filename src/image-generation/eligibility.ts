import { isExactModelAllowed } from "../model-scope";
import type { ImageGenerationConfig } from "../types";
import {
	IMAGE_GENERATION_CAPABLE_APIS,
	type ImageGenerationModel,
} from "./types";

export function isImageGenerationEnabledForModel(
	model: ImageGenerationModel | undefined,
	config: ImageGenerationConfig,
): boolean {
	return (
		config.enabled &&
		typeof model?.api === "string" &&
		(IMAGE_GENERATION_CAPABLE_APIS as readonly string[]).includes(model.api) &&
		isExactModelAllowed(model, config.models)
	);
}
