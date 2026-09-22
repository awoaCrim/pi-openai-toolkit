import { afterEach, expect, mock, test } from "bun:test";
import { createServer } from "node:http";
import { executeRemoteV2Compaction, parseSseEvents, type RemoteV2CompactionItem } from "./remote-v2-client";
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
			name: "checkpoint after invalid terminal cannot rescue it",
			body: stream(
				completedEvent({ id: "resp_v2", status: "completed", output: [] }),
				outputItemDone({ ...checkpoint }),
			),
			reason: "invalid-compaction-count",
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

test("validates stream identity, content conflicts and semantic field equality", async () => {
	const terminal = completedEvent({ id: "resp_v2", status: "completed", output: [checkpoint] });
	for (const [name, body, reason] of [
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

function installChunks(chunks: Uint8Array[], options: { close?: boolean; cancel?: () => Promise<void> | void } = {}) {
	const cancel = mock(options.cancel ?? (() => undefined));
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			if (options.close) controller.close();
		},
		cancel,
	});
	globalThis.fetch = mock(async () => new Response(body)) as typeof fetch;
	return { body, cancel };
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("stream did not settle promptly")), 1000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

const encoder = new TextEncoder();
const validTerminal = stream(completedEvent({ id: "resp_v2", status: "completed", output: [checkpoint] }));

test("completes an open response at its terminal and releases the reader without waiting for cancel", async () => {
	for (const cancel of [
		() => undefined,
		() => new Promise<void>(() => {}),
		() => Promise.reject(new Error("transport cancellation failed")),
		() => { throw new Error("synchronous cancellation failed"); },
	]) {
		const installed = installChunks([encoder.encode(validTerminal)], { cancel });
		const result = await promptly(executeRemoteV2Compaction({ runtime, request }));
		expect(result).toMatchObject({ ok: true, compactedWindow: [checkpoint], compactResponseId: "resp_v2" });
		expect(installed.cancel).toHaveBeenCalledTimes(1);
		expect(installed.body.locked).toBe(false);
	}
});

test("ignores all data after the first completed frame regardless of byte chunk boundaries", async () => {
	const suffixes = [
		validTerminal,
		stream(dataEvent("error", { message: "late failure" })),
		stream(outputItemDone({ ...checkpoint, encrypted_content: "late conflict" })),
		"data: {broken JSON\n\n",
	];
	for (const suffix of suffixes) {
		const bytes = encoder.encode(validTerminal + suffix);
		for (let split = 0; split <= bytes.length; split += 1) {
			installChunks([bytes.slice(0, split), bytes.slice(split)], { close: true });
			const result = await executeRemoteV2Compaction({ runtime, request });
			expect(result, `suffix ${suffix}, split ${split}`).toMatchObject({ ok: true, compactedWindow: [checkpoint] });
		}
	}
	// Invalid UTF-8 following completion must not make success depend on chunking either.
	installChunks([new Uint8Array([...encoder.encode(validTerminal), 0xff, 0xc0])]);
	expect(await promptly(executeRemoteV2Compaction({ runtime, request }))).toMatchObject({ ok: true });
});

test("decodes split UTF-8, all SSE line endings, comments and multiline data", async () => {
	const unicodeCheckpoint = { ...checkpoint, metadata: "总结 🧭 café" };
	for (const newline of ["\n", "\r\n", "\r"]) {
		const body = [
			": comment", "event: response.output_item.done",
			`data: ${JSON.stringify({ type: "response.output_item.done", item: unicodeCheckpoint })}`,
			"", "event: response.completed", "data: {\"type\": \"response.completed\",",
			"data: \"response\": {\"id\":\"resp_v2\",\"status\":\"completed\"}}", "", "",
		].join(newline);
		const bytes = encoder.encode(body);
		for (let split = 0; split <= bytes.length; split += 1) {
			installChunks([bytes.slice(0, split), bytes.slice(split)], { close: true });
			expect(await executeRemoteV2Compaction({ runtime, request }), `${JSON.stringify(newline)}, split ${split}`)
				.toMatchObject({ ok: true, compactedWindow: [unicodeCheckpoint] });
		}
		installChunks(Array.from(bytes, (byte) => Uint8Array.of(byte)));
		expect(await promptly(executeRemoteV2Compaction({ runtime, request }))).toMatchObject({
			ok: true, compactedWindow: [unicodeCheckpoint],
		});
		expect(parseSseEvents(body)).toHaveLength(2);
	}
	expect(parseSseEvents("data: {broken}\n\n")).toBeUndefined();
	expect(parseSseEvents("data: [DONE]")).toMatchObject([{ dataText: "[DONE]" }]);
});

test("rejects early malformed and error terminals promptly even if the body stays open", async () => {
	for (const [body, reason] of [
		["data: {broken JSON\n\n" + validTerminal, "invalid-sse"],
		[stream(dataEvent("error", { message: "gateway error" })) + validTerminal, "error-event"],
		[stream(dataEvent("response.failed", { error: { message: "failed" } })), "error-event"],
		[stream(dataEvent("response.incomplete", { response: { status: "incomplete" } })), "error-event"],
		[stream(completedEvent({ status: "in_progress", output: [checkpoint] })) + validTerminal, "incomplete-response"],
		[stream(completedEvent({ status: "completed", output: [] })) + validTerminal, "invalid-compaction-count"],
	] as const) {
		const installed = installChunks([encoder.encode(body)]);
		expect(await promptly(executeRemoteV2Compaction({ runtime, request }))).toMatchObject({ ok: false, reason });
		expect(installed.cancel).toHaveBeenCalledTimes(1);
		expect(installed.body.locked).toBe(false);
	}
});

test("EOF without a complete terminal frame never adopts a checkpoint", async () => {
	for (const body of ["", " \n", ": only a comment\n\n", stream(outputItemDone(checkpoint)),
		validTerminal.slice(0, -1), validTerminal.slice(0, -2), validTerminal.slice(0, -10)]) {
		installChunks([encoder.encode(body)], { close: true });
		expect(await executeRemoteV2Compaction({ runtime, request })).toMatchObject({ ok: false });
	}
});

test("abort interrupts a stalled read with noncooperative cleanup and consumes late cleanup rejection", async () => {
	let rejectCancel!: (error: Error) => void;
	for (const cancel of [
		() => new Promise<void>(() => {}),
		() => new Promise<void>((_resolve, reject) => { rejectCancel = reject; }),
	]) {
		const controller = new AbortController();
		const installed = installChunks([encoder.encode(stream(outputItemDone(checkpoint)))], { cancel });
		const pending = executeRemoteV2Compaction({ runtime, request, signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort(new Error("custom abort reason"));
		expect(await promptly(pending)).toMatchObject({ ok: false, reason: "aborted" });
		expect(installed.cancel).toHaveBeenCalledTimes(1);
		expect(installed.body.locked).toBe(false);
	}
	rejectCancel(new Error("late transport failure"));
	await new Promise((resolve) => setTimeout(resolve, 0));
});

test("an abort observed with a queued terminal wins, while abort during terminal cleanup cannot undo success", async () => {
	const early = new AbortController();
	const earlyBody = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(encoder.encode(validTerminal));
			early.abort();
		},
	});
	globalThis.fetch = mock(async () => new Response(earlyBody)) as typeof fetch;
	expect(await executeRemoteV2Compaction({ runtime, request, signal: early.signal })).toMatchObject({ ok: false, reason: "aborted" });
	expect(earlyBody.locked).toBe(false);

	const late = new AbortController();
	installChunks([encoder.encode(validTerminal)], { cancel: () => late.abort() });
	expect(await executeRemoteV2Compaction({ runtime, request, signal: late.signal })).toMatchObject({ ok: true });
});

