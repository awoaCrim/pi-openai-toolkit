import type {
	Api,
	FetchFunction,
	Model,
	SimpleStreamOptions,
	StreamOptions,
} from "@earendil-works/pi-ai";
import type { ApiProvider } from "@earendil-works/pi-ai/compat";
import { reportContinuation } from "./notifications";

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

// Only transport failures (not arbitrary caught errors) authorize auto fallback.
class RecoverableWebSocketError extends Error {}

const STREAM_INTERRUPTION = /\bstream closed before response\.completed\b/iu;
const TERMINAL_FAILURE_TEXT = /quota|billing|budget|usage.?limit|api.?key|unauthori[sz]ed|forbidden|authenticat|permission|invalid|malformed|unsupported|policy|context.?length|context.?overflow|\babort(?:ed)?\b|\bcancell?ed\b/iu;
const TRANSIENT_ERROR_CODES = new Set(["stream_error", "server_error", "request_timeout"]);

function transportError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	if ((error instanceof Error && error.name === "AbortError") || TERMINAL_FAILURE_TEXT.test(message)) {
		return error instanceof Error ? error : new Error(message);
	}
	return new RecoverableWebSocketError(/^WebSocket (?:error|closed|.*timeout)/iu.test(message)
		? message : `WebSocket error: ${message}`);
}

function socketError(event: WebSocketEvent): Error {
	if (typeof event.message === "string" && event.message.length > 0) return transportError(event.message);
	if (event.error instanceof Error) return transportError(event.error);
	return transportError("WebSocket transport failed");
}

function socketCloseError(event: WebSocketEvent, streaming: boolean): Error {
	const suffix = event.reason ? `: ${event.reason}` : "";
	if ([1002, 1003, 1007, 1008].includes(event.code ?? 0) || TERMINAL_FAILURE_TEXT.test(event.reason ?? "")) {
		return new Error(`Responses connection rejected${event.code ? ` (${event.code})` : ""}${suffix}`);
	}
	return transportError(streaming
		? `WebSocket closed before response completion${suffix}`
		: `WebSocket closed${event.code ? ` ${event.code}` : ""}${suffix}`);
}

function compatibleFailureMetadata(error: Record<string, unknown>): boolean {
	if (typeof error.message === "string" && TERMINAL_FAILURE_TEXT.test(error.message)) return false;
	for (const field of ["code", "type"]) {
		const value = error[field];
		if (value !== undefined && value !== null && value !== "" &&
			(typeof value !== "string" || !TRANSIENT_ERROR_CODES.has(value.toLowerCase()))) return false;
	}
	for (const field of ["status", "status_code"]) {
		const value = error[field];
		if (value !== undefined && value !== null &&
			(typeof value !== "number" || ![408, 429, 500, 502, 503, 504].includes(value))) return false;
	}
	return true;
}

