import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
Checkpoint the active request, known history IDs, decisions, progress, learnings and next steps in notes before new_context; no summary carries over. After rollover, read hinted notes. Use history only for a missing detail.
</context_window_guidance>`;

export function renderContextWindowMessage(
	identity: ContextWindowIdentity,
	threadHint?: string,
): string {
	const lines = [
		"<context_window>",
		"Agent name: /root",
		`First context window id: ${identity.firstWindowId}`,
		`Current context window id: ${identity.currentWindowId}`,
	];
	if (identity.previousWindowId) lines.push(`Previous context window id: ${identity.previousWindowId}`);
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
