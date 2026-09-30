import { describe, expect, test } from "bun:test";
import {
	buildImageGenerationRequest,
	decodeGeneratedImage,
	decodeGeneratedPng,
	detectReferenceImageMimeType,
	normalizeGenerateImageParams,
	parseImagesApiResponse,
	readImageMetadata,
	readPngDimensions,
	selectImageGenerationModel,
} from "./protocol";
import {
	completedImageResponse,
	imageDetails,
	VALID_PNG_BASE64,
	validJpeg,
	validPng,
	validWebp,
} from "./test-helpers";
import {
	ImageGenerationError,
	isImageGenerationBatchDetails,
	isImageGenerationDetails,
	sanitizeImageDiagnostic,
} from "./types";

describe("image generation protocol", () => {
	test("normalizes the small tool interface, model and batch defaults", () => {
		expect(normalizeGenerateImageParams({ prompt: " draw a cat " })).toEqual({
			prompt: "draw a cat",
			referenceImagePaths: [],
			outputPath: undefined,
			size: "auto",
			quality: "auto",
			model: undefined,
			batchSize: 1,
			action: "generate",
		});
		expect(
			normalizeGenerateImageParams({
			prompt: "edit",
			referenceImagePaths: [" a.png "],
			outputPath: " result.png ",
			size: "1024x1536",
			quality: "high",
			model: " grok-imagine-image-2.0 ",
		}),
		).toEqual({
			prompt: "edit",
			referenceImagePaths: ["a.png"],
			outputPath: "result.png",
			size: "1024x1536",
			quality: "high",
			model: "grok-imagine-image-2.0",
			batchSize: 1,
			action: "edit",
		});
		expect(normalizeGenerateImageParams({ prompt: "draw", batchSize: 4 }).batchSize).toBe(4);
		expect(() => normalizeGenerateImageParams({ prompt: "draw", batchSize: 0 })).toThrow(
			"batchSize must be an integer from 1 to 10.",
		);
		expect(() => normalizeGenerateImageParams({ prompt: "draw", batchSize: 1.5 })).toThrow();
		expect(() => normalizeGenerateImageParams({ prompt: "draw", batchSize: 11 })).toThrow();
		expect(() => normalizeGenerateImageParams({ prompt: "draw", batchSize: 2, outputPath: "out.png" })).toThrow(
			"outputPath cannot be used",
		);
	});

	test("treats null, empty and blank optional paths as absent", () => {
		expect(
			normalizeGenerateImageParams({
				prompt: "draw a cat",
				referenceImagePaths: null,
				outputPath: null,
				model: null,
				batchSize: null,
			}),
		).toMatchObject({ referenceImagePaths: [], outputPath: undefined, model: undefined, batchSize: 1 });
		expect(
			normalizeGenerateImageParams({
			prompt: "edit",
			referenceImagePaths: ["", " ", " first.png ", "\t", "second.webp"],
			outputPath: " ",
		}),
		).toMatchObject({ referenceImagePaths: ["first.png", "second.webp"], outputPath: undefined, action: "edit" });
		expect(
			normalizeGenerateImageParams({
			prompt: "edit",
			referenceImagePaths: [" omit ", "none", "null"],
			outputPath: " omit ",
		}),
		).toMatchObject({ referenceImagePaths: ["omit", "none", "null"], outputPath: "omit" });
	});

	test("rejects malformed optional values", () => {
		expect(() => normalizeGenerateImageParams({ prompt: "draw", model: 42 as unknown as string })).toThrow(
			"model must be a model id string or null.",
		);
		expect(() => normalizeGenerateImageParams({ prompt: "draw", outputPath: 42 as unknown as string })).toThrow(
			"outputPath must be a path string or null.",
		);
		expect(() => normalizeGenerateImageParams({ prompt: "edit", referenceImagePaths: [null] as unknown as string[] })).toThrow(
			"referenceImagePaths must contain only path strings.",
		);
	});

	test("selects the configured default or an explicitly configured image model", () => {
		expect(selectImageGenerationModel({})).toBe("grok-imagine-image-2.0");
		expect(selectImageGenerationModel({ configuredModels: ["grok-imagine-image-2.0", "test-image-model"] })).toBe(
			"grok-imagine-image-2.0",
		);
		expect(
			selectImageGenerationModel({
				requestedModel: " test-image-model ",
				configuredModels: ["grok-imagine-image-2.0", "test-image-model"],
			}),
		).toBe("test-image-model");
		expect(selectImageGenerationModel({ configuredModels: [" ", "test-image-model", "test-image-model"] })).toBe("test-image-model");
	});

	test("rejects an unconfigured image model before it can be selected", () => {
		expect(() =>
			selectImageGenerationModel({ requestedModel: "grok-imagine-image-2.0", configuredModels: ["test-image-model"] }),
		).toThrow(ImageGenerationError);
		expect(() =>
			selectImageGenerationModel({ requestedModel: "openai/test-image-model", configuredModels: ["test-image-model"] }),
		).toThrow(ImageGenerationError);
	});

	test("builds an isolated one-image Images request descriptor", () => {
		const params = normalizeGenerateImageParams({
			prompt: "Turn this into a watercolor",
			referenceImagePaths: ["reference.png"],
			size: "1536x1024",
			quality: "medium",
		});
		const reference = { path: "reference.png", mimeType: "image/png" as const, bytes: validPng() };
		const body = buildImageGenerationRequest({ imageModel: "grok-imagine-image-2.0", params, references: [reference] });

		expect(body).toEqual({
			action: "edit",
			model: "grok-imagine-image-2.0",
			prompt: "Turn this into a watercolor",
			n: 1,
			size: "1536x1024",
			quality: "medium",
			references: [reference],
		});
		expect(body).not.toHaveProperty("tools");
		expect(body).not.toHaveProperty("tool_choice");
		expect(body).not.toHaveProperty("input");
		expect(body).not.toHaveProperty("routingModel");
	});

	test("keeps the selected image model independent from the active routing model", () => {
		const params = normalizeGenerateImageParams({ prompt: "draw a cat" });
		const body = buildImageGenerationRequest({ imageModel: "test-image-model", params, references: [] });
		expect(body.model).toBe("test-image-model");
		expect(() => buildImageGenerationRequest({ imageModel: " ", params, references: [] })).toThrow(
			"A configured image generation model is required.",
		);
	});

	test("parses exactly one Images API base64 result and validates PNG metadata", () => {
		const parsed = parseImagesApiResponse(completedImageResponse());
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.image.imageCallId).toBe("ig_test");
		expect(parsed.image.responseId).toBe("resp_image_test");
		expect(parsed.image.revisedPrompt).toBe("A revised prompt");
		expect(parsed.image.bytes).toEqual(validPng());
		expect({ width: parsed.image.width, height: parsed.image.height }).toEqual({ width: 1, height: 1 });
	});

	test("rejects missing or multiple Images API results", () => {
		expect(parseImagesApiResponse({ data: [] })).toEqual(expect.objectContaining({ ok: false, reason: "no-image" }));
		expect(
			parseImagesApiResponse({ data: [{ b64_json: VALID_PNG_BASE64 }, { b64_json: VALID_PNG_BASE64 }] }),
		).toEqual(expect.objectContaining({ ok: false, reason: "malformed-response" }));
		expect(parseImagesApiResponse({ data: [{ url: "https://example.invalid/image.png" }] })).toEqual(
			expect.objectContaining({ ok: false, reason: "no-image" }),
		);
		expect(parseImagesApiResponse({ status: "completed", output: [] })).toEqual(
			expect.objectContaining({ ok: false, reason: "malformed-response" }),
		);
	});

	test("parses provider JPEG/WebP base64 responses and preserves their actual MIME type", () => {
		const jpeg = validJpeg();
		const jpegResult = parseImagesApiResponse({
			data: [{ b64_json: jpeg.toString("base64"), mime_type: "image/jpeg" }],
		});
		expect(jpegResult).toMatchObject({ ok: true });
		if (jpegResult.ok) {
			expect(jpegResult.image.mimeType).toBe("image/jpeg");
			expect({ width: jpegResult.image.width, height: jpegResult.image.height }).toEqual({ width: 1, height: 1 });
		}

		const webp = validWebp();
		const webpResult = parseImagesApiResponse({
			data: [{ b64_json: webp.toString("base64"), mime_type: "image/webp" }],
		});
		expect(webpResult).toMatchObject({ ok: true });
		if (webpResult.ok) expect(webpResult.image.mimeType).toBe("image/webp");
		expect(readImageMetadata(jpeg)).toEqual({ mimeType: "image/jpeg", width: 1, height: 1 });
		expect(readImageMetadata(webp)).toEqual({ mimeType: "image/webp", width: 1, height: 1 });
	});

	test("rejects malformed base64, MIME mismatches, and unsupported responses", () => {
		expect(parseImagesApiResponse({ data: [{ b64_json: "not-base64" }] })).toEqual(
			expect.objectContaining({ ok: false, reason: "malformed-response" }),
		);
		expect(
			parseImagesApiResponse({ data: [{ b64_json: validJpeg().toString("base64"), mime_type: "image/png" }] }),
		).toEqual(expect.objectContaining({ ok: false, reason: "malformed-response" }));
		expect(decodeGeneratedImage(Buffer.from("not an image").toString("base64"))).toEqual(
			expect.objectContaining({ ok: false, reason: "malformed-response" }),
		);
		expect(decodeGeneratedPng(Buffer.from("not a png").toString("base64"))).toEqual(
			expect.objectContaining({ ok: false, reason: "malformed-response" }),
		);
	});

	test("recognizes complete PNG, JPEG and WebP references and rejects truncated formats", () => {
		expect(detectReferenceImageMimeType(validPng())).toBe("image/png");
		expect(detectReferenceImageMimeType(validJpeg())).toBe("image/jpeg");
		expect(detectReferenceImageMimeType(validWebp())).toBe("image/webp");
		expect(detectReferenceImageMimeType(validPng().subarray(0, 24))).toBeUndefined();
		expect(detectReferenceImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
		expect(detectReferenceImageMimeType(validWebp().subarray(0, 20))).toBeUndefined();
		expect(readPngDimensions(validPng())).toEqual({ width: 1, height: 1 });
	});

	test("validates single and batch persisted details and redacts image data", () => {
		const details = imageDetails("/agent/generated-images/session/ig.png");
		expect(isImageGenerationDetails(details)).toBe(true);
		expect(isImageGenerationDetails({ ...details, imageModel: "grok-imagine-image-2.0" })).toBe(true);
		expect(isImageGenerationDetails({ ...details, imageModel: "" })).toBe(false);
		expect(isImageGenerationDetails({ ...details, imageModel: "x".repeat(257) })).toBe(false);
		const batch = {
			batch: true as const,
			requestedCount: 2,
			succeededCount: 1,
			failedCount: 1,
			images: [details],
			failures: [{ index: 1, code: "network" as const, message: "temporary failure" }],
		};
		expect(isImageGenerationBatchDetails(batch)).toBe(true);
		expect(isImageGenerationBatchDetails({ ...batch, failures: [{ ...batch.failures[0]!, index: 1 }] })).toBe(true);
		expect(
			isImageGenerationBatchDetails({
				...batch,
				failures: [{ ...batch.failures[0]!, code: "not-a-failure-code" }],
			}),
		).toBe(false);
		const diagnostic = sanitizeImageDiagnostic(
			`failed data:image/png;base64,${VALID_PNG_BASE64.repeat(2)} account-id=acct_secret`,
			"fallback",
		);
		expect(diagnostic).toContain("[REDACTED_IMAGE_DATA]");
		expect(diagnostic).toContain("account-id: [REDACTED]");
		expect(diagnostic).not.toContain(VALID_PNG_BASE64);
	});
});
