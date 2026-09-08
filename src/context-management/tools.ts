import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { executeHistoryNotesTool, type CodexHistoryNotesDetails } from "./history-notes";
import { type CodexContextWindowManager } from "./window-manager";
import {
	HISTORY_ACTION_FIELDS,
	HISTORY_ENDPOINTS,
	NOTES_ACTION_FIELDS,
	NOTES_ENDPOINTS,
} from "./history-notes";
import type { HistoryAction, NotesAction } from "./types";

const EMPTY_PARAMETERS = Type.Object({}, { additionalProperties: false });

function arrayEquals(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
const HISTORY_ACTIONS = Object.keys(HISTORY_ENDPOINTS) as [HistoryAction, ...HistoryAction[]];
const NOTES_ACTIONS = Object.keys(NOTES_ENDPOINTS) as [NotesAction, ...NotesAction[]];

export const HISTORY_PARAMETERS = Type.Object({
	action: StringEnum(HISTORY_ACTIONS),
	agent_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	item_id: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	limit_chars: Type.Optional(Type.Integer({ minimum: 1 })),
	max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1 })),
	offset_chars: Type.Optional(Type.Integer({ minimum: 0 })),
	query: Type.Optional(Type.String()),
	recent_first: Type.Optional(Type.Boolean()),
	role: Type.Optional(Type.Union([StringEnum(["user", "assistant", "tool", "system", "developer"] as const), Type.Null()])),
	tool_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	tool_namespace: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	window_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { additionalProperties: false });

export const NOTES_PARAMETERS = Type.Object({
	action: StringEnum(NOTES_ACTIONS),
	file_order: Type.Optional(StringEnum(["ascending", "descending"] as const)),
	file_order_by: Type.Optional(StringEnum(["name", "created_at", "updated_at"] as const)),
	max_files: Type.Optional(Type.Integer({ minimum: 1 })),
	max_matches_per_file: Type.Optional(Type.Integer({ minimum: 1 })),
	max_results: Type.Optional(Type.Integer({ minimum: 1 })),
	path: Type.Optional(Type.String()),
	path_prefix: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	prefix: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	query: Type.Optional(Type.String()),
	recent_file_first: Type.Optional(Type.Boolean()),
	start_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
	stop_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
	text: Type.Optional(Type.String()),
}, { additionalProperties: false });

export interface NewContextDetails { started: boolean; }

export const NEW_CONTEXT_PARAMETERS = Type.Object({
	force: Type.Optional(Type.Boolean({
	description: "Roll over even without a successful notes checkpoint in this window. Discards unsaved working state.",
})),
}, { additionalProperties: false });

export const NEW_CONTEXT_CHECKPOINT_REQUIRED_MESSAGE =
	"new_context refused: no successful notes checkpoint in this window. "
	+ "Save the active request, decisions, progress and next steps with notes append_to_file or write_file, then retry. "
	+ "Pass force=true only when the user explicitly accepts losing unsaved working state.";
export interface ContextRemainingDetails {
	remainingTokens?: number;
	windowId?: string;
	contextWindow: number;
}

export type ContextManagementTools = {
	newContext: ToolDefinition<typeof NEW_CONTEXT_PARAMETERS, NewContextDetails>;
	getContextRemaining: ToolDefinition<typeof EMPTY_PARAMETERS, ContextRemainingDetails>;
	history: ToolDefinition<typeof HISTORY_PARAMETERS, CodexHistoryNotesDetails>;
	notes: ToolDefinition<typeof NOTES_PARAMETERS, CodexHistoryNotesDetails>;
};

