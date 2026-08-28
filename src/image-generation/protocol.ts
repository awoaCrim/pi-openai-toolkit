import {
	IMAGE_GENERATION_MIME_TYPE,
	IMAGE_GENERATION_MODEL,
	IMAGE_GENERATION_QUALITIES,
	IMAGE_GENERATION_SIZES,
	MAX_GENERATED_IMAGE_BYTES,
	MAX_IMAGE_DIAGNOSTIC_CHARS,
	MAX_IMAGE_DIMENSION,
	MAX_IMAGE_IDENTIFIER_CHARS,
	MAX_IMAGE_PATH_CHARS,
	MAX_IMAGE_PROMPT_CHARS,
	MAX_REFERENCE_IMAGE_COUNT,
	ImageGenerationError,
	sanitizeImageDiagnostic,
	type GenerateImageParams,
	type NormalizedGenerateImageParams,
	type ParsedGeneratedImage,
	type PreparedReferenceImage,
	type ReferenceImageMimeType,
} from "./types";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is;

export type ImageGenerationRequestBody = {
	model: string;
	store: false;
	stream: false;
	parallel_tool_calls: false;
	input: Array<{
		role: "user";
		content: Array<
			| { type: "input_text"; text: string }
			| { type: "input_image"; image_url: string; detail: "auto" }
		>;
	}>;
	tools: Array<{
		type: "image_generation";
		model: typeof IMAGE_GENERATION_MODEL;
		action: "generate" | "edit";
		size: NormalizedGenerateImageParams["size"];
		quality: NormalizedGenerateImageParams["quality"];
		output_format: "png";
	}>;
	tool_choice: { type: "image_generation" };
};

export type ParsedImageResponseResult =
	| { ok: true; image: ParsedGeneratedImage }
	| {
			ok: false;
			reason: "malformed-response" | "no-image" | "request-rejected" | "oversized-response";
			errorMessage: string;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizedOptionalString(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, maxChars) : undefined;
}

function normalizePathList(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new ImageGenerationError(
			"invalid-parameters",
			"referenceImagePaths must be an array of path strings or null.",
		);
	}

	const normalized: string[] = [];
	for (const rawPath of value) {
		if (typeof rawPath !== "string") {
			throw new ImageGenerationError(
				"invalid-parameters",
				"referenceImagePaths must contain only path strings.",
			);
		}
		const trimmed = rawPath.trim();
		if (!trimmed) continue;
		if (trimmed.length > MAX_IMAGE_PATH_CHARS) {
			throw new ImageGenerationError(
				"invalid-parameters",
				`Each reference image path must be at most ${MAX_IMAGE_PATH_CHARS} characters.`,
			);
		}
		normalized.push(trimmed);
		if (normalized.length > MAX_REFERENCE_IMAGE_COUNT) {
			throw new ImageGenerationError(
				"invalid-parameters",
				`referenceImagePaths must contain at most ${MAX_REFERENCE_IMAGE_COUNT} paths.`,
			);
		}
	}
	return normalized;
}

function normalizeOutputPath(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new ImageGenerationError(
			"invalid-parameters",
			"outputPath must be a path string or null.",
		);
	}
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.length > MAX_IMAGE_PATH_CHARS) {
		throw new ImageGenerationError(
			"invalid-parameters",
			`outputPath must be at most ${MAX_IMAGE_PATH_CHARS} characters when provided.`,
		);
	}
	return trimmed;
}

export function normalizeGenerateImageParams(
	params: GenerateImageParams,
): NormalizedGenerateImageParams {
	const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
	if (!prompt || prompt.length > MAX_IMAGE_PROMPT_CHARS) {
		throw new ImageGenerationError(
			"invalid-parameters",
			`prompt must be 1-${MAX_IMAGE_PROMPT_CHARS} characters.`,
		);
	}

	const size = params.size ?? "auto";
	if (!(IMAGE_GENERATION_SIZES as readonly string[]).includes(size)) {
		throw new ImageGenerationError(
			"invalid-parameters",
			`Unsupported image size: ${String(size)}.`,
		);
	}

	const quality = params.quality ?? "auto";
	if (!(IMAGE_GENERATION_QUALITIES as readonly string[]).includes(quality)) {
		throw new ImageGenerationError(
			"invalid-parameters",
			`Unsupported image quality: ${String(quality)}.`,
		);
	}

	const referenceImagePaths = normalizePathList(params.referenceImagePaths);
	const outputPath = normalizeOutputPath(params.outputPath);

	return {
		prompt,
		referenceImagePaths,
		outputPath,
		size,
		quality,
		action: referenceImagePaths.length > 0 ? "edit" : "generate",
	};
}

