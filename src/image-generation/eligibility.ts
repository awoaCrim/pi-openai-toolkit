import type { ImageGenerationConfig } from "../types";
import { IMAGE_GENERATION_CAPABLE_APIS, type ImageGenerationModel } from "./types";

/**
 * The hosted `image_generation` tool is a capability of the Responses API rather than of a
 * specific model, so support is decided by API alone. `enabled` is the single opt-in switch
 * and defaults to off because every successful provider request may incur a charge.
 */
export function isImageGenerationEnabledForModel(
	model: ImageGenerationModel | undefined,
	config: ImageGenerationConfig,
): boolean {
	return (
		config.enabled &&
		typeof model?.api === "string" &&
		(IMAGE_GENERATION_CAPABLE_APIS as readonly string[]).includes(model.api)
	);
}
