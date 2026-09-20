import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
	CONTEXT_MANAGEMENT_PROTOCOL,
	CONTEXT_WINDOW_COMPACTION_STRATEGY,
	CONTEXT_WINDOW_FALLBACK_BUFFER,
	CONTEXT_WINDOW_REMINDER_THRESHOLD,
	type CodexContextManagementMessageDetails,
	type ContextManagementMessageKind,
	type ContextWindowCompactionDetails,
	type ContextWindowIdentity,
	type NotesCheckpointReceipt,
	isCodexContextManagementMessageDetails,
	isContextWindowCompactionDetails,
} from "./types";

export {
	CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
	CONTEXT_WINDOW_COMPACTION_STRATEGY,
	CONTEXT_WINDOW_FALLBACK_BUFFER,
	CONTEXT_WINDOW_REMINDER_THRESHOLD,
	isCodexContextManagementMessageDetails,
	isContextWindowCompactionDetails,
};
export type {
	CodexContextManagementMessageDetails,
	ContextManagementMessageKind,
	ContextWindowCompactionDetails,
	ContextWindowIdentity,
};

export const CONTEXT_WINDOW_COMPACTION_SUMMARY =
	"[Pi Codex context-window boundary; no conversation summary was generated.]";

const CONTEXT_WINDOW_GUIDANCE = `<context_window_guidance>
Before calling new_context, checkpoint the active request, known history IDs, decisions, progress, learnings and next steps in notes, and wait for that result to be persisted; only a persisted successful result in the current window unlocks the rollover. If new_context reports that a rollover is already scheduled, do not call it again in the same window. When this message includes a completed context-switch handoff, follow that post-rollover section first instead of restarting the pre-rollover checkpoint steps. A thread hint is supplemental and must not replace the local checkpoint receipt. No conversation summary carries over, and history is only for missing details.
</context_window_guidance>`;

export function renderContextWindowMessage(
	identity: ContextWindowIdentity,
	threadHint?: string,
	checkpoint?: NotesCheckpointReceipt,
): string {
	const lines = [
		"<context_window>",
		"Agent name: /root",
		`First context window id: ${identity.firstWindowId}`,
		`Current context window id: ${identity.currentWindowId}`,
	];
	if (identity.previousWindowId) lines.push(`Previous context window id: ${identity.previousWindowId}`);
	if (checkpoint) {
		lines.push("Context switch completed. This is the first turn in the new context window.");
		lines.push("Checkpoint successfully written:");
		lines.push(`  Read this note before doing anything else with notes action "read_file": ${JSON.stringify(checkpoint.path)}`);
		lines.push("After reading the checkpoint receipt, resume the active user task.");
		lines.push("Do not immediately create another checkpoint or call new_context as part of this handoff. Only prepare a new checkpoint when a later context rollover is actually needed.");
	}
	if (threadHint) lines.push(threadHint);
	lines.push("</context_window>");
	return `${CONTEXT_WINDOW_GUIDANCE}\n\n${lines.join("\n")}`;
}

export function renderContextWindowReminder(remainingTokens: number): string {
	return `<context_window_reminder>
Only ${Math.max(0, Math.floor(remainingTokens))} context tokens remain. Checkpoint the active request, state and known history IDs in notes, then call new_context; no conversation summary carries over.
</context_window_reminder>`;
}

export const CONTEXT_WINDOW_FALLBACK_MESSAGE = `<context_window_reminder>
Context exhausted. Do not continue or answer. Make exactly one notes write or append call that checkpoints the active request, state and known history IDs, then call new_context. Use no other tools before rollover.
</context_window_reminder>`;

export function isContextWindowBoundary(
	message: AgentMessage,
): message is Extract<AgentMessage, { role: "custom" }> & {
	details: CodexContextManagementMessageDetails;
} {
	return (
		message.role === "custom" &&
		message.customType === CODEX_CONTEXT_WINDOW_MESSAGE_TYPE &&
		isCodexContextManagementMessageDetails(message.details) &&
		message.details.contextManagement.kind === "window"
	);
}

export function sendContextWindowMessage(
	pi: ExtensionAPI,
	content: string,
	kind: ContextManagementMessageKind,
	identity: ContextWindowIdentity,
	options: { triggerTurn: boolean; sessionId?: string },
	trimPreviousWindow = false,
): void {
	const details: CodexContextManagementMessageDetails = {
		protocol: CONTEXT_MANAGEMENT_PROTOCOL,
		id: randomUUID(),
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		contextManagement: {
			protocol: CONTEXT_MANAGEMENT_PROTOCOL,
			kind,
			...identity,
			...(trimPreviousWindow ? { trimPreviousWindow: true as const } : {}),
		},
	};
	pi.sendMessage({
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
		content,
		display: true,
		details,
	}, options.triggerTurn
		? { deliverAs: "steer", triggerTurn: true }
		: { triggerTurn: false });
}

/** Whether a transcript message is a Pi system message (prompt sections and tool deltas). */
export function isSystemTranscriptMessage(message: AgentMessage): boolean {
	return (message as unknown as { role?: string }).role === "system";
}

