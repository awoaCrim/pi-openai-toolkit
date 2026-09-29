export const IMAGE_GENERATION_TOOL_NAME = "openai_generate_image";
export const IMAGE_GENERATION_MIME_TYPE = "image/png" as const;
export const IMAGE_GENERATION_CAPABLE_APIS = [
	"openai-responses",
	"openai-codex-responses",
] as const;
export const IMAGE_GENERATION_SIZES = [
	"auto",
	"1024x1024",
	"1536x1024",
	"1024x1536",
] as const;
export const IMAGE_GENERATION_QUALITIES = ["auto", "low", "medium", "high"] as const;

export const MAX_IMAGE_PROMPT_CHARS = 20_000;
export const MAX_REFERENCE_IMAGE_COUNT = 5;
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_RESPONSE_BYTES = 48 * 1024 * 1024;
export const MAX_IMAGE_ERROR_BYTES = 64 * 1024;
export const IMAGE_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_IMAGE_PATH_CHARS = 4096;
export const MAX_IMAGE_DIAGNOSTIC_CHARS = 4096;
export const MAX_IMAGE_IDENTIFIER_CHARS = 256;
/** Upper bound for a configured or requested Images API model id. */
export const MAX_IMAGE_MODEL_ID_CHARS = 256;
export const MAX_IMAGE_BATCH_SIZE = 10;
export const MAX_IMAGE_DIMENSION = 100_000;

export type ImageGenerationCapableApi = (typeof IMAGE_GENERATION_CAPABLE_APIS)[number];
export type ImageGenerationSize = (typeof IMAGE_GENERATION_SIZES)[number];
export type ImageGenerationQuality = (typeof IMAGE_GENERATION_QUALITIES)[number];
export type ImageGenerationAction = "generate" | "edit";
export type ReferenceImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export type ImageGenerationModel = {
	api?: string;
	provider?: string;
	id?: string;
};

export type GenerateImageParams = {
	prompt: string;
	referenceImagePaths?: string[] | null;
	outputPath?: string | null;
	size?: ImageGenerationSize;
	quality?: ImageGenerationQuality;
	/** Optional bare image model id that must exist in the configured image model allowlist. */
	model?: string | null;
	/** Number of independent image requests to run concurrently. */
	batchSize?: number | null;
};

export type NormalizedGenerateImageParams = {
	prompt: string;
	referenceImagePaths: string[];
	outputPath?: string;
	size: ImageGenerationSize;
	quality: ImageGenerationQuality;
	action: ImageGenerationAction;
	batchSize: number;
	/** Trimmed requested model id, or undefined when the caller omitted it. */
	model?: string;
};

export type PreparedReferenceImage = {
	path: string;
	mimeType: ReferenceImageMimeType;
	bytes: Buffer;
};

export type ParsedGeneratedImage = {
	bytes: Buffer;
	imageCallId: string;
	responseId?: string;
	revisedPrompt?: string;
	width: number;
	height: number;
};

export type ImageGenerationDetails = {
	artifactPath: string;
	outputPath?: string;
	routingModel: string;
	imageModel: string;
	imageCallId: string;
	responseId?: string;
	mimeType: typeof IMAGE_GENERATION_MIME_TYPE;
	byteCount: number;
	width: number;
	height: number;
	edited: boolean;
	referenceCount: number;
	revisedPrompt?: string;
	warning?: string;
};

export type ImageGenerationBatchFailure = {
	index: number;
	code: ImageGenerationFailureCode;
	message: string;
};

export type ImageGenerationBatchDetails = {
	batch: true;
	requestedCount: number;
	succeededCount: number;
	failedCount: number;
	images: ImageGenerationDetails[];
	failures?: ImageGenerationBatchFailure[];
};

export type ImageGenerationToolDetails = ImageGenerationDetails | ImageGenerationBatchDetails;

export type ImageGenerationExecutionResult = {
	details: ImageGenerationToolDetails;
	text: string;
};

export type ImageGenerationFailureCode =
	| "aborted"
	| "timeout"
	| "disabled"
	| "unsupported-model"
	| "missing-runtime"
	| "invalid-parameters"
	| "reference-input-invalid"
	| "reference-upload-approval-required"
	| "reference-upload-declined"
	| "output-path-invalid"
	| "output-path-approval-required"
	| "output-path-declined"
	| "authentication"
	| "rate-limit"
	| "request-rejected"
	| "backend-unavailable"
	| "network"
	| "oversized-response"
	| "malformed-response"
	| "no-image"
	| "artifact-write-failed";

