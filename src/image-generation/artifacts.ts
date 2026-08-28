import { constants as fsConstants } from "node:fs";
import {
	link,
	mkdir,
	open,
	realpath,
	stat,
	unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	MAX_IMAGE_PATH_CHARS,
	ImageGenerationError,
	sanitizeImageDiagnostic,
} from "./types";

export type ExplicitOutputPlan = {
	path: string;
};

function isPathInsideOrEqual(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function sanitizePathPart(value: string, fallback: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "")
		.slice(0, 120);
	return sanitized || fallback;
}

async function realDirectory(path: string): Promise<string> {
	return realpath(path).catch(() => resolve(path));
}

async function resolveWriteTarget(candidate: string): Promise<string> {
	const suffix: string[] = [];
	let current = resolve(candidate);
	while (true) {
		try {
			const info = await stat(current);
			if (suffix.length > 0 && !info.isDirectory()) {
				throw new ImageGenerationError(
					"output-path-invalid",
					`Output parent is not a directory: ${current}`,
				);
			}
			const existing = await realpath(current);
			return resolve(existing, ...suffix);
		} catch (error) {
			if (error instanceof ImageGenerationError) throw error;
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code !== "ENOENT"
			) {
				throw new ImageGenerationError(
					"output-path-invalid",
					`Unable to inspect output path: ${candidate}`,
				);
			}
			const parent = dirname(current);
			if (parent === current) {
				throw new ImageGenerationError(
					"output-path-invalid",
					`Unable to resolve output path: ${candidate}`,
				);
			}
			suffix.unshift(basename(current));
			current = parent;
		}
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new ImageGenerationError("aborted", "Image generation was cancelled.");
	}
}

export function getGeneratedImagesRoot(agentDir: string): string {
	return join(resolve(agentDir), "generated-images");
}

export async function prepareExplicitOutputPath(args: {
	rawPath?: string;
	agentDir: string;
	ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "isProjectTrusted" | "ui">;
	signal?: AbortSignal;
}): Promise<ExplicitOutputPlan | undefined> {
	if (args.rawPath === undefined) return undefined;
	const trimmed = args.rawPath.trim();
	if (!trimmed || trimmed.length > MAX_IMAGE_PATH_CHARS || extname(trimmed).toLowerCase() !== ".png") {
		throw new ImageGenerationError(
			"output-path-invalid",
			"outputPath must be a non-empty .png file path.",
		);
	}

	throwIfAborted(args.signal);
	const lexical = isAbsolute(trimmed) ? resolve(trimmed) : resolve(args.ctx.cwd, trimmed);
	const target = await resolveWriteTarget(lexical);
	const targetInfo = await stat(target).catch(() => undefined);
	if (targetInfo) {
		throw new ImageGenerationError(
			"output-path-invalid",
			`Output path already exists and will not be overwritten: ${target}`,
		);
	}

	const [agentRoot, projectRoot] = await Promise.all([
		realDirectory(args.agentDir),
		realDirectory(args.ctx.cwd),
	]);
	if (isPathInsideOrEqual(agentRoot, target)) return { path: target };

	if (isPathInsideOrEqual(projectRoot, target)) {
		if (!args.ctx.isProjectTrusted()) {
			throw new ImageGenerationError(
				"output-path-invalid",
				"Writing generated images inside an untrusted project is not allowed.",
			);
		}
		return { path: target };
	}

	if (!args.ctx.hasUI) {
		throw new ImageGenerationError(
			"output-path-approval-required",
			"Writing outside the Pi agent root or trusted project requires interactive approval.",
		);
	}
	const approved = await args.ctx.ui.confirm(
		"Write generated image outside safe roots?",
		[
			"The generated PNG will be copied to this external path without overwriting an existing file:",
			"",
			target,
			"",
			"Continue?",
		].join("\n"),
		{ signal: args.signal },
	);
	throwIfAborted(args.signal);
	if (!approved) {
		throw new ImageGenerationError("output-path-declined", "External output path was declined.");
	}
	return { path: target };
}

async function publishBytesNoOverwrite(bytes: Uint8Array, target: string): Promise<void> {
	const parent = dirname(target);
	await mkdir(parent, { recursive: true });
	const tempPath = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await link(tempPath, target);
	} finally {
		await handle?.close().catch(() => undefined);
		await unlink(tempPath).catch(() => undefined);
	}
}

function isAlreadyExistsError(error: unknown): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

export async function saveCanonicalImage(args: {
	bytes: Uint8Array;
	agentDir: string;
	sessionId: string;
	imageCallId: string;
}): Promise<string> {
	const root = getGeneratedImagesRoot(args.agentDir);
	const sessionPart = sanitizePathPart(args.sessionId, "session");
	const imagePart = sanitizePathPart(args.imageCallId, "image_generation");
	const directory = join(root, sessionPart);

	for (let index = 1; index <= 1000; index += 1) {
		const suffix = index === 1 ? "" : `-${index}`;
		const target = join(directory, `${imagePart}${suffix}.png`);
		try {
			await publishBytesNoOverwrite(args.bytes, target);
			return target;
		} catch (error) {
			if (isAlreadyExistsError(error)) continue;
			throw new ImageGenerationError(
				"artifact-write-failed",
				sanitizeImageDiagnostic(
					error instanceof Error ? error.message : error,
					"Failed to persist the generated image artifact.",
				),
			);
		}
	}
	throw new ImageGenerationError(
		"artifact-write-failed",
		"Failed to reserve a unique generated image artifact path.",
	);
}

export async function copyImageToExplicitPath(args: {
	bytes: Uint8Array;
	plan: ExplicitOutputPlan;
}): Promise<void> {
	const currentTarget = await resolveWriteTarget(args.plan.path);
	if (currentTarget !== args.plan.path) {
		throw new Error("Output path changed after approval.");
	}
	await publishBytesNoOverwrite(args.bytes, args.plan.path);
}

export const _artifactTest = {
	isPathInsideOrEqual,
	publishBytesNoOverwrite,
	resolveWriteTarget,
};
