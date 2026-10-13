export const CODEX_FAST_ENTRY_TYPE = "pi-openai-toolkit:codex-fast";

export type CodexFastState = {
	version: 1;
	sessionId: string;
	enabled: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Session metadata, not model input. Foreign fork/copy entries never apply. */
export function readCodexFastState(entries: readonly unknown[], sessionId: string | undefined): boolean {
	if (!sessionId) return false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CODEX_FAST_ENTRY_TYPE) continue;
		const data = entry.data;
		// A malformed latest preference must not resurrect an older ON.
		if (!isRecord(data) || data.version !== 1 || typeof data.sessionId !== "string" || typeof data.enabled !== "boolean") return false;
		if (data.sessionId === sessionId) return data.enabled;
	}
	return false;
}
