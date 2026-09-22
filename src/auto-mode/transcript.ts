import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	boundReviewText,
	MAX_TRANSCRIPT_CHARS,
	MAX_TRANSCRIPT_ENTRY_CHARS,
	MAX_TRANSCRIPT_RECENT_ENTRIES,
	MAX_TRANSCRIPT_TOOL_CHARS,
	TRUNCATION_MARKER,
} from "./types";

/**
 * A transcript line already reduced to text, with the role kept so the reviewer can
 * tell whose words these are. `[user]` is the only role that carries authorization.
 */
export type TranscriptLine = {
	role: "user" | "assistant" | "tool";
	text: string;
};

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const record = block as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") return record.text;
			if (record.type === "image") return "[image omitted]";
			if (record.type === "toolCall" && typeof record.name === "string") {
				const args = record.arguments;
				return `${record.name} ${typeof args === "object" && args ? JSON.stringify(args) : ""}`.trim();
			}
			return "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

/**
 * Flatten session entries into reviewer lines. Non-message entries are skipped,
 * except a compaction summary, which is kept as a `[user]`-adjacent context marker
 * because it is the only surviving view of the older conversation.
 */
export function sessionEntriesToLines(entries: readonly SessionEntry[]): TranscriptLine[] {
	const lines: TranscriptLine[] = [];
	for (const entry of entries) {
		if (entry.type === "compaction" && typeof entry.summary === "string") {
			// Defer bounding until selection so the transcript reports truncation.
			if (entry.summary) lines.push({ role: "assistant", text: `[earlier conversation summary] ${entry.summary}` });
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; content?: unknown };
		const text = textOfContent(message.content);
		if (!text) continue;
		if (message.role === "user") lines.push({ role: "user", text });
		else if (message.role === "assistant") lines.push({ role: "assistant", text });
		else if (message.role === "toolResult") lines.push({ role: "tool", text });
	}
	return lines;
}

function renderLine(index: number, line: TranscriptLine, maxChars = MAX_TRANSCRIPT_ENTRY_CHARS): string {
	const body = boundReviewText(line.text, maxChars);
	return `[${index}] [${line.role}]: ${body}`;
}

/**
 * Build a bounded transcript the way Codex's guardian does: user turns are the
 * anchors and are protected, tool and assistant evidence gets its own smaller
 * budget so verbose command output cannot crowd out the human conversation that
 * actually establishes authorization.
 *
 * Selection order is newest-first, then rendered in chronological order.
 */
export function buildReviewTranscript(
	lines: readonly TranscriptLine[],
	budgets: {
		maxTotalChars?: number;
		maxToolChars?: number;
		maxRecentEntries?: number;
	} = {},
): { text: string; omitted: boolean } {
	const maxTotalChars = Math.max(0, budgets.maxTotalChars ?? MAX_TRANSCRIPT_CHARS);
	const maxToolChars = Math.max(0, budgets.maxToolChars ?? MAX_TRANSCRIPT_TOOL_CHARS);
	const maxRecentEntries = budgets.maxRecentEntries ?? MAX_TRANSCRIPT_RECENT_ENTRIES;
	const recent = lines.slice(-Math.max(1, maxRecentEntries));
	const notice = `${TRUNCATION_MARKER} conversation content was omitted or truncated.`;

	function select(budget: number): { text: string; omitted: boolean } {
		const selected = new Map<number, string>();
		let totalChars = 0;
		let toolChars = 0;
		let omitted = recent.length < lines.length;
		// Authorization gets the first claim on space, newest instructions first.
		const indices = recent.map((_, index) => index).reverse();
		for (const index of [...indices.filter((i) => recent[i]!.role === "user"), ...indices.filter((i) => recent[i]!.role !== "user")]) {
			const line = recent[index]!;
			const separator = selected.size > 0 ? 1 : 0;
			const available = Math.min(budget - totalChars, line.role === "user" ? Infinity : maxToolChars - toolChars) - separator;
			const prefix = `[${index + 1}] [${line.role}]: `;
			if (available <= prefix.length + 3) {
				omitted = true;
				continue;
			}
			const rendered = renderLine(index + 1, line, Math.min(MAX_TRANSCRIPT_ENTRY_CHARS, available - prefix.length));
			if (rendered.slice(prefix.length) !== line.text) omitted = true;
			selected.set(index, rendered);
			const cost = rendered.length + separator;
			totalChars += cost;
			if (line.role !== "user") toolChars += cost;
		}
		return {
			text: [...selected].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n"),
			omitted,
		};
	}

	const initial = select(maxTotalChars);
	if (!initial.omitted) return initial;
	if (maxTotalChars <= notice.length) return { text: notice.slice(0, maxTotalChars), omitted: true };
	const bounded = select(maxTotalChars - notice.length - 1);
	return { text: bounded.text ? `${notice}\n${bounded.text}` : notice, omitted: true };
}

/**
 * Build the reviewer transcript straight from session entries.
 */
export function transcriptFromEntries(
	entries: readonly SessionEntry[],
	budgets?: Parameters<typeof buildReviewTranscript>[1],
): { text: string; omitted: boolean } {
	return buildReviewTranscript(sessionEntriesToLines(entries), budgets);
}
