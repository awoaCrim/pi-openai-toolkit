import { afterEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeNativeCompaction, extractCompactedSummaryText } from "./compact-client";
import { redactValue, writeDebugArtifact } from "./debug";
import { executeRemoteV2Compaction } from "./remote-v2-client";
import { buildCompactUrl, buildResponsesUrl } from "./runtime";
import {
	DEFAULT_COMPACTION_CONFIG,
	createNativeCompactionDetails,
	isNativeCompactionDetails,
} from "./types";

const baseModel = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-5-mini",
	name: "gpt-5-mini",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};

let serializerImportCounter = 0;

async function loadSerializerModule() {
	mock.module("@earendil-works/pi-coding-agent", () => ({
		convertToLlm: (messages: unknown[]) => messages,
	}));
	return import(`./serializer.ts?unit=${serializerImportCounter++}`);
}

function createJwtWithAccountId(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
			},
		}),
	).toString("base64url");
	return `${header}.${payload}.signature`;
}

afterEach(() => {
	serializerImportCounter = 0;
	mock.restore();
});

test("debug redaction hides opaque content and sensitive URL query parameters", () => {
	expect(
		redactValue({
			encrypted_content: "opaque-secret",
			url: "https://proxy.example/v1/responses?api_key=query-secret&mode=v2",
		}),
	).toEqual({
		encrypted_content: "[REDACTED]",
		url: "https://proxy.example/v1/responses?api_key=[REDACTED]&mode=v2",
	});
});

test("debug artifacts always redact credentials and opaque checkpoints even when optional redaction is disabled", () => {
	const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-openai-toolkit-critical-redaction-"));
	try {
		const artifactPath = writeDebugArtifact(
			"compact-response",
			{
				request: {
					headers: { authorization: "Bearer sk-sensitive-key" },
					body: { input: [{ type: "compaction", encrypted_content: "opaque-sensitive" }] },
				},
			},
			{
				...DEFAULT_COMPACTION_CONFIG,
				artifactRoot,
				logCompactResponses: true,
				redactSensitiveData: false,
			},
			{ cwd: process.cwd(), sessionId: "critical-redaction-test" },
		);
		expect(artifactPath).toBeDefined();
		const artifact = JSON.parse(fs.readFileSync(artifactPath!, "utf8"));
		expect(artifact.redaction.enabled).toBe(false);
		expect(artifact.data.request.headers.authorization).toBe("[REDACTED]");
		expect(artifact.data.request.body.input[0].encrypted_content).toBe("[REDACTED]");
		expect(JSON.stringify(artifact)).not.toContain("sk-sensitive-key");
		expect(JSON.stringify(artifact)).not.toContain("opaque-sensitive");
	} finally {
		fs.rmSync(artifactRoot, { recursive: true, force: true });
	}
});

test("native compaction details preserve optional producer identity and legacy compatibility", () => {
	const producer = {
		provider: "uwoacrimson",
		api: "openai-responses",
		model: "gpt-5.6-luna",
		baseUrl: "https://gateway.example/v1",
	};
	const details = createNativeCompactionDetails({
		provider: "uwoacrimson",
		api: "openai-responses",
		model: "gpt-5.6-sol",
		baseUrl: "https://gateway.example/v1",
		compactionModel: producer,
		compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
		createdAt: "2026-08-18T00:00:00.000Z",
	});
	producer.model = "mutated-after-create";

	expect(details.compactionModel).toEqual({
		provider: "uwoacrimson",
		api: "openai-responses",
		model: "gpt-5.6-luna",
		baseUrl: "https://gateway.example/v1",
	});
	expect(isNativeCompactionDetails(details)).toBe(true);
	expect(isNativeCompactionDetails({ ...details, compactionModel: undefined })).toBe(true);
	expect(isNativeCompactionDetails({ ...details, compactionModel: { provider: "uwoacrimson" } })).toBe(false);
});

