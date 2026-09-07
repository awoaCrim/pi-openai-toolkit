import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_WINDOW_FALLBACK_BUFFER,
	CONTEXT_WINDOW_FALLBACK_MESSAGE,
	renderContextWindowReminder,
	type ContextManagementMessageKind,
	type ContextWindowIdentity,
} from "./messages";

export interface ContextRemaining {
	remainingTokens: number | undefined;
	windowId: string | undefined;
	contextWindow: number;
}

export class ContextWindowBudget {
	private readonly remindedWindows = new Set<string>();
	private readonly exhaustedWindows = new Set<string>();

	reset(): void {
		this.remindedWindows.clear();
		this.exhaustedWindows.clear();
	}

	restore(kind: ContextManagementMessageKind, windowId: string): void {
		if (kind === "reminder") this.remindedWindows.add(windowId);
		if (kind === "fallback") this.exhaustedWindows.add(windowId);
	}

	record(
		ctx: ExtensionContext,
		identity: ContextWindowIdentity,
		contextTokens: number | undefined,
		contextReminderThresholdPercent: number,
	): { content: string; kind: "fallback" | "reminder" } | undefined {
		const remaining = this.remaining(ctx, identity, contextTokens);
		if (remaining.remainingTokens === undefined) return undefined;
		const windowId = identity.currentWindowId;
		if (remaining.remainingTokens <= 0 && !this.exhaustedWindows.has(windowId)) {
			this.exhaustedWindows.add(windowId);
			return { content: CONTEXT_WINDOW_FALLBACK_MESSAGE, kind: "fallback" };
		}
		const reminderThreshold =
			contextReminderThresholdPercent > 0
				? Math.floor((remaining.contextWindow * contextReminderThresholdPercent) / 100)
				: 0;
		if (
			contextReminderThresholdPercent > 0 &&
			remaining.remainingTokens <= reminderThreshold &&
			!this.remindedWindows.has(windowId)
		) {
			this.remindedWindows.add(windowId);
			return { content: renderContextWindowReminder(remaining.remainingTokens), kind: "reminder" };
		}
		return undefined;
	}

	remaining(
		ctx: ExtensionContext,
		identity: ContextWindowIdentity | undefined,
		contextTokens?: number,
	): ContextRemaining {
		const usage = ctx.getContextUsage();
		const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const limit = Math.max(0, contextWindow - CONTEXT_WINDOW_FALLBACK_BUFFER);
		if (usage === undefined && contextTokens === undefined) {
			return {
				remainingTokens: undefined,
				windowId: identity?.currentWindowId,
				contextWindow: limit,
			};
		}
		const used = contextTokens ?? usage?.tokens;
		return {
			remainingTokens:
				used === null || used === undefined
					? undefined
					: Math.max(0, limit - used),
			windowId: identity?.currentWindowId,
			contextWindow: limit,
		};
	}
}
