import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createReadOnlyTools, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig, resolveToolkitConfig, type ResolvedToolkitConfig } from "../config";
import { notifyConfigIssues } from "../config/notifications";
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
import { listenForProtectedSelection } from "./model-selection-guard";
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
import {
	installToolReviewRenderer,
	type ToolReviewDisplayState,
	type ToolReviewRendererBridge,
} from "./tool-review-tui";

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
	const userContent = entries
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message as { role?: string; content?: unknown } | undefined)
		.filter((message): message is { role?: string; content?: unknown } => message?.role === "user")
		.map((message) => message.content);
	// Display truncation must not change whether the authorization premise changed.
	return authorizationVersion(JSON.stringify(userContent));
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
	createToolReviewRenderer: () => ToolReviewRendererBridge = installToolReviewRenderer,
): void {
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	const toolReviewRenderer = createToolReviewRenderer();
	let toolReviewRendererWarningShown = false;
	const runtime: AutoModeRuntimeState = createRuntimeState(DEFAULT_AUTO_MODE_CONFIG);
	const breaker: RejectionBreakerState = createRejectionBreaker();
	const tracker: ScoreTracker = createScoreTracker();

	let callIndex = 0;
	let scoringGeneration = 0;
	let scoringController: AbortController | undefined;
	let protectedSelection: string | undefined;
	let stopSelectionListener: (() => void) | undefined;

	function invalidateClassification(): void {
		scoringGeneration += 1;
		scoringController?.abort();
		scoringController = undefined;
		resetScoreTracker(tracker);
	}

	function readConfig(ctx: ExtensionContext, model: Parameters<typeof resolveToolkitConfig>[1] = ctx.model): ResolvedToolkitConfig {
		const resolved = resolveToolkitConfig(loadConfig(), model);
		notifyConfigIssues(ctx, resolved);
		return resolved;
	}

	function updateStatus(ctx: ExtensionContext, reviewingTool?: string): void {
		if (!ctx.hasUI) return;
		if (ctx.mode === "tui") {
			toolReviewRenderer.setTheme(ctx.ui.theme);
			if (reviewingTool) ctx.ui.setWorkingMessage(`Auto mode: reviewing ${reviewingTool}`);
		}
		const rendererSuffix = toolReviewRenderer.supported ? "" : " (footer only)";
		ctx.ui.setStatus(
			AUTO_MODE_STATUS_KEY,
			runtime.engaged
				? reviewingTool
					? `auto-review: reviewing ${reviewingTool}${rendererSuffix}`
					: `auto-review: ${describeGate(runtime)}${rendererSuffix}`
				: undefined,
		);
	}

	function setReviewDisplay(ctx: ExtensionContext, toolCallId: string, state: ToolReviewDisplayState): void {
		if (ctx.mode === "tui") toolReviewRenderer.setTheme(ctx.ui.theme);
		toolReviewRenderer.setState(toolCallId, state);
	}

	function clearReviewActivity(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (ctx.mode === "tui") ctx.ui.setWorkingMessage(undefined);
		updateStatus(ctx);
	}

	function recordDecision(data: Omit<AutoModeDecisionRecord, "timestamp">): void {
		pi.appendEntry(AUTO_MODE_ENTRY_TYPE, { timestamp: Date.now(), ...data } satisfies AutoModeDecisionRecord);
	}

	function engage(ctx: ExtensionContext, config: AutoModeConfig): boolean {
		if (!isAutoModeEligible(ctx.model, config)) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Auto mode needs availability for the current model and a configured reviewerModel.",
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
		invalidateClassification();
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
		if (!config.classifier.enabled || scoringController) return;
		const modelSpec = config.classifier.model ?? config.reviewerModel;
		if (!modelSpec) return;

		const entries = ctx.sessionManager.buildContextEntries();
		const { text: transcript } = transcriptFromEntries(entries);
		const authVersion = userAuthorizationVersion(entries as never);
		const scoredAtCall = callIndex;
		const generation = scoringGeneration;
		const controller = new AbortController();
		scoringController = controller;

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
			signal: ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal,
		})
			.then((result) => {
				if (generation !== scoringGeneration || controller.signal.aborted) return;
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
				if (generation === scoringGeneration && !controller.signal.aborted) recordFailedCall(tracker, scoredAtCall);
			})
			.finally(() => {
				if (generation === scoringGeneration) scoringController = undefined;
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
			const resolved = readConfig(ctx);
			const auto = resolved.config.autoMode;
			const sub = args.trim().toLowerCase();
			if (resolved.invalidFeatures.includes("autoMode") && sub !== "off") {
				if (ctx.hasUI) ctx.ui.notify("Auto-mode configuration is invalid; the existing gate remains engaged until /auto off or a valid configuration is supplied.", "error");
				return;
			}
			applyConfiguredGate(runtime, auto);

			switch (sub) {
				case "on":
					if (engage(ctx, auto)) ctx.ui.notify(`Auto mode on. Reviewing: ${describeGate(runtime)}`, "info");
					break;
				case "off":
					runtime.engaged = false;
					setGateOverride(runtime, auto, undefined);
					invalidateClassification();
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

	pi.on("session_start", (event, ctx) => {
		stopSelectionListener?.();
		stopSelectionListener = listenForProtectedSelection(pi, (target, sessionId) => {
			if (ctx.sessionManager.getSessionId() !== sessionId || !runtime.engaged) return "inactive";
			const policy = readConfig(ctx, target);
			return !policy.invalidFeatures.includes("autoMode") && isAutoModeEligible(target, policy.config.autoMode) ? "allow" : "deny";
		}, (owner) => { protectedSelection = owner; });
		const resolved = readConfig(ctx);
		const { config } = resolved;
		toolReviewRenderer.clear();
		if (
			!toolReviewRenderer.supported &&
			!toolReviewRendererWarningShown &&
			ctx.hasUI &&
			ctx.mode === "tui"
		) {
			ctx.ui.notify(
				"Per-tool auto-review display is unavailable in this Pi version; using the footer status instead.",
				"warning",
			);
			toolReviewRendererWarningShown = true;
		}
		setGateOverride(runtime, config.autoMode, undefined);
		applyConfiguredGate(runtime, config.autoMode);
		invalidateClassification();
		resetRejectionBreaker(breaker);
		callIndex = 0;
		const requestedFromFlag = pi.getFlag(AUTO_MODE_FLAG) === true;
		const startedFromFlag = requestedFromFlag && (resolved.invalidFeatures.includes("autoMode") ? (runtime.engaged = true) : engage(ctx, config.autoMode));
		if (startedFromFlag && event.reason === "startup" && ctx.mode === "tui") {
			ctx.ui.notify(`Auto mode on. Reviewing: ${describeGate(runtime)}`, "info");
		}
		updateStatus(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		const resolved = readConfig(ctx, event.model);
		const { config } = resolved;
		if (!protectedSelection && !resolved.invalidFeatures.includes("autoMode") && runtime.engaged && !isAutoModeEligible(event.model, config.autoMode)) {
			disengage(ctx);
			if (ctx.hasUI) ctx.ui.notify("Auto mode off: this model is not allowlisted.", "warning");
		}
		updateStatus(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		const resolved = readConfig(ctx);
		const { config } = resolved;
		if (resolved.invalidFeatures.includes("autoMode")) { invalidateClassification(); updateStatus(ctx); return; }
		applyConfiguredGate(runtime, config.autoMode);
		if (!protectedSelection && runtime.engaged && !isAutoModeEligible(ctx.model, config.autoMode)) {
			disengage(ctx);
		}
		updateStatus(ctx);
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "user") return;
		// Steer/follow-up delivery can happen without before_agent_start.
		// Merely enqueueing input and ordinary tool turns retain denial history.
		resetRejectionBreaker(breaker);
		invalidateClassification();
	});
	pi.on("session_shutdown", () => { invalidateClassification(); stopSelectionListener?.(); });
	pi.on("session_tree", () => {
		invalidateClassification();
		resetRejectionBreaker(breaker);
		callIndex = 0;
	});

	pi.on("tool_call", async (event, ctx) => {
		callIndex += 1;
		if (!runtime.engaged) return undefined;

		const resolved = readConfig(ctx);
		if (resolved.invalidFeatures.includes("autoMode")) {
			invalidateClassification();
			return { block: true, reason: "Auto-mode configuration is invalid. The gate remains engaged; fix the configuration or explicitly use /auto off." };
		}
		const auto = resolved.config.autoMode;
		applyConfiguredGate(runtime, auto);

		if (!isAutoModeEligible(ctx.model, auto)) {
			if (protectedSelection) return { block: true, reason: "Auto-mode eligibility changed during managed /compact; the existing approval gate remains engaged." };
			disengage(ctx);
			return undefined;
		}
		if (!shouldReviewTool(event.toolName, runtime)) {
			setReviewDisplay(ctx, event.toolCallId, {
				phase: "skipped",
				toolName: event.toolName,
				detail: "outside the configured gate",
			});
			updateStatus(ctx);
			return undefined;
		}

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
				setReviewDisplay(ctx, pending.toolCallId, {
					phase: "allowed",
					toolName: pending.toolName,
					source: "classifier",
					detail: "low-risk trajectory pre-score",
				});
				updateStatus(ctx);
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

		setReviewDisplay(ctx, pending.toolCallId, { phase: "reviewing", toolName: pending.toolName });
		updateStatus(ctx, event.toolName);
		let outcome: ReviewOutcome;
		try {
			outcome = await requestReview({
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
		} finally {
			clearReviewActivity(ctx);
		}

		const decision = evaluateOutcome(outcome, pending, ctx, auto.circuitBreaker);
		if (decision.kind === "ask-human") {
			setReviewDisplay(ctx, pending.toolCallId, { phase: "awaiting-user", toolName: pending.toolName });
			updateStatus(ctx);
			const confirmed = await ctx.ui.confirm(
				"Auto-mode review unavailable",
				`${decision.reason}\n\nAllow ${event.toolName} to run?`,
			);
			if (confirmed) recordNonDenial(breaker);
			setReviewDisplay(
				ctx,
				pending.toolCallId,
				confirmed
					? {
							phase: "allowed",
							toolName: pending.toolName,
						source: "human",
							detail: `review unavailable · ${outcome.kind === "unavailable" ? outcome.cause : "manual confirmation"}`,
					  }
					: { phase: "blocked", toolName: pending.toolName, detail: "user declined" },
			);
			updateStatus(ctx);
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

		if (decision.kind === "block") {
			setReviewDisplay(
				ctx,
				pending.toolCallId,
				outcome.kind === "deny"
					? {
							phase: "denied",
							toolName: pending.toolName,
							detail: `${outcome.verdict.riskLevel} risk · ${outcome.verdict.rationale}`,
					  }
					: {
							phase: "blocked",
							toolName: pending.toolName,
							detail:
								outcome.kind === "unavailable" ? `${outcome.cause} · ${outcome.reason}` : decision.reason,
					  },
			);
			updateStatus(ctx);
			return { block: true, reason: decision.reason, ...(decision.terminate ? { terminate: true } : {}) };
		}

		setReviewDisplay(ctx, pending.toolCallId, {
			phase: "allowed",
			toolName: pending.toolName,
			source: "reviewer",
			detail:
				outcome.kind === "allow"
					? `${outcome.verdict.riskLevel} risk · authorization ${outcome.verdict.userAuthorization}`
					: "review completed",
		});
		updateStatus(ctx);
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!runtime.engaged) return undefined;
		const resolved = readConfig(ctx);
		const { config } = resolved;
		const auto = config.autoMode;
		if (resolved.invalidFeatures.includes("autoMode") || !isAutoModeEligible(ctx.model, auto)) { invalidateClassification(); return undefined; }
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
