/** Reserved persisted identifiers, retained only to refuse retired sessions. */
export const RETIRED_REMOTE_WINDOW_TYPE = "codex-context-window" as const;
export const RETIRED_MANUAL_COMPACT_TYPE = "pi-openai-toolkit:manual-compact" as const;
export const RETIRED_REMOTE_WINDOW_SUMMARY =
	"[Pi Codex context-window boundary; no conversation summary was generated.]";

export type RetiredRemoteWindowsReason =
	| "window-message"
	| "window-compaction"
	| "window-summary"
	| "manual-compact-record";

export const RETIRED_REMOTE_WINDOWS_MESSAGE =
	"Remote Windows has been removed. This branch contains retired window or manual-compaction records and cannot continue. Start a new session and explicitly choose the model you want to use. Existing history is unchanged; no model or thinking level was restored.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Inspect only the supplied active branch. Reserved identifiers suffice even
 * when their data is damaged, terminal or superseded by a newer checkpoint.
 * This deliberately interprets no ownership, recovery or migration state.
 */
export function detectRetiredRemoteWindows(entries: readonly unknown[]): RetiredRemoteWindowsReason | undefined {
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (entry.type === "custom_message" && entry.customType === RETIRED_REMOTE_WINDOW_TYPE) return "window-message";
		if (entry.type === "custom" && entry.customType === RETIRED_MANUAL_COMPACT_TYPE) return "manual-compact-record";
		if (entry.type !== "compaction") continue;
		if (isRecord(entry.details) && entry.details.strategy === RETIRED_REMOTE_WINDOW_TYPE) return "window-compaction";
		if (entry.summary === RETIRED_REMOTE_WINDOW_SUMMARY) return "window-summary";
	}
	return undefined;
}
