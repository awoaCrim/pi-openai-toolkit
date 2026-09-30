import { afterEach, describe, expect, test } from "bun:test";
import {
	getApiProvider,
	normalizeContext,
	type Api,
	type Model,
} from "@earendil-works/pi-ai/compat";
import type { FetchFunction } from "@earendil-works/pi-ai";
import {
	buildResponsesWebSocketUrl,
	closeResponsesWebSocketSessions,
	createResponsesWebSocketProvider,
	shouldUseResponsesWebSocket,
} from "./transport";

type FakeSocketEvent = { data?: unknown; code?: number; reason?: string; message?: string; error?: unknown };
type FakeSocketInstance = {
	url: string;
	headers?: Record<string, string>;
	sent: string[];
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

function textResponse(text: string): Response {
	const output = {
		type: "message",
		id: "msg_1",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	const events = [
		{ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: output },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item: output },
		{ type: "response.completed", response: {
			id: "resp_1", status: "completed", output: [output],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		} },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function installFakeWebSocket(options: { fail?: boolean } = {}): { instances: FakeSocketInstance[] } {
	const instances: FakeSocketInstance[] = [];
	class FakeWebSocket {
		private readonly listeners = new Map<string, Array<(event: FakeSocketEvent) => void>>();
		private readonly record: FakeSocketInstance;
		readyState = 0;

		constructor(url: string, init?: { headers?: Record<string, string> }) {
			this.record = { url, headers: init?.headers, sent: [] };
			instances.push(this.record);
			queueMicrotask(() => {
				if (options.fail) {
					this.emit("error", { message: "handshake failed" });
					return;
				}
				this.readyState = 1;
				this.emit("open", {});
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
			const turn = this.record.sent.length;
			const text = turn === 1 ? "hello" : "second";
			const output = {
				type: "message",
				id: `msg_${turn}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			};
			const events = [
				{ type: "response.created", response: { id: `resp_${turn}`, status: "in_progress", output: [] } },
				{ type: "response.output_item.added", output_index: 0, item: output },
				{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
				{ type: "response.output_item.done", output_index: 0, item: output },
				{ type: "response.completed", response: {
					id: `resp_${turn}`, status: "completed", output: [output],
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				} },
			];
			for (const event of events) queueMicrotask(() => this.emit("message", { data: JSON.stringify(event) }));
		}

		close(): void {
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

afterEach(() => {
	closeResponsesWebSocketSessions();
	globalThis.WebSocket = originalWebSocket;
});

describe("Responses WebSocket transport", () => {
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