export function buildImageGenerationRequest(args: {
	routingModel: string;
	params: NormalizedGenerateImageParams;
	references: readonly PreparedReferenceImage[];
}): ImageGenerationRequestBody {
	const content: ImageGenerationRequestBody["input"][number]["content"] = [
		{ type: "input_text", text: args.params.prompt },
	];
	for (const reference of args.references) {
		content.push({
			type: "input_image",
			image_url: `data:${reference.mimeType};base64,${reference.bytes.toString("base64")}`,
			detail: "auto",
		});
	}

	return {
		model: args.routingModel,
		store: false,
		stream: false,
		parallel_tool_calls: false,
		input: [{ role: "user", content }],
		tools: [
			{
				type: "image_generation",
				model: IMAGE_GENERATION_MODEL,
				action: args.params.action,
				size: args.params.size,
				quality: args.params.quality,
				output_format: "png",
			},
		],
		tool_choice: { type: "image_generation" },
	};
}

function hasPngEndChunk(buffer: Buffer): boolean {
	return (
		buffer.length >= 33 &&
		buffer.readUInt32BE(buffer.length - 12) === 0 &&
		buffer.toString("ascii", buffer.length - 8, buffer.length - 4) === "IEND"
	);
}

export function detectReferenceImageMimeType(bytes: Uint8Array): ReferenceImageMimeType | undefined {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (readPngDimensions(buffer) && hasPngEndChunk(buffer)) return "image/png";
	if (
		buffer.length >= 4 &&
		buffer[0] === 0xff &&
		buffer[1] === 0xd8 &&
		buffer[2] === 0xff &&
		buffer.lastIndexOf(Buffer.from([0xff, 0xd9])) >= 3
	) {
		return "image/jpeg";
	}
	if (
		buffer.length >= 20 &&
		buffer.toString("ascii", 0, 4) === "RIFF" &&
		buffer.toString("ascii", 8, 12) === "WEBP"
	) {
		const declaredSize = buffer.readUInt32LE(4) + 8;
		const chunkType = buffer.toString("ascii", 12, 16);
		const chunkSize = buffer.readUInt32LE(16);
		const paddedChunkSize = chunkSize + (chunkSize % 2);
		if (
			declaredSize === buffer.length &&
			(chunkType === "VP8 " || chunkType === "VP8L" || chunkType === "VP8X") &&
			20 + paddedChunkSize <= buffer.length
		) {
			return "image/webp";
		}
	}
	return undefined;
}

export function isValidPng(bytes: Uint8Array): boolean {
	return bytes.byteLength >= PNG_SIGNATURE.length && Buffer.from(bytes).subarray(0, 8).equals(PNG_SIGNATURE);
}

export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (!isValidPng(buffer) || buffer.length < 24) return undefined;
	if (buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") return undefined;
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	if (
		width <= 0 ||
		height <= 0 ||
		width > MAX_IMAGE_DIMENSION ||
		height > MAX_IMAGE_DIMENSION
	) return undefined;
	return { width, height };
}

function extractBase64(value: string): string {
	const trimmed = value.trim();
	const dataUrl = DATA_URL_PATTERN.exec(trimmed);
	return (dataUrl?.[1] ?? trimmed).trim();
}

