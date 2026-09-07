import { expect, test } from "bun:test";
import {
	buildContextWindowRequestMetadata,
	rewriteEncryptedToolOutputs,
	rewriteWindowHeaders,
	rewriteWindowPayload,
} from "./window-request";
import { encodeEncryptedOutputForContext } from "./history-notes";

const identity = { firstWindowId: "first", currentWindowId: "current", windowNumber: 2 };
const ctx = { sessionManager: { getSessionId: () => "session-1" } } as never;

test("adds immutable window metadata while preserving unknown payload fields", () => {
	const payload = {
		model: "gpt-5.5",
		input: [{ type: "message", role: "user", content: "hello" }],
		client_metadata: { existing: "keep" },
		tools: [{ type: "function", name: "history" }],
		unknown: { value: 1 },
	};
	const rewritten = rewriteWindowPayload(payload, ctx, identity) as Record<string, unknown>;
	expect(rewritten).not.toBe(payload);
	expect(payload.client_metadata).toEqual({ existing: "keep" });
	expect(rewritten.unknown).toEqual({ value: 1 });
	expect(rewritten.client_metadata).toMatchObject({ "x-codex-window-id": "session-1:2" });
	expect(JSON.parse((rewritten.client_metadata as Record<string, unknown>)["x-codex-turn-metadata"] as string)).toEqual({
	...buildContextWindowRequestMetadata(ctx, identity),
});
});

test("merges existing turn metadata and leaves malformed payloads unchanged", () => {
	const payload = {
		model: "gpt-5.5",
		input: [],
		client_metadata: {
			keep: "yes",
			"x-codex-turn-metadata": JSON.stringify({ existing: "yes" }),
		},
	};
	const rewritten = rewriteWindowPayload(payload, ctx, identity) as Record<string, unknown>;
	const metadata = rewritten.client_metadata as Record<string, unknown>;
	expect(JSON.parse(metadata["x-codex-turn-metadata"] as string)).toMatchObject({ existing: "yes", session_id: "session-1" });
	expect(rewriteWindowPayload({ model: "gpt-5.5", input: [], client_metadata: "bad" }, ctx, identity)).toEqual({
		model: "gpt-5.5",
		input: [],
		client_metadata: "bad",
	});
	expect(rewriteWindowPayload({ model: "gpt-5.5", input: "bad" }, ctx, identity)).toEqual({ model: "gpt-5.5", input: "bad" });
});

test("restores namespace action names before sending a routed context call", () => {
	const rewritten = rewriteWindowPayload({
		model: "gpt-5.5",
		input: [{
			type: "function_call",
			call_id: "call-1",
			name: "history",
			namespace: "history",
			arguments: JSON.stringify({ action: "list_windows", limit: 2 }),
		}],
	}, ctx, identity) as { input: Array<Record<string, unknown>> };
	expect(rewritten.input[0]).toMatchObject({ name: "list_windows", namespace: "history" });
	expect(rewritten.input[0]?.arguments).toBe(JSON.stringify({ limit: 2 }));
});

test("converts the context marker into Codex encrypted function output content", () => {
	const marker = encodeEncryptedOutputForContext("opaque-value");
	const rewritten = rewriteEncryptedToolOutputs({
		model: "gpt-5.5",
		input: [
			{ type: "function_call_output", call_id: "call-1", output: marker },
			{ type: "function_call_output", call_id: "call-2", output: [{ type: "input_text", text: marker }] },
		],
	}) as { input: Array<Record<string, unknown>> };
	expect(rewritten.input[0]?.output).toEqual([{ type: "encrypted_content", encrypted_content: "opaque-value" }]);
	expect(rewritten.input[1]?.output).toEqual([{ type: "encrypted_content", encrypted_content: "opaque-value" }]);
});

test("mutates provider headers in place and does nothing without an identity", () => {
	const headers: Record<string, string | null> = { Authorization: "Bearer secret" };
	rewriteWindowHeaders(headers, ctx, identity);
	expect(headers.Authorization).toBe("Bearer secret");
	expect(headers["x-codex-window-id"]).toBe("session-1:2");

	const untouched = { existing: "yes" };
	rewriteWindowHeaders(untouched, ctx, undefined);
	expect(untouched).toEqual({ existing: "yes" });
});