test("buildCompactUrl and buildResponsesUrl select OpenAI/Codex paths", () => {
	expect(buildResponsesUrl("https://api.openai.com/v1", "openai-responses")).toBe(
		"https://api.openai.com/v1/responses",
	);
	expect(buildResponsesUrl("https://api.openai.com/v1/responses", "openai-responses")).toBe(
		"https://api.openai.com/v1/responses",
	);
	expect(buildResponsesUrl("https://chatgpt.com/backend-api", "openai-codex-responses")).toBe(
		"https://chatgpt.com/backend-api/codex/responses",
	);
	expect(buildCompactUrl("https://api.openai.com/v1", "openai-responses")).toBe(
		"https://api.openai.com/v1/responses/compact",
	);
	expect(buildCompactUrl("https://chatgpt.com/backend-api", "openai-codex-responses")).toBe(
		"https://chatgpt.com/backend-api/codex/responses/compact",
	);
	expect(buildCompactUrl("https://chatgpt.com/backend-api/codex", "openai-codex-responses")).toBe(
		"https://chatgpt.com/backend-api/codex/responses/compact",
	);
	expect(buildCompactUrl("https://chatgpt.com/backend-api/codex/responses", "openai-codex-responses")).toBe(
		"https://chatgpt.com/backend-api/codex/responses/compact",
	);
});

test("executeNativeCompaction propagates resolved request headers and codex auth headers", async () => {
	const token = createJwtWithAccountId("acct_123");
	let fetchArgs: { url?: string; init?: RequestInit } = {};
	globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
		fetchArgs = { url: String(url), init };
		return new Response(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "opaque" }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;

	const result = await executeNativeCompaction({
		runtime: {
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "gpt-5.1",
			baseUrl: "https://chatgpt.com/backend-api",
			apiKey: token,
			headers: {
				"x-test-model-header": "present",
				"x-test-runtime-header": "resolved",
			},
			responsesPath: "codex/responses",
			responsesUrl: buildResponsesUrl("https://chatgpt.com/backend-api", "openai-codex-responses"),
			compactPath: "codex/responses/compact",
			compactUrl: buildCompactUrl("https://chatgpt.com/backend-api", "openai-codex-responses"),
			currentModel: {
				...baseModel,
				provider: "openai-codex",
				api: "openai-codex-responses",
				id: "gpt-5.1",
				name: "gpt-5.1",
				baseUrl: "https://chatgpt.com/backend-api",
			},
		},
		request: {
			model: "gpt-5.1",
			instructions: "compact this",
			input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
		},
	});

	expect(result.ok).toBe(true);
	expect(fetchArgs.url).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
	const headers = new Headers(fetchArgs.init?.headers);
	expect(headers.get("x-test-model-header")).toBe("present");
	expect(headers.get("x-test-runtime-header")).toBe("resolved");
	expect(headers.get("authorization")).toBe(`Bearer ${token}`);
	expect(headers.get("chatgpt-account-id")).toBe("acct_123");
	expect(headers.get("originator")).toBe("pi");
	expect(headers.get("openai-beta")).toBe("responses=experimental");
	expect(headers.get("content-type")).toBe("application/json");
});

test("executeRemoteV2Compaction sends a trigger and accepts exactly one completed opaque item", async () => {
	let requestBody: Record<string, unknown> = {};
	const opaque = { type: "compaction", id: "cmp_v2", encrypted_content: "opaque-v2" };
	globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
		expect(String(url)).toBe("https://proxy.example.com/v1/responses");
		requestBody = JSON.parse(String(init?.body));
		return new Response(
			[
				`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_v2", status: "in_progress", output: [] } })}`,
				`event: keepalive\ndata: ${JSON.stringify({ type: "keepalive" })}`,
				`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: opaque })}`,
				`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_v2", created_at: 1_800_000_000, status: "completed", output: [opaque], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } })}`,
			].join("\n\n"),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	}) as typeof fetch;

	const result = await executeRemoteV2Compaction({
		runtime: {
			provider: "custom-newapi",
			api: "openai-responses",
			model: "gpt-5.6-luna",
			baseUrl: "https://proxy.example.com/v1",
			apiKey: "sk-test",
			responsesPath: "responses",
			responsesUrl: buildResponsesUrl("https://proxy.example.com/v1", "openai-responses"),
			compactPath: "responses/compact",
			compactUrl: buildCompactUrl("https://proxy.example.com/v1", "openai-responses"),
			currentModel: { ...baseModel, provider: "custom-newapi", id: "gpt-5.6-luna", name: "gpt-5.6-luna", baseUrl: "https://proxy.example.com/v1" } as never,
		},
		request: {
			model: "gpt-5.6-luna",
			instructions: "compact this",
			input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
			tools: [{ type: "function", name: "read" }],
			parallel_tool_calls: true,
		},
	});

	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.compactedWindow).toEqual([opaque]);
		expect(result.compactResponseId).toBe("resp_v2");
		expect(result.usage?.total_tokens).toBe(15);
	}
	expect(requestBody.stream).toBe(true);
	expect(requestBody.store).toBe(false);
	expect(requestBody.input).toEqual([
		{ role: "user", content: [{ type: "input_text", text: "hello" }] },
		{ type: "compaction_trigger" },
	]);
});

