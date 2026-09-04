import { describe, expect, test } from "bun:test";
import { DEFAULT_AUTO_MODE_CONFIG, type AutoModeConfig } from "../types";
import {
	applyConfiguredGate,
	createRuntimeState,
	describeGate,
	isAutoModeEligible,
	setGateOverride,
	shouldReviewTool,
} from "./policy";

const eligibleModel = { provider: "uwoacrimson", id: "gpt-5.6-luna" };

function configWith(overrides: Partial<AutoModeConfig> = {}): AutoModeConfig {
	return {
		...DEFAULT_AUTO_MODE_CONFIG,
		models: [...DEFAULT_AUTO_MODE_CONFIG.models],
		extraTools: [...DEFAULT_AUTO_MODE_CONFIG.extraTools],
		...overrides,
	};
}

describe("auto mode eligibility", () => {
	test("needs the master switch, a reviewer, and an allowlisted active model", () => {
		expect(
			isAutoModeEligible(eligibleModel, configWith({ models: ["uwoacrimson/gpt-5.6-luna"], reviewerModel: "uwoacrimson/gpt-5.6-sol" })),
		).toBe(true);
		expect(
			isAutoModeEligible(eligibleModel, configWith({ enabled: false, models: ["uwoacrimson/gpt-5.6-luna"], reviewerModel: "x/y" })),
		).toBe(false);
		expect(isAutoModeEligible(eligibleModel, configWith({ models: ["uwoacrimson/gpt-5.6-luna"] }))).toBe(false);
		expect(isAutoModeEligible(eligibleModel, configWith({ reviewerModel: "x/y" }))).toBe(false);
		expect(
			isAutoModeEligible({ provider: "uwoacrimson", id: "gpt-5.6-sol" }, configWith({ models: ["uwoacrimson/gpt-5.6-luna"], reviewerModel: "x/y" })),
		).toBe(false);
		expect(isAutoModeEligible(undefined, configWith({ reviewerModel: "x/y" }))).toBe(false);
	});
});

describe("auto mode gating", () => {
	test("reviews side-effect tools by default and honours extra tools", () => {
		const state = createRuntimeState(configWith({ extraTools: ["openai_generate_image", " "] }));
		expect(shouldReviewTool("bash", state)).toBe(true);
		expect(shouldReviewTool("write", state)).toBe(true);
		expect(shouldReviewTool("edit", state)).toBe(true);
		expect(shouldReviewTool("openai_generate_image", state)).toBe(true);
		expect(shouldReviewTool("read", state)).toBe(false);
		expect(shouldReviewTool("grep", state)).toBe(false);
	});

	test("the all gate reviews every tool including read-only ones", () => {
		const state = createRuntimeState(configWith({ gate: "all" }));
		expect(shouldReviewTool("read", state)).toBe(true);
		expect(shouldReviewTool("anything_else", state)).toBe(true);
	});

	test("a session override wins until it is cleared, and never touches engagement", () => {
		const config = configWith({ gate: "side-effect", extraTools: ["apply_patch"] });
		const state = createRuntimeState(config);
		state.engaged = true;

		setGateOverride(state, config, "all");
		expect(state.gate).toBe("all");
		expect(state.engaged).toBe(true);

		applyConfiguredGate(state, config);
		expect(state.gate).toBe("all");

		setGateOverride(state, config, undefined);
		applyConfiguredGate(state, config);
		expect(state.gate).toBe("side-effect");
		expect(shouldReviewTool("apply_patch", state)).toBe(true);
	});

	test("describes the effective gate for the status line", () => {
		expect(describeGate(createRuntimeState(configWith({ gate: "all" })))).toBe("all tools");
		expect(describeGate(createRuntimeState(configWith({ extraTools: ["mcp__x__y"] })))).toBe(
			"bash, write, edit, mcp__x__y",
		);
	});
});
