import { describe, expect, test } from "bun:test";
import { getExactModelKey, isExactModelAllowed } from "../model-scope";
import { isImageGenerationEnabledForModel } from "./eligibility";

const eligibleModel = {
	provider: "newapi",
	api: "openai-responses",
	id: "gpt-5.5",
};

const enabled = { enabled: true, models: ["newapi/gpt-5.5"] };

describe("exact model scope", () => {
	test("builds and matches the exact provider/model-id", () => {
		expect(getExactModelKey(eligibleModel)).toBe("newapi/gpt-5.5");
		expect(isExactModelAllowed(eligibleModel, ["newapi/gpt-5.5"])).toBe(true);
		expect(isExactModelAllowed(eligibleModel, ["other/gpt-5.5", "newapi/other"])).toBe(false);
	});
});

describe("image generation eligibility", () => {
	test("requires enabled, a supported Responses API, and an exact allowlist match", () => {
		expect(isImageGenerationEnabledForModel(eligibleModel, enabled)).toBe(true);
		expect(isImageGenerationEnabledForModel(eligibleModel, { ...enabled, enabled: false })).toBe(false);
		expect(isImageGenerationEnabledForModel(eligibleModel, { enabled: true, models: [] })).toBe(false);
		expect(
			isImageGenerationEnabledForModel(
				{ ...eligibleModel, api: "openai-codex-responses" },
				enabled,
			),
		).toBe(true);
		expect(
			isImageGenerationEnabledForModel(
				{ ...eligibleModel, api: "anthropic-messages" },
				enabled,
			),
		).toBe(false);
		expect(
			isImageGenerationEnabledForModel(
				{ ...eligibleModel, provider: "other" },
				enabled,
			),
		).toBe(false);
	});
});
