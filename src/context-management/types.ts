import type { ContextManagementMode } from "../types";

export type { ContextManagementMode };

export const CONTEXT_MANAGEMENT_PROTOCOL = 1 as const;
export const CODEX_CONTEXT_WINDOW_MESSAGE_TYPE = "codex-context-window" as const;
export const CONTEXT_WINDOW_COMPACTION_STRATEGY = "codex-context-window" as const;
export const CONTEXT_WINDOW_REMINDER_THRESHOLD = 6_144;
export const CONTEXT_WINDOW_FALLBACK_BUFFER = 16_384;

export type ContextManagementMessageKind = "window" | "reminder" | "fallback";

export type ContextWindowIdentity = {
	firstWindowId: string;
	currentWindowId: string;
	previousWindowId?: string;
	windowNumber: number;
};

export type CodexContextManagementMessageDetails = {
	protocol: typeof CONTEXT_MANAGEMENT_PROTOCOL;
	id: string;
	sessionId?: string;
	contextManagement: ContextWindowIdentity & {
		protocol: typeof CONTEXT_MANAGEMENT_PROTOCOL;
		kind: ContextManagementMessageKind;
		trimPreviousWindow?: true;
	};
};

export type ContextWindowCompactionDetails = {
	protocol: typeof CONTEXT_MANAGEMENT_PROTOCOL;
	strategy: typeof CONTEXT_WINDOW_COMPACTION_STRATEGY;
	windowId?: string;
};

export type RemoteContextFailureReason =
	| "context-management-inactive"
	| "unsupported-model"
	| "unsupported-api"
	| "unsupported-backend"
	| "auth-resolution-failed"
	| "missing-token"
	| "missing-api-key"
	| "missing-account-id"
	| "missing-base-url"
	| "invalid-account-token"
	| "backend-timeout"
	| "aborted"
	| "http-error"
	| "invalid-json"
	| "invalid-response"
	| "protocol-error";

export type NativeCodexContextProvider = {
	kind: "native-codex";
	route: "openai-codex";
	provider: "openai-codex";
	api: "openai-codex-responses";
	model: string;
	baseUrl: string;
	token: string;
	accountId: string;
	headers: Record<string, string>;
};

export type GatewayCodexContextProvider = {
	kind: "codex-gateway";
	route: "codex-gateway";
	provider: "uwoacrimson";
	api: "openai-responses";
	model: string;
	baseUrl: string;
	apiKey: string;
	headers: Record<string, string>;
};

export type CodexContextProvider = NativeCodexContextProvider | GatewayCodexContextProvider;

export type CodexContextProviderResolution =
	| { ok: true; provider: CodexContextProvider }
	| {
			ok: false;
			reason: RemoteContextFailureReason;
			provider?: string;
			api?: string;
			model?: string;
			baseUrl?: string;
		};

export type HistoryAction =
	| "list_windows"
	| "list_items"
	| "read_item"
	| "search_contents";

export type NotesAction =
	| "list_files_by_prefix"
	| "read_file"
	| "search_contents"
	| "append_to_file"
	| "write_file";

export type HistoryNotesResponse = Record<string, unknown>;

export type HistoryNotesResult =
	| { ok: true; value: HistoryNotesResponse }
	| {
			ok: false;
			reason: Exclude<RemoteContextFailureReason, "context-management-inactive" | "unsupported-model" | "unsupported-api">;
			status?: number;
		};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function isContextWindowIdentity(value: unknown): value is ContextWindowIdentity {
	if (!isRecord(value)) return false;
	return (
		isNonEmptyString(value.firstWindowId) &&
		isNonEmptyString(value.currentWindowId) &&
		(value.previousWindowId === undefined || isNonEmptyString(value.previousWindowId)) &&
		Number.isInteger(value.windowNumber) &&
		(value.windowNumber as number) >= 0
	);
}

export function isCodexContextManagementMessageDetails(
	value: unknown,
): value is CodexContextManagementMessageDetails {
	if (!isRecord(value) || value.protocol !== CONTEXT_MANAGEMENT_PROTOCOL || !isNonEmptyString(value.id)) {
		return false;
	}
	if (value.sessionId !== undefined && !isNonEmptyString(value.sessionId)) return false;
	if (!isRecord(value.contextManagement) || value.contextManagement.protocol !== CONTEXT_MANAGEMENT_PROTOCOL) {
		return false;
	}
	const context = value.contextManagement;
	if (!isRecord(context)) return false;
	const trimPreviousWindow = context.trimPreviousWindow;
	return (
		(context.kind === "window" || context.kind === "reminder" || context.kind === "fallback") &&
		isContextWindowIdentity(context) &&
		(trimPreviousWindow === undefined || trimPreviousWindow === true)
	);
}

export function isContextWindowCompactionDetails(value: unknown): value is ContextWindowCompactionDetails {
	return (
		isRecord(value) &&
		value.protocol === CONTEXT_MANAGEMENT_PROTOCOL &&
		value.strategy === CONTEXT_WINDOW_COMPACTION_STRATEGY &&
		(value.windowId === undefined || isNonEmptyString(value.windowId))
	);
}
