import { afterEach, describe, expect, test } from "bun:test";
import {
	createAssistantMessageEventStream,
	normalizeContext,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import type { ApiProvider } from "@earendil-works/pi-ai/compat";
import {
	buildResponsesWebSocketUrl,
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

function fallbackProvider(calls: { stream: number }): ApiProvider {
	return {
		api: "openai-responses",
		stream: () => {
			calls.stream += 1;
			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "start",
				partial: {
					role: "assistant",
					content: [],
					api: "openai-responses",
					provider: "generic-provider",
					model: "gpt-test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "pending",
					timestamp: 1,
				},
			});
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "fallback" }],
					api: "openai-responses",
					provider: "generic-provider",
					model: "gpt-test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			});
			stream.end();
			return stream;
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	};
}

function installFakeWebSocket(options: { fail?: boolean } = {}): { instances: FakeSocketInstance[] } {
	const instances: FakeSocketInstance[] = [];
	class FakeWebSocket {
		static instances = instances;
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
			const events = [
				{ type: "response.created", response: { id: "resp_1" } },
				{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", content: [] } },
				{ type: "response.output_text.delta", output_index: 0, delta: "hello" },
				{ type: "response.output_item.done", output_index: 0, item: {
					type: "message",
					id: "msg_1",
					status: "completed",
					content: [{ type: "output_text", text: "hello" }],
				} },
				{ type: "response.completed", response: { id: "resp_1", status: "completed" } },
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

afterEach(() => {
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

	test("sends a standard response.create frame and parses Responses events", async () => {
		const { instances } = installFakeWebSocket();
		const calls = { stream: 0 };
		const provider = createResponsesWebSocketProvider(fallbackProvider(calls), true);
		const stream = provider.stream(model(), context(), { transport: "websocket", apiKey: "test-key" });
		const events = [];
		for await (const event of stream) events.push(event);

		expect(calls.stream).toBe(0);
		expect(instances).toHaveLength(1);
		expect(instances[0]!.url).toBe("wss://example.test/v1/responses?model=gpt-test");
		expect(instances[0]!.headers?.authorization).toBe("Bearer test-key");
		const frame = JSON.parse(instances[0]!.sent[0]!) as Record<string, unknown>;
		expect(frame.type).toBe("response.create");
		expect(frame.model).toBe("gpt-test");
		expect(events.some((event) => event.type === "text_delta" && event.delta === "hello")).toBe(true);
		expect(events.at(-1)?.type).toBe("done");
	});

	test("auto falls back to the original SSE adapter before WS emits start", async () => {
		installFakeWebSocket({ fail: true });
		const calls = { stream: 0 };
		const provider = createResponsesWebSocketProvider(fallbackProvider(calls), true);
		const stream = provider.stream(model(), context(), { transport: "auto", apiKey: "test-key" });
		const events = [];
		for await (const event of stream) events.push(event);

		expect(calls.stream).toBe(1);
		expect(events.at(-1)?.type).toBe("done");
	});

	test("a disabled provider delegates even when Pi requests WebSocket", async () => {
		const calls = { stream: 0 };
		const provider = createResponsesWebSocketProvider(fallbackProvider(calls));
		const stream = provider.stream(model(), context(), { transport: "websocket", apiKey: "test-key" });
		for await (const _event of stream) {
			// drain
		}
		expect(calls.stream).toBe(1);
	});

	test("explicit SSE bypasses the WebSocket wrapper", async () => {
		const calls = { stream: 0 };
		const provider = createResponsesWebSocketProvider(fallbackProvider(calls), true);
		const stream = provider.stream(model(), context(), { transport: "sse", apiKey: "test-key" });
		for await (const _event of stream) {
			// drain
		}
		expect(calls.stream).toBe(1);
	});
});
