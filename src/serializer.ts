import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compact, convertToLlm } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { ResponsesCompatibleRequestPayload } from "./runtime";
import type { CompactionRequestExtras } from "./request-context-cache";

/**
 * pi stopped exporting the CompactionPreparation type name in 0.80.x, but it is still
 * structurally the first argument of the exported compact(). Derive it from there so we
 * track pi's shape without depending on a private export.
 */
type CompactionPreparation = Parameters<typeof compact>[0];

/**
 * Decision for T4: keep a narrow local serializer instead of importing Pi internals.
 *
 * Why this is sufficient for v1:
 * - we only target same-model OpenAI Responses-compatible requests
 * - we only need Pi's current supported message semantics (assistant phase,
 *   reasoning signatures, tool call/result pairing, image blocks)
 * - Pi's shared Responses converter is not publicly exported, so importing it
 *   would require a brittle install-path-specific wrapper
 *
 * The helpers below intentionally mirror Pi's same-model Responses serialization
 * rules closely so later tasks can compare their output against captured
 * before_provider_request payload artifacts.
 */
export const COMPACTION_SERIALIZER_STRATEGY = "local-same-model-responses-serializer" as const;

export type CompactionSerializerStrategy = typeof COMPACTION_SERIALIZER_STRATEGY;
export type AssistantPhase = "commentary" | "final_answer";

type ResponsesTextInputItem = {
	type: "input_text";
	text: string;
};

type ResponsesImageInputItem = {
	type: "input_image";
	detail: "auto";
	image_url: string;
};

export type ResponsesInputContentItem = ResponsesTextInputItem | ResponsesImageInputItem;

export type ResponsesInputMessageItem = {
	role: "user" | "developer" | "system";
	content: ResponsesInputContentItem[] | string;
};

export type ResponsesAssistantOutputItem = {
	type: "message";
	role: "assistant";
	content: Array<{
		type: "output_text";
		text: string;
		annotations: [];
	}>;
	status: "completed";
	id: string;
	phase?: AssistantPhase;
};

export type ResponsesFunctionCallItem = {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
};

export type ResponsesFunctionCallOutputItem = {
	type: "function_call_output";
	call_id: string;
	output: ResponsesInputContentItem[] | string;
};

export type ResponsesReasoningItem = Record<string, unknown>;

/**
 * Pi 0.86 adds `SystemMessage` to the public `Message` union; 0.85.1 has no system
 * variant and does not export that type name. Use the public shape when the installed
 * Pi declares it and a structural fallback for the fields this serializer consumes
 * otherwise, so one source file type-checks against both supported versions.
 */
type ResponsesSystemMessage = Extract<Message, { role: "system" }> extends never
	? {
			role: "system";
			content: string | TextContent[];
			sections?: Record<string, string | null>;
			timestamp: number;
		}
	: Extract<Message, { role: "system" }>;

export type ResponsesInputItem =
	| ResponsesInputMessageItem
	| ResponsesAssistantOutputItem
	| ResponsesFunctionCallItem
	| ResponsesFunctionCallOutputItem
	| ResponsesReasoningItem;

/** The synthetic request shares the live-request extras allowlist. */
export type NativeCompactionRequestBody = CompactionRequestExtras & {
	model: string;
	input: ResponsesInputItem[];
	instructions: string;
};

export type SerializeResponsesMessagesOptions = {
	instructions?: string;
	includeInstructionsInInput?: boolean;
	/** Treat a system message at the start of a sliced post-compaction tail as an update. */
	firstSystemMessageIsUpdate?: boolean;
};

export type ResponsesParityReport = {
	ok: boolean;
	actual: string[];
	expected: string[];
	mismatches: string[];
};

type ParsedTextSignature = {
	id: string;
	phase?: AssistantPhase;
};

const SYNTHETIC_TOOL_RESULT_TEXT = "No result provided";

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function instructionRole<TApi extends Api>(model: Model<TApi>): "developer" | "system" {
	// Pi's public Model compat union is broader than the OpenAI Responses compat
	// shape, while the runtime field is shared by both supported Pi versions.
	const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
	return model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
}

