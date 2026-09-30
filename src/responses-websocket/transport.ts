import {
	clampThinkingLevel,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type StreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { formatProviderError, normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";
import {
	getDeclaredTools,
	resolveTranscript,
	resolveTranscriptTools,
} from "@earendil-works/pi-ai/utils/transcript";
import type { ApiProvider } from "@earendil-works/pi-ai/compat";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
const RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CONNECTING = 0;

type ResponsesEvent = Parameters<typeof processResponsesStream>[0] extends AsyncIterable<infer Event> ? Event : never;
type ResponsesPayload = Record<string, unknown>;
type HeaderInput = Record<string, string | null> | undefined;

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

type ResponsesStreamOptions = StreamOptions & {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: unknown;
};

type TransportMode = "auto" | "sse" | "websocket" | "websocket-cached";

class AsyncEventQueue<T> implements AsyncIterable<T> {
	private readonly items: T[] = [];
	private readonly waiters: Array<{
		resolve: (result: IteratorResult<T>) => void;
		reject: (error: unknown) => void;
	}> = [];
	private closed = false;
	private failure: unknown;

	push(item: T): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter.resolve({ value: item, done: false });
			return;
		}
		this.items.push(item);
	}

	fail(error: unknown): void {
		if (this.closed) return;
		this.failure = error;
		this.closed = true;
		while (this.waiters.length > 0) this.waiters.shift()!.reject(error);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		while (this.waiters.length > 0) {
			this.waiters.shift()!.resolve({ value: undefined, done: true });
		}
	}

	next(): Promise<IteratorResult<T>> {
		if (this.items.length > 0) {
			return Promise.resolve({ value: this.items.shift()!, done: false });
		}
		if (this.failure !== undefined) return Promise.reject(this.failure);
		if (this.closed) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return this;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isGptResponsesModel(model: Model<Api>): boolean {
	return model.api === "openai-responses" && /^gpt/iu.test(model.id);
}

function transportMode(options: StreamOptions | undefined): TransportMode {
	return options?.transport ?? "auto";
}

export function shouldUseResponsesWebSocket(
	model: Model<Api>,
	options?: StreamOptions,
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

function hasHeader(headers: Headers, name: string): boolean {
	return headers.has(name) && headers.get(name)!.trim().length > 0;
}

function mergeHeaders(modelHeaders: HeaderInput, optionHeaders: HeaderInput): Headers {
	const headers = new Headers();
	for (const source of [modelHeaders, optionHeaders]) {
		for (const [name, value] of Object.entries(source ?? {})) {
			if (value === null) headers.delete(name);
			else if (typeof value === "string" && value.trim()) headers.set(name, value);
		}
	}
	return headers;
}

function buildWebSocketHeaders(model: Model<Api>, options: StreamOptions, requestId: string): Record<string, string> {
	const headers = mergeHeaders(model.headers, options.headers);
	if (options.apiKey && !hasHeader(headers, "authorization")) {
		const apiKey = options.apiKey.trim();
		headers.set("Authorization", apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`);
	}
	if (!hasHeader(headers, "authorization") && !hasHeader(headers, "cf-aig-authorization")) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	// This is the Responses WebSocket capability marker used by Pi's official
	// Codex transport. It is an API-level header, not a provider-specific value.
	if (!hasHeader(headers, "openai-beta")) headers.set("OpenAI-Beta", RESPONSES_WEBSOCKET_BETA);
	if (!hasHeader(headers, "x-client-request-id")) headers.set("X-Client-Request-Id", requestId);

	return Object.fromEntries(headers.entries());
}

type ResponsesCompat = {
	supportsMidConvoSystemMessages?: boolean;
	supportsLongCacheRetention?: boolean;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
	supportsExplicitPromptCacheMode?: boolean;
	supportsMaxOutputTokens?: boolean;
};

function getCompat(model: Model<Api>): Required<ResponsesCompat> {
	const compat = (model.compat ?? {}) as ResponsesCompat;
	return {
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages ?? false,
		supportsLongCacheRetention: compat.supportsLongCacheRetention ?? true,
		supportsStrictMode: compat.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: compat.supportsAdditionalTools ?? false,
		supportsToolSearch: compat.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: compat.supportsExplicitPromptCacheMode ?? false,
		supportsMaxOutputTokens: compat.supportsMaxOutputTokens ?? true,
	};
}

function getPromptCacheOptions(compat: ReturnType<typeof getCompat>, cacheRetention: StreamOptions["cacheRetention"]): Record<string, unknown> | undefined {
	if (!compat.supportsExplicitPromptCacheMode) return undefined;
	if (cacheRetention === "none") return { mode: "explicit" };
	if (cacheRetention === "long" && compat.supportsLongCacheRetention) return { ttl: "30m" };
	return undefined;
}

function getPromptCacheRetention(compat: ReturnType<typeof getCompat>, cacheRetention: StreamOptions["cacheRetention"]): string | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
		? "24h"
		: undefined;
}

function buildResponsesPayload(
	model: Model<Api>,
	context: TranscriptContext,
	options: ResponsesStreamOptions | undefined,
): ResponsesPayload {
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);
	const compat = getCompat(model);
	const grammarToolInputProperties = createGrammarToolInputProperties(
		getDeclaredTools(normalizedContext.messages),
		compat.supportsOpenAIGrammarTools,
	);
	const transcriptTools = resolveTranscriptTools(
		normalizedContext.messages,
		compat.supportsAdditionalTools || compat.supportsToolSearch,
	);
	const cacheRetention = options?.cacheRetention ?? "short";
	const params: ResponsesPayload = {
		model: model.id,
		input: convertResponsesMessages(model, normalizedContext, OPENAI_TOOL_CALL_PROVIDERS, {
			grammarToolInputProperties,
			supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
			supportsAdditionalTools: compat.supportsAdditionalTools,
			supportsToolSearch: compat.supportsToolSearch,
			toolOptions: {
				supportsStrictMode: compat.supportsStrictMode,
				supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
			},
		}),
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: getPromptCacheOptions(compat, cacheRetention),
		store: false,
	};

	if (options?.maxTokens !== undefined && compat.supportsMaxOutputTokens) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}
	if (options?.temperature !== undefined) params.temperature = options.temperature;
	if (options?.serviceTier !== undefined) params.service_tier = options.serviceTier;
	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}
	if (options?.toolChoice !== undefined) params.tool_choice = options.toolChoice;

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort,
				summary: options.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.thinkingLevelMap?.off !== null) {
			params.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		}
	}

	Object.assign(params, model.samplingParams, options?.samplingParams);
	return params;
}

function createAssistantOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function thrownMessage(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "OpenAI Responses API error");
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

async function connectWebSocket(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<WebSocketLike> {
	const WebSocketCtor = globalThis.WebSocket as unknown as WebSocketConstructor | undefined;
	if (typeof WebSocketCtor !== "function") throw new Error("WebSocket transport is not available in this runtime");
	if (signal?.aborted) throw new Error("Request was aborted");

	return new Promise((resolve, reject) => {
		let socket: WebSocketLike;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			socket?.removeEventListener("open", onOpen);
			socket?.removeEventListener("error", onError);
			socket?.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
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
			resolve(socket);
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
		signal?.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs > 0) timeout = setTimeout(() => fail(new Error(`WebSocket connect timeout after ${timeoutMs}ms`)), timeoutMs);
	});
}

async function decodeSocketData(value: unknown): Promise<string | undefined> {
	if (typeof value === "string") return value;
	if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
	if (ArrayBuffer.isView(value)) {
		return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	}
	if (isRecord(value) && typeof value.arrayBuffer === "function") {
		const bytes = await (value.arrayBuffer as () => Promise<ArrayBuffer>)();
		return new TextDecoder().decode(new Uint8Array(bytes));
	}
	return undefined;
}

async function* readSocketEvents(
	socket: WebSocketLike,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): AsyncIterable<ResponsesEvent> {
	const queue = new AsyncEventQueue<ResponsesEvent>();
	let sawTerminal = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const armIdleTimer = () => {
		if (timeoutMs <= 0) return;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => queue.fail(new Error(`WebSocket idle timeout after ${timeoutMs}ms`)), timeoutMs);
	};
	const onMessage = (event: WebSocketEvent) => {
		void (async () => {
			try {
				const text = await decodeSocketData(event.data);
				if (!text) return;
				const parsed: unknown = JSON.parse(text);
				if (!isRecord(parsed) || typeof parsed.type !== "string") throw new Error("Invalid Responses WebSocket event");
				const responseEvent = parsed as unknown as ResponsesEvent;
				armIdleTimer();
				queue.push(responseEvent);
				if (["response.completed", "response.done", "response.incomplete", "response.failed", "error"].includes(parsed.type)) {
					sawTerminal = true;
					queue.close();
				}
			} catch (error) {
				queue.fail(error);
			}
		})();
	};
	const onError = (event: WebSocketEvent) => queue.fail(socketError(event));
	const onClose = (event: WebSocketEvent) => {
		if (sawTerminal) queue.close();
		else queue.fail(new Error(`WebSocket closed before response completion${event.reason ? `: ${event.reason}` : ""}`));
	};
	const onAbort = () => queue.fail(new Error("Request was aborted"));

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort, { once: true });
	armIdleTimer();
	try {
		for await (const event of queue) {
			yield event;
		}
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
		if (idleTimer) clearTimeout(idleTimer);
	}
}

function assertSuccessfulOutput(
	output: AssistantMessage,
): asserts output is AssistantMessage & { stopReason: "stop" | "length" | "toolUse" | "deferred" } {
	if (output.stopReason === "pending") throw new Error("Responses WebSocket stream ended without a stop reason");
	if (output.stopReason === "error" || output.stopReason === "aborted") {
		throw new Error(output.errorMessage || "Responses WebSocket response failed");
	}
}

async function pipeFallback(
	original: ApiProvider,
	model: Model<Api>,
	context: TranscriptContext,
	options: ResponsesStreamOptions | undefined,
	payload: ResponsesPayload | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const fallbackOptions = payload
		? { ...options, onPayload: () => payload }
		: options;
	const fallback = original.stream(model, context, fallbackOptions);
	for await (const event of fallback) stream.push(event);
	stream.end();
}

async function runResponsesWebSocket(
	original: ApiProvider,
	model: Model<Api>,
	context: TranscriptContext,
	options: ResponsesStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const output = createAssistantOutput(model);
	let socket: WebSocketLike | undefined;
	let streamStarted = false;
	let payload: ResponsesPayload | undefined;
	try {
		if (options?.signal?.aborted) throw new Error("Request was aborted");
		payload = buildResponsesPayload(model, context, options);
		const replaced = await options?.onPayload?.(payload, model);
		if (replaced !== undefined) {
			if (!isRecord(replaced)) throw new Error("OpenAI Responses payload must be an object");
			payload = replaced;
		}
		const requestId = options?.sessionId?.slice(0, 64) || crypto.randomUUID();
		const headers = buildWebSocketHeaders(model, options ?? {}, requestId);
		socket = await connectWebSocket(
			buildResponsesWebSocketUrl(model),
			headers,
			options?.signal,
			options?.websocketConnectTimeoutMs ?? 15_000,
		);
		await options?.onResponse?.({ status: 101, headers: {} }, model);
		streamStarted = true;
		stream.push({ type: "start", partial: output });
		socket.send(JSON.stringify({ type: "response.create", ...payload }));
		const compat = getCompat(model);
		const grammarToolInputProperties = createGrammarToolInputProperties(
			getDeclaredTools(resolveTranscript(context, compat.supportsMidConvoSystemMessages).messages),
			compat.supportsOpenAIGrammarTools,
		);
		await processResponsesStream(readSocketEvents(socket, options?.signal, options?.timeoutMs ?? 0), output, stream, model, {
			onProviderStreamEvent: options?.onProviderStreamEvent,
			serviceTier: options?.serviceTier,
			grammarToolInputProperties,
		});
		if (options?.signal?.aborted) throw new Error("Request was aborted");
		assertSuccessfulOutput(output);
		stream.push({ type: "done", reason: output.stopReason, message: output });
		stream.end();
	} catch (error) {
		if (!streamStarted && transportMode(options) === "auto" && !options?.signal?.aborted) {
			try {
				await pipeFallback(original, model, context, options, payload, stream);
				return;
			} catch (fallbackError) {
				error = fallbackError;
			}
		}
		for (const block of output.content) {
			const scratch = block as unknown as { partialJson?: unknown; customInput?: unknown };
			delete scratch.partialJson;
			delete scratch.customInput;
		}
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = thrownMessage(error);
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end();
	} finally {
		closeSocket(socket, "done");
	}
}

export function streamResponsesWebSocket(
	original: ApiProvider,
	model: Model<Api>,
	context: TranscriptContext,
	options?: StreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runResponsesWebSocket(original, model, context, options as ResponsesStreamOptions | undefined, stream);
	return stream;
}

export function createResponsesWebSocketProvider(original: ApiProvider, enabled = false): ApiProvider {
	return {
		api: "openai-responses",
		stream(model, context, options) {
			if (!shouldUseResponsesWebSocket(model, options, enabled)) return original.stream(model, context, options);
			return streamResponsesWebSocket(original, model, context, options);
		},
		streamSimple(model, context, options) {
			if (!shouldUseResponsesWebSocket(model, options, enabled)) return original.streamSimple(model, context, options);
			const apiKey = options?.apiKey;
			const base = {
				...buildBaseOptions(model, context, options, apiKey),
				toolChoice: options?.toolChoice,
			};
			const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
			const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
			return streamResponsesWebSocket(original, model, context, {
				...base,
				reasoningEffort,
			} as ResponsesStreamOptions);
		},
	};
}
