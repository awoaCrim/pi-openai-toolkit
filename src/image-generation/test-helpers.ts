import type { ImageGenerationDetails } from "./types";

export const VALID_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=";

export function validPng(): Buffer {
	return Buffer.from(VALID_PNG_BASE64, "base64");
}

export function validJpeg(): Buffer {
	return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
}

export function validWebp(): Buffer {
	const bytes = Buffer.alloc(30);
	bytes.write("RIFF", 0, "ascii");
	bytes.writeUInt32LE(bytes.length - 8, 4);
	bytes.write("WEBP", 8, "ascii");
	bytes.write("VP8X", 12, "ascii");
	bytes.writeUInt32LE(10, 16);
	return bytes;
}

export function completedImageResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "resp_image_test",
		status: "completed",
		output: [
			{
				type: "image_generation_call",
				id: "ig_test",
				status: "completed",
				result: VALID_PNG_BASE64,
				revised_prompt: "A revised prompt",
			},
		],
		...overrides,
	};
}

export function imageDetails(artifactPath: string): ImageGenerationDetails {
	return {
		artifactPath,
		routingModel: "newapi/gpt-5.5",
		imageModel: "gpt-image-2",
		imageCallId: "ig_test",
		responseId: "resp_image_test",
		mimeType: "image/png",
		byteCount: validPng().length,
		width: 1,
		height: 1,
		edited: false,
		referenceCount: 0,
	};
}
