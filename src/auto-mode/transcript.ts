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
			const summary = boundReviewText(entry.summary, MAX_TRANSCRIPT_ENTRY_CHARS);
			if (summary) lines.push({ role: "assistant", text: `[earlier conversation summary] ${summary}` });
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

function renderLine(index: number, line: TranscriptLine): string {
	const body = boundReviewText(line.text, MAX_TRANSCRIPT_ENTRY_CHARS);
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
	const maxTotalChars = budgets.maxTotalChars ?? MAX_TRANSCRIPT_CHARS;
	const maxToolChars = budgets.maxToolChars ?? MAX_TRANSCRIPT_TOOL_CHARS;
	const maxRecentEntries = budgets.maxRecentEntries ?? MAX_TRANSCRIPT_RECENT_ENTRIES;

	const recent = lines.slice(-Math.max(1, maxRecentEntries));
	const omitted = recent.length < lines.length;

	const userLines: number[] = [];
	const otherLines: number[] = [];
	recent.forEach((line, index) => {
		if (line.role === "user") userLines.push(index);
		else otherLines.push(index);
	});

	const selected = new Set<number>();
	let userChars = 0;
	// The first user turn carries the task; the latest carries the immediate ask.
	for (const index of [userLines[0]!, userLines[userLines.length - 1]!, ...userLines.slice(1, -1).reverse()]) {
		if (index === undefined || selected.has(index)) continue;
		const cost = recent[index]!.text.length;
		if (userChars + cost > maxTotalChars) break;
		selected.add(index);
		userChars += cost;
	}

	let toolChars = 0;
	for (const index of [...otherLines].reverse()) {
		const cost = recent[index]!.text.length;
		if (toolChars + cost > maxToolChars) continue;
		if (userChars + toolChars + cost > maxTotalChars) continue;
		selected.add(index);
		toolChars += cost;
	}

	const ordered = [...selected].sort((a, b) => a - b);
	const rendered = ordered.map((index) => renderLine(index + 1, recent[index]!));
	if (omitted) rendered.unshift(`${TRUNCATION_MARKER} earlier conversation entries were omitted.`);
	return { text: rendered.join("\n"), omitted };
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
