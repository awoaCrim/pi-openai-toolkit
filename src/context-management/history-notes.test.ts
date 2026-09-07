import { afterEach, expect, test } from "bun:test";
import { callHistoryNotesBackend, executeHistoryNotesTool, HISTORY_ENDPOINTS, NOTES_ENDPOINTS } from "./history-notes";

const originalFetch = globalThis.fetch;
const model = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.5",
	baseUrl: "https://chatgpt.com/backend-api",
};
const ctx = {
	model,
	modelRegistry: {
		getApiKeyAndHeaders: async () => ({
			ok: true,
			apiKey: "token",
			headers: { "chatgpt-account-id": "account" },
			baseUrl: model.baseUrl,
		}),
	},
	sessionManager: { getSessionId: () => "session-1" },
} as never;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("builds Codex history requests with context and opaque encrypted output", async () => {
	let request: Request | undefined;
	globalThis.fetch = async (input, init) => {
		request = new Request(input, init);
		return new Response(JSON.stringify({ encrypted_output: "opaque-value" }), { status: 200 });
	};
	const result = await callHistoryNotesBackend(
		HISTORY_ENDPOINTS.search_contents,
		{ query: "needle" },
		ctx,
	);
	expect(result).toEqual({ ok: true, value: { encrypted_output: "opaque-value" } });
	expect(request?.url).toBe("https://chatgpt.com/backend-api/codex/alpha/history/v2/search_contents");
	expect(request?.headers.get("x-openai-encrypted-tool-arguments")).toBe("true");
	expect(request?.headers.get("chatgpt-account-id")).toBe("account");
	expect(request?.headers.get("version")).toBe("0.0.0");
	expect(await request?.json()).toEqual({ query: "needle", context: { session_id: "session-1", current_agent_name: "/root" } });
});

test("keeps non-encrypted operations free of the encrypted-argument header", async () => {
	let request: Request | undefined;
	globalThis.fetch = async (input, init) => {
		request = new Request(input, init);
		return new Response(JSON.stringify({ files: [] }), { status: 200 });
	};
	const result = await callHistoryNotesBackend(NOTES_ENDPOINTS.list_files_by_prefix, {}, ctx);
	expect(result.ok).toBe(true);
	expect(request?.headers.get("x-openai-encrypted-tool-arguments")).toBeNull();
});

test("surfaces abort, HTTP and malformed JSON failures without response-body leakage", async () => {
	const controller = new AbortController();
	controller.abort();
	globalThis.fetch = async () => { throw new Error("secret encrypted output"); };
	const aborted = await callHistoryNotesBackend(HISTORY_ENDPOINTS.list_windows, {}, ctx, controller.signal);
	expect(aborted).toMatchObject({ ok: false, reason: "aborted" });

	globalThis.fetch = async () => new Response("backend secret", { status: 500 });
	const http = await callHistoryNotesBackend(HISTORY_ENDPOINTS.list_windows, {}, ctx);
	expect(http).toMatchObject({ ok: false, reason: "http-error", status: 500 });

	globalThis.fetch = async () => new Response("not-json", { status: 200 });
	const malformed = await callHistoryNotesBackend(HISTORY_ENDPOINTS.list_windows, {}, ctx);
	expect(malformed).toMatchObject({ ok: false, reason: "invalid-json" });
});

test("returns encrypted output as an opaque top-level tool result", async () => {
	globalThis.fetch = async () => new Response(JSON.stringify({ encrypted_output: "opaque-value", extra: "kept" }), { status: 200 });
	const result = await executeHistoryNotesTool("history", "list_windows", { action: "list_windows" }, ctx);
	expect(result.content).toEqual([{ type: "text", text: "history operation completed" }]);
	expect(result.details?.codexHistoryNotes).toEqual({ encrypted_output: "opaque-value", extra: "kept" });
});

test("rejects an empty successful response as invalid protocol data", async () => {
	globalThis.fetch = async () => new Response("{}", { status: 200 });
	const result = await callHistoryNotesBackend(HISTORY_ENDPOINTS.list_windows, {}, ctx);
	expect(result).toMatchObject({ ok: false, reason: "invalid-response" });
});
