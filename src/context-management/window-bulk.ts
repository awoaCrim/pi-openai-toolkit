import {
	buildSessionContext,
	estimateTokens,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { LeaveManagedModePolicy } from "../types";
import { isContextWindowBoundary } from "./messages";

/**
 * Share of the target model's context window above which a projection is considered
 * over budget. Estimates are conservative (`estimateTokens` is chars/4 and overestimates),
 * so the trigger fires slightly early rather than after a hard provider failure.
 */
export const BULK_CLIFF_RATIO = 0.8;

/** How much larger the durable view must be than the windowed view to call it a cliff. */
export const BULK_EXPANSION_RATIO = 2;

export type WindowBulkReport = {
	/** The window the durable view is measured against; a notice is surfaced once per window and model. */
	readonly windowId: string | undefined;
	/** Tokens an uncovered model would receive: the whole branch, markers filtered. */
	readonly unmanagedTokens: number;
	/** Tokens a covered model receives: the current window only. */
	readonly managedTokens: number;
	readonly targetContextWindow: number;
	/** The durable view exceeds `BULK_CLIFF_RATIO` of the model that would receive it. */
	readonly overBudget: boolean;
	/** The durable view is at least `BULK_EXPANSION_RATIO` times the windowed view. */
	readonly expanded: boolean;
};

/** What the runtime should do about a measured cliff. */
export type BulkCliffAction = "ignore" | "warn" | "compact";

/**
 * `warn` is the default because an automatic compaction costs a real model call. `compact`
 * only acts when the durable transcript is also past the target window: a session that is
 * merely bigger than its windowed view still fits, and compacting it would be pure loss.
 */
export function decideBulkCliffAction(
	report: WindowBulkReport,
	policy: LeaveManagedModePolicy,
): BulkCliffAction {
	if (!report.expanded) return "ignore";
	if (policy === "compact" && report.overBudget) return "compact";
	return "warn";
}

export type BulkCloseOutContext = {
	/** What the policy decided for this report. */
	action: BulkCliffAction;
	/** Pi's run mode: print sessions exit with the turn, so they cannot await a compaction. */
	mode: string;
	/** When the measurement happened. */
	trigger: "model-switch" | "turn-end";
	/** Whether a rollover trim is queued for the next eligible compaction. */
	hasPendingTrim: boolean;
};

/**
 * Turn a decided action into one that is safe to execute here.
 *
 * `ExtensionContext.compact()` is fire-and-forget and aborts the running turn. In print mode
 * the process exits with the turn, so the summary would be killed mid-request; a turn-end
 * close-out on a covered model is also pointless unless a rollover trim is queued, because
 * the window policy cancels any other compaction. Both cases degrade to the warning.
 */
export function decideBulkCloseOut(context: BulkCloseOutContext): BulkCliffAction {
	if (context.action !== "compact") return context.action;
	if (context.mode === "print") return "warn";
	if (context.trigger === "turn-end" && !context.hasPendingTrim) return "warn";
	return "compact";
}

function sumTokens(messages: readonly AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) tokens += estimateTokens(message as never);
	return tokens;
}

/**
 * Measure the gap between the durable transcript and the remote window view.
 *
 * Remote context management retires previous windows *in the request projection*; the
 * session branch keeps them, and a boundary compaction only lands when a compaction
 * attempt consumes the scheduled trim. That asymmetry is invisible while a covered model
 * runs and becomes a cliff the moment the session talks to a model without remote context:
 * a window that streamed 25k tokens per request can hand over 400k tokens of history that
 * no model has ever been shown, blowing past the new window and making the first manual
 * `/compact` summarize the whole pile.
 *
 * Returns `undefined` when nothing has been retired yet, so young sessions and plain
 * Pi transcripts never see a report.
 */
export function measureWindowBulk(args: {
	readonly messages: readonly AgentMessage[];
	contextWindow: number | undefined;
}): WindowBulkReport | undefined {
	const { messages, contextWindow } = args;
	let boundaryIndex = -1;
	for (let index = 0; index < messages.length; index += 1) {
		if (isContextWindowBoundary(messages[index]!)) boundaryIndex = index;
	}
	if (boundaryIndex < 1) return undefined;

	const boundaryMessage = messages[boundaryIndex]!;
	const windowId = isContextWindowBoundary(boundaryMessage)
		? boundaryMessage.details.contextManagement.currentWindowId
		: undefined;
	const window = messages.slice(boundaryIndex);
	const managedTokens = sumTokens(window);
	const unmanagedTokens = managedTokens + sumTokens(
		messages
			.slice(0, boundaryIndex)
			.filter((message) => !isContextWindowBoundary(message)),
	);
	const targetContextWindow = typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 0;
	return {
		windowId,
		unmanagedTokens,
		managedTokens,
		targetContextWindow,
		overBudget: targetContextWindow > 0 && unmanagedTokens > targetContextWindow * BULK_CLIFF_RATIO,
		expanded: unmanagedTokens > managedTokens * BULK_EXPANSION_RATIO,
	};
}

/**
 * The provider-visible message list for the current branch: Pi's compaction-anchored
 * context, exactly as an uncovered model would receive it before the toolkit trims.
 */
export function durableContextMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	return buildSessionContext(entries as never[]).messages as unknown as AgentMessage[];
}

/**
 * Measure the current branch for a bulk cliff. Returns `undefined` when the session has
 * no window state, cannot report a target window, or has retired nothing.
 */
export function evaluateWindowBulk(ctx: Pick<ExtensionContext, "sessionManager" | "model">): WindowBulkReport | undefined {
	const contextWindow = ctx.model?.contextWindow;
	if (typeof contextWindow !== "number" || contextWindow <= 0) return undefined;
	const messages = durableContextMessages(ctx.sessionManager.getBranch() as never[]);
	if (!messages.some(isContextWindowBoundary)) return undefined;
	return measureWindowBulk({ messages, contextWindow });
}
