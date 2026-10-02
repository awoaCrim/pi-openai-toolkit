export const HISTORY_ACTIONS = [
	"list_windows",
	"list_items",
	"read_item",
	"search_contents",
] as const;

export const NOTES_ACTIONS = [
	"list_files_by_prefix",
	"read_file",
	"search_contents",
	"append_to_file",
	"write_file",
] as const;

/** Stable names shared by Toolkit registration and an external Pi launcher. */
export const CONTEXT_MANAGEMENT_TOOL_NAMES = [
	"new_context",
	"get_context_remaining",
	"history",
	"notes",
] as const;

export type HistoryAction = (typeof HISTORY_ACTIONS)[number];
export type NotesAction = (typeof NOTES_ACTIONS)[number];
export type ContextManagementToolName = (typeof CONTEXT_MANAGEMENT_TOOL_NAMES)[number];

export type ContextToolSelection = {
	/** Pi's explicit tool allowlist. Omitted means use Pi's default selection. */
	tools?: readonly string[];
	/** Pi's default suppression mode. Both values are explicit host policy. */
	noTools?: "all" | "builtin";
	/** Pi applies this denylist after the allowlist. */
	excludeTools?: readonly string[];
};

/**
 * Add Toolkit context tools to a host-provided allowlist without overriding an
 * explicit no-tools or exclude-tools decision. The launcher owns model eligibility;
 * this helper only owns the shared selection contract.
 */
export function ensureContextManagementToolsInAllowlist(
	selection: ContextToolSelection,
	eligible: boolean,
): string[] | undefined {
	if (!eligible || selection.noTools !== undefined || selection.tools === undefined) {
		return selection.tools === undefined ? undefined : [...selection.tools];
	}

	const excluded = new Set(selection.excludeTools ?? []);
	const names = [...selection.tools];
	for (const name of CONTEXT_MANAGEMENT_TOOL_NAMES) {
		if (!excluded.has(name) && !names.includes(name)) names.push(name);
	}
	return names;
}

export const HISTORY_DESCRIPTION =
	"Prior-window detail. Pass IDs unchanged. Search, never browse.";

export const NOTES_DESCRIPTION =
	"Cross-window checkpoints on virtual paths. Relative uses current agent; cross-agent uses <agent>/notes[/path].";
