import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createReadOnlyTools, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "../config";
import {
	DEFAULT_AUTO_MODE_CONFIG,
	type AutoModeConfig,
} from "../types";
import {
	authorizationVersion,
	classifyTrajectory,
	createScoreTracker,
	fastApprovalEligible,
	recordFailedCall,
	recordScoredCall,
	resetScoreTracker,
	type ScoreTracker,
} from "./classifier";
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
	type AutoModeRuntimeState,
	type RejectionBreakerState,
} from "./policy";
import { requestToolReview, type EvidenceTool, type ReviewerRegistry } from "./reviewer";
import { buildClassifierPrompt } from "./prompt";
import { transcriptFromEntries } from "./transcript";
import {
	AUTO_MODE_COMMAND,
	AUTO_MODE_ENTRY_TYPE,
	AUTO_MODE_FLAG,
	AUTO_MODE_STATUS_KEY,
	boundReviewText,
	type AutoModeDecisionRecord,
	MAX_REVIEW_REASON_CHARS,
	type ReviewOutcome,
} from "./types";

const registeredApis = new WeakSet<object>();

/** Read-only tools are stateless per working directory, so build them once each. */
const evidenceToolCache = new Map<string, EvidenceTool[]>();

function textFromToolContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const record = block as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") return record.text;
			if (record.type === "image") return "[image omitted]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * Fingerprint of everything the user actually said. Used to invalidate a cached
 * pre-score: once the authorization premise changes, the old score is meaningless.
 */
function userAuthorizationVersion(entries: readonly { type: string; message?: unknown }[]): string {
	const userText = entries
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message as { role?: string; content?: unknown } | undefined)
		.filter((message): message is { role?: string; content?: unknown } => message?.role === "user")
		.map((message) => textFromToolContent(message.content))
		.join("\n");
	return authorizationVersion(userText);
}

function evidenceToolsFor(cwd: string): EvidenceTool[] {
	const cached = evidenceToolCache.get(cwd);
	if (cached) return cached;
	const built: EvidenceTool[] = createReadOnlyTools(cwd).map((tool: AgentTool<any>) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		execute: async (args, signal) => {
			const result = await tool.execute(
				`auto-mode-review-${Date.now().toString(36)}`,
				args as never,
				signal,
				undefined,
			);
			return textFromToolContent(result.content);
		},
	}));
	evidenceToolCache.set(cwd, built);
	return built;
}

/**
 * Anti-circumvention clause. A denial has to survive contact with a motivated
 * agent: without an explicit prohibition on workarounds, the model reissues the
 * same operation in a form the reviewer has not seen.
 */
const GUARDIAN_REJECTION_INSTRUCTIONS =
	"The agent must not attempt to achieve the same outcome by workaround, indirect execution, " +
	"renaming, splitting the command, or policy circumvention. Proceed only with a materially " +
	"safer alternative, or if the user explicitly approves this action after being informed of " +
	"the risk. Otherwise stop and ask the user.";

/**
 * A review that never finished is an infrastructure outcome, not a safety verdict.
 * Telling the model "rejected due to risk" here would teach it the wrong lesson.
 */
const REVIEW_INCOMPLETE_INSTRUCTIONS =
	"The automatic approval review did not produce a verdict. Do not assume the action is unsafe " +
	"because of that. Ask the user for explicit approval, or choose a materially safer alternative.";

type GateDecision =
	| { kind: "pass" }
	| { kind: "block"; reason: string; terminate?: boolean }
	| { kind: "ask-human"; reason: string };

/**
 * Auto mode replaces the human approval prompt with a reviewer model that sees the
 * conversation, may investigate with read-only tools, and returns a risk/authorization
 * verdict. Enabling it is always a synchronous state flip: no provider call happens
 * until a gated tool is about to run, so turning the mode on can never stall a turn.
 */
