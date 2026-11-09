import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateCost, type Api, type Model, type SimpleStreamOptions, type Usage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { NativeCompactionRuntime } from "./runtime";
import type { NativeCompactionRequestBody } from "./serializer";
import type { CompactionRequestExtras } from "./request-context-cache";

export type CompactionPayloadProjector = (payload: unknown) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Run Pi's ordinary encoder and ordered payload hooks, stopping at onPayload.
 * No HTTP/WS request is made: onPayload throws, transport is forced to SSE and
 * fetch is a deny-all guard. This avoids maintaining a second wire serializer
 * for system/tool declarations, signatures, reasoning and provider features.
 */
export async function buildEncodedCompactionRequest(options: {
	runtime: NativeCompactionRuntime;
	messages: readonly AgentMessage[];
	projectPayload: CompactionPayloadProjector;
	thinkingLevel?: string;
	customInstructions?: string;
	signal?: AbortSignal;
	cache?: CompactionRequestExtras;
	stream?: typeof streamSimple;
}): Promise<NativeCompactionRequestBody> {
	const { runtime, signal } = options;
	signal?.throwIfAborted();
	let captured: NativeCompactionRequestBody | undefined;
	let failure: unknown;
	let dispatched = false;
	const stop = new Error("Compaction payload encoded; dispatch intentionally stopped");
	const context = { messages: convertToLlm([...options.messages]) };
	const stream = (options.stream ?? streamSimple)(runtime.currentModel, context, {
		apiKey: runtime.apiKey,
		headers: runtime.headers,
		env: runtime.env,
		sessionId: runtime.sessionId,
		signal,
		transport: "sse",
		...(options.thinkingLevel && options.thinkingLevel !== "off"
			? { reasoning: options.thinkingLevel as SimpleStreamOptions["reasoning"] } : {}),
		fetch: async () => {
			dispatched = true;
			throw new Error("Compaction encoder attempted network dispatch");
		},
		onPayload: async (payload) => {
			try {
				if (options.cache && isRecord(payload)) {
					// Preserve the live cache policy, including deliberately absent
					// fields. Later ordered hooks may still override these normally.
					for (const key of ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"] as const) {
						delete payload[key];
						if (options.cache[key] !== undefined) payload[key] = structuredClone(options.cache[key]);
					}
				}
				const projected = await options.projectPayload(payload);
				signal?.throwIfAborted();
				if (!isRecord(projected) || !Array.isArray(projected.input)) {
					throw new Error("Compaction encoder did not produce a full Responses payload");
				}
				if (projected.model !== (runtime.requestModel ?? runtime.model)) {
					throw new Error("Compaction encoder model does not match the resolved producer");
				}
				if (projected.previous_response_id !== undefined) {
					throw new Error("Compaction encoder returned a continuation-only payload");
				}
				captured = structuredClone(projected) as NativeCompactionRequestBody;
				const guidance = options.customInstructions?.trim();
				if (guidance) {
					captured.input.push({
						role: runtime.currentModel.reasoning ? "developer" : "system",
						content: `Additional user guidance for this manual /compact request:\n${guidance}`,
					});
				}
			} catch (error) {
				failure = error;
			}
			throw stop;
		},
	});
	await stream.result();
	signal?.throwIfAborted();
	if (dispatched) throw new Error("Compaction encoder attempted network dispatch");
	if (failure) throw failure;
	if (!captured) throw new Error("Compaction encoder did not expose a request payload");
	return captured;
}

function count(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Missing usage is unknown, not a free request. OpenAI input includes cached tokens. */
export function compactionUsage(raw: unknown, model: Model<Api>): Usage | undefined {
	if (!isRecord(raw) || !count(raw.input_tokens) || !count(raw.output_tokens)) return undefined;
	const input = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : {};
	if (!count(input.cached_tokens)) return undefined;
	const cacheWrite = input.cache_write_tokens ?? 0;
	if (!count(cacheWrite) || input.cached_tokens + cacheWrite > raw.input_tokens) return undefined;
	const output = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {};
	const reasoning = output.reasoning_tokens ?? 0;
	const total = raw.total_tokens ?? raw.input_tokens + raw.output_tokens;
	if (!count(reasoning) || reasoning > raw.output_tokens || !count(total)) return undefined;
	const usage: Usage = {
		input: raw.input_tokens - input.cached_tokens - cacheWrite,
		output: raw.output_tokens,
		cacheRead: input.cached_tokens,
		cacheWrite,
		reasoning,
		totalTokens: total,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}