test("preserves pre-send abort, HTTP errors and body read failures", async () => {
	const controller = new AbortController();
	controller.abort();
	const fetchMock = installSse(validTerminal);
	expect(await executeRemoteV2Compaction({ runtime, request, signal: controller.signal })).toMatchObject({ ok: false, reason: "aborted" });
	expect(fetchMock).not.toHaveBeenCalled();

	globalThis.fetch = mock(async () => new Response('{"error":{"message":"unauthorized"}}', { status: 401 })) as typeof fetch;
	expect(await executeRemoteV2Compaction({ runtime, request })).toMatchObject({
		ok: false, reason: "non-2xx", status: 401, responseJson: { error: { message: "unauthorized" } },
	});
	const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("body disconnected")); } });
	globalThis.fetch = mock(async () => new Response(body)) as typeof fetch;
	expect(await executeRemoteV2Compaction({ runtime, request })).toMatchObject({ ok: false, reason: "network-error", errorMessage: "body disconnected" });
	expect(body.locked).toBe(false);
});

test("real loopback HTTP completes while the response remains open", async () => {
	globalThis.fetch = originalFetch;
	let responseEnded: (() => boolean) | undefined;
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) { /* Drain the synthetic request before streaming. */ }
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(validTerminal);
		responseEnded = () => response.writableEnded;
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("loopback server missing TCP address");
		const result = await promptly(executeRemoteV2Compaction({
			runtime: { ...runtime, responsesUrl: `http://127.0.0.1:${address.port}/responses` }, request,
		}));
		expect(result).toMatchObject({ ok: true, compactResponseId: "resp_v2", compactedWindow: [checkpoint] });
		expect(responseEnded?.()).toBe(false);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
