import { createHash } from "node:crypto";

/**
 * Stable request-level reasoning effort via `configuration_update` input items
 * (GPT-6 Astra), ported from Oh My Pi (`@oh-my-pi/pi-ai`, MIT licensed,
 * Copyright (c) 2025-2026 Can Bölük / Stencil Labs) to an extension-side
 * payload rewrite.
 *
 * The request-level `reasoning.effort` is pinned to the value of the session's
 * first request so the cached prompt prefix survives an effort change. Each
 * later change is carried as a `configuration_update` item inserted at the
 * tail of the transcript — before the user message it takes effect on, or
 * after the latest tool result when the level changes inside a tool loop — and
 * replayed at that position on every subsequent request until another update
 * overrides it.
 *
 * Wire constraints (verified upstream against the Codex backend): only
 * `gpt-6-astra` accepts the item type, consecutive updates are rejected, and
 * `/responses/compact` rejects histories containing them — compaction
 * requests are built outside this planner and never carry the items.
 */

/** `configuration_update` input item; only `reasoning.effort` is updatable. */
export type ConfigurationUpdateItem = {
	type: "configuration_update";
	reasoning: { effort: string };
};

export type PlannableInputItem = {
	type?: string | null;
	role?: string;
	id?: string | null;
	status?: string | null;
	[key: string]: unknown;
};

type EffortTransition = {
	/** Input-array position the item is spliced into (before `input[index]`). */
	index: number;
	/** Fingerprint of `input[index - 1]` at record time; a mismatch means the history was rewritten. */
	anchor: string;
	effort: string;
};

/** Per-conversation effort baseline and recorded transitions. */
export type EffortControlState = {
	baseEffort?: string;
	currentEffort?: string;
	transitions: EffortTransition[];
};

export type EffortPlanResult = {
	/** The request-level effort that must accompany the returned input. */
	effort: string;
	/** Number of `configuration_update` items spliced into this request. */
	spliced: number;
};

export function createEffortControlState(): EffortControlState {
	return { transitions: [] };
}

const MAX_EFFORT_CONTROL_STATES = 16;

/**
 * Fetch (or create) the control state for one conversation from a bounded
 * LRU map, refreshing its slot.
 */
export function getEffortControlState(states: Map<string, EffortControlState>, key: string): EffortControlState {
	const existing = states.get(key);
	if (existing) {
		states.delete(key);
		states.set(key, existing);
		return existing;
	}
	const created = createEffortControlState();
	states.set(key, created);
	if (states.size > MAX_EFFORT_CONTROL_STATES) {
		const oldest = states.keys().next().value;
		if (oldest !== undefined) states.delete(oldest);
	}
	return created;
}

/**
 * Fingerprint of the item a transition sits after. Output-only lifecycle
 * fields are excluded: a live response item carries `id`/`status` that the
 * sanitized replay of the same item drops.
 */
function transitionAnchor(input: readonly PlannableInputItem[], index: number): string {
	if (index === 0) return "";
	const item = input[index - 1];
	if (!item) return "";
	const { id: _id, status: _status, ...stable } = item;
	return createHash("sha1").update(JSON.stringify(stable)).digest("hex");
}

function resetEffortControlState(state: EffortControlState): void {
	state.baseEffort = undefined;
	state.currentEffort = undefined;
	state.transitions = [];
}

/**
 * Discard the baseline when the request no longer continues the conversation
 * it was captured for: a wire history that shrank or was rewritten under a
 * recorded transition (compaction, branch switch, `/clear`). The next request
 * re-baselines from its own effort, which is what the API asks for after
 * compaction anyway.
 */
function syncEffortControlState(state: EffortControlState, input: readonly PlannableInputItem[]): void {
	for (const transition of state.transitions) {
		if (transition.index > input.length || transition.anchor !== transitionAnchor(input, transition.index)) {
			resetEffortControlState(state);
			return;
		}
	}
}

/**
 * Pin the request-level effort to the session baseline and splice pending
 * `configuration_update` items into a copy of `input`.
 *
 * `input` is the freshly built transcript for this request, without any
 * `configuration_update` items. `requested` is the wire effort the caller
 * would otherwise send at the request level.
 */
export function planStableEffort(
	state: EffortControlState,
	input: readonly PlannableInputItem[],
	requested: string,
): { input: Array<PlannableInputItem | ConfigurationUpdateItem>; result: EffortPlanResult } {
	const next: Array<PlannableInputItem | ConfigurationUpdateItem> = [...input];
	syncEffortControlState(state, next);
	if (state.baseEffort === undefined) {
		state.baseEffort = requested;
		state.currentEffort = requested;
		return { input: next, result: { effort: requested, spliced: 0 } };
	}
	if (state.currentEffort !== requested) {
		const last = next[next.length - 1];
		const index = last && last.role === "user" ? next.length - 1 : next.length;
		const existing = state.transitions.find((transition) => transition.index === index);
		if (existing) {
			existing.effort = requested;
		} else {
			state.transitions.push({ index, anchor: transitionAnchor(next, index), effort: requested });
		}
		// A change back to the effort already in force at that position is a
		// no-op on the wire; drop it rather than send a redundant item.
		let preceding = state.baseEffort;
		let precedingIndex = -1;
		for (const transition of state.transitions) {
			if (transition.index < index && transition.index > precedingIndex) {
				preceding = transition.effort;
				precedingIndex = transition.index;
			}
		}
		if (requested === preceding) {
			state.transitions = state.transitions.filter((transition) => transition.index !== index);
		}
		state.currentEffort = requested;
	}
	// Splice in ascending order so each insertion offsets only the ones after it.
	state.transitions.sort((a, b) => a.index - b.index);
	let offset = 0;
	for (const transition of state.transitions) {
		next.splice(transition.index + offset, 0, {
			type: "configuration_update",
			reasoning: { effort: transition.effort },
		});
		offset++;
	}
	return { input: next, result: { effort: state.baseEffort, spliced: state.transitions.length } };
}
