import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { detectReferenceImageMimeType } from "./protocol";
import {
	MAX_REFERENCE_IMAGE_BYTES,
	MAX_REFERENCE_IMAGE_COUNT,
	MAX_TOTAL_REFERENCE_IMAGE_BYTES,
	ImageGenerationError,
	type PreparedReferenceImage,
} from "./types";

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new ImageGenerationError("aborted", "Image generation was cancelled.");
	}
}

function displayPath(filePath: string, cwd: string): string {
	const rel = relative(cwd, filePath);
	const value = rel && !rel.startsWith(`..${sep}`) && rel !== ".." ? rel : filePath;
	return value.length > 240 ? `…${value.slice(-239)}` : value;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function clearPreparedReferences(references: readonly PreparedReferenceImage[]): void {
	for (const reference of references) {
		reference.bytes.fill(0);
	}
}

export async function prepareReferenceImages(args: {
	paths: readonly string[];
	ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "ui">;
	signal?: AbortSignal;
}): Promise<PreparedReferenceImage[]> {
	if (args.paths.length === 0) return [];
	if (args.paths.length > MAX_REFERENCE_IMAGE_COUNT) {
		throw new ImageGenerationError(
			"reference-input-invalid",
			`Too many reference images (maximum ${MAX_REFERENCE_IMAGE_COUNT}).`,
		);
	}
	if (!args.ctx.hasUI) {
		throw new ImageGenerationError(
			"reference-upload-approval-required",
			"Reference-image upload requires interactive approval and is unavailable in headless mode.",
		);
	}

	const prepared: PreparedReferenceImage[] = [];
	const seen = new Set<string>();
	let totalBytes = 0;
	try {
		for (const rawPath of args.paths) {
			throwIfAborted(args.signal);
			const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(args.ctx.cwd, rawPath);
			let resolvedPath: string;
			try {
				resolvedPath = await realpath(candidate);
			} catch {
				throw new ImageGenerationError(
					"reference-input-invalid",
					`Reference image does not exist or is not accessible: ${displayPath(candidate, args.ctx.cwd)}`,
				);
			}
			if (seen.has(resolvedPath)) continue;

			const handle = await open(resolvedPath, "r").catch(() => undefined);
			if (!handle) {
				throw new ImageGenerationError(
					"reference-input-invalid",
					`Reference image does not exist or is not accessible: ${displayPath(resolvedPath, args.ctx.cwd)}`,
				);
			}

			let bytes: Buffer | undefined;
			let readCompleted = false;
			try {
				const info = await handle.stat();
				if (!info.isFile()) {
					throw new ImageGenerationError(
						"reference-input-invalid",
						`Reference image must be a regular file: ${displayPath(resolvedPath, args.ctx.cwd)}`,
					);
				}
				if (info.size <= 0 || info.size > MAX_REFERENCE_IMAGE_BYTES) {
					throw new ImageGenerationError(
						"reference-input-invalid",
						`Reference image must be between 1 byte and 20 MiB: ${displayPath(resolvedPath, args.ctx.cwd)}`,
					);
				}
				totalBytes += info.size;
				if (totalBytes > MAX_TOTAL_REFERENCE_IMAGE_BYTES) {
					throw new ImageGenerationError(
						"reference-input-invalid",
						"Reference images exceed the 50 MiB total limit.",
					);
				}

				bytes = Buffer.alloc(info.size);
				let offset = 0;
				while (offset < bytes.length) {
					if (args.signal?.aborted) {
						bytes.fill(0);
						throw new ImageGenerationError("aborted", "Image generation was cancelled.");
					}
					const { bytesRead } = await handle.read(
						bytes,
						offset,
						bytes.length - offset,
						offset,
					);
					if (bytesRead === 0) break;
					offset += bytesRead;
				}
				const extra = Buffer.alloc(1);
				const { bytesRead: extraBytesRead } = await handle.read(extra, 0, 1, info.size);
				extra.fill(0);
				if (offset !== info.size || extraBytesRead !== 0) {
					bytes.fill(0);
					throw new ImageGenerationError(
						"reference-input-invalid",
						`Reference image changed while being read: ${displayPath(resolvedPath, args.ctx.cwd)}`,
					);
				}
				if (args.signal?.aborted) {
					bytes.fill(0);
					throw new ImageGenerationError("aborted", "Image generation was cancelled.");
				}
				readCompleted = true;
			} finally {
				if (!readCompleted) bytes?.fill(0);
				await handle.close().catch(() => undefined);
			}
			if (!bytes) {
				throw new ImageGenerationError(
					"reference-input-invalid",
					`Reference image could not be read: ${displayPath(resolvedPath, args.ctx.cwd)}`,
				);
			}

			const mimeType = detectReferenceImageMimeType(bytes);
			if (!mimeType) {
				bytes.fill(0);
				throw new ImageGenerationError(
					"reference-input-invalid",
					`Reference image must be PNG, JPEG, or WebP: ${displayPath(resolvedPath, args.ctx.cwd)}`,
				);
			}
			seen.add(resolvedPath);
			prepared.push({ path: resolvedPath, mimeType, bytes });
		}

		if (prepared.length === 0) {
			throw new ImageGenerationError(
				"reference-input-invalid",
				"No unique readable reference images were provided.",
			);
		}

		const lines = prepared.map(
			(reference) =>
				`• ${displayPath(reference.path, args.ctx.cwd)} (${formatBytes(reference.bytes.length)})`,
		);
		const approved = await args.ctx.ui.confirm(
			"Upload reference images?",
			[
				"The following local files will be uploaded to the current model's configured gateway for image editing:",
				"",
				...lines,
				"",
				"Continue with this paid image request?",
			].join("\n"),
			{ signal: args.signal },
		);
		throwIfAborted(args.signal);
		if (!approved) {
			throw new ImageGenerationError(
				"reference-upload-declined",
				"Reference-image upload was declined.",
			);
		}
		return prepared;
	} catch (error) {
		clearPreparedReferences(prepared);
		throw error;
	}
}
