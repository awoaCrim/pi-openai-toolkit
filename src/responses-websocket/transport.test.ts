import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { observeContinuation } from "./notifications";
import { clearSendStats, formatSendStats } from "./stats";
import {
	getApiProvider,
	normalizeContext,
	type Api,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { isRetryableAssistantError, type FetchFunction, type StreamOptions } from "@earendil-works/pi-ai";
import {
	buildResponsesWebSocketUrl,
	closeResponsesWebSocketSessions,
	createResponsesWebSocketFetch,
	createResponsesWebSocketProvider,
	shouldUseResponsesWebSocket,
	RESPONSES_WEBSOCKET_HTTP_THRESHOLD_BYTES,
} from "./transport";

type FakeSocketEvent = { data?: unknown; code?: number; reason?: string; message?: string; error?: unknown };
type FakeSocketInstance = {
	url: string;
	headers?: Record<string, string>;
	sent: string[];
	closeCalls: number;
	emit(type: string, event: FakeSocketEvent): void;
	message(event: Record<string, unknown>): void;
	peerClose(reason?: string): void;
	listenerCount(): number;
};

const originalWebSocket = globalThis.WebSocket;

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "gpt-test",
		name: "GPT test",
		api: "openai-responses",
		provider: "generic-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		...overrides,
	} as Model<Api>;
}

function context() {
	return normalizeContext({
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
	});
}

