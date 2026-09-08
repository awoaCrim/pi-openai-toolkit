import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	codexContextProviderHeaders,
	resolveCodexContextProvider,
} from "./codex-provider";
import {
	isRecord,
	type HistoryAction,
	type HistoryNotesResponse,
	type HistoryNotesResult,
	type NotesAction,
} from "./types";

export const BACKEND_TIMEOUT_MS = 35_000;
export const THREAD_HINT_MAX_BYTES = 4_000;
export const TOOL_OUTPUT_TOKEN_LIMIT = 10_000;
export const CODEX_ENCRYPTED_OUTPUT_CONTEXT_MARKER = "\u0000pi-openai-toolkit:encrypted-output:";

export function encodeEncryptedOutputForContext(value: string): string {
	return `${CODEX_ENCRYPTED_OUTPUT_CONTEXT_MARKER}${JSON.stringify(value)}`;
}

export const HISTORY_ENDPOINTS = {
	list_windows: "alpha/history/v2/list_windows",
	list_items: "alpha/history/v2/list_items",
	read_item: "alpha/history/v2/read_item",
	search_contents: "alpha/history/v2/search_contents",
} as const satisfies Record<HistoryAction, string>;

export const THREAD_HINT_ENDPOINT = "alpha/notes/v2/thread_hint";

export const NOTES_ENDPOINTS = {
	list_files_by_prefix: "alpha/notes/v2/list_files_by_prefix",
	read_file: "alpha/notes/v2/read_file",
	search_contents: "alpha/notes/v2/search_contents",
	append_to_file: "alpha/notes/v2/append_to_file",
	write_file: "alpha/notes/v2/write_file",
} as const satisfies Record<NotesAction, string>;

export const ENCRYPTED_ARGUMENT_ENDPOINTS = new Set<string>([
	HISTORY_ENDPOINTS.search_contents,
	NOTES_ENDPOINTS.search_contents,
	NOTES_ENDPOINTS.append_to_file,
	NOTES_ENDPOINTS.write_file,
]);

export const HISTORY_ACTION_FIELDS: Record<HistoryAction, readonly string[]> = {
	list_windows: ["agent_name", "limit", "recent_first"],
	list_items: [
		"agent_name", "limit", "max_chars_per_item", "recent_first", "role",
		"tool_name", "tool_namespace", "window_id",
	],
	read_item: ["agent_name", "item_id", "limit_chars", "offset_chars", "window_id"],
	search_contents: [
		"agent_name", "limit", "query", "recent_first", "role", "tool_name",
		"tool_namespace", "window_id",
	],
};

export const NOTES_ACTION_FIELDS: Record<NotesAction, readonly string[]> = {
	list_files_by_prefix: ["file_order", "file_order_by", "max_results", "prefix"],
	read_file: ["path", "start_line", "stop_line"],
	search_contents: ["max_files", "max_matches_per_file", "path_prefix", "query", "recent_file_first"],
	append_to_file: ["path", "text"],
	write_file: ["path", "text"],
};

export interface CodexHistoryNotesDetails {
	codexHistoryNotes: Record<string, unknown>;
}

export async function callHistoryNotesBackend(
	endpoint: string,
	arguments_: Record<string, unknown>,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	truncationPolicy: { mode: "bytes" | "tokens"; limit: number } = {
		mode: "tokens",
		limit: TOOL_OUTPUT_TOKEN_LIMIT,
	},
): Promise<HistoryNotesResult> {
	const timeoutSignal = AbortSignal.timeout(BACKEND_TIMEOUT_MS);
	if (signal?.aborted) return { ok: false, reason: "aborted" };
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const providerResult = await resolveProviderWithDeadline(ctx, requestSignal, timeoutSignal);
	if (providerResult === "aborted") return { ok: false, reason: "aborted" };
	if (providerResult === "timeout") return { ok: false, reason: "backend-timeout" };
	const provider = providerResult;
	if (!provider.ok) {
		const reason = provider.reason === "unsupported-model" || provider.reason === "unsupported-api" || provider.reason === "context-management-inactive"
			? "unsupported-backend"
			: provider.reason;
		return { ok: false, reason };
	}
	const sessionId = ctx.sessionManager.getSessionId();
	const headers = codexContextProviderHeaders(provider.provider, {
		sessionId,
		clientRequestId: sessionId,
	});
	headers.set("x-openai-tool-output-truncation-policy", JSON.stringify(truncationPolicy));
	if (ENCRYPTED_ARGUMENT_ENDPOINTS.has(endpoint)) {
		headers.set("x-openai-encrypted-tool-arguments", "true");
	}
	try {
		const response = await fetch(`${provider.provider.baseUrl}/${endpoint}`, {
			method: "POST",
			headers,
			signal: requestSignal,
			body: JSON.stringify({
				...arguments_,
				context: {
					session_id: ctx.sessionManager.getSessionId(),
					current_agent_name: "/root",
				},
			}),
		});
		if (!response.ok) return { ok: false, reason: "http-error", status: response.status };
		let parsed: unknown;
		try {
			parsed = JSON.parse(await response.text()) as unknown;
		} catch {
			return { ok: false, reason: "invalid-json", status: response.status };
		}
		if (!isHistoryNotesResponse(parsed, endpoint)) return { ok: false, reason: "invalid-response", status: response.status };
		return { ok: true, value: parsed };
	} catch {
		if (signal?.aborted) return { ok: false, reason: "aborted" };
		if (timeoutSignal.aborted) return { ok: false, reason: "backend-timeout" };
		return { ok: false, reason: "protocol-error" };
	}
}