function normalizeStreamInterruption(event: Record<string, unknown>): Record<string, unknown> | undefined {
	const response = isRecord(event.response) ? event.response : undefined;
	const error = event.type === "error" ? event : event.type === "response.failed" && isRecord(response?.error) ? response.error : undefined;
	if (!error || typeof error.message !== "string" || !STREAM_INTERRUPTION.test(error.message) ||
		TERMINAL_FAILURE_TEXT.test(error.message)) return undefined;
	// Envelope type/status describe the event/response, not its failure category.
	// Still check their code/HTTP status so a nested transient message cannot
	// override explicit fatal metadata on an enclosing envelope.
	const metadata: Record<string, unknown>[] = [{ ...event, type: undefined }];
	if (event.type === "response.failed") {
		metadata.push({ ...response, type: undefined, status: response?.status === "failed" ? undefined : response?.status }, error);
	}
	if (isRecord(error.error)) metadata.push(error.error);
	if (metadata.some((value) => !compatibleFailureMetadata(value))) return undefined;
	const normalized = { ...error, message: `WebSocket error: ${error.message}` };
	return event.type === "error" ? normalized : { ...event, response: { ...response, error: normalized } };
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

function canReplayLostTurn(body: ResponsesPayload): boolean {
	// Function/custom tools run on the client only after a successful tool turn.
	// Unknown hosted tools may already have changed external state.
	const safeTools = new Set(["function", "custom", "web_search", "web_search_preview", "file_search"]);
	return body.tools === undefined || (Array.isArray(body.tools) &&
		body.tools.every(tool => isRecord(tool) && typeof tool.type === "string" && safeTools.has(tool.type)));
}

function normalizeUpstreamWebsocketLoss(event: Record<string, unknown>): Record<string, unknown> | undefined {
	const response = isRecord(event.response) ? event.response : undefined;
	const nested = event.type === "error" && isRecord(event.error);
	const error = event.type === "error" ? (nested ? event.error as Record<string, unknown> : event)
		: event.type === "response.failed" && isRecord(response?.error) ? response.error : undefined;
	if (!error || error.code !== "upstream_websocket_lost" || typeof error.message !== "string") return undefined;
	const metadata = [{ ...event, type: undefined }, error === event ? { ...error, type: undefined } : error];
	if (response) metadata.push({ ...response, type: undefined, status: response.status === "failed" ? undefined : response.status });
	if (isRecord(error.error)) metadata.push(error.error);
	if (metadata.some(value => !compatibleFailureMetadata({
		...value, code: value.code === "upstream_websocket_lost" ? "stream_error" : value.code,
	}))) return undefined;
	const normalized = { ...error, message: `WebSocket error [upstream_websocket_lost]: ${error.message}` };
	if (event.type === "response.failed") return { ...event, response: { ...response, error: normalized } };
	return nested ? { ...event, error: normalized } : normalized;
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


function liveSignals(options: StreamOptions, input: RequestInfo | URL, init?: RequestInit): AbortSignal[] {
	return [...new Set([options.signal, init?.signal, input instanceof Request ? input.signal : undefined]
		.filter((signal): signal is AbortSignal => signal !== undefined && signal !== null))];
}

async function connectWebSocket(
	url: string,
	headers: Record<string, string>,
	signals: AbortSignal[],
	timeoutMs: number,
): Promise<WebSocketLike> {
	const WebSocketCtor = globalThis.WebSocket as unknown as WebSocketConstructor | undefined;
	if (typeof WebSocketCtor !== "function") throw transportError("WebSocket transport is not available in this runtime");
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
		const onClose = (event: WebSocketEvent) => fail(socketCloseError(event, false));
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
		if (signals.some((signal) => signal.aborted)) { onAbort(); return; }
		if (timeoutMs > 0) timeout = setTimeout(() => fail(transportError(`WebSocket connect timeout after ${timeoutMs}ms`)), timeoutMs);
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

// Compare replay semantics, not response-only metadata. Do not strip IDs,
// arguments, annotations, phases, reasoning signatures, or unknown fields.
function replayComparableItem(item: unknown): unknown {
	if (!isRecord(item)) return item;
	if ((item.type === "function_call" || item.type === "custom_tool_call") && item.status === "completed") {
		const { status: _status, ...rest } = item;
		return rest;
	}
	if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
		return { ...item, content: item.content.map((part) => {
			if (!isRecord(part) || part.type !== "output_text") return part;
			const { logprobs: _logprobs, ...rest } = part;
			return rest;
		}) };
	}
	return item;
}

function buildCachedRequestBody(entry: CachedSocketEntry, body: ResponsesPayload): ResponsesPayload {
	const continuation = entry.continuation;
	if (!continuation) {
		reportContinuation(entry.sessionId, "expected-full");
		return body;
	}
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		reportContinuation(entry.sessionId, "expected-full");
		entry.continuation = undefined;
		return body;
	}
	const currentInput = inputItems(body);
	const baseline = [...inputItems(continuation.lastRequestBody), ...continuation.lastResponseItems];
	if (currentInput.length < inputItems(continuation.lastRequestBody).length) {
		// A shortened request history is an expected compaction/branch rebuild.
		// Missing *response* items alone (e.g. hosted tools) are not compaction.
		reportContinuation(entry.sessionId, "expected-full");
		entry.continuation = undefined;
		return body;
	}
	if (!responseInputsEqual(currentInput.slice(0, baseline.length).map(replayComparableItem), baseline.map(replayComparableItem))) {
		reportContinuation(entry.sessionId, "prefix-mismatch");
		entry.continuation = undefined;
		return body;
	}
	reportContinuation(entry.sessionId, "delta");
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

async function createSseResponse(
	socket: WebSocketLike,
	signals: AbortSignal[],
	idleTimeoutMs: number,
	requestFrame: string,
	onTerminal: (event: Record<string, unknown>) => boolean,
	onRelease: (keep: boolean) => void,
	allowBootstrapFallback: boolean,
	allowLostTurnReplay: boolean,
): Promise<Response> {
	const encoder = new TextEncoder();
	let resolveReady!: () => void;
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	let cancelBody: (reason?: unknown) => void = () => {};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let committed = false;
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			let pending = Promise.resolve();
			const cleanup = () => {
				if (idleTimer) clearTimeout(idleTimer);
				socket.removeEventListener("message", onMessage);
				socket.removeEventListener("error", onError);
				socket.removeEventListener("close", onClose);
				for (const signal of signals) signal.removeEventListener("abort", onAbort);
			};
			const fail = (error: unknown) => {
				if (closed) return;
				closed = true;
				cleanup();
				onRelease(false);
				if (!committed) {
					if (signals.some((signal) => signal.aborted) || (allowBootstrapFallback && error instanceof RecoverableWebSocketError)) {
						rejectReady(error);
					} else {
						// Return an errored body for deterministic failures/explicit WS.
						// Rejecting fetch would make the SDK recast these as connection errors.
						resolveReady();
					}
				}
				controller.error(error);
			};
			const armIdleTimer = () => {
				if (idleTimeoutMs <= 0) return;
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => fail(transportError(`WebSocket idle timeout after ${idleTimeoutMs}ms`)), idleTimeoutMs);
			};
			const enqueue = (operation: () => Promise<void> | void) => {
				pending = pending.then(() => { if (!closed) return operation(); }).catch(fail);
			};
			const onMessage = (event: WebSocketEvent) => enqueue(async () => {
				const text = await decodeSocketData(event.data);
				if (closed) return;
				if (text === undefined) throw new Error("Invalid Responses WebSocket frame");
				const parsed: unknown = JSON.parse(text);
				if (!isRecord(parsed) || typeof parsed.type !== "string" || !parsed.type) throw new Error("Invalid Responses WebSocket event");
				if (parsed.type === "response.output_item.added" && isRecord(parsed.item) &&
					typeof parsed.item.type === "string" && parsed.item.type.endsWith("_call") &&
					!["function_call", "custom_tool_call", "web_search_call", "file_search_call"].includes(parsed.item.type)) {
					allowLostTurnReplay = false;
				}
				const interruption = normalizeStreamInterruption(parsed);
				const normalized = interruption ?? (allowLostTurnReplay ? normalizeUpstreamWebsocketLoss(parsed) : undefined);
				if (!committed && allowBootstrapFallback && interruption) {
					fail(transportError("stream closed before response.completed"));
					return;
				}
				const forwarded = normalized ?? parsed;
				controller.enqueue(encoder.encode(`event: ${forwarded.type}\ndata: ${JSON.stringify(forwarded)}\n\n`));
				committed = true;
				resolveReady();
				armIdleTimer();
				if (TERMINAL_EVENTS.has(parsed.type)) {
					closed = true;
					cleanup();
					const keep = onTerminal(parsed);
					onRelease(keep);
					controller.close();
				}
			});
			const onError = (event: WebSocketEvent) => enqueue(() => fail(socketError(event)));
			const onClose = (event: WebSocketEvent) => enqueue(() => fail(socketCloseError(event, true)));
			// Abort/timeout deliberately bypass decoding: a stuck decoder must not
			// prevent cancellation. Its late result sees closed and is discarded.
			const onAbort = () => fail(new Error("Request was aborted"));
			cancelBody = (reason) => fail(reason instanceof Error ? reason : new Error("Response stream was cancelled"));
			socket.addEventListener("message", onMessage);
			socket.addEventListener("error", onError);
			socket.addEventListener("close", onClose);
			for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
			if (signals.some((signal) => signal.aborted)) { onAbort(); return; }
			armIdleTimer();
			try {
				socket.send(requestFrame);
			} catch (error) {
				fail(transportError(error));
			}
		},
		cancel(reason) { cancelBody(reason); },
	});
	await ready;
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

		const signals = liveSignals(options, input, init);
		const requestId = options.sessionId?.slice(0, 64) || crypto.randomUUID();
		const fetchHeaders = requestHeaders(input, init);
		const headers = buildWebSocketHeaders(model, options, fetchHeaders, requestId);
		const cacheKey = shouldCacheSocket(options) ? buildCacheKey(model, options, fetchHeaders) : undefined;
		let release: ((keep: boolean) => void) | undefined;
		try {
			const lease = await acquireWebSocket(
				buildResponsesWebSocketUrl(model),
				headers,
				signals,
				options.websocketConnectTimeoutMs ?? 15_000,
				cacheKey,
				options.sessionId,
			);
			let released = false;
			release = (keep) => {
				if (released) return;
				released = true;
				lease.release(keep);
			};
			const fullPayload = payload;
			const requestPayload = lease.entry ? buildCachedRequestBody(lease.entry, fullPayload) : fullPayload;
			const requestFrame = JSON.stringify({ type: "response.create", ...requestPayload });
			return await createSseResponse(
				lease.socket,
				signals,
				options.timeoutMs ?? 0,
				requestFrame,
				(event) => completedContinuation(lease.entry, fullPayload, event),
				release,
				transportMode(options) === "auto",
				canReplayLostTurn(fullPayload),
			);
		} catch (error) {
			release?.(false);
			if (error instanceof RecoverableWebSocketError && transportMode(options) === "auto" && !signals.some((signal) => signal.aborted)) {
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