function responseEvents(text: string, turn = 1): Array<Record<string, unknown>> {
	const output = {
		type: "message",
		id: `msg_${turn}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	return [
		{ type: "response.created", response: { id: `resp_${turn}`, status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: output },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item: output },
		{ type: "response.completed", response: {
			id: `resp_${turn}`, status: "completed", output: [output],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		} },
	];
}

function textResponse(text: string): Response {
	return new Response(responseEvents(text).map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function emitEvents(socket: FakeSocketInstance, events: Array<Record<string, unknown>>): void {
	for (const event of events) queueMicrotask(() => socket.message(event));
}

function installFakeWebSocket(options: {
	fail?: boolean;
	onOpen?: (socket: FakeSocketInstance) => void;
	onConstruct?: () => void;
	noOpen?: boolean;
	onSend?: (socket: FakeSocketInstance) => void;
} = {}): { instances: FakeSocketInstance[] } {
	const instances: FakeSocketInstance[] = [];
	class FakeWebSocket {
		private readonly listeners = new Map<string, Array<(event: FakeSocketEvent) => void>>();
		private readonly record: FakeSocketInstance;
		readyState = 0;

		constructor(url: string, init?: { headers?: Record<string, string> }) {
			this.record = {
				url, headers: init?.headers, sent: [], closeCalls: 0,
				emit: (type, event) => this.emit(type, event),
				message: (event) => this.emit("message", { data: JSON.stringify(event) }),
				peerClose: (reason) => {
					this.readyState = 3;
					this.emit("close", { code: 1006, reason });
				},
				listenerCount: () => [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.length, 0),
			};
			instances.push(this.record);
			options.onConstruct?.();
			if (options.noOpen) return;
			queueMicrotask(() => {
				if (options.fail) {
					this.emit("error", { message: "handshake failed" });
					return;
				}
				this.readyState = 1;
				this.emit("open", {});
				options.onOpen?.(this.record);
			});
		}

		addEventListener(type: string, listener: (event: FakeSocketEvent) => void): void {
			const listeners = this.listeners.get(type) ?? [];
			listeners.push(listener);
			this.listeners.set(type, listeners);
		}

		removeEventListener(type: string, listener: (event: FakeSocketEvent) => void): void {
			const listeners = this.listeners.get(type) ?? [];
			this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
		}

		send(data: string): void {
			this.record.sent.push(data);
			const request = JSON.parse(data) as { type?: string };
			if (request.type !== "response.create") throw new Error("unexpected websocket frame");
			if (options.onSend) {
				options.onSend(this.record);
				return;
			}
			const turn = this.record.sent.length;
			emitEvents(this.record, responseEvents(turn === 1 ? "hello" : "second", turn));
		}

		close(): void {
			this.record.closeCalls++;
			this.readyState = 3;
			this.emit("close", { code: 1000, reason: "done" });
		}

		private emit(type: string, event: FakeSocketEvent): void {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	return { instances };
}

function originalResponsesProvider() {
	const provider = getApiProvider("openai-responses");
	if (!provider) throw new Error("Pi openai-responses provider is not registered");
	return provider;
}

const interruption = "stream closed before response.completed";
const upstreamError = { type: "error", code: "stream_error", message: interruption };

async function collect(options: StreamOptions) {
	const events = [];
	const provider = createResponsesWebSocketProvider(originalResponsesProvider(), true);
	for await (const event of provider.stream(model(), context(), { apiKey: "test-key", maxRetries: 0, ...options })) {
		events.push(event);
	}
	return events;
}

function failureEvent(shape: "error" | "response.failed", code = "stream_error", message = interruption) {
	return shape === "error"
		? { type: "error", code, message }
		: { type: "response.failed", response: { id: "resp_fail", status: "failed", error: { code, message } } };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

const directPayload = { model: "gpt-test", input: [{ role: "user", content: "hello" }], stream: true };
function directRequest(payload: Record<string, unknown> = directPayload): RequestInit {
	return { method: "POST", headers: { "X-Custom": "preserve-me" }, body: JSON.stringify(payload) };
}

function directFetch(options: StreamOptions = {}) {
	return createResponsesWebSocketFetch(model(), { apiKey: "test-key", ...options });
}

const responsesUrl = "https://example.test/v1/responses";

afterEach(() => {
	closeResponsesWebSocketSessions();
	globalThis.WebSocket = originalWebSocket;
});

describe("size-aware HTTP routing", () => {
	const limit = RESPONSES_WEBSOCKET_HTTP_THRESHOLD_BYTES;
	function payloadAtBytes(bytes: number): typeof directPayload {
		const payload = { ...directPayload, input: [{ role: "user", content: "" }] };
		const overhead = Buffer.byteLength(JSON.stringify({ type: "response.create", ...payload }));
		payload.input[0]!.content = "x".repeat(bytes - overhead);
		expect(Buffer.byteLength(JSON.stringify({ type: "response.create", ...payload }))).toBe(bytes);
		return payload;
	}
	for (const mode of ["auto", "websocket", "websocket-cached"] as const) {
		test(`large first requests go straight to HTTP without a socket (${mode})`, async () => {
			const { instances } = installFakeWebSocket();
			const id = randomUUID(), payload = payloadAtBytes(limit);
			const init = directRequest(payload);
			let calls = 0;
			const fetch = directFetch({ sessionId: id, transport: mode, fetch: async (url, actual) => {
				calls++;
				expect(url).toBe(responsesUrl);
				expect(actual).toBe(init);
				return textResponse("HTTP success");
			} });
			expect(await (await fetch(responsesUrl, init)).text()).toContain("HTTP success");
			expect(calls).toBe(1);
			expect(instances).toHaveLength(0);
			const stats = formatSendStats(id);
			expect(stats).toContain("大请求 HTTP 1 次");
			expect(stats).toContain("SSE 回退 0 次");
			expect(stats).toContain("15 MiB");
			clearSendStats(id);
		});
	}
	test("below-threshold frames still use WebSocket", async () => {
		const { instances } = installFakeWebSocket();
		await (await directFetch({ transport: "websocket" })(responsesUrl, directRequest(payloadAtBytes(limit - 1)))).text();
		expect(instances).toHaveLength(1);
		expect(Buffer.byteLength(instances[0]!.sent[0]!)).toBe(limit - 1);
	});
	test("large full history remains on WebSocket when the actual delta is small", async () => {
		const { instances } = installFakeWebSocket();
		const payload = payloadAtBytes(limit - 1), id = randomUUID();
		const fetch = directFetch({ transport: "websocket-cached", sessionId: id, fetch: async () => { throw new Error("HTTP must not be used"); } });
		await (await fetch(responsesUrl, directRequest(payload))).text();
		const output = (responseEvents("hello").at(-1)! as any).response.output;
		const second = { ...payload, input: [...payload.input, ...output, { role: "user", content: "next" }] };
		expect(Buffer.byteLength(JSON.stringify({ type: "response.create", ...second }))).toBeGreaterThan(limit);
		await (await fetch(responsesUrl, directRequest(second))).text();
		expect(instances).toHaveLength(1);
		const sent = JSON.parse(instances[0]!.sent[1]!);
		expect(sent.previous_response_id).toBe("resp_1");
		expect(sent.input).toEqual([{ role: "user", content: "next" }]);
		expect(formatSendStats(id)).toContain("增量 1 次");
		expect(formatSendStats(id)).toContain("大请求 HTTP 0 次");
		clearSendStats(id);
	});
	for (const changed of ["large-delta", "tools", "history"] as const) {
		test(`${changed} causing an oversized frame uses full HTTP and evicts stale continuation`, async () => {
			const { instances } = installFakeWebSocket();
			const first = payloadAtBytes(limit - 1), id = randomUUID();
			let calls = 0;
			let second: Record<string, unknown>;
			const fetch = directFetch({ transport: "websocket-cached", sessionId: id, fetch: async (_url, init) => {
				calls++;
				expect(JSON.parse(init!.body as string)).toEqual(second);
				return textResponse("http");
			} });
			await (await fetch(responsesUrl, directRequest(first))).text();
			const output = (responseEvents("hello").at(-1)! as any).response.output;
			const input = [...first.input, ...output, { role: "user", content: changed === "large-delta" ? "z".repeat(limit) : "next" }];
			if (changed === "history") input[0] = { role: "user", content: "y" + first.input[0]!.content.slice(1) };
			second = { ...first, input, ...(changed === "tools" ? { tools: [{ type: "web_search" }] } : {}) };
			await (await fetch(responsesUrl, directRequest(second))).text();
			expect(calls).toBe(1);
			expect(instances[0]!.sent).toHaveLength(1);
			expect(instances[0]!.closeCalls).toBe(1);
			await (await fetch(responsesUrl, directRequest())).text();
			expect(instances).toHaveLength(2);
			expect(JSON.parse(instances[1]!.sent[0]!).previous_response_id).toBeUndefined();
			expect(formatSendStats(id)).toContain("大请求 HTTP 1 次");
			clearSendStats(id);
		});
	}
	test("measures UTF-8 bytes, not JavaScript string length", async () => {
		const { instances } = installFakeWebSocket();
		const payload = { ...directPayload, input: [{ role: "user", content: "界".repeat(6 * 1024 * 1024) }] };
		const frame = JSON.stringify({ type: "response.create", ...payload });
		expect(frame.length).toBeLessThan(limit);
		expect(Buffer.byteLength(frame)).toBeGreaterThan(limit);
		let calls = 0;
		await (await directFetch({ fetch: async () => { calls++; return textResponse("http"); } })(responsesUrl, directRequest(payload))).text();
		expect(calls).toBe(1);
		expect(instances).toHaveLength(0);
	});
	test("large Request inputs preserve headers, signal and original body bytes", async () => {
		const { instances } = installFakeWebSocket();
		const abort = new AbortController();
		const request = new Request(responsesUrl, { method: "POST", signal: abort.signal,
			headers: { Authorization: "Bearer private", "X-Probe": "preserved" }, body: JSON.stringify(payloadAtBytes(limit)) });
		await (await directFetch({ fetch: async (input, init) => {
			expect(input).toBe(request);
			expect(init).toBeUndefined();
			expect((input as Request).headers.get("X-Probe")).toBe("preserved");
			expect((input as Request).signal.aborted).toBe(false);
			expect(await (input as Request).text()).toBe(JSON.stringify(payloadAtBytes(limit)));
			return textResponse("http");
		} })(request)).text();
		expect(instances).toHaveLength(0);
	});
	test("HTTP failures propagate without retrying via WebSocket", async () => {
		const { instances } = installFakeWebSocket();
		let calls = 0;
		const fetch = directFetch({ fetch: async () => { calls++; throw new Error("HTTP rejected"); } });
		await expect(fetch(responsesUrl, directRequest(payloadAtBytes(limit)))).rejects.toThrow("HTTP rejected");
		expect(calls).toBe(1);
		expect(instances).toHaveLength(0);
	});
	test("large image and encrypted reasoning data are sent unchanged, not compacted", async () => {
		const { instances } = installFakeWebSocket();
		const payload = {
			...directPayload,
			input: [
				{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64," + "A".repeat(limit) }] },
				{ type: "reasoning", id: "rs_test", encrypted_content: "opaque-replay-data", summary: [] },
			],
		};
		let calls = 0;
		await (await directFetch({ fetch: async (_input, init) => {
			calls++;
			expect(JSON.parse(init!.body as string)).toEqual(payload);
			return textResponse("http");
		} })(responsesUrl, directRequest(payload))).text();
		expect(calls).toBe(1);
		expect(instances).toHaveLength(0);
	});
	test("a pre-aborted large request does not start HTTP or WebSocket", async () => {
		const { instances } = installFakeWebSocket();
		const abort = new AbortController();
		abort.abort();
		let calls = 0;
		const fetch = directFetch({ signal: abort.signal, fetch: async () => { calls++; return textResponse("unexpected"); } });
		await expect(fetch(responsesUrl, directRequest(payloadAtBytes(limit)))).rejects.toThrow("aborted");
		expect(calls).toBe(0);
		expect(instances).toHaveLength(0);
	});
	test("a large concurrent request does not close another turn's busy socket", async () => {
		const { instances } = installFakeWebSocket({ onSend: socket => emitEvents(socket, [responseEvents("hello")[0]!]) });
		const id = randomUUID();
		const fetch = directFetch({ transport: "websocket-cached", sessionId: id, fetch: async () => textResponse("http") });
		const response = await fetch(responsesUrl, directRequest());
		await (await fetch(responsesUrl, directRequest(payloadAtBytes(limit)))).text();
		expect(instances).toHaveLength(1);
		expect(instances[0]!.closeCalls).toBe(0);
		emitEvents(instances[0]!, responseEvents("hello").slice(1));
		await response.text();
		clearSendStats(id);
	});
});

describe("Responses WebSocket transport", () => {
	test("independent adapter instances reuse one session connection and continuation", async () => {
		const { instances } = installFakeWebSocket();
		const a = await import(`./transport.ts?instance=${randomUUID()}`);
		const b = await import(`./transport.ts?instance=${randomUUID()}`);
		const id = randomUUID();
		const options = { apiKey: "test-key", sessionId: id, transport: "websocket-cached" as const };
		await (await a.createResponsesWebSocketFetch(model(), options)(responsesUrl, directRequest())).text();
		const output = (responseEvents("hello").at(-1)! as any).response.output;
		const second = { ...directPayload, input: [...directPayload.input, ...output, { role: "user", content: "next" }] };
		await (await b.createResponsesWebSocketFetch(model(), options)(responsesUrl, directRequest(second))).text();
		expect(instances).toHaveLength(1);
		const sent = JSON.parse(instances[0]!.sent[1]!);
		expect(sent.previous_response_id).toBe("resp_1");
		expect(sent.input).toEqual([{ role: "user", content: "next" }]);
		expect(formatSendStats(id)).toContain("全量 1 次，增量 1 次");
		a.closeResponsesWebSocketSessions(id);
		clearSendStats(id);
	});
	test("requires the Toolkit feature flag and selects only GPT openai-responses models", () => {
		expect(shouldUseResponsesWebSocket(model(), { transport: "auto" })).toBe(false);
		expect(shouldUseResponsesWebSocket(model(), { transport: "auto" }, true)).toBe(true);
		expect(shouldUseResponsesWebSocket(model(), { transport: "websocket" }, true)).toBe(true);
		expect(shouldUseResponsesWebSocket(model(), { transport: "sse" }, true)).toBe(false);
		expect(shouldUseResponsesWebSocket(model({ id: "o3-mini" }), { transport: "auto" }, true)).toBe(false);
		expect(shouldUseResponsesWebSocket(model({ api: "openai-completions" }), { transport: "auto" }, true)).toBe(false);
	});

	test("builds the generic Responses WebSocket URL from the model base URL", () => {
		expect(buildResponsesWebSocketUrl(model())).toBe("wss://example.test/v1/responses?model=gpt-test");
		expect(buildResponsesWebSocketUrl(model({ baseUrl: "http://localhost:8080/v1/" }))).toBe(
			"ws://localhost:8080/v1/responses?model=gpt-test",
		);
	});

	test("sends a standard response.create frame and lets Pi parse the bridged SSE events", async () => {
		const { instances } = installFakeWebSocket();
		let fallbackCalls = 0;
		const fallback: FetchFunction = async () => {
			fallbackCalls++;
			return textResponse("fallback");
		};
		const provider = createResponsesWebSocketProvider(originalResponsesProvider(), true);
		const stream = provider.stream(model(), context(), { transport: "websocket", apiKey: "test-key", fetch: fallback });
		const events = [];
		for await (const event of stream) events.push(event);

		expect(fallbackCalls).toBe(0);
		expect(instances).toHaveLength(1);
		expect(instances[0]!.url).toBe("wss://example.test/v1/responses?model=gpt-test");
		expect(instances[0]!.headers?.authorization).toBe("Bearer test-key");
		const frame = JSON.parse(instances[0]!.sent[0]!) as Record<string, unknown>;
		expect(frame.type).toBe("response.create");
		expect(frame.model).toBe("gpt-test");
		expect(events.some((event) => event.type === "text_delta" && event.delta === "hello")).toBe(true);
		expect(events.at(-1)?.type).toBe("done");
	});

	test("preserves authorization supplied through Pi headers", async () => {
		const { instances } = installFakeWebSocket();
		const fallback: FetchFunction = async () => textResponse("fallback");
		const provider = createResponsesWebSocketProvider(originalResponsesProvider(), true);
		const stream = provider.stream(model(), context(), {
			transport: "websocket",
			headers: { authorization: "Bearer header-key" },
			fetch: fallback,
		});
		for await (const _event of stream) {
			// drain
		}
		expect(instances[0]!.headers?.authorization).toBe("Bearer header-key");
	});

	test("reuses the session socket and sends only the post-response input delta", async () => {
		const { instances } = installFakeWebSocket();
		let fallbackCalls = 0;
		const fallback: FetchFunction = async () => {
			fallbackCalls++;
			return textResponse("fallback");
		};
		const provider = createResponsesWebSocketProvider(originalResponsesProvider(), true);
		const options = { transport: "auto" as const, apiKey: "test-key", sessionId: "session-1", fetch: fallback };
		const firstEvents = [];
		for await (const event of provider.stream(model(), context(), options)) firstEvents.push(event);
		const done = firstEvents.find((event) => event.type === "done");
		if (!done || done.type !== "done") throw new Error("first response did not complete");

		const secondContext = normalizeContext({
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				done.message,
				{ role: "user", content: "second", timestamp: 3 },
			],
		});
		const secondEvents = [];
		for await (const event of provider.stream(model(), secondContext, options)) secondEvents.push(event);

		expect(fallbackCalls).toBe(0);
		expect(instances).toHaveLength(1);
		expect(instances[0]!.sent).toHaveLength(2);
		const firstFrame = JSON.parse(instances[0]!.sent[0]!) as Record<string, unknown>;
		const secondFrame = JSON.parse(instances[0]!.sent[1]!) as Record<string, unknown>;
		expect(firstFrame.previous_response_id).toBeUndefined();
		expect(secondFrame.previous_response_id).toBe("resp_1");
		expect(secondFrame.input).toHaveLength(1);
		expect(JSON.stringify(secondFrame.input)).not.toContain("hello");
		expect(secondEvents.some((event) => event.type === "text_delta" && event.delta === "second")).toBe(true);
	});

	test("auto falls back to the original HTTP/SSE fetch before WS emits a response", async () => {
		installFakeWebSocket({ fail: true });
		let fallbackCalls = 0;
		const fallback: FetchFunction = async () => {
			fallbackCalls++;
			return textResponse("fallback");
		};
		const provider = createResponsesWebSocketProvider(originalResponsesProvider(), true);
		const stream = provider.stream(model(), context(), { transport: "auto", apiKey: "test-key", fetch: fallback });
		const events = [];
		for await (const event of stream) events.push(event);

		expect(fallbackCalls).toBe(1);
		expect(events.some((event) => event.type === "text_delta" && event.delta === "fallback")).toBe(true);
		expect(events.at(-1)?.type).toBe("done");
	});

	for (const failure of ["close", "error", "send", "error-frame", "failed-frame"] as const) {
		test(`auto recovers post-open/pre-event ${failure} once`, async () => {
			const { instances } = installFakeWebSocket({ onSend: (socket) => {
				if (failure === "send") throw new Error("send failed");
				queueMicrotask(() => {
					if (failure === "close") socket.peerClose();
					else if (failure === "error") socket.emit("error", {});
					else socket.message(failureEvent(failure === "failed-frame" ? "response.failed" : "error"));
				});
			} });
			let calls = 0;
			const events = await collect({ transport: "auto", fetch: async () => { calls++; return textResponse("fallback"); } });
			expect(calls).toBe(1);
			expect(events.at(-1)?.type).toBe("done");
			expect(events.filter((e) => e.type === "text_delta").map((e) => e.delta)).toEqual(["fallback"]);
			expect(instances[0]!.listenerCount()).toBe(0);
			expect(instances[0]!.closeCalls).toBeLessThanOrEqual(1);
		});
	}

	for (const transport of ["websocket", "websocket-cached"] as const) {
		for (const shape of ["error", "response.failed"] as const) {
			test(`${transport} makes the precise ${shape} interruption retryable without SSE`, async () => {
				const original = failureEvent(shape);
				installFakeWebSocket({ onSend: (socket) => emitEvents(socket, [original]) });
				let calls = 0;
				const events = await collect({ transport, fetch: async () => { calls++; return textResponse("unexpected"); } });
				const last = events.at(-1);
				expect(calls).toBe(0);
				expect(last?.type).toBe("error");
				if (last?.type !== "error") throw new Error("expected failed attempt");
				expect(last.error.errorMessage).toContain(interruption);
				expect(isRetryableAssistantError(last.error)).toBe(true);
				expect(original).toEqual(failureEvent(shape));
			});
		}
	}

	for (const progress of ["created", "text", "tool"] as const) {
		test(`auto never splices after committed ${progress} events`, async () => {
			const frames = responseEvents("half").slice(0, progress === "created" ? 1 : 3);
			if (progress === "tool") frames.splice(1, 2,
				{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_fail", call_id: "call_fail", name: "write", arguments: "" } },
				{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":' },
			);
			installFakeWebSocket({ onSend: (socket) => emitEvents(socket, [...frames, upstreamError]) });
			let calls = 0;
			const events = await collect({ transport: "auto", fetch: async () => { calls++; return textResponse("unexpected"); } });
			const last = events.at(-1);
			expect(calls).toBe(0);
			expect(last?.type).toBe("error");
			if (last?.type !== "error") throw new Error("expected failed attempt");
			expect(isRetryableAssistantError(last.error)).toBe(true);
			if (progress === "text") expect(events.some((e) => e.type === "text_delta" && e.delta === "half")).toBe(true);
			if (progress === "tool") expect(events.some((e) => e.type === "toolcall_delta")).toBe(true);
		});
	}

	for (const shape of ["error", "response.failed"] as const) {
		for (const code of ["invalid_api_key", "authentication_error", "insufficient_quota", "billing_error", "context_length_exceeded", "invalid_request_error", "content_policy_violation", "unknown_failure"]) {
			test(`does not promote ${shape} ${code} even with the exact interruption text`, async () => {
				installFakeWebSocket({ onSend: (socket) => emitEvents(socket, [failureEvent(shape, code)]) });
				let calls = 0;
				const events = await collect({ transport: "auto", fetch: async () => { calls++; return textResponse("unexpected"); } });
				const last = events.at(-1);
				expect(calls).toBe(0);
				expect(last?.type).toBe("error");
				if (last?.type !== "error") throw new Error("expected failed attempt");
				expect(last.error.errorMessage).not.toContain("WebSocket error:");
				expect(isRetryableAssistantError(last.error)).toBe(false);
			});
		}
	}

	for (const message of ["generic stream error", `insufficient_quota: ${interruption}`, `Invalid API key: ${interruption}`, `context_length_exceeded: ${interruption}`]) {
		test(`does not broaden retry classification for ${message}`, async () => {
			installFakeWebSocket({ onSend: (socket) => emitEvents(socket, [failureEvent("error", "stream_error", message)]) });
			let calls = 0;
			const events = await collect({ transport: "auto", fetch: async () => { calls++; return textResponse("unexpected"); } });
			const last = events.at(-1);
			expect(calls).toBe(0);
			expect(last?.type).toBe("error");
			if (last?.type !== "error") throw new Error("expected failed attempt");
			expect(last.error.errorMessage).not.toContain("WebSocket error:");
		});
	}

	for (const shape of ["error", "response.failed"] as const) {
		for (const metadata of [{ type: "authentication_error" }, { status: 401 }, { status_code: 403 }, { code: 400 }]) {
			test(`rejects incompatible ${shape} error metadata ${JSON.stringify(metadata)}`, async () => {
				const frame = failureEvent(shape);
				if (shape === "error") Object.assign(frame, { error: metadata });
				else Object.assign((frame as { response: { error: unknown } }).response.error!, metadata);
				installFakeWebSocket({ onSend: (socket) => emitEvents(socket, [frame]) });
				let calls = 0;
				const events = await collect({ fetch: async () => { calls++; return textResponse("unexpected"); } });
				const last = events.at(-1);
				expect(calls).toBe(0);
				if (last?.type !== "error") throw new Error("expected failed attempt");
				expect(last.error.errorMessage).not.toContain("WebSocket error:");
			});
		}
	}

	for (const envelope of ["event", "response"] as const) {
		test(`does not ignore fatal metadata on the ${envelope} failure envelope`, async () => {
			const frame = failureEvent("response.failed");
			Object.assign(envelope === "event" ? frame : frame.response!, { status_code: 401, code: "invalid_api_key" });
			installFakeWebSocket({ onSend: (socket) => emitEvents(socket, [frame]) });
			let calls = 0;
			const events = await collect({ fetch: async () => { calls++; return textResponse("unexpected"); } });
			expect(calls).toBe(0);
			const last = events.at(-1);
			if (last?.type !== "error") throw new Error("expected failed attempt");
			expect(last.error.errorMessage).not.toContain("WebSocket error:");
		});
	}

	for (const failure of ["close", "error", "idle"] as const) {
		test(`committed local ${failure} fails retryably without SSE`, async () => {
			const { instances } = installFakeWebSocket({ onSend: (socket) => {
				emitEvents(socket, responseEvents("pending").slice(0, 1));
				if (failure === "close") queueMicrotask(() => socket.peerClose());
				if (failure === "error") queueMicrotask(() => socket.emit("error", { message: "connection lost" }));
			} });
			let calls = 0;
			// Direct body consumption isolates the WS idle budget from the SDK's
			// total request deadline, which is tested separately below.
			const response = await directFetch({ timeoutMs: failure === "idle" ? 10 : 0, fetch: async () => { calls++; return textResponse("unexpected"); } })(responsesUrl, directRequest());
			await expect(response.text()).rejects.toThrow(/WebSocket (?:error|closed|idle timeout)/);
			expect(calls).toBe(0);
			expect(instances[0]!.listenerCount()).toBe(0);
		});
	}

	test("unknown typed events commit conservatively before an interruption", async () => {
		installFakeWebSocket({ onSend: (socket) => emitEvents(socket, [{ type: "response.future_event" }, upstreamError]) });
		let calls = 0;
		const response = await directFetch({ fetch: async () => { calls++; return textResponse("unexpected"); } })(responsesUrl, directRequest());
		const text = await response.text();
		expect(text).toContain("response.future_event");
		expect(text).toContain(`WebSocket error: ${interruption}`);
		expect(calls).toBe(0);
	});

	for (const data of ["", 42, {}, JSON.stringify({ type: "" }), JSON.stringify([])]) {
		test(`invalid uncommitted frame ${JSON.stringify(data)} never authorizes fallback`, async () => {
			installFakeWebSocket({ onSend: (socket) => socket.emit("message", { data }) });
			let calls = 0;
			const response = await directFetch({ timeoutMs: 10, fetch: async () => { calls++; return textResponse("unexpected"); } })(responsesUrl, directRequest());
			await expect(response.text()).rejects.toThrow();
			expect(calls).toBe(0);
		});
	}

	for (const mode of ["sse", "auto"] as const) {
		test(`${mode} preserves original fallback/SSE error classification`, async () => {
			installFakeWebSocket({ fail: true });
			let calls = 0;
			const events = await collect({ transport: mode, fetch: async () => {
				calls++;
				return new Response(`event: error\ndata: ${JSON.stringify(upstreamError)}\n\n`, { headers: { "content-type": "text/event-stream" } });
			} });
			const last = events.at(-1);
			expect(calls).toBe(1);
			if (last?.type !== "error") throw new Error("expected native SSE failure");
			expect(last.error.errorMessage).toBe(interruption);
			expect(isRetryableAssistantError(last.error)).toBe(false);
		});
	}

	for (const error of [new Error("Request was aborted"), new Error("Response stream was cancelled"), Object.assign(new Error("operation stopped"), { name: "AbortError" })]) {
		test(`send cancellation ${error.name}: ${error.message} is not promoted`, async () => {
			installFakeWebSocket({ onSend: () => { throw error; } });
			let calls = 0;
			const response = await directFetch({ fetch: async () => { calls++; return textResponse("unexpected"); } })(responsesUrl, directRequest());
			await expect(response.text()).rejects.toThrow(error.message);
			expect(calls).toBe(0);
		});
	}

	test("abort just before fallback does not issue HTTP", async () => {
		const controller = new AbortController();
		installFakeWebSocket({ onSend: (socket) => {
			socket.emit("error", { message: "connection lost" });
			controller.abort();
		} });
		let calls = 0;
		await expect(directFetch({ signal: controller.signal, fetch: async () => { calls++; return textResponse("unexpected"); } })(responsesUrl, directRequest())).rejects.toThrow(/abort/i);
		expect(calls).toBe(0);
	});

	test("protocol/policy socket rejection never authorizes fallback", async () => {
		installFakeWebSocket({ onSend: (socket) => socket.emit("close", { code: 1008, reason: "request rejected" }) });
		let calls = 0;
		const response = await directFetch({ fetch: async () => { calls++; return textResponse("unexpected"); } })(responsesUrl, directRequest());
		await expect(response.text()).rejects.toThrow("Responses connection rejected (1008): request rejected");
		expect(calls).toBe(0);
	});

	test("constructor-time abort settles even if the socket never opens", async () => {
		const controller = new AbortController();
		const { instances } = installFakeWebSocket({ noOpen: true, onConstruct: () => controller.abort() });
		let calls = 0;
		await expect(directFetch({ signal: controller.signal, websocketConnectTimeoutMs: 20,
			fetch: async () => { calls++; return textResponse("unexpected"); },
		})(responsesUrl, directRequest())).rejects.toThrow(/abort/i);
		expect(calls).toBe(0);
		expect(instances[0]!.listenerCount()).toBe(0);
		expect(instances[0]!.closeCalls).toBe(1);
	});

	test("Request.signal cancels bootstrap with a null init signal", async () => {
		const sent = deferred<void>();
		const controller = new AbortController();
		const { instances } = installFakeWebSocket({ onSend: () => sent.resolve() });
		let calls = 0;
		const request = new Request(responsesUrl, { ...directRequest(), signal: controller.signal });
		const promise = directFetch({ fetch: async () => { calls++; return textResponse("unexpected"); } })(request, { signal: null });
		await sent.promise;
		controller.abort();
		await expect(promise).rejects.toThrow(/abort/i);
		expect(calls).toBe(0);
		expect(instances[0]!.listenerCount()).toBe(0);
	});

	test("malformed frames fail rather than silently replaying", async () => {
		const { instances } = installFakeWebSocket({ onSend: (socket) => queueMicrotask(() => socket.emit("message", { data: "not JSON" })) });
		let calls = 0;
		const events = await collect({ transport: "auto", fetch: async () => { calls++; return textResponse("unexpected"); } });
		expect(calls).toBe(0);
		expect(events.at(-1)?.type).toBe("error");
		expect(instances[0]!.listenerCount()).toBe(0);
	});

	test("cached delta failure falls back with full opaque input and evicts continuation", async () => {
		const { instances } = installFakeWebSocket({ onSend: (socket) => {
			if (socket.sent.length === 2) queueMicrotask(() => socket.peerClose());
			else emitEvents(socket, responseEvents("hello"));
		} });
		let calls = 0;
		let fallbackBody: unknown;
		const fetch = directFetch({ transport: "auto", sessionId: "recovery-session", fetch: async (input, init) => {
			calls++;
			const request = new Request(input, init);
			expect(request.headers.get("X-Custom")).toBe("preserve-me");
			fallbackBody = await request.json();
			return textResponse("fallback");
		} });
		const first = { ...directPayload, input: [{ type: "compaction", encrypted_content: "opaque-active-window" }, ...directPayload.input] };
		await (await fetch(responsesUrl, directRequest(first))).text();
		const terminal = responseEvents("hello").at(-1)! as { response: { output: unknown[] } };
		const full = { ...first, input: [...first.input, ...terminal.response.output, { role: "user", content: "current-tail" }] };
		await (await fetch(responsesUrl, directRequest(full))).text();
		expect(calls).toBe(1);
		expect(fallbackBody).toEqual(full);
		const delta = JSON.parse(instances[0]!.sent[1]!);
		expect(delta.previous_response_id).toBe("resp_1");
		expect(delta.input).toEqual([{ role: "user", content: "current-tail" }]);
		await (await fetch(responsesUrl, directRequest(full))).text();
		expect(instances).toHaveLength(2);
		const next = JSON.parse(instances[1]!.sent[0]!);
		expect(next.previous_response_id).toBeUndefined();
		expect(next.input).toEqual(full.input);
	});

	test("pre-abort and abort between acquire and send never dispatch or fallback", async () => {
		let calls = 0;
		const controller = new AbortController();
		controller.abort();
		const { instances } = installFakeWebSocket();
		const fetch = directFetch({ signal: controller.signal, fetch: async () => { calls++; return textResponse("unexpected"); } });
		await expect(fetch(responsesUrl, directRequest())).rejects.toThrow(/abort/i);
		expect(instances).toHaveLength(0);
		const gapController = new AbortController();
		const gap = installFakeWebSocket({ onOpen: () => gapController.abort() });
		await expect(directFetch({ signal: gapController.signal, fetch: async () => { calls++; return textResponse("unexpected"); } })(responsesUrl, directRequest())).rejects.toThrow(/abort/i);
		expect(calls).toBe(0);
		expect(gap.instances[0]!.sent).toHaveLength(0);
		expect(gap.instances[0]!.listenerCount()).toBe(0);
	});

	test("abort breaks a stuck bootstrap decode and late frames cannot revive it", async () => {
		const started = deferred<void>();
		const bytes = deferred<ArrayBuffer>();
		const controller = new AbortController();
		const { instances } = installFakeWebSocket({ onSend: (socket) => socket.emit("message", { data: { arrayBuffer: () => {
			started.resolve();
			return bytes.promise;
		} } }) });
		let calls = 0;
		const promise = directFetch({ signal: controller.signal, fetch: async () => { calls++; return textResponse("unexpected"); } })(responsesUrl, directRequest());
		await started.promise;
		controller.abort();
		await expect(promise).rejects.toThrow(/abort/i);
		bytes.resolve(new TextEncoder().encode(JSON.stringify(responseEvents("late")[0])).buffer);
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toBe(0);
		expect(instances[0]!.closeCalls).toBe(1);
		expect(instances[0]!.listenerCount()).toBe(0);
	});

	test("the native SDK deadline cancels bootstrap rather than issuing a fallback", async () => {
		const { instances } = installFakeWebSocket({ onSend: () => {} });
		let calls = 0;
		const events = await collect({ timeoutMs: 10, transport: "auto", fetch: async () => { calls++; return textResponse("unexpected"); } });
		expect(calls).toBe(0);
		expect(events.at(-1)?.type).toBe("error");
		expect(instances[0]!.listenerCount()).toBe(0);
	});

	test("idle timeout can recover while a decoder never resolves", async () => {
		const { instances } = installFakeWebSocket({ onSend: (socket) => socket.emit("message", { data: { arrayBuffer: () => new Promise(() => {}) } }) });
		let calls = 0;
		const response = await directFetch({ timeoutMs: 10, fetch: async () => { calls++; return textResponse("fallback"); } })(responsesUrl, directRequest());
		expect(await response.text()).toContain("fallback");
		expect(calls).toBe(1);
		expect(instances[0]!.listenerCount()).toBe(0);
	});

	test("decoder order preserves completion before a trailing close", async () => {
		const bytes = deferred<ArrayBuffer>();
		installFakeWebSocket({ onSend: (socket) => {
			const frames = responseEvents("ordered");
			socket.emit("message", { data: { arrayBuffer: () => bytes.promise } });
			emitEvents(socket, frames.slice(1));
			queueMicrotask(() => socket.peerClose());
			setTimeout(() => bytes.resolve(new TextEncoder().encode(JSON.stringify(frames[0])).buffer), 5);
		} });
		let calls = 0;
		const response = await directFetch({ fetch: async () => { calls++; return textResponse("unexpected"); } })(responsesUrl, directRequest());
		const text = await response.text();
		expect(calls).toBe(0);
		expect(text.indexOf("response.created")).toBeLessThan(text.indexOf("response.completed"));
		expect(text).toContain("ordered");
	});

	test("consumer body cancellation evicts a committed socket without fallback", async () => {
		const { instances } = installFakeWebSocket({ onSend: (socket) => emitEvents(socket, responseEvents("pending").slice(0, 1)) });
		let calls = 0;
		const response = await directFetch({ sessionId: "cancel-session", fetch: async () => { calls++; return textResponse("unexpected"); } })(responsesUrl, directRequest());
		await response.body!.cancel();
		expect(calls).toBe(0);
		expect(instances[0]!.listenerCount()).toBe(0);
		expect(instances[0]!.closeCalls).toBe(1);
	});

	test("a disabled provider delegates without touching WebSocket", async () => {
		const calls = { stream: 0 };
		const original = {
			api: "openai-responses" as const,
			stream() {
				calls.stream++;
				throw new Error("delegated");
			},
			streamSimple() {
				throw new Error("delegated");
			},
		};
		const provider = createResponsesWebSocketProvider(original, false);
		expect(() => provider.stream(model(), context(), { transport: "websocket", apiKey: "test-key" })).toThrow("delegated");
		expect(calls.stream).toBe(1);
	});

	test("explicit SSE bypasses the WebSocket wrapper", async () => {
		const fallback: FetchFunction = async () => textResponse("sse");
		const provider = createResponsesWebSocketProvider(originalResponsesProvider(), true);
		const stream = provider.stream(model(), context(), { transport: "sse", apiKey: "test-key", fetch: fallback });
		const events = [];
		for await (const event of stream) events.push(event);
		expect(events.some((event) => event.type === "text_delta" && event.delta === "sse")).toBe(true);
	});
});


describe("Responses replay metadata", () => {
 const cases: Array<{name:string; original:Record<string,unknown>; replay:Record<string,unknown>; delta:boolean}> = [
  {name:"completed function status",original:{type:"function_call",id:"fc_1",call_id:"call_1",name:"bash",arguments:'{"command":"pwd"}',status:"completed"},replay:{type:"function_call",id:"fc_1",call_id:"call_1",name:"bash",arguments:'{"command":"pwd"}'},delta:true},
  {name:"completed custom tool status",original:{type:"custom_tool_call",id:"ctc_1",call_id:"call_1",name:"patch",input:"patch text",status:"completed"},replay:{type:"custom_tool_call",id:"ctc_1",call_id:"call_1",name:"patch",input:"patch text"},delta:true},
  {name:"output text logprobs",original:{type:"message",role:"assistant",id:"msg_1",status:"completed",content:[{type:"output_text",text:"hello",annotations:[],logprobs:[]}]},replay:{type:"message",role:"assistant",id:"msg_1",status:"completed",content:[{type:"output_text",text:"hello",annotations:[]}]},delta:true},
  {name:"changed arguments",original:{type:"function_call",id:"fc_1",call_id:"call_1",name:"bash",arguments:'{"command":"pwd"}',status:"completed"},replay:{type:"function_call",id:"fc_1",call_id:"call_1",name:"bash",arguments:'{"command":"ls"}'},delta:false},
  {name:"unfinished tool status",original:{type:"function_call",id:"fc_1",call_id:"call_1",name:"bash",arguments:"{}",status:"in_progress"},replay:{type:"function_call",id:"fc_1",call_id:"call_1",name:"bash",arguments:"{}"},delta:false},
 ];
 for (const c of cases) test(c.name, async () => {
  const events=[{type:"response.completed",response:{id:"resp_metadata",status:"completed",output:[c.original]}}];
  const {instances}=installFakeWebSocket({onSend:socket=>emitEvents(socket,events)});
  const fetch=directFetch({transport:"websocket-cached",sessionId:"metadata"});
  await (await fetch(responsesUrl,directRequest())).text();
  const payload={...directPayload,input:[...directPayload.input,c.replay,{role:"user",content:"next"}]};
  await (await fetch(responsesUrl,directRequest(payload))).text();
  const sent=JSON.parse(instances[0]!.sent[1]!);
  expect(!!sent.previous_response_id).toBe(c.delta);
  expect(sent.input).toEqual(c.delta?[{role:"user",content:"next"}]:payload.input);
  expect(c.original).toEqual(events[0]!.response.output[0]);
 });
});


test("continuation diagnostics distinguish expected rebuilds from prefix changes", async () => {
 const outcomes: string[] = [];
 const dispose = observeContinuation("diagnostics", outcome => outcomes.push(outcome));
 try {
  installFakeWebSocket({onSend: socket => emitEvents(socket, responseEvents("hello"))});
  const fetch = directFetch({transport:"websocket-cached",sessionId:"diagnostics"});
  await (await fetch(responsesUrl,directRequest())).text();
  const output = (responseEvents("hello").at(-1)! as any).response.output;
  const full = {...directPayload,input:[...directPayload.input,...output,{role:"user",content:"next"}]};
  await (await fetch(responsesUrl,directRequest(full))).text();
  const changed = {...full,input:[{role:"user",content:"edited"},...full.input.slice(1),...output,{role:"user",content:"tail"}]};
  await (await fetch(responsesUrl,directRequest(changed))).text();
  await (await fetch(responsesUrl,directRequest())).text();
  await (await fetch(responsesUrl,directRequest({...directPayload,tools:[{type:"web_search"}]}))).text();
  expect(outcomes).toEqual(["expected-full","delta","prefix-mismatch","expected-full","expected-full"]);
  expect(formatSendStats("diagnostics")).toContain("全量 4 次，增量 1 次");
  expect(formatSendStats("diagnostics")).toContain("历史前缀不匹配");
  expect(formatSendStats("diagnostics")).toContain("请求设置发生变化");
  clearSendStats("diagnostics");
 } finally { dispose(); }
});