async function resolveProviderWithDeadline(
	ctx: ExtensionContext,
	requestSignal: AbortSignal,
	timeoutSignal: AbortSignal,
): Promise<Awaited<ReturnType<typeof resolveCodexContextProvider>> | "aborted" | "timeout"> {
	if (requestSignal.aborted) return timeoutSignal.aborted ? "timeout" : "aborted";
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: Awaited<ReturnType<typeof resolveCodexContextProvider>> | "aborted" | "timeout") => {
			if (settled) return;
			settled = true;
			requestSignal.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => finish(timeoutSignal.aborted ? "timeout" : "aborted");
		requestSignal.addEventListener("abort", onAbort, { once: true });
		resolveCodexContextProvider(ctx, ctx.model).then(
			(value) => finish(value),
			() => finish({ ok: false, reason: "auth-resolution-failed" }),
		);
	});
}

export async function loadHistoryNotesThreadHint(
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const result = await callHistoryNotesBackend(
		THREAD_HINT_ENDPOINT,
		{},
		ctx,
		signal,
		{ mode: "bytes", limit: THREAD_HINT_MAX_BYTES },
	);
	if (!result.ok) {
		if (result.reason === "aborted") throw new Error("Remote context hint request was aborted");
		return undefined;
	}
	const text = result.value.text;
	return typeof text === "string" && Buffer.byteLength(text, "utf8") <= THREAD_HINT_MAX_BYTES ? text : undefined;
}

