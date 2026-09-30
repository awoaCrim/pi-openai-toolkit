import { VIRTUAL_MODEL_API } from "../runtime";
import type { ImageGenerationConfig } from "../types";
import { IMAGE_GENERATION_CAPABLE_APIS, type ImageGenerationModel } from "./types";

/**
 * The independent Images API is exposed only for Responses-capable runtimes rather than for a
 * specific conversation model. `enabled` is the single opt-in switch and defaults to off because
 * every successful provider request may incur a charge.
 */
export function isImageGenerationEnabledForModel(
	model: ImageGenerationModel | undefined,
	config: ImageGenerationConfig,
	effectiveModel: ImageGenerationModel | undefined = model,
): boolean {
	if (!config.enabled) return false;
	// A virtual model is only a candidate until execution resolves its physical
	// model. The service performs that resolution and fails closed if it is not
	// available; this keeps the tool discoverable instead of silently hiding a
	// valid virtual route at startup.
	if (model?.api === VIRTUAL_MODEL_API && effectiveModel === model) return true;
	return typeof effectiveModel?.api === "string" &&
		(IMAGE_GENERATION_CAPABLE_APIS as readonly string[]).includes(effectiveModel.api);
}
