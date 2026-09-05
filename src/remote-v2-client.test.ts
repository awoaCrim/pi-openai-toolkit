import { afterEach, expect, mock, test } from "bun:test";
import { executeRemoteV2Compaction, type RemoteV2CompactionItem } from "./remote-v2-client";
import type { NativeCompactionRequestBody } from "./serializer";
import type { NativeCompactionRuntime } from "./runtime";

const originalFetch = globalThis.fetch;

const runtime = {
	provider: "custom-newapi",
	api: "openai-responses",
	model: "gpt-5.6-luna",
	baseUrl: "https://proxy.example.com/v1",
	apiKey: "sk-test",
	responsesPath: "responses",
	responsesUrl: "https://proxy.example.com/v1/responses",
	compactPath: "responses/compact",
	compactUrl: "https://proxy.example.com/v1/responses/compact",
	currentModel: {
		provider: "custom-newapi",
		api: "openai-responses",
		id: "gpt-5.6-luna",
		name: "gpt-5.6-luna",
		baseUrl: "https://proxy.example.com/v1",
	},
} as never as NativeCompactionRuntime;

const request = {
	model: "gpt-5.6-luna",
	instructions: "compact this",
	input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
} as never as NativeCompactionRequestBody;

afterEach(() => {
	globalThis.fetch = originalFetch;
	mock.restore();
});