test("executeRemoteV2Compaction honors nullable provider header overrides", async () => {
	let requestHeaders: Headers | undefined;
	const opaque = { type: "compaction", encrypted_content: "opaque-v2" };
	globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
		requestHeaders = new Headers(init?.headers);
		return new Response(
			`event: response.completed\ndata: ${JSON.stringify({
				type: "response.completed",
				response: { id: "resp_headers", status: "completed", output: [opaque] },
			})}\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	}) as typeof fetch;

	const result = await executeRemoteV2Compaction({
		runtime: {
			provider: "custom-newapi",
			api: "openai-responses",
			model: "gpt-5.6-luna",
			baseUrl: "https://proxy.example.com/v1",
			apiKey: "sk-test",
			headers: {
				"X-SHARED": "auth-value",
				"X-DELETE": null,
				"x-auth-only": "auth-only",
			},
			responsesPath: "responses",
			responsesUrl: buildResponsesUrl("https://proxy.example.com/v1", "openai-responses"),
			compactPath: "responses/compact",
			compactUrl: buildCompactUrl("https://proxy.example.com/v1", "openai-responses"),
			currentModel: {
				...baseModel,
				provider: "custom-newapi",
				id: "gpt-5.6-luna",
				name: "gpt-5.6-luna",
				baseUrl: "https://proxy.example.com/v1",
				headers: {
					"x-shared": "model-value",
					"x-delete": "delete-me",
					"x-model-only": "model-only",
				},
			} as never,
		},
		request: {
			model: "gpt-5.6-luna",
			instructions: "compact this",
			input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
		},
	});

	expect(result.ok).toBe(true);
	expect(requestHeaders?.get("x-shared")).toBe("auth-value");
	expect(requestHeaders?.get("x-delete")).toBeNull();
	expect(requestHeaders?.get("x-model-only")).toBe("model-only");
	expect(requestHeaders?.get("x-auth-only")).toBe("auth-only");
	expect([...(requestHeaders?.values() ?? [])]).not.toContain("null");
});

test("executeRemoteV2Compaction rejects missing completed events and malformed opaque items", async () => {
	const runtime = {
		provider: "custom-newapi",
		api: "openai-responses",
		model: "gpt-5.6-luna",
		baseUrl: "https://proxy.example.com/v1",
		apiKey: "sk-test",
		responsesPath: "responses",
		responsesUrl: buildResponsesUrl("https://proxy.example.com/v1", "openai-responses"),
		compactPath: "responses/compact",
		compactUrl: buildCompactUrl("https://proxy.example.com/v1", "openai-responses"),
		currentModel: { ...baseModel, provider: "custom-newapi", id: "gpt-5.6-luna", name: "gpt-5.6-luna", baseUrl: "https://proxy.example.com/v1" },
	} as never;
	const request = {
		model: "gpt-5.6-luna",
		instructions: "compact this",
		input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
	} as never;

	globalThis.fetch = mock(async () =>
		new Response(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "opaque" } })}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	) as typeof fetch;
	const missingCompleted = await executeRemoteV2Compaction({ runtime, request });
	expect(missingCompleted).toEqual(expect.objectContaining({ ok: false, reason: "missing-completed-event" }));

	globalThis.fetch = mock(async () =>
		new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_bad", status: "completed", output: [{ type: "compaction", encrypted_content: "" }] } })}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	) as typeof fetch;
	const malformed = await executeRemoteV2Compaction({ runtime, request });
	expect(malformed).toEqual(expect.objectContaining({ ok: false, reason: "malformed-compaction-item" }));
});

test("serializer sanitizes unpaired surrogates in instructions and message content", async () => {
	const { serializeMessagesToCompactRequest, serializeMessagesToResponsesInput } = await loadSerializerModule();
	const invalid = "\ud800Hello\udc00";
	const request = serializeMessagesToCompactRequest({
		model: baseModel as never,
		instructions: `Prefix ${invalid}`,
		messages: [
			{ role: "user", content: [{ type: "text", text: invalid }], timestamp: 1 },
			{
				role: "assistant",
				provider: baseModel.provider,
				api: baseModel.api,
				model: baseModel.id,
				stopReason: "stop",
				content: [{ type: "text", text: invalid, textSignature: JSON.stringify({ v: 1, id: "msg_1" }) }],
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_1|fc_call_1",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: invalid }],
				timestamp: 3,
			},
		],
	});

	expect(JSON.stringify(request.instructions)).not.toContain("\\ud800");
	expect(JSON.stringify(request.input)).not.toContain("\\ud800");
	expect(JSON.stringify(request.input)).not.toContain("\\udc00");

	const inputOnly = serializeMessagesToResponsesInput(baseModel as never, [
		{ role: "user", content: [{ type: "text", text: invalid }], timestamp: 1 },
	] as never);
	expect(JSON.stringify(inputOnly)).not.toContain("\\ud800");
	expect(JSON.stringify(inputOnly)).not.toContain("\\udc00");
});

test("extractCompactedSummaryText joins assistant output_text blocks and skips opaque items", () => {
	expect(
		extractCompactedSummaryText([
			{ type: "compaction", encrypted_content: "opaque" },
			{
				type: "message",
				role: "assistant",
				status: "completed",
				id: "cmp_1",
				content: [
					{ type: "output_text", text: "  Summary part one.  ", annotations: [] },
					{ type: "output_text", text: "Summary part two.", annotations: [] },
				],
			},
			{ type: "message", role: "user", content: [{ type: "input_text", text: "not a summary" }] },
		]),
	).toBe("Summary part one.\n\nSummary part two.");

	expect(extractCompactedSummaryText([{ type: "compaction", encrypted_content: "opaque" }])).toBeUndefined();
	expect(
		extractCompactedSummaryText([
			{ type: "message", role: "assistant", status: "completed", id: "cmp_2", content: [] },
		]),
	).toBeUndefined();
});

test("executeNativeCompaction serializes codex-aligned passthrough fields and extracts summary text", async () => {
	let requestBody: Record<string, unknown> = {};
	globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body));
		return new Response(
			JSON.stringify({
				id: "resp_compact",
				output: [
					{ type: "compaction", encrypted_content: "opaque" },
					{
						type: "message",
						role: "assistant",
						status: "completed",
						id: "cmp_summary",
						content: [{ type: "output_text", text: "Native summary.", annotations: [] }],
					},
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;

	const result = await executeNativeCompaction({
		runtime: {
			provider: "openai",
			api: "openai-responses",
			model: "gpt-5-mini",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "sk-test",
			responsesPath: "responses",
			responsesUrl: buildResponsesUrl("https://api.openai.com/v1", "openai-responses"),
			compactPath: "responses/compact",
			compactUrl: buildCompactUrl("https://api.openai.com/v1", "openai-responses"),
			currentModel: baseModel as never,
		},
		request: {
			model: "gpt-5-mini",
			instructions: "compact this",
			input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
			tools: [{ type: "function", name: "read" }],
			parallel_tool_calls: true,
			reasoning: { effort: "high", summary: "auto" },
			prompt_cache_key: "session-123",
			text: { verbosity: "low" },
		},
	});

	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.summaryText).toBe("Native summary.");
	}
	expect(requestBody.tools).toEqual([{ type: "function", name: "read" }]);
	expect(requestBody.parallel_tool_calls).toBe(true);
	expect(requestBody.reasoning).toEqual({ effort: "high", summary: "auto" });
	expect(requestBody.prompt_cache_key).toBe("session-123");
	expect(requestBody.text).toEqual({ verbosity: "low" });
	expect("service_tier" in requestBody).toBe(false);
});