export function registerAutoModeExtension(
	pi: ExtensionAPI,
	loadConfig: typeof loadToolkitConfig = loadToolkitConfig,
	requestReview: typeof requestToolReview = requestToolReview,
): void {
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	const runtime: AutoModeRuntimeState = createRuntimeState(DEFAULT_AUTO_MODE_CONFIG);
	const breaker: RejectionBreakerState = createRejectionBreaker();
	const tracker: ScoreTracker = createScoreTracker();

	let callIndex = 0;
	let scoringInFlight = false;

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			AUTO_MODE_STATUS_KEY,
			runtime.engaged ? `auto-review: ${describeGate(runtime)}` : undefined,
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
		runtime.engaged = true;
		return true;
	}

	function disengage(ctx: ExtensionContext): void {
		if (!runtime.engaged) return;
		runtime.engaged = false;
		resetScoreTracker(tracker);
		updateStatus(ctx);
	}

	function reviewerRegistry(ctx: ExtensionContext): ReviewerRegistry {
		return ctx.modelRegistry;
	}

	/**
	 * Reviewer verdicts feed the breaker; a classifier fast allow does not, because
	 * the classifier never denies anything and must not be able to mask a streak.
	 */
	function evaluateOutcome(
		outcome: ReviewOutcome,
		pending: { toolName: string; toolCallId: string; reviewerModelSpec: string },
		ctx: ExtensionContext,
		breakerConfig: AutoModeConfig["circuitBreaker"],
	): GateDecision {
		const reviewerModel = outcome.kind === "unavailable" ? pending.reviewerModelSpec : outcome.reviewerModel;

		if (outcome.kind === "allow") {
			recordNonDenial(breaker);
			recordDecision({
				toolName: pending.toolName,
				toolCallId: pending.toolCallId,
				decision: "allow",
				reason: boundReviewText(outcome.verdict.rationale, MAX_REVIEW_REASON_CHARS),
				reviewerModel,
				source: "reviewer",
				riskLevel: outcome.verdict.riskLevel,
				userAuthorization: outcome.verdict.userAuthorization,
				evidenceRounds: outcome.evidenceRounds,
			});
			return { kind: "pass" };
		}

		if (outcome.kind === "deny") {
			const reason = boundReviewText(outcome.verdict.rationale, MAX_REVIEW_REASON_CHARS);
			recordDecision({
				toolName: pending.toolName,
				toolCallId: pending.toolCallId,
				decision: "deny",
				reason,
				reviewerModel,
				source: "reviewer",
				riskLevel: outcome.verdict.riskLevel,
				userAuthorization: outcome.verdict.userAuthorization,
				evidenceRounds: outcome.evidenceRounds,
			});
			const breakerAction = recordDenial(breaker, breakerConfig, pending.toolName);
			const risk = `Risk: ${outcome.verdict.riskLevel}. User authorization: ${outcome.verdict.userAuthorization}.`;
			if (breakerAction === "interrupt") {
				recordDecision({
					toolName: pending.toolName,
					toolCallId: pending.toolCallId,
					decision: "turn-interrupted",
					reason: `Repeated reviewer denials in this turn; the turn was stopped.`,
					reviewerModel,
					source: "circuit-breaker",
				});
				return {
					kind: "block",
					terminate: true,
					reason:
						`Approval reviewer denied this action (${risk} Reason: ${reason}). ` +
						"Repeated denials in this turn mean the current approach is not acceptable. " +
						"Stop, explain the blocker to the user, and ask how to proceed.",
				};
			}
			return {
				kind: "block",
				reason: `This action was rejected by the approval reviewer. ${risk} Reason: ${reason} ${GUARDIAN_REJECTION_INSTRUCTIONS}`,
			};
		}

		const reason = boundReviewText(outcome.reason, MAX_REVIEW_REASON_CHARS);
		const detail = `Review status: ${outcome.cause}. ${reason}`;

		if (ctx.signal?.aborted) {
			recordDecision({
				toolName: pending.toolName,
				toolCallId: pending.toolCallId,
				decision: "unavailable-blocked",
				reason,
				reviewerModel,
				source: "policy",
			});
			return { kind: "block", reason: `Auto-mode review was cancelled, so the action did not run. ${detail}` };
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
				reason:
					`The action did not run because no interactive surface is available to confirm it. ${detail} ` +
					REVIEW_INCOMPLETE_INSTRUCTIONS,
			};
		}

		return { kind: "ask-human", reason: detail };
	}

	/**
	 * Non-blocking trajectory classification. Fired after a gated tool has run, so
	 * the next gated call can be satisfied from a cached score instead of waiting on
	 * a full review. A failed sample is recorded as a failure, never as low risk.
	 */
	function scheduleClassification(
		ctx: ExtensionContext,
		config: AutoModeConfig,
		completed: { toolName: string; toolInput: unknown },
	): void {
		if (!config.classifier.enabled || scoringInFlight) return;
		const modelSpec = config.classifier.model ?? config.reviewerModel;
		if (!modelSpec) return;

		const entries = ctx.sessionManager.buildContextEntries();
		const { text: transcript } = transcriptFromEntries(entries);
		const authVersion = userAuthorizationVersion(entries as never);
		const scoredAtCall = callIndex;
		scoringInFlight = true;

		void classifyTrajectory({
			registry: reviewerRegistry(ctx),
			modelSpec,
			prompt: buildClassifierPrompt({
				transcript,
				pendingToolName: completed.toolName,
				pendingToolInput: completed.toolInput,
				cwd: ctx.cwd,
			}),
			timeoutMs: config.classifier.timeoutMs,
			signal: ctx.signal,
		})
			.then((result) => {
				if (result.kind === "failed") {
					recordFailedCall(tracker, scoredAtCall);
					return;
				}
				recordScoredCall(tracker, {
					risk: result.kind,
					scoredAtCall,
					authorizationVersion: authVersion,
					sampledAt: Date.now(),
				});
			})
			.catch(() => {
				recordFailedCall(tracker, scoredAtCall);
			})
			.finally(() => {
				scoringInFlight = false;
			});
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
			applyConfiguredGate(runtime, auto);
			const sub = args.trim().toLowerCase();

			switch (sub) {
				case "on":
					if (engage(ctx, auto)) ctx.ui.notify(`Auto mode on. Reviewing: ${describeGate(runtime)}`, "info");
					break;
				case "off":
					runtime.engaged = false;
					setGateOverride(runtime, auto, undefined);
					resetScoreTracker(tracker);
					ctx.ui.notify("Auto mode off.", "info");
					break;
				case "all":
					setGateOverride(runtime, auto, "all");
					if (engage(ctx, auto)) ctx.ui.notify("Auto mode on. Reviewing all tools.", "info");
					break;
				case "side":
					setGateOverride(runtime, auto, "side-effect");
					ctx.ui.notify(`Reviewing side-effect tools only: ${describeGate(runtime)}`, "info");
					break;
				case "":
				case "status":
					ctx.ui.notify(
						runtime.engaged
							? [
									`Auto mode on. Reviewing: ${describeGate(runtime)}.`,
									`Reviewer: ${auto.reviewerModel ?? "unset"} (transcript ${auto.transcript ? "on" : "off"}, read-only evidence ${auto.evidenceTools ? "on" : "off"}).`,
									`Pre-scorer: ${auto.classifier.enabled ? `${auto.classifier.model ?? auto.reviewerModel ?? "unset"} (max lag ${auto.classifier.maxLag})` : "off"}.`,
									`Circuit breaker: ${auto.circuitBreaker.consecutiveDenials} consecutive / ${auto.circuitBreaker.recentDenials} in ${auto.circuitBreaker.windowSize}.`,
								].join(" ")
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
		setGateOverride(runtime, config.autoMode, undefined);
		applyConfiguredGate(runtime, config.autoMode);
		resetScoreTracker(tracker);
		resetRejectionBreaker(breaker);
		callIndex = 0;
		if (pi.getFlag(AUTO_MODE_FLAG)) engage(ctx, config.autoMode);
		updateStatus(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		const { config } = loadConfig();
		if (runtime.engaged && !isAutoModeEligible(event.model, config.autoMode)) {
			disengage(ctx);
			if (ctx.hasUI) ctx.ui.notify("Auto mode off: this model is not allowlisted.", "warning");
		}
		updateStatus(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		const { config } = loadConfig();
		applyConfiguredGate(runtime, config.autoMode);
		if (runtime.engaged && !isAutoModeEligible(ctx.model, config.autoMode)) {
			disengage(ctx);
		}
		updateStatus(ctx);
	});

	// The breaker judges one turn's denial pattern, so it starts clean each turn.
	pi.on("turn_start", () => {
		resetRejectionBreaker(breaker);
	});

	pi.on("tool_call", async (event, ctx) => {
		callIndex += 1;
		if (!runtime.engaged) return undefined;

		const { config } = loadConfig();
		const auto = config.autoMode;
		applyConfiguredGate(runtime, auto);

		if (!isAutoModeEligible(ctx.model, auto)) {
			disengage(ctx);
			return undefined;
		}
		if (!shouldReviewTool(event.toolName, runtime)) return undefined;

		const pending = {
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			reviewerModelSpec: auto.reviewerModel ?? "",
		};

		// A repeat of a tool already denied this turn is the shape of a workaround,
		// so it never rides the pre-scorer fast path.
		const requiresSynchronousReview = wasDeniedThisTurn(breaker, event.toolName);
		if (auto.classifier.enabled && !requiresSynchronousReview) {
			const fastEntries = ctx.sessionManager.buildContextEntries();
			const fast = fastApprovalEligible({
				tracker,
				currentCallIndex: callIndex,
				authorizationVersion: userAuthorizationVersion(fastEntries as never),
				maxLag: auto.classifier.maxLag,
			});
			if (fast.eligible) {
				recordDecision({
					toolName: pending.toolName,
					toolCallId: pending.toolCallId,
					decision: "allow",
					reason: "Non-blocking trajectory pre-score reported low risk for this position.",
					reviewerModel: boundReviewText(auto.classifier.model ?? auto.reviewerModel ?? "", MAX_REVIEW_REASON_CHARS),
					source: "classifier",
					fastDecision: fast.reason,
				});
				return undefined;
			}
		}

		const entries = ctx.sessionManager.buildContextEntries();
		const transcript = auto.transcript ? transcriptFromEntries(entries).text : undefined;

		const outcome = await requestReview({
			registry: reviewerRegistry(ctx),
			reviewerModelSpec: pending.reviewerModelSpec,
			toolName: event.toolName,
			toolInput: event.input,
			transcript,
			cwd: ctx.cwd,
			timeoutMs: auto.timeoutMs,
			signal: ctx.signal,
			evidenceTools: auto.evidenceTools ? evidenceToolsFor(ctx.cwd) : undefined,
			maxEvidenceRounds: auto.maxEvidenceRounds,
		});

		const decision = evaluateOutcome(outcome, pending, ctx, auto.circuitBreaker);
		if (decision.kind === "ask-human") {
			const confirmed = await ctx.ui.confirm(
				"Auto-mode review unavailable",
				`${decision.reason}\n\nAllow ${event.toolName} to run?`,
			);
			if (confirmed) recordNonDenial(breaker);
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
		return decision.kind === "block"
			? { block: true, reason: decision.reason, ...(decision.terminate ? { terminate: true } : {}) }
			: undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!runtime.engaged) return undefined;
		const { config } = loadConfig();
		const auto = config.autoMode;
		if (auto.classifier.enabled && shouldReviewTool(event.toolName, runtime)) {
			scheduleClassification(ctx, auto, {
				toolName: event.toolName,
				toolInput: (event as { input?: unknown }).input,
			});
		}
		return undefined;
	});
}

export default function autoModeExtension(pi: ExtensionAPI): void {
	registerAutoModeExtension(pi);
}