function dataEvent(type: string, value: Record<string, unknown>): string {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}`;
}

function completedEvent(response: Record<string, unknown>): string {
	return dataEvent("response.completed", { response });
}

function outputItemDone(
	item: Record<string, unknown>,
	metadata: Record<string, unknown> = {},
): string {
	return dataEvent("response.output_item.done", { item, ...metadata });
}

function stream(...events: string[]): string {
	return `${events.join("\n\n")}\n\n`;
}

function installSse(body: string): ReturnType<typeof mock> {
	const fetchMock = mock(async () =>
		new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	);
	globalThis.fetch = fetchMock as typeof fetch;
	return fetchMock;
}

async function execute(body: string) {
	installSse(body);
	return executeRemoteV2Compaction({ runtime, request });
}

const checkpoint: RemoteV2CompactionItem = {
	type: "compaction",
	id: "cmp_v2",
	encrypted_content: "opaque-v2",
};

test("reconciles an item.done-only checkpoint with a metadata-only completed response", async () => {
	const body = stream(
		dataEvent("response.created", {
			response: { id: "resp_v2", status: "in_progress", output: [] },
		}),
		outputItemDone(
			{
				...checkpoint,
				from_done: { nested: true },
			},
			{ response_id: "resp_v2", output_index: 0 },
		),
		completedEvent({
			id: "resp_v2",
			created_at: 1_800_000_000,
			status: "completed",
			usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
			metadata: { gateway: "proxy", retained: true },
		}),
		"event: [DONE]\ndata: [DONE]",
	);

	const result = await execute(body);

	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.compactedWindow).toEqual([
			{
				...checkpoint,
				from_done: { nested: true },
			},
		]);
		expect(result.compactResponseId).toBe("resp_v2");
		expect(result.createdAt).toBe("2027-01-15T08:00:00.000Z");
		expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 3, total_tokens: 15 });
		expect(result.response).toEqual({
			id: "resp_v2",
			created_at: 1_800_000_000,
			status: "completed",
			usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
			metadata: { gateway: "proxy", retained: true },
			output: [
				{
					...checkpoint,
					from_done: { nested: true },
				},
			],
		});
		(result.compactedWindow[0] as Record<string, unknown>).from_done = { nested: false };
		expect(result.response.output?.[0]).toEqual({
			...checkpoint,
			from_done: { nested: true },
		});
	}
});

test("accepts a terminal-only checkpoint and merges equal checkpoints from both SSE sources", async () => {
	const terminalItem = {
		...checkpoint,
		from_terminal: ["terminal", { preserved: true }],
	};
	const body = stream(
		outputItemDone(
			{
				...checkpoint,
				from_done: "done",
			},
			{ response_id: "resp_v2", output_index: 1 },
		),
		completedEvent({
			id: "resp_v2",
			status: "completed",
			output: [
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "kept" }] },
				terminalItem,
			],
			unknown_envelope_field: { keep: "me" },
		}),
		"event: keepalive\ndata: {\"type\":\"keepalive\"}",
		"event: [DONE]\ndata: [DONE]",
	);

	const result = await execute(body);

	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.compactedWindow).toEqual([
			{
				...checkpoint,
				from_done: "done",
				from_terminal: ["terminal", { preserved: true }],
			},
		]);
		expect(result.response.output).toEqual([
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "kept" }] },
			{
				...checkpoint,
				from_done: "done",
				from_terminal: ["terminal", { preserved: true }],
			},
		]);
		expect(result.response.unknown_envelope_field).toEqual({ keep: "me" });
	}
});

test("preserves terminal output order when item.done supplies the omitted checkpoint", async () => {
	const body = stream(
		outputItemDone(
			{ ...checkpoint, from_done: true },
			{ response_id: "resp_v2", output_index: 1 },
		),
		completedEvent({
			id: "resp_v2",
			status: "completed",
			output: [{ type: "message", role: "assistant" }],
		}),
	);

	const result = await execute(body);

	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.response.output).toEqual([
			{ type: "message", role: "assistant" },
			{ ...checkpoint, from_done: true },
		]);
	}
});

test("rejects malformed, duplicate, conflicting, error, incomplete, and out-of-order SSE flows", async () => {
	const cases: Array<{ name: string; body: string; reason?: string }> = [
		{
			name: "duplicate item.done checkpoints",
			body: stream(
				outputItemDone({ ...checkpoint }),
				outputItemDone({ ...checkpoint }),
				completedEvent({ id: "resp_v2", status: "completed", output: [] }),
			),
			reason: "invalid-compaction-count",
		},
		{
			name: "duplicate terminal checkpoints",
			body: stream(
				completedEvent({
					id: "resp_v2",
					status: "completed",
					output: [{ ...checkpoint }, { ...checkpoint }],
				}),
			),
			reason: "invalid-compaction-count",
		},
		{
			name: "conflicting checkpoint contents",
			body: stream(
				outputItemDone({ ...checkpoint, id: "cmp_done" }),
				completedEvent({
					id: "resp_v2",
					status: "completed",
					output: [{ ...checkpoint, id: "cmp_terminal" }],
				}),
			),
			reason: "conflicting-compaction-item",
		},
		{
			name: "malformed opaque content",
			body: stream(
				completedEvent({
					id: "resp_v2",
					status: "completed",
					output: [{ type: "compaction", encrypted_content: "   " }],
				}),
			),
			reason: "malformed-compaction-item",
		},
		{
			name: "missing completed event",
			body: stream(outputItemDone({ ...checkpoint })),
			reason: "missing-completed-event",
		},
		{
			name: "error event",
			body: stream(
				dataEvent("response.failed", { error: { message: "gateway failed" } }),
				completedEvent({ id: "resp_v2", status: "completed", output: [{ ...checkpoint }] }),
			),
			reason: "error-event",
		},
		{
			name: "incomplete terminal response",
			body: stream(
				dataEvent("response.completed", {
					response: { id: "resp_v2", status: "in_progress", output: [] },
				}),
			),
			reason: "incomplete-response",
		},
		{
			name: "checkpoint after terminal",
			body: stream(
				completedEvent({ id: "resp_v2", status: "completed", output: [] }),
				outputItemDone({ ...checkpoint }),
			),
			reason: "invalid-event-order",
		},
		{
			name: "response id mismatch",
			body: stream(
				outputItemDone({ ...checkpoint }, { response_id: "wrong-response" }),
				completedEvent({ id: "resp_v2", status: "completed", output: [] }),
			),
			reason: "invalid-compaction-metadata",
		},
		{
			name: "output index mismatch",
			body: stream(
				outputItemDone({ ...checkpoint }, { output_index: 0 }),
				completedEvent({
					id: "resp_v2",
					status: "completed",
					output: [{ type: "message" }, { ...checkpoint }],
				}),
			),
			reason: "invalid-compaction-metadata",
		},
		{
			name: "completed output is not an array",
			body: stream(
				completedEvent({ id: "resp_v2", status: "completed", output: null }),
			),
			reason: "incomplete-response",
		},
	];

	for (const scenario of cases) {
		const result = await execute(scenario.body);
		expect(result.ok, scenario.name).toBe(false);
		if (scenario.reason) {
			expect(result).toEqual(expect.objectContaining({ reason: scenario.reason }));
		}
	}
});

test("requires exactly one valid checkpoint even for a successful terminal response", async () => {
	const result = await execute(
		stream(completedEvent({ id: "resp_v2", status: "completed", output: [{ type: "message" }] })),
	);

	expect(result).toEqual(expect.objectContaining({ ok: false, reason: "invalid-compaction-count" }));
});

test("validates terminal uniqueness, stream identity, content conflicts and semantic field equality", async () => {
	const terminal = completedEvent({ id: "resp_v2", status: "completed", output: [checkpoint] });
	for (const [name, body, reason] of [
		["duplicate terminal", stream(terminal, terminal), "duplicate-completed-event"],
		["created identity mismatch", stream(dataEvent("response.created", { response: { id: "other" } }), terminal), "invalid-compaction-metadata"],
		["opaque conflict", stream(outputItemDone({ ...checkpoint, encrypted_content: "other-opaque" }), terminal), "conflicting-compaction-item"],
		["extension field conflict", stream(outputItemDone({ ...checkpoint, extra: { value: 1 } }), completedEvent({ status: "completed", output: [{ ...checkpoint, extra: { value: 2 } }] })), "conflicting-compaction-item"],
		["invalid index", stream(outputItemDone(checkpoint, { output_index: -1 }), terminal), "invalid-compaction-metadata"],
		["invalid done content with valid terminal", stream(outputItemDone({ ...checkpoint, encrypted_content: "" }), terminal), "malformed-compaction-item"],
		["incomplete event", stream(dataEvent("response.incomplete", { response: { status: "incomplete" } }), terminal), "error-event"],
		["early DONE", stream("data: [DONE]", terminal), "invalid-event-order"],
	] as const) {
		const result = await execute(body);
		expect(result, name).toMatchObject({ ok: false, reason });
	}
	const equal = await execute(stream(outputItemDone({ ...checkpoint, extra: { a: 1, b: [2] } }),
		completedEvent({ status: "completed", output: [{ ...checkpoint, extra: { b: [2], a: 1 } }] })));
	expect(equal.ok).toBe(true);
	for (const output of [undefined, []]) {
		const result = await execute(stream(outputItemDone(checkpoint, { output_index: 2 }),
			completedEvent({ status: "completed", ...(output ? { output } : {}) })));
		expect(result).toMatchObject({ ok: true, compactedWindow: [checkpoint] });
	}
});
