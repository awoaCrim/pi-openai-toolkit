import type {
	Api,
	FetchFunction,
	Model,
	SimpleStreamOptions,
	StreamOptions,
} from "@earendil-works/pi-ai";
import type { ApiProvider } from "@earendil-works/pi-ai/compat";

const RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CONNECTING = 0;
const TERMINAL_EVENTS = new Set([
	"response.completed",
	"response.done",
	"response.incomplete",
	"response.failed",
	"error",
]);

type ResponsesPayload = Record<string, unknown>;
type WebSocketEvent = {
	data?: unknown;
	message?: string;
	error?: unknown;
	code?: number;
	reason?: string;
};
type WebSocketLike = {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: (event: WebSocketEvent) => void): void;
	removeEventListener(type: string, listener: (event: WebSocketEvent) => void): void;
};
type WebSocketConstructor = new (url: string, options?: { headers?: Record<string, string> }) => WebSocketLike;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isGptResponsesModel(model: Model<Api>): boolean {
	return model.api === "openai-responses" && /^gpt/iu.test(model.id);
}

function transportMode(options: Pick<StreamOptions, "transport"> | undefined): NonNullable<StreamOptions["transport"]> {
	return options?.transport ?? "auto";
}

export function shouldUseResponsesWebSocket(
	model: Model<Api>,
	options?: Pick<StreamOptions, "transport">,
	enabled = false,
): boolean {
	return enabled && isGptResponsesModel(model) && transportMode(options) !== "sse";
}

function cleanBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/u, "");
}