function isImageGenerationFailureCode(value: unknown): value is ImageGenerationFailureCode {
	switch (value) {
		case "aborted":
		case "timeout":
		case "disabled":
		case "unsupported-model":
		case "missing-runtime":
		case "invalid-parameters":
		case "reference-input-invalid":
		case "reference-upload-approval-required":
		case "reference-upload-declined":
		case "output-path-invalid":
		case "output-path-approval-required":
		case "output-path-declined":
		case "authentication":
		case "rate-limit":
		case "request-rejected":
		case "backend-unavailable":
		case "network":
		case "oversized-response":
		case "malformed-response":
		case "no-image":
		case "artifact-write-failed":
			return true;
		default:
			return false;
	}
}

export class ImageGenerationError extends Error {
	readonly code: ImageGenerationFailureCode;

	constructor(code: ImageGenerationFailureCode, message: string) {
		super(message);
		this.name = "ImageGenerationError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxChars: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxChars;
}

export function isImageGenerationDetails(value: unknown): value is ImageGenerationDetails {
	if (!isRecord(value)) return false;
	return (
		isBoundedString(value.artifactPath, MAX_IMAGE_PATH_CHARS) &&
		(value.outputPath === undefined || isBoundedString(value.outputPath, MAX_IMAGE_PATH_CHARS)) &&
		isBoundedString(value.routingModel, MAX_IMAGE_DIAGNOSTIC_CHARS) &&
		isBoundedString(value.imageModel, MAX_IMAGE_MODEL_ID_CHARS) &&
		isBoundedString(value.imageCallId, MAX_IMAGE_IDENTIFIER_CHARS) &&
		(value.responseId === undefined || isBoundedString(value.responseId, MAX_IMAGE_IDENTIFIER_CHARS)) &&
		value.mimeType === IMAGE_GENERATION_MIME_TYPE &&
		typeof value.byteCount === "number" &&
		Number.isInteger(value.byteCount) &&
		value.byteCount > 0 &&
		value.byteCount <= MAX_GENERATED_IMAGE_BYTES &&
		typeof value.width === "number" &&
		Number.isInteger(value.width) &&
		value.width > 0 &&
		value.width <= MAX_IMAGE_DIMENSION &&
		typeof value.height === "number" &&
		Number.isInteger(value.height) &&
		value.height > 0 &&
		value.height <= MAX_IMAGE_DIMENSION &&
		typeof value.edited === "boolean" &&
		typeof value.referenceCount === "number" &&
		Number.isInteger(value.referenceCount) &&
		value.referenceCount >= 0 &&
		value.referenceCount <= MAX_REFERENCE_IMAGE_COUNT &&
		(value.revisedPrompt === undefined || isBoundedString(value.revisedPrompt, MAX_IMAGE_DIAGNOSTIC_CHARS)) &&
		(value.warning === undefined || isBoundedString(value.warning, MAX_IMAGE_DIAGNOSTIC_CHARS))
	);
}

function isBoundedIndex(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < maximum;
}

export function isImageGenerationBatchDetails(value: unknown): value is ImageGenerationBatchDetails {
	if (!isRecord(value) || value.batch !== true) return false;
	if (
		typeof value.requestedCount !== "number" ||
		!Number.isInteger(value.requestedCount) ||
		value.requestedCount < 2 ||
		value.requestedCount > MAX_IMAGE_BATCH_SIZE ||
		typeof value.succeededCount !== "number" ||
		!Number.isInteger(value.succeededCount) ||
		value.succeededCount < 1 ||
		value.succeededCount > value.requestedCount ||
		typeof value.failedCount !== "number" ||
		!Number.isInteger(value.failedCount) ||
		value.failedCount !== value.requestedCount - value.succeededCount ||
		!Array.isArray(value.images) ||
		value.images.length !== value.succeededCount ||
		!value.images.every(isImageGenerationDetails)
	) {
		return false;
	}
	if (value.failedCount === 0) return value.failures === undefined;
	if (!Array.isArray(value.failures) || value.failures.length !== value.failedCount) return false;
	const requestedCount = value.requestedCount;
	const indexes = new Set<number>();
	return value.failures.every((failure) => {
		if (!isRecord(failure) || !isBoundedIndex(failure.index, requestedCount)) return false;
		if (!isImageGenerationFailureCode(failure.code) || !isBoundedString(failure.message, MAX_IMAGE_DIAGNOSTIC_CHARS)) return false;
		if (indexes.has(failure.index)) return false;
		indexes.add(failure.index);
		return true;
	});
}

export function isImageGenerationToolDetails(value: unknown): value is ImageGenerationToolDetails {
	return isImageGenerationDetails(value) || isImageGenerationBatchDetails(value);
}

export function sanitizeImageDiagnostic(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value
		.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[REDACTED_IMAGE_DATA]")
		.replace(/[A-Za-z0-9+/]{128,}={0,2}/g, "[REDACTED_BASE64]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(
			/\b(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|account[-_ ]?id|cookie)\s*[:=]\s*[^\s,;]+/gi,
			"$1: [REDACTED]",
		)
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) return fallback;
	return normalized.slice(0, MAX_IMAGE_DIAGNOSTIC_CHARS);
}
