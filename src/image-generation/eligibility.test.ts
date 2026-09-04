import { describe, expect, test } from "bun:test";
import { getExactModelKey, isExactModelAllowed } from "../model-scope";
import { DEFAULT_IMAGE_GENERATION_CONFIG } from "../types";
import { isImageGenerationEnabledForModel } from "./eligibility";

const responsesModel = {
	provider: "newapi",
	api: "openai-responses",
	id: "gpt-5.5",
};

describe("exact model scope", () => {
	test("builds and matches the exact provider/model-id", () => {
		expect(getExactModelKey(responsesModel)).toBe("newapi/gpt-5.5");
		expect(isExactModelAllowed(responsesModel, ["newapi/gpt-5.5"])).toBe(true);
		expect(isExactModelAllowed(responsesModel, ["other/gpt-5.5", "newapi/other"])).toBe(false);
	});
});

describe("image generation eligibility", () => {
	test("is disabled by default because each success may be billed", () => {
		expect(DEFAULT_IMAGE_GENERATION_CONFIG.enabled).toBe(false);
		expect(isImageGenerationEnabledForModel(responsesModel, DEFAULT_IMAGE_GENERATION_CONFIG)).toBe(false);
	});

	test("depends only on the switch and a Responses-capable API", () => {
		expect(isImageGenerationEnabledForModel(responsesModel, { enabled: true })).toBe(true);
		expect(
			isImageGenerationEnabledForModel(
				{ ...responsesModel, api: "openai-codex-responses" },
				{ enabled: true },
			),
		).toBe(true);
		expect(
			isImageGenerationEnabledForModel(
				{ ...responsesModel, provider: "another-provider", id: "some-other-model" },
				{ enabled: true },
			),
		).toBe(true);
	});

	test("stays off for non-Responses APIs and models without API metadata", () => {
		expect(
			isImageGenerationEnabledForModel({ ...responsesModel, api: "anthropic-messages" }, { enabled: true }),
		).toBe(false);
		expect(isImageGenerationEnabledForModel({ ...responsesModel, api: undefined }, { enabled: true })).toBe(false);
		expect(isImageGenerationEnabledForModel(undefined, { enabled: true })).toBe(false);
	});
});
