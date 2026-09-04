import { isExactModelAllowed } from "../model-scope";
import type { AutoModeConfig } from "../types";
import {
	SIDE_EFFECT_TOOLS,
	type AutoModeGateSource,
	type AutoModeModelRef,
} from "./types";

export type AutoModeRuntimeState = {
	engaged: boolean;
	/** Gate currently in force: either the configured value or a session override. */
	gate: AutoModeGateSource;
	/** Session override from `/auto all` or `/auto side`; cleared on session start. */
	gateOverride?: AutoModeGateSource;
	extraTools: string[];
};

function normalizeToolNames(names: readonly string[]): string[] {
	return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

/**
 * Auto mode needs an allowlisted active model plus a configured reviewer. The
 * reviewer model itself is resolved later, so an unknown spec degrades through the
 * normal review-unavailable path instead of silently disabling the gate.
 */
export function isAutoModeEligible(
	model: AutoModeModelRef | undefined,
	config: AutoModeConfig,
): boolean {
	if (!config.enabled) return false;
	if (!config.reviewerModel) return false;
	return isExactModelAllowed(model, config.models);
}

export function shouldReviewTool(toolName: string, state: AutoModeRuntimeState): boolean {
	if (state.gate === "all") return true;
	if ((SIDE_EFFECT_TOOLS as readonly string[]).includes(toolName)) return true;
	return normalizeToolNames(state.extraTools).includes(toolName);
}

export function describeGate(state: Pick<AutoModeRuntimeState, "gate" | "extraTools">): string {
	if (state.gate === "all") return "all tools";
	return [...new Set([...SIDE_EFFECT_TOOLS, ...normalizeToolNames(state.extraTools)])].join(", ");
}

export function createRuntimeState(config: AutoModeConfig): AutoModeRuntimeState {
	return {
		engaged: false,
		gate: config.gate,
		extraTools: normalizeToolNames(config.extraTools),
	};
}

/**
 * Refresh the configured gate and tool list without touching engagement: editing
 * config changes what gets reviewed, it never silently turns auto mode on or off.
 * An explicit `/auto` scope override wins until the next session start.
 */
export function applyConfiguredGate(
	state: AutoModeRuntimeState,
	config: AutoModeConfig,
): AutoModeRuntimeState {
	state.gate = state.gateOverride ?? config.gate;
	state.extraTools = normalizeToolNames(config.extraTools);
	return state;
}

export function setGateOverride(
	state: AutoModeRuntimeState,
	config: AutoModeConfig,
	gate: AutoModeGateSource | undefined,
): AutoModeRuntimeState {
	state.gateOverride = gate;
	state.gate = gate ?? config.gate;
	return state;
}