export async function executeHistoryNotesTool(
	namespace: "history" | "notes",
	action: HistoryAction | NotesAction,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AgentToolResult<CodexHistoryNotesDetails>> {
	const endpoint = namespace === "history"
		? HISTORY_ENDPOINTS[action as HistoryAction]
		: NOTES_ENDPOINTS[action as NotesAction];
	if (!endpoint) throw new Error(`Unsupported ${namespace} action`);
	validateAction(namespace, action, params);
	const result = await callHistoryNotesBackend(
		endpoint,
		stripAction(params),
		ctx,
		signal,
		undefined,
	);
	if (!result.ok) throw new Error(formatHistoryNotesFailure(result.reason, result.status));
	const modelResult = { ...result.value };
	delete modelResult.images;
	const content: AgentToolResult<CodexHistoryNotesDetails>["content"] = [
		{
			type: "text",
			text: typeof modelResult.encrypted_output === "string"
				? `${namespace} operation completed`
				: JSON.stringify(modelResult),
		},
	];
	for (const image of parseBackendImages(result.value.images)) content.push(image);
	return { content, details: { codexHistoryNotes: modelResult } };
}

export function formatHistoryNotesFailure(
	reason: Exclude<HistoryNotesResult, { ok: true }>["reason"],
	status?: number,
): string {
	switch (reason) {
		case "aborted": return "Remote history/notes request was aborted";
		case "backend-timeout": return "Remote history/notes backend timed out";
		case "http-error": return `Remote history/notes backend returned HTTP ${status ?? "error"}`;
		case "invalid-json": return "Remote history/notes backend returned invalid JSON";
		case "invalid-response": return "Remote history/notes backend returned an invalid response";
		case "auth-resolution-failed": return "Remote history/notes authentication could not be resolved";
		case "missing-token": return "Remote history/notes authentication is missing a token";
		case "missing-api-key": return "Remote history/notes gateway authentication is missing an API key";
		case "missing-account-id": return "Remote history/notes authentication is missing an account id";
		case "missing-base-url": return "Remote history/notes backend is missing a base URL";
		case "unsupported-backend": return "Remote history/notes require the native Codex backend";
		case "protocol-error": return "Remote history/notes request failed";
		case "invalid-account-token": return "Remote history/notes authentication token is invalid";
		default: return "Remote history/notes request failed";
	}
}

const RESPONSE_KEYS_BY_ENDPOINT: Record<string, readonly string[]> = {
	[HISTORY_ENDPOINTS.list_windows]: ["windows", "items", "results", "data", "output", "encrypted_output"],
	[HISTORY_ENDPOINTS.list_items]: ["items", "results", "data", "output", "encrypted_output"],
	[HISTORY_ENDPOINTS.read_item]: ["item", "content", "text", "data", "output", "encrypted_output"],
	[HISTORY_ENDPOINTS.search_contents]: ["matches", "items", "results", "data", "output", "encrypted_output"],
	[NOTES_ENDPOINTS.list_files_by_prefix]: ["files", "items", "results", "data", "output", "encrypted_output"],
	[NOTES_ENDPOINTS.read_file]: ["file", "content", "text", "data", "output", "encrypted_output"],
	[NOTES_ENDPOINTS.search_contents]: ["matches", "items", "results", "data", "output", "encrypted_output"],
	[NOTES_ENDPOINTS.append_to_file]: ["ok", "success", "file", "content", "data", "output", "encrypted_output"],
	[NOTES_ENDPOINTS.write_file]: ["ok", "success", "file", "content", "data", "output", "encrypted_output"],
	[THREAD_HINT_ENDPOINT]: ["text", "data", "output"],
};

const ARRAY_RESPONSE_KEYS = new Set(["windows", "items", "results", "matches", "files"]);

function isHistoryNotesResponse(value: unknown, endpoint: string): value is HistoryNotesResponse {
	if (!isRecord(value) || Object.keys(value).length === 0) return false;
	if (value.encrypted_output !== undefined &&
		(typeof value.encrypted_output !== "string" || value.encrypted_output.length === 0)) return false;
	if (value.images !== undefined && !isValidImages(value.images)) return false;
	if (value.ok !== undefined && typeof value.ok !== "boolean") return false;
	if (value.success !== undefined && typeof value.success !== "boolean") return false;
	if (value.text !== undefined && typeof value.text !== "string") return false;
	for (const key of ARRAY_RESPONSE_KEYS) {
		if (value[key] !== undefined && !Array.isArray(value[key])) return false;
	}
	const expectedKeys = RESPONSE_KEYS_BY_ENDPOINT[endpoint];
	return expectedKeys ? expectedKeys.some((key) => key in value) : false;
}

type BackendImage = {
	data: string;
	mime_type: string;
	detail?: "auto" | "high" | "original" | null;
};

function isValidImages(value: unknown): value is BackendImage[] {
	return Array.isArray(value) && value.every((item): item is BackendImage => {
		if (!isRecord(item) || typeof item.data !== "string" || typeof item.mime_type !== "string") return false;
		return item.detail === undefined || item.detail === null || item.detail === "auto" || item.detail === "high" || item.detail === "original";
	});
}

function parseBackendImages(value: unknown): Array<{
	type: "image";
	data: string;
	mimeType: string;
	detail?: "auto" | "high" | "original";
}> {
	if (value === undefined) return [];
	if (!isValidImages(value)) throw new Error("Remote history backend returned invalid image content");
	return value.map((item) => ({
		type: "image" as const,
		data: item.data,
		mimeType: item.mime_type,
		...(item.detail ? { detail: item.detail } : {}),
	}));
}

function stripAction(params: Record<string, unknown>): Record<string, unknown> {
	const result = { ...params };
	delete result.action;
	return result;
}

function validateAction(
	namespace: "history" | "notes",
	action: HistoryAction | NotesAction,
	params: Record<string, unknown>,
): void {
	const fields = namespace === "history"
		? HISTORY_ACTION_FIELDS[action as HistoryAction]
		: NOTES_ACTION_FIELDS[action as NotesAction];
	if (!fields) throw new Error(`Unsupported ${namespace} action`);
	const unexpected = Object.keys(params).find((field) => field !== "action" && !fields.includes(field));
	if (unexpected) throw new Error(`${namespace} ${action} does not accept ${unexpected}`);
	if (action === "read_item" && (typeof params.item_id !== "string" || !params.item_id || typeof params.window_id !== "string" || !params.window_id)) {
		throw new Error("history read_item requires item_id and window_id");
	}
	if (action === "search_contents" && (typeof params.query !== "string" || !params.query)) {
		throw new Error(`${namespace} search_contents requires query`);
	}
	if ((action === "read_file" || action === "append_to_file" || action === "write_file") && (typeof params.path !== "string" || !params.path)) {
		throw new Error(`notes ${action} requires path`);
	}
	if ((action === "append_to_file" || action === "write_file") && typeof params.text !== "string") {
		throw new Error(`notes ${action} requires text`);
	}
}
