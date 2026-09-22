import type {
	AssistantMessage,
	Context,
	Message,
	Tool,
	ToolCall,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { parseModelSpec } from "../runtime";
import { backfillVerdictFields, buildReviewPrompt, reviewerSystemPrompt } from "./prompt";
import {
	boundReviewText,
	type GuardianVerdict,
	MAX_REVIEW_MODEL_KEY_CHARS,
	type ReviewFailureCause,
	type ReviewOutcome,
	type RiskLevel,
	type UserAuthorization,
} from "./types";

/** The reviewer needs model lookup plus whatever read-only tools we choose to give it. */
export type ReviewerRegistry = Pick<ModelRegistry, "find" | "complete">;

/**
 * One read-only investigation tool the reviewer may call. `parameters` is passed to
 * the provider verbatim; `execute` is ours, so the reviewer can never reach a tool
 * that is not in this list.
 */
export type EvidenceTool = {
	name: string;
	description: string;
	parameters: Tool["parameters"];
	execute: (
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
	) => Promise<string>;
};

const RISK_LEVELS: readonly string[] = ["low", "medium", "high", "critical"];
const AUTHORIZATIONS: readonly string[] = ["unknown", "low", "medium", "high"];

/**
 * Parse a reviewer answer. Only the outcome is required; risk, authorization, and
 * rationale are back-filled. Both the Codex-style field names and our earlier
 * `decision`/`reason` spelling are accepted, so an older reviewer prompt cached by
 * a provider still yields a usable verdict.
 *
 * A verdict we cannot read is reported as a failure, never guessed into approval.
 */
export function parseReviewVerdict(text: string): GuardianVerdict | undefined {
	for (const candidate of candidateJsonObjects(text)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const record = parsed as Record<string, unknown>;
		const rawOutcome = record.outcome ?? record.decision;
		if (rawOutcome !== "allow" && rawOutcome !== "deny") continue;
		const risk = String(record.risk_level ?? record.riskLevel ?? "").toLowerCase();
		const authorization = String(
			record.user_authorization ?? record.userAuthorization ?? "",
		).toLowerCase();
		const rationale =
			typeof record.rationale === "string"
				? record.rationale
				: typeof record.reason === "string"
					? record.reason
					: undefined;
		return backfillVerdictFields({
			outcome: rawOutcome,
			riskLevel: (RISK_LEVELS.includes(risk) ? risk : undefined) as RiskLevel | undefined,
			userAuthorization: (AUTHORIZATIONS.includes(authorization) ? authorization : undefined) as
				| UserAuthorization
				| undefined,
			rationale,
		});
	}
	return undefined;
}

function candidateJsonObjects(text: string): string[] {
	const candidates: string[] = [];
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) candidates.push(fenced[1].trim());
	candidates.push(text.trim());
	const brace = text.match(/\{[\s\S]*\}/);
	if (brace?.[0]) candidates.push(brace[0]);
	return candidates;
}

function firstTextBlock(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
}

/**
 * Pi 0.85 typed tool-call arguments as `Record<string, any>` and Pi 0.86 tightened
 * them to the public `JsonObject`. Narrow with Pi's exported `ToolCall` instead of a
 * handwritten shape so the guard tracks whichever contract the installed Pi declares.
 */
