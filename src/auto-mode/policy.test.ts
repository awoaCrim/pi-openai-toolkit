import { describe, expect, test } from "bun:test";
import { DEFAULT_AUTO_MODE_CONFIG, type AutoModeConfig } from "../types";
import {
	applyConfiguredGate,
	createRejectionBreaker,
	createRuntimeState,
	describeGate,
	isAutoModeEligible,
	recordDenial,
	recordNonDenial,
	resetRejectionBreaker,
	setGateOverride,
	shouldReviewTool,
	wasDeniedThisTurn,
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


describe("rejection circuit breaker", () => {
	const breaker = { consecutiveDenials: 3, recentDenials: 4, windowSize: 6 };

	test("a run of consecutive denials interrupts the turn", () => {
		const state = createRejectionBreaker();
		expect(recordDenial(state, breaker, "bash")).toBe("continue");
		expect(recordDenial(state, breaker, "bash")).toBe("continue");
		expect(recordDenial(state, breaker, "write")).toBe("interrupt");
		expect(state.interrupted).toBe(true);
	});

	test("an allowed action breaks the streak", () => {
		const state = createRejectionBreaker();
		recordDenial(state, breaker, "bash");
		recordDenial(state, breaker, "bash");
		recordNonDenial(state);
		expect(recordDenial(state, breaker, "bash")).toBe("continue");
		expect(recordDenial(state, breaker, "bash")).toBe("interrupt");
	});

	test("the sliding window catches a scattered denial rate with no streak", () => {
		const scattered = { consecutiveDenials: 5, recentDenials: 3, windowSize: 5 };
		const state = createRejectionBreaker();
		expect(recordDenial(state, scattered, "bash")).toBe("continue");
		recordNonDenial(state);
		expect(recordDenial(state, scattered, "write")).toBe("continue");
		recordNonDenial(state);

		// Five reviewed calls, three of them denials: never a run of two, but the
		// agent is still being refused often enough to stop negotiating.
		expect(state.consecutiveDenials).toBe(0);
		expect(recordDenial(state, scattered, "edit")).toBe("interrupt");
	});

	test("the window forgets denials older than its size", () => {
		const state = createRejectionBreaker();
		for (let index = 0; index < 10; index += 1) {
			recordDenial(state, { ...breaker, recentDenials: 0 }, "bash");
			expect(state.recentDenials.length).toBeLessThanOrEqual(6);
		}
	});

	test("a zero threshold disables that trigger instead of interrupting everything", () => {
		const state = createRejectionBreaker();
		const disabled = { consecutiveDenials: 0, recentDenials: 0, windowSize: 50 };
		expect(recordDenial(state, disabled, "bash")).toBe("continue");
		expect(recordDenial(state, disabled, "bash")).toBe("continue");
	});

	test("a tool denied this turn is recognised as a likely workaround attempt", () => {
		const state = createRejectionBreaker();
		expect(wasDeniedThisTurn(state, "bash")).toBe(false);
		recordDenial(state, breaker, "bash");
		expect(wasDeniedThisTurn(state, "bash")).toBe(true);
		expect(wasDeniedThisTurn(state, "write")).toBe(false);
	});

	test("turn reset clears counts, denied tools, and the interrupt flag", () => {
		const state = createRejectionBreaker();
		recordDenial(state, breaker, "bash");
		resetRejectionBreaker(state);
		expect(state).toMatchObject({ consecutiveDenials: 0, interrupted: false });
		expect(state.recentDenials).toEqual([]);
		expect(wasDeniedThisTurn(state, "bash")).toBe(false);
	});
});
