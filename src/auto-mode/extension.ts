import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "../config";
import { DEFAULT_AUTO_MODE_CONFIG, type AutoModeConfig } from "../types";
import {
	applyConfiguredGate,
	createRuntimeState,
	describeGate,
	isAutoModeEligible,
	setGateOverride,
	shouldReviewTool,
	type AutoModeRuntimeState,
} from "./policy";
import { requestToolReview } from "./reviewer";
import {
	AUTO_MODE_COMMAND,
	AUTO_MODE_ENTRY_TYPE,
	AUTO_MODE_FLAG,
	AUTO_MODE_STATUS_KEY,
	boundReviewText,
	MAX_REVIEW_INTENT_CHARS,
	MAX_REVIEW_REASON_CHARS,
	type AutoModeDecisionRecord,
	type ReviewOutcome,
} from "./types";

const registeredApis = new WeakSet<object>();

type GateDecision =
	| { kind: "pass" }
	| { kind: "block"; reason: string }
	| { kind: "ask-human"; reason: string };

/**
 * Auto mode replaces the human approval prompt with a reviewer model. Enabling it
 * is always a synchronous state flip: no provider call happens until a gated tool
 * is about to run, so turning the mode on can never stall the current turn.
 */
export function registerAutoModeExtension(
	pi: ExtensionAPI,
	loadConfig: typeof loadToolkitConfig = loadToolkitConfig,
	requestReview: typeof requestToolReview = requestToolReview,
): void {
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	const state: AutoModeRuntimeState = createRuntimeState(DEFAULT_AUTO_MODE_CONFIG);
	let lastIntent: string | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			AUTO_MODE_STATUS_KEY,
			state.engaged ? `auto-review: ${describeGate(state)}` : undefined,
		);
	}

	function recordDecision(data: Omit<AutoModeDecisionRecord, "timestamp">): void {
		pi.appendEntry(AUTO_MODE_ENTRY_TYPE, { timestamp: Date.now(), ...data } satisfies AutoModeDecisionRecord);
	}

	function engage(ctx: ExtensionContext, config: AutoModeConfig): boolean {
		if (!isAutoModeEligible(ctx.model, config)) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Auto mode needs an allowlisted model in autoMode.models and a configured autoMode.reviewerModel.",
					"warning",
				);
			}
			return false;
		}
		state.engaged = true;
		return true;
	}

	function evaluateOutcome(
		outcome: ReviewOutcome,
		pending: { toolName: string; toolCallId: string; reviewerModelSpec: string },
		ctx: ExtensionContext,
	): GateDecision {
		const reviewerModel = outcome.kind === "unavailable" ? pending.reviewerModelSpec : outcome.reviewerModel;

		if (outcome.kind === "allow") {
			recordDecision({
				toolName: pending.toolName,
				toolCallId: pending.toolCallId,
				decision: "allow",
				reason: boundReviewText(outcome.reason, MAX_REVIEW_REASON_CHARS),
				reviewerModel,
				source: "reviewer",
			});
			return { kind: "pass" };
		}

		if (outcome.kind === "deny") {
			const reason = boundReviewText(outcome.reason, MAX_REVIEW_REASON_CHARS);
			recordDecision({
				toolName: pending.toolName,
				toolCallId: pending.toolCallId,
				decision: "deny",
				reason,
				reviewerModel,
				source: "reviewer",
			});
			return { kind: "block", reason: `Auto-mode reviewer denied this action: ${reason}` };
		}

		const reason = boundReviewText(outcome.reason, MAX_REVIEW_REASON_CHARS);

		if (ctx.signal?.aborted) {
			recordDecision({
				toolName: pending.toolName,
				toolCallId: pending.toolCallId,
				decision: "unavailable-blocked",
				reason,
				reviewerModel,
				source: "policy",
			});
			return { kind: "block", reason: `Auto-mode review was cancelled, so the action did not run: ${reason}` };
		}

		// Fail closed without an interactive surface: print and JSON modes cannot ask.
		if (!ctx.hasUI) {
			recordDecision({
				toolName: pending.toolName,
				toolCallId: pending.toolCallId,
				decision: "unavailable-blocked",
				reason,
				reviewerModel,
				source: "policy",
			});
			return {
				kind: "block",
				reason: `Auto-mode review is unavailable and no interactive UI can confirm, so the action was blocked: ${reason}`,
			};
		}

		return { kind: "ask-human", reason };
	}

	pi.registerFlag(AUTO_MODE_FLAG, {
		description: "Start with auto mode: a reviewer model approves gated tool calls instead of you",
		type: "boolean",
		default: false,
	});

	pi.registerCommand(AUTO_MODE_COMMAND, {
		description: "Model-reviewed tool approval: /auto [on|off|status|all|side]",
		handler: async (args, ctx) => {
			const { config } = loadConfig();
			const auto = config.autoMode;
			applyConfiguredGate(state, auto);
			const sub = args.trim().toLowerCase();

			switch (sub) {
				case "on":
					if (engage(ctx, auto)) ctx.ui.notify(`Auto mode on. Reviewing: ${describeGate(state)}`, "info");
					break;
				case "off":
					state.engaged = false;
					setGateOverride(state, auto, undefined);
					ctx.ui.notify("Auto mode off.", "info");
					break;
				case "all":
					setGateOverride(state, auto, "all");
					if (engage(ctx, auto)) ctx.ui.notify("Auto mode on. Reviewing all tools.", "info");
					break;
				case "side":
					setGateOverride(state, auto, "side-effect");
					ctx.ui.notify(`Reviewing side-effect tools only: ${describeGate(state)}`, "info");
					break;
				case "":
				case "status":
					ctx.ui.notify(
						state.engaged
							? `Auto mode on. Reviewing: ${describeGate(state)}. Reviewer: ${auto.reviewerModel ?? "unset"}.`
							: `Auto mode off. Eligible: ${isAutoModeEligible(ctx.model, auto) ? "yes" : "no"}.`,
						"info",
					);
					break;
				default:
					ctx.ui.notify("Usage: /auto [on|off|status|all|side]", "warning");
			}

			updateStatus(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const { config } = loadConfig();
		setGateOverride(state, config.autoMode, undefined);
		applyConfiguredGate(state, config.autoMode);
		if (pi.getFlag(AUTO_MODE_FLAG)) engage(ctx, config.autoMode);
		updateStatus(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		const { config } = loadConfig();
		if (state.engaged && !isAutoModeEligible(event.model, config.autoMode)) {
			state.engaged = false;
			if (ctx.hasUI) ctx.ui.notify("Auto mode off: this model is not allowlisted.", "warning");
		}
		updateStatus(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const { config } = loadConfig();
		applyConfiguredGate(state, config.autoMode);
		if (typeof event.prompt === "string" && event.prompt.trim().length > 0) {
			lastIntent = boundReviewText(event.prompt, MAX_REVIEW_INTENT_CHARS);
		}
		if (state.engaged && !isAutoModeEligible(ctx.model, config.autoMode)) {
			state.engaged = false;
		}
		updateStatus(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.engaged) return undefined;

		const { config } = loadConfig();
		const auto = config.autoMode;
		applyConfiguredGate(state, auto);

		if (!isAutoModeEligible(ctx.model, auto)) {
			state.engaged = false;
			updateStatus(ctx);
			return undefined;
		}
		if (!shouldReviewTool(event.toolName, state)) return undefined;

		const pending = {
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			reviewerModelSpec: auto.reviewerModel ?? "",
		};
		const outcome = await requestReview({
			registry: ctx.modelRegistry,
			reviewerModelSpec: pending.reviewerModelSpec,
			toolName: event.toolName,
			toolInput: event.input,
			intent: lastIntent,
			cwd: ctx.cwd,
			timeoutMs: auto.timeoutMs,
			signal: ctx.signal,
		});

		const decision = evaluateOutcome(outcome, pending, ctx);
		if (decision.kind === "ask-human") {
			const confirmed = await ctx.ui.confirm(
				"Auto-mode review unavailable",
				`${decision.reason}\n\nAllow ${event.toolName} to run?`,
			);
			recordDecision({
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				decision: confirmed ? "unavailable-allowed" : "unavailable-blocked",
				reason: decision.reason,
				reviewerModel: pending.reviewerModelSpec,
				source: "human",
			});
			return confirmed
				? undefined
				: { block: true, reason: "Blocked by user after auto-mode review could not complete." };
		}

		updateStatus(ctx);
		return decision.kind === "block" ? { block: true, reason: decision.reason } : undefined;
	});
}

export default function autoModeExtension(pi: ExtensionAPI): void {
	registerAutoModeExtension(pi);
}