function toolCallBlocks(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

type ReviewAttempt<T> = {
	value?: T;
	errorMessage?: string;
	timedOut: boolean;
	cancelled: boolean;
};

/** One deadline owns every model and evidence operation in this review. */
function createReviewDeadline(timeoutMs: number, callerSignal?: AbortSignal) {
	const deadlineAt = Date.now() + timeoutMs;
	const controller = new AbortController();
	let timedOut = false;
	let cancelled = false;
	const abortFromCaller = () => {
		if (controller.signal.aborted) return;
		cancelled = true;
		controller.abort();
	};
	const expire = () => {
		if (controller.signal.aborted) return;
		timedOut = true;
		controller.abort();
	};
	if (callerSignal?.aborted) abortFromCaller();
	else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
	const timer = setTimeout(expire, Math.max(0, timeoutMs));

	return {
		async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<ReviewAttempt<T>> {
			if (Date.now() >= deadlineAt) expire();
			if (controller.signal.aborted) return { timedOut, cancelled };
			let onAbort!: () => void;
			const aborted = new Promise<ReviewAttempt<T>>((resolve) => {
				onAbort = () => resolve({ timedOut, cancelled });
				controller.signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				// Both settlement handlers stay attached after cancellation, so an
				// uncooperative dependency cannot leak an unhandled rejection.
				const pending = Promise.resolve().then(() => {
					controller.signal.throwIfAborted();
					return operation(controller.signal);
				}).then(
					(value): ReviewAttempt<T> => ({ value, timedOut, cancelled }),
					(error): ReviewAttempt<T> => ({ errorMessage: error instanceof Error ? error.message : String(error), timedOut, cancelled }),
				);
				const result = await Promise.race([pending, aborted]);
				if (Date.now() >= deadlineAt) expire();
				return { ...result, timedOut, cancelled };
			} finally {
				controller.signal.removeEventListener("abort", onAbort);
			}
		},
		dispose() {
			clearTimeout(timer);
			callerSignal?.removeEventListener("abort", abortFromCaller);
		},
	};
}

function failure(cause: ReviewFailureCause, reason: string): ReviewOutcome {
	return { kind: "unavailable", reason: boundReviewText(reason, 240), cause };
}

function outcomeFromVerdict(
	verdict: GuardianVerdict,
	reviewerModel: string,
	evidenceRounds: number,
): ReviewOutcome {
	return verdict.outcome === "allow"
		? { kind: "allow", verdict, reviewerModel, evidenceRounds }
		: { kind: "deny", verdict, reviewerModel, evidenceRounds };
}

/**
 * Ask the reviewer model about one pending tool call.
 *
 * When `evidenceTools` are supplied the reviewer runs as a short bounded agent
 * loop: it may call read-only tools to establish facts, we execute those calls
 * ourselves, and we feed the results back. The whole exchange shares one deadline,
 * and the final round is forced to answer without tools, so a reviewer that keeps
 * investigating still terminates as a verdict or as an explicit failure.
 */
export async function requestToolReview(params: {
	registry: ReviewerRegistry;
	reviewerModelSpec: string;
	toolName: string;
	toolInput: unknown;
	transcript?: string;
	cwd?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	evidenceTools?: EvidenceTool[];
	maxEvidenceRounds?: number;
}): Promise<ReviewOutcome> {
	const parsed = parseModelSpec(params.reviewerModelSpec);
	if (!parsed) {
		return failure(
			"not-configured",
			`autoMode.reviewerModel "${params.reviewerModelSpec}" is not provider/model-id.`,
		);
	}

	const model = params.registry.find(parsed.provider, parsed.modelId);
	if (!model) {
		return failure("not-configured", `Reviewer model ${params.reviewerModelSpec} is not available.`);
	}
	const reviewerModel = boundReviewText(`${model.provider}/${model.id}`, MAX_REVIEW_MODEL_KEY_CHARS);

	const tools = params.evidenceTools ?? [];
	const maxRounds = Math.max(0, params.maxEvidenceRounds ?? 0);
	const useTools = tools.length > 0 && maxRounds > 0;
	const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
	const messages: Message[] = [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: buildReviewPrompt({
						toolName: params.toolName,
						toolInput: params.toolInput,
						transcript: params.transcript,
						cwd: params.cwd,
					}),
				},
			],
			timestamp: Date.now(),
		},
	];

	const deadline = createReviewDeadline(params.timeoutMs, params.signal);
	try {
		let evidenceRounds = 0;
		for (let round = 0; ; round += 1) {
			const forceAnswer = !useTools || round >= maxRounds;
			const context: Context = {
				systemPrompt: reviewerSystemPrompt(useTools),
				messages,
				...(forceAnswer ? {} : { tools: tools.map(toProviderTool) }),
			};

			const attempt = await deadline.run((signal) => params.registry.complete(model, context, { signal, cacheRetention: "none" }));
			if (attempt.cancelled) {
				return failure("cancelled", "Auto-mode review was cancelled before it finished.");
			}
			if (attempt.timedOut) {
				return failure("timeout", `Auto-mode review timed out after ${params.timeoutMs}ms.`);
			}
			if (attempt.errorMessage) {
				return failure("provider-error", attempt.errorMessage);
			}
			const response = attempt.value;
			if (!response) {
				return failure("provider-error", "Reviewer returned no message.");
			}
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				return failure(
					"provider-error",
					response.errorMessage ?? `Reviewer stopped with "${response.stopReason}".`,
				);
			}

			const calls = toolCallBlocks(response);
			if (forceAnswer || calls.length === 0) {
				const verdict = parseReviewVerdict(firstTextBlock(response));
				if (!verdict) {
					return failure("invalid-output", "Reviewer did not return a readable allow/deny verdict.");
				}
				return outcomeFromVerdict(verdict, reviewerModel, evidenceRounds);
			}

			messages.push(response);
			evidenceRounds += 1;
			for (const call of calls) {
				const tool = toolByName.get(call.name);
				if (!tool) {
					messages.push(refusedToolResult(call, `Tool "${call.name}" is not available to the reviewer.`));
					continue;
				}
				const evidence = await deadline.run((signal) => tool.execute(call.arguments, signal));
				if (evidence.cancelled) return failure("cancelled", "Auto-mode review was cancelled during investigation.");
				if (evidence.timedOut) return failure("timeout", `Auto-mode review timed out after ${params.timeoutMs}ms.`);
				messages.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: boundReviewText(evidence.errorMessage ?? evidence.value ?? "", evidence.errorMessage ? 1_000 : 4_000) }],
					isError: evidence.errorMessage !== undefined,
					timestamp: Date.now(),
				});
			}
		}
	} finally {
		deadline.dispose();
	}
}

function toProviderTool(tool: EvidenceTool): Tool {
	return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

function refusedToolResult(
	call: { id: string; name: string },
	text: string,
): Message {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: true,
		timestamp: Date.now(),
	};
}
