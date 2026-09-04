import { expect, test } from "bun:test";
import {
	buildResponsesRequestHeaders,
	clampCodexSessionId,
	CODEX_CLIENT_VERSION,
	type ResponsesHeaderRuntime,
} from "./responses-headers";

function codexJwt(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `${header}.${payload}.signature`;
}

function runtimeFor(api: string, apiKey: string, sessionId?: string): ResponsesHeaderRuntime {
	return {
		api,
		apiKey,
		sessionId,
		currentModel: {},
	};
}

test("codex requests carry the backend version gate and conversation affinity headers", () => {
	const headers = buildResponsesRequestHeaders(
		runtimeFor("openai-codex-responses", codexJwt("acct_1"), "sess-42"),
		{ accept: "application/json" },
	);

	expect(headers.get("version")).toBe(CODEX_CLIENT_VERSION);
	expect(headers.get("chatgpt-account-id")).toBe("acct_1");
	expect(headers.get("originator")).toBe("pi");
	expect(headers.get("openai-beta")).toBe("responses=experimental");
	expect(headers.get("session-id")).toBe("sess-42");
	expect(headers.get("x-client-request-id")).toBe("sess-42");
});

test("codex affinity headers are omitted without a session id", () => {
	const headers = buildResponsesRequestHeaders(
		runtimeFor("openai-codex-responses", codexJwt("acct_1")),
		{ accept: "application/json" },
	);

	expect(headers.get("version")).toBe(CODEX_CLIENT_VERSION);
	expect(headers.get("session-id")).toBeNull();
	expect(headers.get("x-client-request-id")).toBeNull();
});

test("session ids are clamped to the prompt-cache key limit", () => {
	const long = "x".repeat(100);
	expect(clampCodexSessionId(long)).toBe("x".repeat(64));
	expect(clampCodexSessionId("short")).toBe("short");
	expect(clampCodexSessionId(undefined)).toBeUndefined();

	const headers = buildResponsesRequestHeaders(
		runtimeFor("openai-codex-responses", codexJwt("acct_1"), long),
		{ accept: "application/json" },
	);
	expect(headers.get("session-id")).toBe("x".repeat(64));
});

test("non-codex responses requests never carry codex headers", () => {
	const headers = buildResponsesRequestHeaders(
		runtimeFor("openai-responses", "sk-key", "sess-42"),
		{ accept: "application/json" },
	);

	expect(headers.get("version")).toBeNull();
	expect(headers.get("session-id")).toBeNull();
	expect(headers.get("x-client-request-id")).toBeNull();
	expect(headers.get("authorization")).toBe("Bearer sk-key");
});

test("codex version header respects an explicit null override from provider headers", () => {
	const runtime = runtimeFor("openai-codex-responses", codexJwt("acct_1"), "sess-42");
	runtime.headers = { version: null };
	const headers = buildResponsesRequestHeaders(runtime, { accept: "application/json" });

	// null is Pi's deletion semantics for configured headers; the codex block
	// re-asserts its own required values afterwards, so the gate stays present.
	expect(headers.get("version")).toBe(CODEX_CLIENT_VERSION);
});

test("buildResponsesRequestHeaders falls back to the runtime session id", () => {
	const headers = buildResponsesRequestHeaders(
		runtimeFor("openai-codex-responses", codexJwt("acct_1"), "runtime-sess"),
		{ accept: "application/json" },
	);
	expect(headers.get("session-id")).toBe("runtime-sess");
});