export function buildResponsesWebSocketUrl(model: Model<Api>): string {
	const base = cleanBaseUrl(model.baseUrl);
	const endpoint = base.endsWith("/responses") ? base : `${base}/responses`;
	const url = new URL(endpoint);
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	url.searchParams.set("model", model.id);
	return url.toString();
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
	if (init?.method) return init.method.toUpperCase();
	if (typeof input !== "string" && !(input instanceof URL) && "method" in input) {
		return String(input.method || "GET").toUpperCase();
	}
	return "GET";
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
	const headers = new Headers();
	if (typeof input !== "string" && !(input instanceof URL) && "headers" in input) {
		new Headers(input.headers).forEach((value, name) => headers.set(name, value));
	}
	if (init?.headers) {
		new Headers(init.headers).forEach((value, name) => headers.set(name, value));
	}
	return headers;
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | undefined> {
	const body = init?.body as unknown;
	if (typeof body === "string") return body;
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	if (ArrayBuffer.isView(body)) {
		return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
	}
	if (body && typeof body === "object" && "text" in body && typeof body.text === "function") {
		return await (body.text as () => Promise<string>)();
	}
	if (typeof input !== "string" && !(input instanceof URL) && "clone" in input && typeof input.clone === "function") {
		return await input.clone().text();
	}
	return undefined;
}

function hasHeader(headers: Headers, name: string): boolean {
	const value = headers.get(name);
	return value !== null && value.trim().length > 0;
}

function buildWebSocketHeaders(
	model: Model<Api>,
	options: StreamOptions,
	requestHeadersFromFetch: Headers,
	requestId: string,
): Record<string, string> {
	const headers = new Headers();
	for (const source of [model.headers, options.headers]) {
		for (const [name, value] of Object.entries(source ?? {})) {
			if (value === null) headers.delete(name);
			else if (typeof value === "string" && value.trim()) headers.set(name, value);
		}
	}
	requestHeadersFromFetch.forEach((value, name) => {
		if (value.trim()) headers.set(name, value);
	});
	if (!hasHeader(headers, "authorization") && options.apiKey?.trim()) {
		const apiKey = options.apiKey.trim();
		headers.set("Authorization", apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`);
	}
	if (!hasHeader(headers, "authorization") && !hasHeader(headers, "cf-aig-authorization")) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}
	if (!hasHeader(headers, "openai-beta")) headers.set("OpenAI-Beta", RESPONSES_WEBSOCKET_BETA);
	if (!hasHeader(headers, "x-client-request-id")) headers.set("X-Client-Request-Id", requestId);
	return Object.fromEntries(headers.entries());
}

function socketError(event: WebSocketEvent): Error {
	if (typeof event.message === "string" && event.message.length > 0) return new Error(event.message);
	if (event.error instanceof Error) return event.error;
	return new Error("WebSocket transport failed");
}

function closeSocket(socket: WebSocketLike | undefined, reason = "done"): void {
	if (!socket) return;
	if (socket.readyState === WEBSOCKET_OPEN || socket.readyState === WEBSOCKET_CONNECTING) {
		try {
			socket.close(1000, reason);
		} catch {
			// The provider socket is already gone.
		}
	}
}

function liveSignals(options: StreamOptions, init?: RequestInit): AbortSignal[] {
	return [options.signal, init?.signal].filter((signal): signal is AbortSignal => signal !== undefined);
}

async function connectWebSocket(
	url: string,
	headers: Record<string, string>,
	signals: AbortSignal[],
	timeoutMs: number,
): Promise<WebSocketLike> {
	const WebSocketCtor = globalThis.WebSocket as unknown as WebSocketConstructor | undefined;
	if (typeof WebSocketCtor !== "function") throw new Error("WebSocket transport is not available in this runtime");
	if (signals.some((signal) => signal.aborted)) throw new Error("Request was aborted");

	return new Promise((resolve, reject) => {
		let socket: WebSocketLike | undefined;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			socket?.removeEventListener("open", onOpen);
			socket?.removeEventListener("error", onError);
			socket?.removeEventListener("close", onClose);
			for (const signal of signals) signal.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			closeSocket(socket, "connect_failed");
			reject(error);
		};
		const onOpen = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket!);
		};
		const onError = (event: WebSocketEvent) => fail(socketError(event));
		const onClose = (event: WebSocketEvent) => fail(new Error(
			`WebSocket closed${typeof event.code === "number" ? ` ${event.code}` : ""}${event.reason ? ` ${event.reason}` : ""}`,
		));
		const onAbort = () => fail(new Error("Request was aborted"));

		try {
			socket = new WebSocketCtor(url, { headers });
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs > 0) timeout = setTimeout(() => fail(new Error(`WebSocket connect timeout after ${timeoutMs}ms`)), timeoutMs);
	});
}

async function decodeSocketData(value: unknown): Promise<string | undefined> {
	if (typeof value === "string") return value;
	if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
	if (ArrayBuffer.isView(value)) return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	if (isRecord(value) && typeof value.arrayBuffer === "function") {
		const bytes = await (value.arrayBuffer as () => Promise<ArrayBuffer>)();
		return new TextDecoder().decode(new Uint8Array(bytes));
	}
	return undefined;
}

function createSseResponse(socket: WebSocketLike, signals: AbortSignal[], idleTimeoutMs: number): Response {
	const encoder = new TextEncoder();
	let cancelBody: (reason?: unknown) => void = () => closeSocket(socket, "consumer_cancelled");
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			let sawTerminal = false;
			const cleanup = () => {
				if (idleTimer) clearTimeout(idleTimer);
				socket.removeEventListener("message", onMessage);
				socket.removeEventListener("error", onError);
				socket.removeEventListener("close", onClose);
				for (const signal of signals) signal.removeEventListener("abort", onAbort);
			};
			const finish = () => {
				if (closed) return;
				closed = true;
				cleanup();
				closeSocket(socket);
				controller.close();
			};
			const fail = (error: unknown) => {
				if (closed) return;
				closed = true;
				cleanup();
				closeSocket(socket, "stream_failed");
				controller.error(error);
			};
			const armIdleTimer = () => {
				if (idleTimeoutMs <= 0) return;
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => fail(new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`)), idleTimeoutMs);
			};
			const onMessage = (event: WebSocketEvent) => {
				void (async () => {
					try {
						const text = await decodeSocketData(event.data);
						if (!text) return;
						const parsed: unknown = JSON.parse(text);
						if (!isRecord(parsed) || typeof parsed.type !== "string") throw new Error("Invalid Responses WebSocket event");
						controller.enqueue(encoder.encode(`event: ${parsed.type}\ndata: ${JSON.stringify(parsed)}\n\n`));
						armIdleTimer();
						if (TERMINAL_EVENTS.has(parsed.type)) {
							sawTerminal = true;
							finish();
						}
					} catch (error) {
						fail(error);
					}
				})();
			};
			const onError = (event: WebSocketEvent) => fail(socketError(event));
			const onClose = (event: WebSocketEvent) => {
				if (sawTerminal) finish();
				else fail(new Error(`WebSocket closed before response completion${event.reason ? `: ${event.reason}` : ""}`));
			};
			const onAbort = () => fail(new Error("Request was aborted"));

			cancelBody = (reason) => fail(reason instanceof Error ? reason : new Error("Response stream was cancelled"));
			socket.addEventListener("message", onMessage);
			socket.addEventListener("error", onError);
			socket.addEventListener("close", onClose);
			for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
			armIdleTimer();
		},
		cancel(reason) {
			cancelBody(reason);
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream", connection: "keep-alive" },
	});
}