export function decodeGeneratedPng(value: string):
	| { ok: true; bytes: Buffer; width: number; height: number }
	| { ok: false; reason: "malformed-response" | "oversized-response"; errorMessage: string } {
	const base64 = extractBase64(value);
	const maxBase64Chars = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4;
	if (base64.length > maxBase64Chars) {
		return {
			ok: false,
			reason: "oversized-response",
			errorMessage: "Image generation returned an image larger than the 32 MiB limit.",
		};
	}
	if (!base64 || base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) {
		return {
			ok: false,
			reason: "malformed-response",
			errorMessage: "Image generation returned invalid base64 image data.",
		};
	}

	const bytes = Buffer.from(base64, "base64");
	if (
		bytes.length === 0 ||
		bytes.length > MAX_GENERATED_IMAGE_BYTES ||
		bytes.toString("base64") !== base64
	) {
		bytes.fill(0);
		return {
			ok: false,
			reason: bytes.length > MAX_GENERATED_IMAGE_BYTES ? "oversized-response" : "malformed-response",
			errorMessage: "Image generation returned invalid or oversized image data.",
		};
	}
	const dimensions = readPngDimensions(bytes);
	if (!dimensions) {
		bytes.fill(0);
		return {
			ok: false,
			reason: "malformed-response",
			errorMessage: "Image generation returned data that is not a valid PNG image.",
		};
	}
	return { ok: true, bytes, ...dimensions };
}

export function extractProviderErrorMessage(value: unknown, fallback: string): string {
	if (!isRecord(value)) return fallback;
	const direct = normalizedOptionalString(value.message, MAX_IMAGE_DIAGNOSTIC_CHARS);
	if (direct) return sanitizeImageDiagnostic(direct, fallback);
	if (isRecord(value.error)) {
		const nested = normalizedOptionalString(value.error.message, MAX_IMAGE_DIAGNOSTIC_CHARS);
		if (nested) return sanitizeImageDiagnostic(nested, fallback);
	}
	return fallback;
}

export function parseImageGenerationResponse(value: unknown): ParsedImageResponseResult {
	if (!isRecord(value)) {
		return {
			ok: false,
			reason: "malformed-response",
			errorMessage: "Image generation returned a non-object response.",
		};
	}

	if (value.status !== "completed") {
		return {
			ok: false,
			reason: "request-rejected",
			errorMessage: extractProviderErrorMessage(
				value,
				`Image generation did not complete (status: ${String(value.status ?? "unknown")}).`,
			),
		};
	}
	if (!Array.isArray(value.output)) {
		return {
			ok: false,
			reason: "malformed-response",
			errorMessage: "Image generation response did not contain an output array.",
		};
	}

	const calls = new Map<string, { result: string; revisedPrompt?: string }>();
	for (let index = 0; index < value.output.length; index += 1) {
		const item = value.output[index];
		if (!isRecord(item) || item.type !== "image_generation_call") continue;
		if (item.status !== "completed") continue;
		const result = typeof item.result === "string"
			? item.result
			: typeof item.b64_json === "string"
				? item.b64_json
				: undefined;
		if (!result?.trim()) continue;
		const id = normalizedOptionalString(item.id, MAX_IMAGE_IDENTIFIER_CHARS) ?? `image_generation_${index}`;
		const revisedPrompt = normalizedOptionalString(item.revised_prompt, MAX_IMAGE_DIAGNOSTIC_CHARS);
		const existing = calls.get(id);
		if (existing && existing.result !== result) {
			return {
				ok: false,
				reason: "malformed-response",
				errorMessage: "Image generation returned conflicting results for one image call.",
			};
		}
		calls.set(id, { result, revisedPrompt: revisedPrompt ?? existing?.revisedPrompt });
	}

	if (calls.size === 0) {
		return {
			ok: false,
			reason: "no-image",
			errorMessage: "Image generation completed without a usable image result.",
		};
	}
	if (calls.size !== 1) {
		return {
			ok: false,
			reason: "malformed-response",
			errorMessage: "Image generation returned more than one image result for a single-image request.",
		};
	}

	const [imageCallId, call] = [...calls.entries()][0]!;
	const decoded = decodeGeneratedPng(call.result);
	if (!decoded.ok) return decoded;

	return {
		ok: true,
		image: {
			bytes: decoded.bytes,
			imageCallId,
			responseId: normalizedOptionalString(value.id, MAX_IMAGE_IDENTIFIER_CHARS),
			revisedPrompt: call.revisedPrompt,
			width: decoded.width,
			height: decoded.height,
		},
	};
}

export const _protocolTest = {
	PNG_SIGNATURE,
	IMAGE_GENERATION_MIME_TYPE,
};