export function createContextManagementTools(
	pi: ExtensionAPI,
	manager: CodexContextWindowManager,
	isActive: (ctx: ExtensionContext) => Promise<boolean> | boolean,
	gatewayAllowlist: readonly string[] | (() => readonly string[]) = [],
): ContextManagementTools {
	const getGatewayAllowlist = (): readonly string[] =>
		typeof gatewayAllowlist === "function" ? gatewayAllowlist() : gatewayAllowlist;
	const assertActive = async (ctx: ExtensionContext): Promise<void> => {
		if (!(await isActive(ctx))) throw new Error("remote-context-inactive");
	};
	const newContext: ToolDefinition<typeof NEW_CONTEXT_PARAMETERS, NewContextDetails> = {
		name: "new_context",
		label: "new_context",
		description: "Start a new remote Codex context window without generating a conversation summary. Requires a successful notes checkpoint in the current window unless force is set.",
		parameters: NEW_CONTEXT_PARAMETERS,
		promptSnippet: "Start a new remote Codex context window without summarizing history.",
		promptGuidelines: ["Checkpoint active work in notes before calling new_context; no conversation summary carries over. A successful notes append/write in this window is required unless the user explicitly accepts discarding unsaved state (force=true)."],
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			await assertActive(ctx);
			if (!params.force && !manager.hasNotesCheckpointSinceBoundary(ctx)) {
				throw new Error(NEW_CONTEXT_CHECKPOINT_REQUIRED_MESSAGE);
			}
			const started = await manager.startNewWindow(pi, ctx, {
				triggerTurn: true,
				signal,
				trimPreviousWindow: true,
			});
			return {
				content: [{ type: "text", text: started ? "A new context window will start without summarizing conversation history." : "A new context window is already scheduled." }],
				details: { started },
			};
		},
	};
	const getContextRemaining: ToolDefinition<typeof EMPTY_PARAMETERS, ContextRemainingDetails> = {
		name: "get_context_remaining",
		label: "get_context_remaining",
		description: "Get the remaining tokens in the current remote Codex context window.",
		parameters: EMPTY_PARAMETERS,
		async execute(_id, _params, _signal, _update, ctx) {
			await assertActive(ctx);
			const remaining = manager.remaining(ctx);
			return {
				content: [{ type: "text", text: remaining.remainingTokens === undefined ? "You have unknown tokens left in this context window." : `You have ${remaining.remainingTokens} tokens left in this context window.` }],
				details: remaining,
			};
		},
	};
	const history: ToolDefinition<typeof HISTORY_PARAMETERS, CodexHistoryNotesDetails> = {
		name: "history",
		label: "history",
		description: "Search or read prior remote Codex context-window history. Pass IDs unchanged.",
		parameters: HISTORY_PARAMETERS,
		promptSnippet: "Search or read prior remote Codex context-window history.",
		promptGuidelines: [
			"When the user asks about decisions, code, or details from earlier in the conversation that are no longer in the current context window, use history first instead of relying on fragments that survived compaction.",
			"Use read_item with the exact item_id returned by list_items or search_contents; never rewrite, truncate, or guess IDs.",
			"Before starting a new context window, use history to verify which earlier work the user still expects to be honored, then checkpoint anything not yet durable in notes.",
			"Prefer search_contents over list_items when you only need a known fact; list_items is for getting an overview of what windows and items exist.",
			"History is read-only; make no edits through it. Edits and durable checkpoints belong to notes.",
		],
		execute: async (_id, params, _signal, _update, ctx) => {
			await assertActive(ctx);
			return executeHistoryNotesTool("history", params.action, params as Record<string, unknown>, ctx, _signal, getGatewayAllowlist());
		},
	};
	const notes: ToolDefinition<typeof NOTES_PARAMETERS, CodexHistoryNotesDetails> = {
		name: "notes",
		label: "notes",
		description: "Read and checkpoint remote Codex notes across context windows.",
		parameters: NOTES_PARAMETERS,
		promptSnippet: "Read and checkpoint remote Codex notes across context windows.",
		promptGuidelines: [
			"Before calling new_context, checkpoint the current turn's active work (unfinished tasks, decisions, open questions, references) into notes with append_to_file or write_file so it survives the window change.",
			"When a large task spans multiple context windows, keep a running note per line of work and read it at the start of each new window; append new state instead of replacing it unless the note is stale.",
			"Prefer read_file or search_contents for looking things up; reserve write_file for explicit rewrite/clear and append_to_file for incremental state.",
			"Keep note text concise and self-contained: it may be read later without the rest of the conversation, so include identifiers and verbatim key decisions, not hearsay summaries.",
			"Do not store live credentials, API keys, or full request bodies in notes; record the fact and where it lives instead.",
		],
		executionMode: "sequential",
		execute: async (_id, params, _signal, _update, ctx) => {
			await assertActive(ctx);
			return executeHistoryNotesTool("notes", params.action, params as Record<string, unknown>, ctx, _signal, getGatewayAllowlist());
		},
	};
	return { newContext, getContextRemaining, history, notes };
}