export function collectCompactionWindowMessages(preparation: CompactionPreparation): AgentMessage[] {
	return [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
}

export function serializeCompactionPreparationToRequest<TApi extends Api>(args: {
	model: Model<TApi>;
	preparation: CompactionPreparation;
	instructions: string;
}): NativeCompactionRequestBody {
	return serializeMessagesToCompactRequest({
		model: args.model,
		messages: collectCompactionWindowMessages(args.preparation),
		instructions: args.instructions,
	});
}

export function serializeMessagesToCompactRequest<TApi extends Api>(args: {
	model: Model<TApi>;
	messages: AgentMessage[];
	instructions: string;
}): NativeCompactionRequestBody {
	return {
		model: args.model.id,
		input: serializeMessagesToResponsesInput(args.model, args.messages),
		instructions: sanitizeSurrogates(args.instructions),
	};
}

/**
 * Async compaction serializer used by live synthetic requests. Pi exposes model
 * image limits and newer versions expose a public resize helper; keep the
 * historical sync API for callers/tests while applying those limits only at the
 * actual request edge.
 */
export async function serializeMessagesToCompactRequestWithLimits<TApi extends Api>(args: {
	model: Model<TApi>;
	messages: AgentMessage[];
	instructions: string;
}): Promise<NativeCompactionRequestBody> {
	return {
		model: args.model.id,
		input: await serializeMessagesToResponsesInputWithLimits(args.model, args.messages),
		instructions: sanitizeSurrogates(args.instructions),
	};
}

export function serializeMessagesToResponsesInput<TApi extends Api>(
	model: Model<TApi>,
	messages: AgentMessage[],
	options: SerializeResponsesMessagesOptions = {},
): ResponsesInputItem[] {
	return serializeLlmMessagesToResponsesInput(model, convertToLlm(messages), options);
}

export async function serializeMessagesToResponsesInputWithLimits<TApi extends Api>(
	model: Model<TApi>,
	messages: AgentMessage[],
	options: SerializeResponsesMessagesOptions = {},
): Promise<ResponsesInputItem[]> {
	return applyModelImageInputLimits(
		model,
		serializeMessagesToResponsesInput(model, messages, options),
	);
}

export async function serializeLlmMessagesToResponsesInputWithLimits<TApi extends Api>(
	model: Model<TApi>,
	messages: Message[],
	options: SerializeResponsesMessagesOptions = {},
): Promise<ResponsesInputItem[]> {
	return applyModelImageInputLimits(
		model,
		serializeLlmMessagesToResponsesInput(model, messages, options),
	);
}

/**
 * Serialize Pi's normalized LLM message union without running `convertToLlm` again.
 * This keeps the system-message boundary directly testable while preserving the public
 * AgentMessage-facing entry point above.
 */
export function serializeLlmMessagesToResponsesInput<TApi extends Api>(
	model: Model<TApi>,
	messages: Message[],
	options: SerializeResponsesMessagesOptions = {},
): ResponsesInputItem[] {
	const transformedMessages = transformMessagesForResponses(messages);
	const input: ResponsesInputItem[] = [];

	if (options.includeInstructionsInInput && options.instructions) {
		input.push({
			role: instructionRole(model),
			content: sanitizeSurrogates(options.instructions),
		});
	}

	let messageIndex = 0;
	let sourceIndex = 0;
	for (const message of transformedMessages) {
		// Pi 0.85's Message union has no system member, so compare through the
		// public role string while keeping the 0.86 discriminant runtime-compatible.
		const isFirstMessage = sourceIndex++ === 0;
		const isLeadingSystemMessage =
			!options.firstSystemMessageIsUpdate && isFirstMessage && (message.role as string) === "system";

		if (message.role === "user") {
			const item = serializeUserMessage(message, model);
			if (item) {
				input.push(item);
			}
			messageIndex++;
			continue;
		}

		if (message.role === "assistant") {
			const items = serializeAssistantMessage(message, messageIndex);
			if (items.length > 0) {
				input.push(...items);
			}
			messageIndex++;
			continue;
		}

		if (message.role === "toolResult") {
			input.push(serializeToolResultMessage(message, model));
			messageIndex++;
			continue;
		}

		// In Pi 0.85.1 this branch narrows to `never`; in Pi 0.86 it is a SystemMessage.
		// Handle it explicitly instead of letting a new message variant become tool output.
		const systemItem = serializeSystemMessage(message, model, isLeadingSystemMessage);
		if (systemItem) {
			input.push(systemItem);
		}
		if (!isLeadingSystemMessage) {
			messageIndex++;
		}
	}

	return input;
}

type ImageResizeOptions = {
	maxWidth?: number;
	maxHeight?: number;
	maxBytes?: number;
	jpegQuality?: number;
};

type ModelImageInputLimits = {
	resize?: ImageResizeOptions;
	maxPerMessage?: number;
	maxPerRequest?: number;
};

type ResizeImageResult = {
	data: string;
	mimeType: string;
};

type ResizeImageFunction = (
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
) => Promise<ResizeImageResult | null>;

let resizeImageLoader: Promise<ResizeImageFunction | undefined> | undefined;

function getModelImageInputLimits(model: Model<Api>): ModelImageInputLimits | undefined {
	return (model as Model<Api> & { inputLimits?: { images?: ModelImageInputLimits } }).inputLimits?.images;
}

function readNonNegativeLimit(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Model image input limit ${name} is invalid.`);
	}
	return value;
}

function normalizeResizeOptions(value: unknown): ImageResizeOptions | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	const options: ImageResizeOptions = {};
	for (const key of ["maxWidth", "maxHeight", "maxBytes"] as const) {
		const number = candidate[key];
		if (number === undefined) continue;
		if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) {
			throw new Error(`Model image resize option ${key} is invalid.`);
		}
		options[key] = Math.floor(number);
	}
	if (candidate.jpegQuality !== undefined) {
		if (
			typeof candidate.jpegQuality !== "number" ||
			!Number.isFinite(candidate.jpegQuality) ||
			candidate.jpegQuality <= 0 ||
			candidate.jpegQuality > 100
		) {
			throw new Error("Model image resize option jpegQuality is invalid.");
		}
		options.jpegQuality = candidate.jpegQuality;
	}
	return Object.keys(options).length > 0 ? options : undefined;
}

async function loadResizeImage(): Promise<ResizeImageFunction | undefined> {
	resizeImageLoader ??= (async () => {
		try {
			const module = await import("@earendil-works/pi-coding-agent") as {
				resizeImage?: ResizeImageFunction;
			};
			return typeof module.resizeImage === "function" ? module.resizeImage : undefined;
		} catch {
			// Pi 0.87 does not export the helper. The request must fail closed when
			// a newer model explicitly requires a resize rather than sending a
			// potentially oversized image unchanged.
			return undefined;
		}
	})();
	return resizeImageLoader;
}

function inputContentArray(item: ResponsesInputItem): ResponsesInputContentItem[] | undefined {
	if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
	const candidate = item as Record<string, unknown>;
	if (candidate.type === "function_call_output") {
		return Array.isArray(candidate.output) ? candidate.output as ResponsesInputContentItem[] : undefined;
	}
	return Array.isArray(candidate.content) ? candidate.content as ResponsesInputContentItem[] : undefined;
}

function isInputImage(item: ResponsesInputContentItem): item is ResponsesImageInputItem {
	return item.type === "input_image";
}

function decodeDataImage(imageUrl: string): { mimeType: string; bytes: Uint8Array } {
	const separator = imageUrl.indexOf(",");
	const prefix = separator >= 0 ? imageUrl.slice(0, separator) : "";
	if (!prefix.startsWith("data:") || !prefix.endsWith(";base64") || separator < 0) {
		throw new Error("Model image input has an invalid data URL.");
	}
	const mimeType = prefix.slice("data:".length, -";base64".length);
	if (!mimeType) throw new Error("Model image input has no MIME type.");
	return { mimeType, bytes: Buffer.from(imageUrl.slice(separator + 1), "base64") };
}

async function resizeInputImage(
	image: ResponsesImageInputItem,
	options: ImageResizeOptions,
): Promise<ResponsesImageInputItem> {
	const resizeImage = await loadResizeImage();
	if (!resizeImage) {
		throw new Error("The active Pi version cannot resize an image required by model input limits.");
	}
	const source = decodeDataImage(image.image_url);
	const resized = await resizeImage(source.bytes, source.mimeType, options);
	if (!resized || typeof resized.data !== "string" || typeof resized.mimeType !== "string") {
		throw new Error("Model image input could not be resized within the provider limits.");
	}
	return {
		...image,
		image_url: `data:${resized.mimeType};base64,${resized.data}`,
	};
}

/** Enforce Pi's per-message/request image limits without mutating serialized input. */
export async function applyModelImageInputLimits<TApi extends Api>(
	model: Model<TApi>,
	input: ResponsesInputItem[],
): Promise<ResponsesInputItem[]> {
	const limits = getModelImageInputLimits(model);
	if (!limits) return input;

	const maxPerMessage = readNonNegativeLimit(limits.maxPerMessage, "maxPerMessage");
	const maxPerRequest = readNonNegativeLimit(limits.maxPerRequest, "maxPerRequest");
	const resizeOptions = normalizeResizeOptions(limits.resize);
	let requestImageCount = 0;
	const output: ResponsesInputItem[] = [];

	for (const item of input) {
		const content = inputContentArray(item);
		if (!content) {
			output.push(item);
			continue;
		}
		const imageCount = content.filter(isInputImage).length;
		if (maxPerMessage !== undefined && imageCount > maxPerMessage) {
			throw new Error(`Model accepts at most ${maxPerMessage} image(s) per message.`);
		}
		if (maxPerRequest !== undefined && requestImageCount + imageCount > maxPerRequest) {
			throw new Error(`Model accepts at most ${maxPerRequest} image(s) per request.`);
		}
		requestImageCount += imageCount;

		if (!resizeOptions || imageCount === 0) {
			output.push(item);
			continue;
		}
		const resizedContent: ResponsesInputContentItem[] = [];
		for (const contentItem of content) {
			resizedContent.push(isInputImage(contentItem)
				? await resizeInputImage(contentItem, resizeOptions)
				: contentItem);
		}
		const itemRecord = item as Record<string, unknown>;
		if (itemRecord.type === "function_call_output") {
			output.push({ ...item, output: resizedContent } as ResponsesInputItem);
		} else {
			output.push({ ...item, content: resizedContent } as ResponsesInputItem);
		}
	}

	return output;
}

export function createResponsesInputParitySignature(input: readonly unknown[]): string[] {
	return input.map(describeResponsesInputItem);
}

export function compareResponsesInputParity(actual: readonly unknown[], expected: readonly unknown[]): ResponsesParityReport {
	const actualSignature = createResponsesInputParitySignature(actual);
	const expectedSignature = createResponsesInputParitySignature(expected);
	const maxLength = Math.max(actualSignature.length, expectedSignature.length);
	const mismatches: string[] = [];

	for (let index = 0; index < maxLength; index++) {
		const actualValue = actualSignature[index];
		const expectedValue = expectedSignature[index];
		if (actualValue !== expectedValue) {
			mismatches.push(`index ${index}: expected ${expectedValue ?? "<missing>"}, got ${actualValue ?? "<missing>"}`);
		}
	}

	return {
		ok: mismatches.length === 0,
		actual: actualSignature,
		expected: expectedSignature,
		mismatches,
	};
}

export function compareCompactRequestToPayload(
	request: NativeCompactionRequestBody,
	payload: Pick<ResponsesCompatibleRequestPayload, "model" | "input" | "instructions">,
): ResponsesParityReport {
	const parity = compareResponsesInputParity(request.input, payload.input);
	const mismatches = [...parity.mismatches];

	if (payload.model !== request.model) {
		mismatches.unshift(`model: expected ${payload.model}, got ${request.model}`);
	}

	if ((payload.instructions ?? "") !== request.instructions) {
		mismatches.unshift("instructions: expected serialized instructions to match payload instructions");
	}

	return {
		ok: mismatches.length === 0,
		actual: parity.actual,
		expected: parity.expected,
		mismatches,
	};
}

function transformMessagesForResponses(messages: Message[]): Message[] {
	const transformed: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();

	for (const message of messages) {
		if (message.role === "assistant") {
			if (pendingToolCalls.length > 0) {
				transformed.push(...createSyntheticToolResults(pendingToolCalls, existingToolResultIds));
				pendingToolCalls = [];
				existingToolResultIds = new Set<string>();
			}

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				continue;
			}

			const normalizedContent: AssistantMessage["content"] = [];
			for (const block of message.content) {
				if (block.type !== "thinking" || block.thinkingSignature) {
					normalizedContent.push(block);
				}
			}

			const normalizedAssistantMessage: AssistantMessage = {
				...message,
				content: normalizedContent,
			};
			transformed.push(normalizedAssistantMessage);

			const toolCalls = normalizedContent.filter(isToolCallBlock);
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set<string>();
			}
			continue;
		}

		if (message.role === "toolResult") {
			existingToolResultIds.add(message.toolCallId);
			transformed.push(message);
			continue;
		}

		if (pendingToolCalls.length > 0) {
			transformed.push(...createSyntheticToolResults(pendingToolCalls, existingToolResultIds));
			pendingToolCalls = [];
			existingToolResultIds = new Set<string>();
		}

		transformed.push(message);
	}

	transformed.push(...createSyntheticToolResults(pendingToolCalls, existingToolResultIds));
	return transformed;
}

function createSyntheticToolResults(
	pendingToolCalls: readonly ToolCall[],
	existingToolResultIds: ReadonlySet<string>,
): ToolResultMessage[] {
	const syntheticResults: ToolResultMessage[] = [];

	for (const toolCall of pendingToolCalls) {
		if (existingToolResultIds.has(toolCall.id)) {
			continue;
		}

		syntheticResults.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: SYNTHETIC_TOOL_RESULT_TEXT }],
			isError: true,
			timestamp: Date.now(),
		});
	}

	return syntheticResults;
}

function serializeUserMessage<TApi extends Api>(
	message: UserMessage,
	model: Model<TApi>,
): ResponsesInputMessageItem | undefined {
	const contentItems = normalizeUserContent(message.content).flatMap((item) => serializeUserContentItem(item, model));
	if (contentItems.length === 0) {
		return undefined;
	}

	return {
		role: "user",
		content: contentItems,
	};
}

function serializeUserContentItem<TApi extends Api>(
	item: TextContent | ImageContent,
	model: Model<TApi>,
): ResponsesInputContentItem[] {
	if (item.type === "text") {
		return [{ type: "input_text", text: sanitizeSurrogates(item.text) }];
	}

	if (!model.input.includes("image")) {
		return [];
	}

	return [
		{
			type: "input_image",
			detail: "auto",
			image_url: `data:${item.mimeType};base64,${item.data}`,
		},
	];
}

function serializeAssistantMessage(message: AssistantMessage, messageIndex: number): ResponsesInputItem[] {
	const items: ResponsesInputItem[] = [];

	for (const block of message.content) {
		if (block.type === "thinking") {
			const reasoningItem = parseReasoningItem(block);
			if (reasoningItem) {
				items.push(reasoningItem);
			}
			continue;
		}

		if (block.type === "text") {
			const signature = parseTextSignature(block.textSignature);
			items.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
				status: "completed",
				id: normalizeAssistantMessageId(signature?.id, messageIndex),
				phase: signature?.phase,
			});
			continue;
		}

		const [callId, rawItemId] = block.id.split("|");
		items.push({
			type: "function_call",
			id: rawItemId,
			call_id: callId,
			name: block.name,
			arguments: JSON.stringify(block.arguments),
		});
	}

	return items;
}

function serializeToolResultMessage<TApi extends Api>(
	message: ToolResultMessage,
	model: Model<TApi>,
): ResponsesFunctionCallOutputItem {
	const [callId] = message.toolCallId.split("|");
	const textOutput = message.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => sanitizeSurrogates(item.text))
		.join("\n");
	const hasImages = message.content.some((item) => item.type === "image");
	const hasText = textOutput.length > 0;

	if (hasImages && model.input.includes("image")) {
		const output: ResponsesInputContentItem[] = [];
		if (hasText) {
			output.push({ type: "input_text", text: textOutput });
		}
		for (const item of message.content) {
			if (item.type !== "image") {
				continue;
			}
			output.push({
				type: "input_image",
				detail: "auto",
				image_url: `data:${item.mimeType};base64,${item.data}`,
			});
		}
		return {
			type: "function_call_output",
			call_id: callId,
			output,
		};
	}

	return {
		type: "function_call_output",
		call_id: callId,
		output: hasText ? textOutput : "(see attached image)",
	};
}

function normalizeUserContent(content: UserMessage["content"]): Array<TextContent | ImageContent> {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/**
 * Serialize one normalized Pi system message as a Responses input message.
 *
 * The role follows the same reasoning-model convention as `instructions`: reasoning
 * models use `developer`, everything else keeps `system`. Leading messages include
 * their complete section state; later messages use Pi's update framing so section
 * additions/removals are not mistaken for a new complete prompt. An empty system
 * message produces no item, matching Pi.
 */
function serializeSystemMessage<TApi extends Api>(
	message: ResponsesSystemMessage,
	model: Model<TApi>,
	isLeadingSystemMessage: boolean,
): ResponsesInputMessageItem | undefined {
	const text = sanitizeSurrogates(
		isLeadingSystemMessage ? getSystemMessageText(message) : renderSystemMessageUpdate(message),
	);
	if (text.length === 0) {
		return undefined;
	}

	return {
		role: instructionRole(model),
		content: text,
	};
}

/** Mirrors Pi's public getSystemMessageText() without importing a 0.86-only helper. */
function getSystemMessageText(message: ResponsesSystemMessage): string {
	const parts = [contentText(message.content)];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) {
			parts.push(text);
		}
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/** Mirrors Pi's public renderSystemMessageUpdate() for later transcript updates. */
function renderSystemMessageUpdate(message: ResponsesSystemMessage): string {
	const parts: string[] = [];
	const text = contentText(message.content);
	if (text.length > 0) {
		parts.push(text);
	}
	for (const [name, value] of Object.entries(message.sections ?? {})) {
		parts.push(
			value === null
				? `Removed system prompt section "${name}".`
				: `Updated system prompt section "${name}":\n\n${value}`,
		);
	}
	return parts.join("\n\n");
}

function contentText(content: ResponsesSystemMessage["content"]): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function parseReasoningItem(block: ThinkingContent): ResponsesReasoningItem | undefined {
	if (!block.thinkingSignature) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(block.thinkingSignature);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return parsed as ResponsesReasoningItem;
	} catch {
		return undefined;
	}
}

function parseTextSignature(signature: string | undefined): ParsedTextSignature | undefined {
	if (!signature) {
		return undefined;
	}

	if (!signature.startsWith("{")) {
		return { id: signature };
	}

	try {
		const parsed = JSON.parse(signature);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}

		const record = parsed as Record<string, unknown>;
		if (record.v !== 1 || typeof record.id !== "string") {
			return undefined;
		}

		return {
			id: record.id,
			phase:
				record.phase === "commentary" || record.phase === "final_answer"
					? record.phase
					: undefined,
		};
	} catch {
		return undefined;
	}
}

function normalizeAssistantMessageId(id: string | undefined, messageIndex: number): string {
	if (!id) {
		return `msg_${messageIndex}`;
	}

	if (id.length <= 64) {
		return id;
	}

	return `msg_${createHash("sha1").update(id).digest("hex").slice(0, 12)}`;
}

function isToolCallBlock(block: AssistantMessage["content"][number]): block is ToolCall {
	return block.type === "toolCall";
}

function describeResponsesInputItem(item: unknown): string {
	if (!item || typeof item !== "object" || Array.isArray(item)) {
		return typeof item;
	}

	const record = item as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : undefined;
	if (type === "message") {
		const phase =
			record.phase === "commentary" || record.phase === "final_answer"
				? `:${record.phase}`
				: "";
		return `message:${typeof record.role === "string" ? record.role : "unknown"}${phase}`;
	}

	if (type === "function_call") {
		return `function_call:${typeof record.name === "string" ? record.name : "unknown"}`;
	}

	if (type === "function_call_output") {
		return "function_call_output";
	}

	if (type === "reasoning") {
		return "reasoning";
	}

	if (typeof record.role === "string") {
		const content = Array.isArray(record.content) ? `[${record.content.length}]` : "";
		return `input:${record.role}${content}`;
	}

	return type ? `item:${type}` : "object";
}
