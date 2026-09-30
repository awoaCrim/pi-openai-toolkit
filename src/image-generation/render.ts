import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	getAgentDir,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	getCapabilities,
	Image,
	Spacer,
	Text,
	type Component,
} from "@earendil-works/pi-tui";
import { getGeneratedImagesRoot } from "./artifacts";
import { readImageMetadata } from "./protocol";
import {
	MAX_GENERATED_IMAGE_BYTES,
	isImageGenerationDetails,
	type GenerateImageParams,
	type ImageGenerationMimeType,
	type ImageGenerationToolDetails,
} from "./types";

export type ImageGenerationRenderState = Record<string, never>;

export type ImageGenerationRenderContext = {
	lastComponent: Component | undefined;
	showImages: boolean;
	isError: boolean;
	isPartial: boolean;
};

export type ImageRendererDependencies = {
	getAgentDir: () => string;
	getCapabilities: typeof getCapabilities;
	readFileSync: typeof readFileSync;
	realpathSync: typeof realpathSync;
	statSync: typeof statSync;
};

const DEFAULT_RENDER_DEPS: ImageRendererDependencies = {
	getAgentDir,
	getCapabilities,
	readFileSync,
	realpathSync,
	statSync,
};

function isPathInsideOrEqual(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resultText(result: AgentToolResult<ImageGenerationToolDetails>): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

class DiskBackedImageResult extends Container {
	readonly artifactPath?: string;
	readonly fileSize?: number;
	readonly mtimeMs?: number;
	readonly mimeType?: ImageGenerationMimeType;
	readonly showImages: boolean;
	readonly textValue: string;

	constructor(args: {
		text: string;
		artifactPath?: string;
		fileSize?: number;
		mtimeMs?: number;
		mimeType?: ImageGenerationMimeType;
		showImages: boolean;
		base64?: string;
		theme: Theme;
		previewWarning?: string;
	}) {
		super();
		this.artifactPath = args.artifactPath;
		this.fileSize = args.fileSize;
		this.mtimeMs = args.mtimeMs;
		this.mimeType = args.mimeType;
		this.showImages = args.showImages;
		this.textValue = `${args.text}\n${args.previewWarning ?? ""}`;
		this.addChild(new Text(args.theme.fg("toolOutput", args.text), 0, 0));
		if (args.previewWarning) {
			this.addChild(new Text(args.theme.fg("muted", args.previewWarning), 0, 0));
		}
		if (args.base64) {
			this.addChild(new Spacer(1));
			this.addChild(
				new Image(
					args.base64,
					args.mimeType ?? "image/png",
					{ fallbackColor: (text) => args.theme.fg("toolOutput", text) },
					{ maxWidthCells: 60, filename: args.artifactPath },
				),
			);
		}
	}

	matches(args: {
		text: string;
		artifactPath?: string;
		fileSize?: number;
		mtimeMs?: number;
		mimeType?: ImageGenerationMimeType;
		showImages: boolean;
		previewWarning?: string;
	}): boolean {
		return (
			this.textValue === `${args.text}\n${args.previewWarning ?? ""}` &&
			this.artifactPath === args.artifactPath &&
			this.fileSize === args.fileSize &&
			this.mtimeMs === args.mtimeMs &&
			this.mimeType === args.mimeType &&
			this.showImages === args.showImages
		);
	}
}

function textOnly(args: {
	text: string;
	theme: Theme;
	context: ImageGenerationRenderContext;
	previewWarning?: string;
}): Component {
	const previous = args.context.lastComponent;
	if (
		previous instanceof DiskBackedImageResult &&
		previous.matches({
			text: args.text,
			showImages: false,
			previewWarning: args.previewWarning,
		})
	) {
		return previous;
	}
	return new DiskBackedImageResult({
		text: args.text,
		showImages: false,
		theme: args.theme,
		previewWarning: args.previewWarning,
	});
}

export function createImageGenerationResultRenderer(
	deps: ImageRendererDependencies = DEFAULT_RENDER_DEPS,
): (
	result: AgentToolResult<ImageGenerationToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ImageGenerationRenderContext,
) => Component {
	return (result, _options, theme, context) => {
		const text = resultText(result) || "Image generation finished.";
		if (
			context.isError ||
			context.isPartial ||
			!context.showImages ||
			!isImageGenerationDetails(result.details) ||
			!deps.getCapabilities().images
		) {
			return textOnly({ text, theme, context });
		}

		const artifactPath = resolve(result.details.artifactPath);
		let root: string;
		let realArtifact: string;
		let info: ReturnType<typeof statSync>;
		try {
			root = deps.realpathSync(getGeneratedImagesRoot(deps.getAgentDir()));
			realArtifact = deps.realpathSync(artifactPath);
			info = deps.statSync(realArtifact);
		} catch {
			return textOnly({
				text,
				theme,
				context,
				previewWarning: "Image preview unavailable: the saved artifact is missing.",
			});
		}

		if (
			!isPathInsideOrEqual(root, realArtifact) ||
			!info.isFile() ||
			info.size <= 0 ||
			info.size > MAX_GENERATED_IMAGE_BYTES
		) {
			return textOnly({
				text,
				theme,
				context,
				previewWarning: "Image preview unavailable: the artifact path or file is not safe.",
			});
		}

		const previous = context.lastComponent;
		if (
			previous instanceof DiskBackedImageResult &&
			previous.matches({
				text,
				artifactPath: realArtifact,
				fileSize: info.size,
				mtimeMs: info.mtimeMs,
				mimeType: result.details.mimeType,
				showImages: true,
			})
		) {
			return previous;
		}

		let bytes: Buffer;
		try {
			bytes = deps.readFileSync(realArtifact);
		} catch {
			return textOnly({
				text,
				theme,
				context,
				previewWarning: "Image preview unavailable: the artifact could not be read.",
			});
		}
		const metadata = readImageMetadata(bytes);
		if (bytes.length !== info.size || !metadata || metadata.mimeType !== result.details.mimeType) {
			bytes.fill(0);
			return textOnly({
				text,
				theme,
				context,
				previewWarning: "Image preview unavailable: the artifact is not a valid supported image.",
			});
		}
		const base64 = bytes.toString("base64");
		bytes.fill(0);
		return new DiskBackedImageResult({
			text,
			artifactPath: realArtifact,
			fileSize: info.size,
			mtimeMs: info.mtimeMs,
			mimeType: metadata.mimeType,
			showImages: true,
			base64,
			theme,
		});
	};
}

export const renderImageGenerationResult = createImageGenerationResultRenderer();

export const _renderTest = {
	DiskBackedImageResult,
	isPathInsideOrEqual,
};