function isResponsesPost(input: RequestInfo | URL, init?: RequestInit): boolean {
	if (requestMethod(input, init) !== "POST") return false;
	try {
		return new URL(requestUrl(input)).pathname.replace(/\/+$/u, "").endsWith("/responses");
	} catch {
		return false;
	}
}

/**
 * Adapt the Responses WebSocket frame protocol to the HTTP/SSE surface already
 * consumed by Pi's stock openai-responses adapter. This keeps payload building,
 * tool conversion, usage accounting, and event normalization in Pi itself.
 */
export function createResponsesWebSocketFetch(model: Model<Api>, options: StreamOptions): FetchFunction {
	const fallback = options.fetch ?? globalThis.fetch;
	if (typeof fallback !== "function") throw new Error("HTTP fetch is not available in this runtime");
	return async (input, init) => {
		if (!isResponsesPost(input, init) || transportMode(options) === "sse") return fallback(input, init);
		const bodyText = await requestBody(input, init);
		if (!bodyText) return fallback(input, init);
		let payload: unknown;
		try {
			payload = JSON.parse(bodyText);
		} catch {
			return fallback(input, init);
		}
		if (!isRecord(payload)) return fallback(input, init);

		const signals = liveSignals(options, init);
		const requestId = options.sessionId?.slice(0, 64) || crypto.randomUUID();
		const headers = buildWebSocketHeaders(model, options, requestHeaders(input, init), requestId);
		let socket: WebSocketLike | undefined;
		try {
			socket = await connectWebSocket(
				buildResponsesWebSocketUrl(model),
				headers,
				signals,
				options.websocketConnectTimeoutMs ?? 15_000,
			);
			socket.send(JSON.stringify({ type: "response.create", ...payload }));
			return createSseResponse(socket, signals, options.timeoutMs ?? 0);
		} catch (error) {
			closeSocket(socket, "connect_failed");
			if (transportMode(options) === "auto" && !signals.some((signal) => signal.aborted)) {
				return fallback(input, init);
			}
			throw error;
		}
	};
}

function withWebSocketFetch<T extends StreamOptions>(model: Model<Api>, options?: T): T {
	const effective = options ?? ({} as T);
	return {
		...effective,
		fetch: createResponsesWebSocketFetch(model, effective),
	};
}

export function createResponsesWebSocketProvider(original: ApiProvider, enabled = false): ApiProvider {
	return {
		api: "openai-responses",
		stream(model, context, options) {
			if (!shouldUseResponsesWebSocket(model, options, enabled)) return original.stream(model, context, options);
			return original.stream(model, context, withWebSocketFetch(model, options));
		},
		streamSimple(model, context, options) {
			if (!shouldUseResponsesWebSocket(model, options, enabled)) return original.streamSimple(model, context, options);
			return original.streamSimple(model, context, withWebSocketFetch(model, options));
		},
	};
}
