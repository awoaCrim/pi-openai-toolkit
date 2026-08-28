import { describe, expect, test } from "bun:test";
import {
	buildImageGenerationRequest,
	decodeGeneratedPng,
	detectReferenceImageMimeType,
	normalizeGenerateImageParams,
	parseImageGenerationResponse,
	readPngDimensions,
} from "./protocol";
import {
	completedImageResponse,
	imageDetails,
	VALID_PNG_BASE64,
	validJpeg,
	validPng,
	validWebp,
} from "./test-helpers";
import { isImageGenerationDetails, sanitizeImageDiagnostic } from "./types";

describe("image generation protocol", () => {
	test("normalizes the small tool interface and infers generate/edit", () => {
		expect(normalizeGenerateImageParams({ prompt: " draw a cat " })).toEqual({
			prompt: "draw a cat",
			referenceImagePaths: [],
			outputPath: undefined,
			size: "auto",
			quality: "auto",
			action: "generate",
		});
		expect(
			normalizeGenerateImageParams({
				prompt: "edit",
				referenceImagePaths: [" a.png "],
				outputPath: " result.png ",
				size: "1024x1536",
				quality: "high",
			}),
		).toEqual({
			prompt: "edit",
			referenceImagePaths: ["a.png"],
			outputPath: "result.png",
			size: "1024x1536",
			quality: "high",
			action: "edit",
		});
		expect(() => normalizeGenerateImageParams({ prompt: " " })).toThrow();
		expect(() =>
			normalizeGenerateImageParams({
				prompt: "edit",
				referenceImagePaths: ["1", "2", "3", "4", "5", "6"],
			}),
		).toThrow();
	});

	test("treats null, empty, and blank optional paths as absent", () => {
		expect(
			normalizeGenerateImageParams({
				prompt: "draw a cat",
				referenceImagePaths: null,
				outputPath: null,
			}),
		).toEqual({
			prompt: "draw a cat",
			referenceImagePaths: [],
			outputPath: undefined,
			size: "auto",
			quality: "auto",
			action: "generate",
		});
		expect(
			normalizeGenerateImageParams({
				prompt: "draw a cat",
				referenceImagePaths: [],
				outputPath: " \t ",
			}),
		).toEqual({
			prompt: "draw a cat",
			referenceImagePaths: [],
			outputPath: undefined,
			size: "auto",
			quality: "auto",
			action: "generate",
		});
		expect(
			normalizeGenerateImageParams({
				prompt: "draw a cat",
				referenceImagePaths: ["", " \t "],
				outputPath: "",
			}),
		).toEqual({
			prompt: "draw a cat",
			referenceImagePaths: [],
			outputPath: undefined,
			size: "auto",
			quality: "auto",
			action: "generate",
		});
		expect(
			normalizeGenerateImageParams({
				prompt: "edit",
				referenceImagePaths: ["", " ", " first.png ", "\t", "second.webp"],
			}),
		).toEqual({
			prompt: "edit",
			referenceImagePaths: ["first.png", "second.webp"],
			outputPath: undefined,
			size: "auto",
			quality: "auto",
			action: "edit",
		});
	});

	test("preserves arbitrary sentinel strings as paths and rejects non-string values", () => {
		expect(
			normalizeGenerateImageParams({
				prompt: "edit",
				referenceImagePaths: [" omit ", "none", "null"],
				outputPath: " omit ",
			}),
		).toEqual({
			prompt: "edit",
			referenceImagePaths: ["omit", "none", "null"],
			outputPath: "omit",
			size: "auto",
			quality: "auto",
			action: "edit",
		});
		expect(() =>
			normalizeGenerateImageParams({
				prompt: "edit",
				referenceImagePaths: [null] as unknown as string[],
			}),
		).toThrow("referenceImagePaths must contain only path strings.");
		expect(() =>
			normalizeGenerateImageParams({
				prompt: "draw",
				outputPath: 42 as unknown as string,
			}),
		).toThrow("outputPath must be a path string or null.");
	});

	test("builds an isolated one-turn non-streaming gpt-image-2 request", () => {
		const params = normalizeGenerateImageParams({
			prompt: "Turn this into a watercolor",
			referenceImagePaths: ["reference.png"],
			size: "1536x1024",
			quality: "medium",
		});
		const body = buildImageGenerationRequest({
			routingModel: "gpt-5.5",
			params,
			references: [{ path: "reference.png", mimeType: "image/png", bytes: validPng() }],
		});

		expect(body).toEqual({
			model: "gpt-5.5",
			store: false,
			stream: false,
			parallel_tool_calls: false,
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "Turn this into a watercolor" },
						{
							type: "input_image",
							image_url: `data:image/png;base64,${VALID_PNG_BASE64}`,
							detail: "auto",
						},
					],
				},
			],
			tools: [
				{
					type: "image_generation",
					model: "gpt-image-2",
					action: "edit",
					size: "1536x1024",
					quality: "medium",
					output_format: "png",
				},
			],
			tool_choice: { type: "image_generation" },
		});
		expect(body).not.toHaveProperty("max_tool_calls");
		expect(body.tools).toHaveLength(1);
		expect(body.tools[0]?.type).toBe("image_generation");
		expect(body.tool_choice).toEqual({ type: "image_generation" });
		expect(body.parallel_tool_calls).toBe(false);
		expect(body).not.toHaveProperty("instructions");
		expect(body).not.toHaveProperty("prompt_cache_key");
		expect(body).not.toHaveProperty("include");
		expect(body).not.toHaveProperty("reasoning");
		expect(body).not.toHaveProperty("previous_response_id");
	});

	test("parses exactly one completed image call and validates PNG metadata", () => {
		const parsed = parseImageGenerationResponse(completedImageResponse());
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.image.imageCallId).toBe("ig_test");
		expect(parsed.image.responseId).toBe("resp_image_test");
		expect(parsed.image.revisedPrompt).toBe("A revised prompt");
		expect(parsed.image.bytes).toEqual(validPng());
		expect({ width: parsed.image.width, height: parsed.image.height }).toEqual({ width: 1, height: 1 });
	});

	test("deduplicates the same terminal item id but rejects conflicting or multiple images", () => {
		const duplicate = completedImageResponse();
		duplicate.output = [
			...(duplicate.output as unknown[]),
			...(duplicate.output as unknown[]),
		];
		expect(parseImageGenerationResponse(duplicate).ok).toBe(true);

		const conflicting = completedImageResponse();
		conflicting.output = [
			...(conflicting.output as unknown[]),
			{
				type: "image_generation_call",
				id: "ig_test",
				status: "completed",
				result: validPng().subarray(0, 24).toString("base64"),
			},
		];
		expect(parseImageGenerationResponse(conflicting)).toEqual(
			expect.objectContaining({ ok: false, reason: "malformed-response" }),
		);

		const multiple = completedImageResponse();
		multiple.output = [
			...(multiple.output as unknown[]),
			{
				type: "image_generation_call",
				id: "ig_second",
				status: "completed",
				result: VALID_PNG_BASE64,
			},
		];
		expect(parseImageGenerationResponse(multiple)).toEqual(
			expect.objectContaining({ ok: false, reason: "malformed-response" }),
		);
	});

	test("rejects failed, missing, malformed base64, and non-PNG responses", () => {
		expect(parseImageGenerationResponse({ status: "failed", error: { message: "moderated" } })).toEqual({
			ok: false,
			reason: "request-rejected",
			errorMessage: "moderated",
		});
		expect(parseImageGenerationResponse({ status: "completed", output: [] })).toEqual(
			expect.objectContaining({ ok: false, reason: "no-image" }),
		);
		expect(decodeGeneratedPng("not-base64")).toEqual(
			expect.objectContaining({ ok: false, reason: "malformed-response" }),
		);
		expect(decodeGeneratedPng(Buffer.from("not a png").toString("base64"))).toEqual(
			expect.objectContaining({ ok: false, reason: "malformed-response" }),
		);
	});

	test("recognizes complete PNG, JPEG, and WebP references and rejects truncated headers", () => {
		expect(detectReferenceImageMimeType(validPng())).toBe("image/png");
		expect(detectReferenceImageMimeType(validJpeg())).toBe("image/jpeg");
		expect(detectReferenceImageMimeType(validWebp())).toBe("image/webp");
		expect(detectReferenceImageMimeType(validPng().subarray(0, 8))).toBeUndefined();
		expect(detectReferenceImageMimeType(validPng().subarray(0, 24))).toBeUndefined();
		expect(detectReferenceImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBeUndefined();
		expect(detectReferenceImageMimeType(Buffer.from("RIFFxxxxWEBP", "ascii"))).toBeUndefined();
		expect(detectReferenceImageMimeType(Buffer.from("text"))).toBeUndefined();
		expect(readPngDimensions(validPng())).toEqual({ width: 1, height: 1 });
	});

	test("bounds persisted details and redacts image data from diagnostics", () => {
		const details = imageDetails("/agent/generated-images/session/ig.png");
		expect(isImageGenerationDetails(details)).toBe(true);
		expect(isImageGenerationDetails({ ...details, artifactPath: "x".repeat(4097) })).toBe(false);
		expect(isImageGenerationDetails({ ...details, imageCallId: "x".repeat(257) })).toBe(false);
		expect(isImageGenerationDetails({ ...details, referenceCount: 6 })).toBe(false);

		const diagnostic = sanitizeImageDiagnostic(
			`failed data:image/png;base64,${VALID_PNG_BASE64.repeat(2)} account-id=acct_secret`,
			"fallback",
		);
		expect(diagnostic).toContain("[REDACTED_IMAGE_DATA]");
		expect(diagnostic).toContain("account-id: [REDACTED]");
		expect(diagnostic).not.toContain(VALID_PNG_BASE64);
		expect(diagnostic).not.toContain("acct_secret");
	});
});
