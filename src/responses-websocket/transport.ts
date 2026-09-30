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
const CACHE_IDLE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_AGE_MS = 55 * 60 * 1000;
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
type CachedContinuation = {
	lastRequestBody: ResponsesPayload;
	lastResponseId: string;
	lastResponseItems: unknown[];
};
type CachedSocketEntry = {
	key: string;
	sessionId: string;
	socket: WebSocketLike;
	busy: boolean;
	createdAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: CachedContinuation;
};
type AcquiredSocket = {
	socket: WebSocketLike;
	entry?: CachedSocketEntry;
	release(keep: boolean): void;
};

const cachedSockets = new Map<string, CachedSocketEntry>();

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

function mergeHeaders(
	modelHeaders: Record<string, string> | undefined,
	optionHeaders: Record<string, string | null> | undefined,
	requestHeadersFromFetch: Headers,
): Headers {
	const headers = new Headers();
	for (const source of [modelHeaders, optionHeaders]) {
		for (const [name, value] of Object.entries(source ?? {})) {
			if (value === null) headers.delete(name);
			else if (typeof value === "string" && value.trim()) headers.set(name, value);
		}
	}
	requestHeadersFromFetch.forEach((value, name) => {
		if (value.trim()) headers.set(name, value);
	});
	return headers;
}

