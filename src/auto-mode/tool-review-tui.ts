import { ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { boundReviewText } from "./types";

const TOOL_REVIEW_PATCH = Symbol.for("pi-openai-toolkit.auto-mode.tool-execution-renderer.v1");
const MAX_REVIEW_STATES = 256;
const MAX_DISPLAY_DETAIL_CHARS = 180;

export type ToolReviewDisplayState =
	| { phase: "skipped"; toolName: string; detail: string }
	| { phase: "reviewing"; toolName: string }
	| { phase: "awaiting-user"; toolName: string }
	| { phase: "allowed"; toolName: string; source: "reviewer" | "classifier" | "human"; detail?: string }
	| { phase: "denied"; toolName: string; detail: string }
	| { phase: "blocked"; toolName: string; detail: string };

export interface ToolReviewRendererBridge {
	readonly supported: boolean;
	readonly reason?: string;
	setTheme(theme: Theme | undefined): void;
	setState(toolCallId: string, state: ToolReviewDisplayState): void;
	clear(): void;
}

type ToolExecutionInstance = {
	toolCallId?: unknown;
};

type RenderMethod = (this: ToolExecutionInstance, width: number) => string[];
type PropertyRecord = Record<PropertyKey, unknown>;

type ReviewStateStore = {
	states: Map<string, ToolReviewDisplayState>;
	theme?: Theme;
};

type PatchRecord = {
	originalRender: RenderMethod;
	store: ReviewStateStore;
};

function asPropertyRecord(value: unknown): PropertyRecord | undefined {
	if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
	return value as PropertyRecord;
}

function isRenderMethod(value: unknown): value is RenderMethod {
	return typeof value === "function";
}

function isPatchRecord(value: unknown): value is PatchRecord {
	const record = asPropertyRecord(value);
	const store = record?.store;
	return (
		isRenderMethod(record?.originalRender) &&
		!!store &&
		typeof store === "object" &&
		(store as { states?: unknown }).states instanceof Map
	);
}

function createStore(): ReviewStateStore {
	return { states: new Map<string, ToolReviewDisplayState>() };
}

function normalizeDisplayText(value: unknown): string {
	return boundReviewText(value, MAX_DISPLAY_DETAIL_CHARS).replace(/\s+/g, " ").trim();
}

function getStatusPresentation(state: ToolReviewDisplayState): {
	color: "accent" | "success" | "error" | "warning" | "muted";
	text: string;
} {
	switch (state.phase) {
		case "skipped":
			return { color: "muted", text: `not reviewed · ${normalizeDisplayText(state.detail)}` };
		case "reviewing":
			return { color: "accent", text: `reviewing ${normalizeDisplayText(state.toolName)}` };
		case "awaiting-user":
			return { color: "warning", text: `waiting for approval of ${normalizeDisplayText(state.toolName)}` };
		case "allowed":
			return {
				color: "success",
				text: `allowed by ${state.source}${state.detail ? ` · ${normalizeDisplayText(state.detail)}` : ""}`,
			};
		case "denied":
			return { color: "error", text: `denied · ${normalizeDisplayText(state.detail)}` };
		case "blocked":
			return { color: "warning", text: `blocked · ${normalizeDisplayText(state.detail)}` };
	}
}

/**
 * Format the single line appended below a Pi tool block. Kept pure so width,
 * truncation, and untrusted reviewer text are testable without booting the TUI.
 */
export function formatToolReviewLine(
	state: ToolReviewDisplayState,
	width: number,
	theme?: Theme,
): string {
	const presentation = getStatusPresentation(state);
	const plain = `  ${presentation.text}`;
	const maxWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
	const styled = theme ? theme.fg(presentation.color, plain) : plain;
	const truncated = truncateToWidth(styled, maxWidth, "");
	return truncated + " ".repeat(Math.max(0, maxWidth - visibleWidth(truncated)));
}

function normalizeState(state: ToolReviewDisplayState): ToolReviewDisplayState {
	const toolName = normalizeDisplayText(state.toolName);
	switch (state.phase) {
		case "skipped":
			return { phase: "skipped", toolName, detail: normalizeDisplayText(state.detail) };
		case "reviewing":
			return { phase: "reviewing", toolName };
		case "awaiting-user":
			return { phase: "awaiting-user", toolName };
		case "allowed":
			return state.detail
				? { phase: "allowed", toolName, source: state.source, detail: normalizeDisplayText(state.detail) }
				: { phase: "allowed", toolName, source: state.source };
		case "denied":
			return { phase: "denied", toolName, detail: normalizeDisplayText(state.detail) };
		case "blocked":
			return { phase: "blocked", toolName, detail: normalizeDisplayText(state.detail) };
	}
}

function createUnsupportedBridge(reason: string): ToolReviewRendererBridge {
	return {
		supported: false,
		reason,
		setTheme: () => undefined,
		setState: () => undefined,
		clear: () => undefined,
	};
}

function createBridge(store: ReviewStateStore, supported = true, reason?: string): ToolReviewRendererBridge {
	return {
		supported,
		reason,
		setTheme: (theme) => {
			store.theme = theme;
		},
		setState: (toolCallId, state) => {
			const id = toolCallId.trim();
			if (!id) return;
			store.states.set(id, normalizeState(state));
			while (store.states.size > MAX_REVIEW_STATES) {
				const oldest = store.states.keys().next().value;
				if (oldest === undefined) break;
				store.states.delete(oldest);
			}
		},
		clear: () => {
			store.states.clear();
		},
	};
}

/**
 * Install the optional per-tool review footer against Pi's exported
 * ToolExecutionComponent. Pi has no public decorator hook yet, so this is a
 * deliberately narrow, feature-detected compatibility patch. If the class or
 * its render method changes, callers retain the existing global footer path.
 */
export function installToolReviewRenderer(
	target: unknown = ToolExecutionComponent,
): ToolReviewRendererBridge {
	const targetRecord = asPropertyRecord(target);
	const prototype = asPropertyRecord(targetRecord?.prototype);
	if (!prototype) return createUnsupportedBridge("ToolExecutionComponent prototype is unavailable");

	const existing = prototype[TOOL_REVIEW_PATCH];
	if (isPatchRecord(existing)) return createBridge(existing.store);

	const originalRender = prototype.render;
	if (!isRenderMethod(originalRender)) return createUnsupportedBridge("ToolExecutionComponent.render is unavailable");

	const store = createStore();
	const wrappedRender: RenderMethod = function (this: ToolExecutionInstance, width: number): string[] {
		const lines = originalRender.call(this, width);
		if (!Array.isArray(lines) || typeof this.toolCallId !== "string") return lines;
		const state = store.states.get(this.toolCallId);
		if (!state) return lines;
		return [...lines, formatToolReviewLine(state, width, store.theme)];
	};
	const patch: PatchRecord = { originalRender, store };

	try {
		Object.defineProperty(prototype, TOOL_REVIEW_PATCH, {
			configurable: true,
			enumerable: false,
			writable: false,
			value: patch,
		});
		prototype.render = wrappedRender;
		if (prototype.render !== wrappedRender) throw new Error("ToolExecutionComponent.render is not writable");
	} catch {
		try {
			delete prototype[TOOL_REVIEW_PATCH];
		} catch {
			// Best effort only: the compatibility fallback remains safe either way.
		}
		return createUnsupportedBridge("ToolExecutionComponent.render cannot be patched");
	}

	return createBridge(store);
}