export class ContextManagementToolController {
	private readonly registeredNames = new Set<string>();
	private readonly definitions = new Map<string, {
		description: string;
		parameters: unknown;
		promptGuidelines?: string[];
	}>();
	private readonly ownedNames = new Set<string>();
	private readonly baselineNames = new Set<string>();
	private registered = false;
	private registrationChecked = false;
	private registrationValid = false;
	private baselineCaptured = false;

	constructor(private readonly pi: ExtensionAPI) {}

	register(tools: ContextManagementTools): boolean {
		const definitions = [tools.newContext, tools.getContextRemaining, tools.history, tools.notes];
		const api = this.pi as ExtensionAPI & { registerTool?: (tool: unknown) => void };
		if (typeof api.registerTool !== "function") return false;

		// registerTool() is a registration method and is valid while Pi is loading
		// the extension. Do not call action methods such as getAllTools() here;
		// those are bound only after extension loading completes.
		try {
			for (const definition of definitions) api.registerTool(definition);
		} catch {
			return false;
		}

		this.registeredNames.clear();
		this.definitions.clear();
		for (const definition of definitions) {
			this.registeredNames.add(definition.name);
			this.definitions.set(definition.name, {
				description: definition.description,
				parameters: definition.parameters,
				promptGuidelines: definition.promptGuidelines,
			});
		}
		this.registered = true;
		this.registrationChecked = false;
		this.registrationValid = false;
		return true;
	}

	private verifyRegistration(): boolean {
		if (!this.registered) return false;
		if (this.registrationChecked) return this.registrationValid;
		this.registrationChecked = true;
		try {
			const api = this.pi as ExtensionAPI & { getAllTools?: () => Array<{
				name: string;
				description: string;
				parameters: unknown;
				promptGuidelines?: string[];
			}> };
			if (typeof api.getAllTools !== "function") return false;
			const available = new Map(api.getAllTools().map((tool) => [tool.name, tool]));
			this.registrationValid = [...this.registeredNames].every((name) => {
				const actual = available.get(name);
				const expected = this.definitions.get(name);
				return actual !== undefined && expected !== undefined &&
					actual.description === expected.description &&
					actual.parameters === expected.parameters &&
					actual.promptGuidelines === expected.promptGuidelines;
			});
		} catch {
			this.registrationValid = false;
		}
		if (!this.registrationValid) this.ownedNames.clear();
		return this.registrationValid;
	}

	private captureBaseline(): boolean {
		if (this.baselineCaptured) return true;
		try {
			const api = this.pi as ExtensionAPI & { getActiveTools?: () => string[] };
			if (typeof api.getActiveTools !== "function") return false;
			this.baselineNames.clear();
			for (const name of api.getActiveTools()) this.baselineNames.add(name);
			this.baselineCaptured = true;
			return true;
		} catch {
			return false;
		}
	}

	sync(active: boolean): boolean {
		if (!this.verifyRegistration() || !this.captureBaseline()) return false;
		const api = this.pi as ExtensionAPI & { getActiveTools?: () => string[]; setActiveTools?: (names: string[]) => void };
		if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return false;
		try {
			const current = api.getActiveTools();
			if (active) {
				const next = [...current];
				for (const name of this.registeredNames) {
					if (!next.includes(name) && !this.baselineNames.has(name)) {
						next.push(name);
						this.ownedNames.add(name);
					}
				}
				if (next.length !== current.length) api.setActiveTools(next);
				return true;
			}
			const next = current.filter((name) => !this.ownedNames.has(name));
			if (next.length !== current.length) api.setActiveTools(next);
			this.ownedNames.clear();
			return true;
		} catch {
			return false;
		}
	}

	reset(): void {
		this.sync(false);
		this.baselineNames.clear();
		this.baselineCaptured = false;
	}
	get isRegistered(): boolean { return this.registrationValid; }
}

export function registerContextManagementTools(
	pi: ExtensionAPI,
	manager: CodexContextWindowManager,
	isActive: (ctx: ExtensionContext) => Promise<boolean> | boolean,
	gatewayAllowlist: readonly string[] | (() => readonly string[]) = [],
): ContextManagementToolController {
	const controller = new ContextManagementToolController(pi);
	controller.register(createContextManagementTools(pi, manager, isActive, gatewayAllowlist));
	return controller;
}

export const _contextToolsTest = {
	EMPTY_PARAMETERS,
	NEW_CONTEXT_PARAMETERS,
	HISTORY_PARAMETERS,
	NOTES_PARAMETERS,
	HISTORY_ACTION_FIELDS,
	NOTES_ACTION_FIELDS,
};