/** Tool names the provider would send for this message list, after replaying every delta. */
export function declaredToolNames(messages: readonly AgentMessage[]): string[] {
	return getCurrentTools(messages).map((tool) => tool.name);
}

export type SystemHeadRepair<TMessage extends AgentMessage = AgentMessage> = {
	/** The window to send: trimmed, trimmed plus a rebuilt head, or untrimmed when the trim is unsafe. */
	readonly messages: readonly TMessage[];
	/** A head from before the boundary was re-anchored at the front of the window. */
	repaired: boolean;
	/** The trim was refused because the window would lose declared tools. */
	shrinkRejected: boolean;
	/** Tool names the trimmed window would have lost; empty on every safe path. */
	lostToolNames: string[];
	/** The system message this window anchors on, when one could be determined. */
	head: AgentMessage | undefined;
};

/**
 * Keep Pi 0.86's prompt and tool head alive across a context-window trim.
 *
 * Pi 0.86 no longer sends the system prompt and the tool loadout beside the
 * transcript: `Agent#createContextSnapshot()` hands over messages only, and the
 * Responses transport rebuilds `params.tools` from the `system` messages inside the
 * message list (`resolveTranscriptTools(getInitialSystemMessage(messages))`). Trimming
 * everything before a window boundary therefore deletes the one message that declares
 * every tool, and Pi does not re-declare it because the persisted transcript still looks
 * unchanged. The result is a window the model can only answer from memory.
 *
 * The merged state of the trimmed-away system messages is re-anchored as the leading
 * message of the window. When even that would lose declared tools, the trim is refused:
 * a window that still carries the previous turns beats a window with no tools at all.
 */
export function preserveSystemHead<TMessage extends AgentMessage>(args: {
	readonly messages: readonly TMessage[];
	boundaryIndex: number;
	/**
	 * Head observed in an earlier projection. A durable compaction can drop the original
	 * declaration from the branch, leaving nothing to rebuild from, so the last known head
	 * is re-anchored instead of sending a window with no tools.
	 */
	fallbackHead?: AgentMessage;
}): SystemHeadRepair<TMessage> {
	const { messages, boundaryIndex, fallbackHead } = args;
	const window = messages.slice(Math.max(boundaryIndex, 0));
	const prefix = messages.slice(0, Math.max(boundaryIndex, 0));

	const anchorFallback = (): SystemHeadRepair<TMessage> | undefined => {
		if (!fallbackHead || messages.some(isSystemTranscriptMessage)) return undefined;
		// A boundary compaction can retire the entry that declared the tools, leaving a
		// branch whose only system state is gone. Nothing in the list can be rebuilt, so
		// the head remembered from an earlier projection is re-anchored instead.
		const reused: readonly TMessage[] = [
			fallbackHead as unknown as TMessage,
			...window.filter((message) => !isSystemTranscriptMessage(message)),
		];
		return { messages: reused, repaired: true, shrinkRejected: false, lostToolNames: [], head: fallbackHead };
	};

	if (boundaryIndex <= 0 || prefix.length === 0) {
		return anchorFallback() ?? {
			messages: window,
			repaired: false,
			shrinkRejected: false,
			lostToolNames: [],
			head: getCurrentSystemMessage(messages) ?? fallbackHead,
		};
	}

	const declared = declaredToolNames(messages);
	const completeHead = getCurrentSystemMessage(messages);
	if (!completeHead) {
		const reused = anchorFallback();
		if (reused) return reused;
		if (!messages.some(isSystemTranscriptMessage) && declared.length === 0) {
			// Pre-0.86 transcripts carry no system messages: the trim stays exactly as before.
			return { messages: window, repaired: false, shrinkRejected: false, lostToolNames: [], head: undefined };
		}
		return { messages, repaired: false, shrinkRejected: true, lostToolNames: declared, head: undefined };
	}

	const windowFirst = window[0];
	if (windowFirst && isSystemTranscriptMessage(windowFirst)) {
		const kept = new Set(declaredToolNames(window));
		const lostFromWindow = declared.filter((name) => !kept.has(name));
		if (lostFromWindow.length === 0) {
			return {
				messages: window,
				repaired: false,
				shrinkRejected: false,
				lostToolNames: [],
				head: windowFirst as unknown as AgentMessage,
			};
		}
		return {
			messages,
			repaired: false,
			shrinkRejected: true,
			lostToolNames: lostFromWindow,
			head: windowFirst as unknown as AgentMessage,
		};
	}

	// Later system messages are folded into the rebuilt head, so a patch cannot be read
	// as a complete declaration by a transport that only anchors the first one.
	const rebuilt: readonly TMessage[] = [
		completeHead as unknown as TMessage,
		...window.filter((message) => !isSystemTranscriptMessage(message)),
	];
	const after = new Set(declaredToolNames(rebuilt));
	const lostToolNames = declared.filter((name) => !after.has(name));
	if (lostToolNames.length > 0) {
		return { messages, repaired: false, shrinkRejected: true, lostToolNames, head: completeHead };
	}
	return { messages: rebuilt, repaired: true, shrinkRejected: false, lostToolNames: [], head: completeHead };
}