function buildWebSocketHeaders(
	model: Model<Api>,
	options: StreamOptions,
	requestHeadersFromFetch: Headers,
	requestId: string,
): Record<string, string> {
	const headers = mergeHeaders(model.headers, options.headers, requestHeadersFromFetch);
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

function stableHash(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

function buildCacheKey(model: Model<Api>, options: StreamOptions, requestHeadersFromFetch: Headers): string | undefined {
	if (!options.sessionId || options.cacheRetention === "none") return undefined;
	const headers = mergeHeaders(model.headers, options.headers, requestHeadersFromFetch);
	if (!hasHeader(headers, "authorization") && options.apiKey?.trim()) {
		const apiKey = options.apiKey.trim();
		headers.set("authorization", apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`);
	}
	// Request ids identify individual calls and must not split one Pi session into
	// a fresh cache entry on every turn. The remaining headers capture auth and
	// provider-specific routing that must not be mixed across sockets.
	headers.delete("x-client-request-id");
	const identity = [...headers.entries()].sort(([a], [b]) => a.localeCompare(b));
	return [model.provider, model.id, cleanBaseUrl(model.baseUrl), options.sessionId, stableHash(JSON.stringify(identity))].join("\u0000");
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

function socketReusable(socket: WebSocketLike): boolean {
	return socket.readyState === WEBSOCKET_OPEN;
}

function removeCachedSocket(entry: CachedSocketEntry, reason: string): void {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	if (cachedSockets.get(entry.key) === entry) cachedSockets.delete(entry.key);
	closeSocket(entry.socket, reason);
}

function scheduleCachedSocketExpiry(entry: CachedSocketEntry): void {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	const remainingAge = CACHE_MAX_AGE_MS - (Date.now() - entry.createdAt);
	const delay = Math.min(CACHE_IDLE_TTL_MS, remainingAge);
	if (delay <= 0) {
		removeCachedSocket(entry, "connection_age_limit");
		return;
	}
	entry.idleTimer = setTimeout(() => {
		if (!entry.busy) removeCachedSocket(entry, "idle_timeout");
	}, delay);
	(entry.idleTimer as unknown as { unref?: () => void }).unref?.();
}

export function closeResponsesWebSocketSessions(sessionId?: string): void {
	for (const entry of [...cachedSockets.values()]) {
		if (sessionId === undefined || entry.sessionId === sessionId) removeCachedSocket(entry, "session_closed");
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

async function acquireWebSocket(
	url: string,
	headers: Record<string, string>,
	signals: AbortSignal[],
	connectTimeoutMs: number,
	cacheKey: string | undefined,
	sessionId: string | undefined,
): Promise<AcquiredSocket> {
	if (cacheKey) {
		const cached = cachedSockets.get(cacheKey);
		if (cached) {
			if (!socketReusable(cached.socket) || Date.now() - cached.createdAt >= CACHE_MAX_AGE_MS) {
				removeCachedSocket(cached, "cache_expired");
			} else if (!cached.busy) {
				if (cached.idleTimer) clearTimeout(cached.idleTimer);
				cached.idleTimer = undefined;
				cached.busy = true;
				return {
					socket: cached.socket,
					entry: cached,
					release(keep) {
						if (keep && socketReusable(cached.socket) && Date.now() - cached.createdAt < CACHE_MAX_AGE_MS) {
							cached.busy = false;
							scheduleCachedSocketExpiry(cached);
						} else {
							removeCachedSocket(cached, "request_finished");
						}
					},
				};
			}
		}
	}

	const socket = await connectWebSocket(url, headers, signals, connectTimeoutMs);
	if (!cacheKey || !sessionId || cachedSockets.has(cacheKey)) {
		return { socket, release: () => closeSocket(socket, "request_finished") };
	}
	const entry: CachedSocketEntry = { key: cacheKey, sessionId, socket, busy: true, createdAt: Date.now() };
	cachedSockets.set(cacheKey, entry);
	return {
		socket,
		entry,
		release(keep) {
			if (keep && socketReusable(entry.socket) && Date.now() - entry.createdAt < CACHE_MAX_AGE_MS) {
				entry.busy = false;
				scheduleCachedSocketExpiry(entry);
			} else {
				removeCachedSocket(entry, "request_finished");
			}
		},
	};
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function responseInputsEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => responseInputsEqual(value, b[index]));
	}
	if (isRecord(a) || isRecord(b)) {
		if (!isRecord(a) || !isRecord(b)) return false;
		const aKeys = Object.keys(a).sort();
		const bKeys = Object.keys(b).sort();
		return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index] && responseInputsEqual(a[key], b[key]));
	}
	return false;
}

function requestBodyWithoutInput(body: ResponsesPayload): ResponsesPayload {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	return rest;
}

function requestBodiesMatchExceptInput(a: ResponsesPayload, b: ResponsesPayload): boolean {
	return responseInputsEqual(requestBodyWithoutInput(a), requestBodyWithoutInput(b));
}

function inputItems(body: ResponsesPayload): unknown[] {
	return Array.isArray(body.input) ? body.input : [];
}

function buildCachedRequestBody(entry: CachedSocketEntry, body: ResponsesPayload): ResponsesPayload {
	const continuation = entry.continuation;
	if (!continuation) return body;
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		entry.continuation = undefined;
		return body;
	}
	const currentInput = inputItems(body);
	const baseline = [...inputItems(continuation.lastRequestBody), ...continuation.lastResponseItems];
	if (currentInput.length < baseline.length || !responseInputsEqual(currentInput.slice(0, baseline.length), baseline)) {
		entry.continuation = undefined;
		return body;
	}
	return {
		...body,
		previous_response_id: continuation.lastResponseId,
		input: currentInput.slice(baseline.length),
	};
}

function completedContinuation(entry: CachedSocketEntry | undefined, fullPayload: ResponsesPayload, event: Record<string, unknown>): boolean {
	if (!entry || (event.type !== "response.completed" && event.type !== "response.done")) return false;
	const response = isRecord(event.response) ? event.response : undefined;
	const responseId = typeof response?.id === "string" ? response.id : undefined;
	if (!responseId) {
		entry.continuation = undefined;
		return true;
	}
	const output = Array.isArray(response?.output)
		? response.output.filter((item): item is Record<string, unknown> => isRecord(item) && item.type !== "function_call_output" && item.type !== "custom_tool_call_output")
		: [];
	entry.continuation = {
		lastRequestBody: cloneJson(fullPayload),
		lastResponseId: responseId,
		lastResponseItems: cloneJson(output),
	};
	return true;
}

function createSseResponse(
	socket: WebSocketLike,
	signals: AbortSignal[],
	idleTimeoutMs: number,
	requestFrame: string,
	onTerminal: (event: Record<string, unknown>) => boolean,
	onRelease: (keep: boolean) => void,
): Response {
	const encoder = new TextEncoder();
	let cancelBody: (reason?: unknown) => void = () => closeSocket(socket, "consumer_cancelled");
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let released = false;
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			let sawTerminal = false;
			const cleanup = () => {
				if (idleTimer) clearTimeout(idleTimer);
				socket.removeEventListener("message", onMessage);
				socket.removeEventListener("error", onError);
				socket.removeEventListener("close", onClose);
				for (const signal of signals) signal.removeEventListener("abort", onAbort);
			};
			const release = (keep: boolean) => {
				if (released) return;
				released = true;
				onRelease(keep);
			};
			const finish = () => {
				if (closed) return;
				closed = true;
				cleanup();
				controller.close();
			};
			const fail = (error: unknown) => {
				if (closed) return;
				closed = true;
				cleanup();
				release(false);
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
							const keep = onTerminal(parsed);
							release(keep);
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
			try {
				socket.send(requestFrame);
			} catch (error) {
				fail(error);
			}
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

function shouldCacheSocket(options: StreamOptions): boolean {
	return Boolean(options.sessionId && options.cacheRetention !== "none" && (transportMode(options) === "auto" || transportMode(options) === "websocket-cached"));
}

/**
 * Adapt the Responses WebSocket frame protocol to the HTTP/SSE surface already
 * consumed by Pi's stock openai-responses adapter. Payload conversion, tool
 * handling, usage accounting, and event normalization therefore stay in Pi.
 *
 * With a stable Pi sessionId, auto/websocket-cached keep one connection alive
 * for subsequent turns. After a completed response, the next request sends
 * previous_response_id plus only the input items after the cached response;
 * it falls back to the full payload when the transcript cannot be matched.
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
		const fetchHeaders = requestHeaders(input, init);
		const headers = buildWebSocketHeaders(model, options, fetchHeaders, requestId);
		const cacheKey = shouldCacheSocket(options) ? buildCacheKey(model, options, fetchHeaders) : undefined;
		let acquired: AcquiredSocket | undefined;
		try {
			const lease = await acquireWebSocket(
				buildResponsesWebSocketUrl(model),
				headers,
				signals,
				options.websocketConnectTimeoutMs ?? 15_000,
				cacheKey,
				options.sessionId,
			);
			acquired = lease;
			const fullPayload = payload;
			const requestPayload = lease.entry ? buildCachedRequestBody(lease.entry, fullPayload) : fullPayload;
			const requestFrame = JSON.stringify({ type: "response.create", ...requestPayload });
			return createSseResponse(
				lease.socket,
				signals,
				options.timeoutMs ?? 0,
				requestFrame,
				(event) => completedContinuation(lease.entry, fullPayload, event),
				(keep) => lease.release(keep),
			);
		} catch (error) {
			acquired?.release(false);
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
