import { isExactModelAllowed } from "../model-scope";
import type { AutoModeCircuitBreakerConfig, AutoModeConfig } from "../types";
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

/**
 * Per-turn denial accounting, modelled on Codex's rejection circuit breaker. Without
 * it a denied action just becomes an infinite negotiation between the agent and the
 * reviewer, which is both expensive and the exact behaviour the anti-circumvention
 * clause is trying to stop.
 */
export type RejectionBreakerState = {
	consecutiveDenials: number;
	recentDenials: boolean[];
	deniedTools: Set<string>;
	interrupted: boolean;
};

export function createRejectionBreaker(): RejectionBreakerState {
	return { consecutiveDenials: 0, recentDenials: [], deniedTools: new Set(), interrupted: false };
}

/** Clear at turn start: the breaker judges one turn's pattern, not the whole session. */
export function resetRejectionBreaker(state: RejectionBreakerState): void {
	state.consecutiveDenials = 0;
	state.recentDenials = [];
	state.deniedTools.clear();
	state.interrupted = false;
}

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

/**
 * Record one genuine reviewer denial and report whether the turn should stop.
 *
 * Two independent triggers, matching Codex: a short run of consecutive denials
 * means the agent cannot get past the reviewer, and a high denial rate inside a
 * sliding window means it keeps trying different unsafe things.
 */
export function recordDenial(
	state: RejectionBreakerState,
	config: AutoModeCircuitBreakerConfig,
	toolName: string,
): "continue" | "interrupt" {
	state.consecutiveDenials += 1;
	state.deniedTools.add(toolName);
	state.recentDenials.push(true);
	if (state.recentDenials.length > Math.max(1, config.windowSize)) {
		state.recentDenials.splice(0, state.recentDenials.length - config.windowSize);
	}

	const recentDenials = state.recentDenials.filter(Boolean).length;
	const consecutiveTripped = config.consecutiveDenials > 0 && state.consecutiveDenials >= config.consecutiveDenials;
	const rateTripped = config.recentDenials > 0 && recentDenials >= config.recentDenials;
	if (consecutiveTripped || rateTripped) {
		state.interrupted = true;
		return "interrupt";
	}
	return "continue";
}

/** Any allowed action resets the consecutive run, so one approval breaks a streak. */
export function recordNonDenial(state: RejectionBreakerState): void {
	state.consecutiveDenials = 0;
	state.recentDenials.push(false);
}

/**
 * A repeat request for a tool that was already denied in this turn is the shape of
 * a workaround attempt, so it must be judged by the blocking reviewer rather than
 * accepted on the strength of an earlier low-risk classification.
 */
export function wasDeniedThisTurn(state: RejectionBreakerState, toolName: string): boolean {
	return state.deniedTools.has(toolName);
}
