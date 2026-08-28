import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageGenerationResultRenderer } from "./render";
import { imageDetails, validPng } from "./test-helpers";

let dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
	dirs = [];
});

const theme = {
	fg: (_name: string, value: string) => value,
} as never;

function context(lastComponent?: never, showImages = true) {
	return {
		lastComponent,
		showImages,
		isError: false,
		isPartial: false,
	};
}

describe("disk-backed image result rendering", () => {
	test("loads an agent artifact once and reuses the prior component", async () => {
		const agentDir = await tempDir("pi-render-agent-");
		const artifact = join(agentDir, "generated-images", "session", "ig.png");
		await mkdir(join(agentDir, "generated-images", "session"), { recursive: true });
		await writeFile(artifact, validPng());
		let reads = 0;
		const renderer = createImageGenerationResultRenderer({
			getAgentDir: () => agentDir,
			getCapabilities: () => ({ images: "kitty", trueColor: true, hyperlinks: false }),
			readFileSync: (...args) => {
				reads += 1;
				return readFileSync(...args);
			},
			realpathSync,
			statSync,
		});
		const result = {
			content: [{ type: "text" as const, text: `Artifact: ${artifact}` }],
			details: imageDetails(artifact),
		};
		const first = renderer(result, { expanded: false, isPartial: false }, theme, context());
		const second = renderer(
			result,
			{ expanded: false, isPartial: false },
			theme,
			context(first as never),
		);

		expect(second).toBe(first);
		expect(reads).toBe(1);
	});

	test("falls back to text when images are hidden or the artifact is missing", async () => {
		const agentDir = await tempDir("pi-render-agent-");
		await mkdir(join(agentDir, "generated-images"), { recursive: true });
		const missing = join(agentDir, "generated-images", "session", "missing.png");
		const renderer = createImageGenerationResultRenderer({
			getAgentDir: () => agentDir,
			getCapabilities: () => ({ images: "kitty", trueColor: true, hyperlinks: false }),
			readFileSync,
			realpathSync,
			statSync,
		});
		const result = {
			content: [{ type: "text" as const, text: `Artifact: ${missing}` }],
			details: imageDetails(missing),
		};
		const hidden = renderer(result, { expanded: false, isPartial: false }, theme, context(undefined, false));
		expect(hidden.render(100).join("\n")).toContain("Artifact:");

		const absent = renderer(result, { expanded: false, isPartial: false }, theme, context());
		expect(absent.render(100).join("\n")).toContain("saved artifact is missing");
	});

	test("never previews a path outside the Pi generated-images root", async () => {
		const agentDir = await tempDir("pi-render-agent-");
		const external = await tempDir("pi-render-external-");
		await mkdir(join(agentDir, "generated-images"), { recursive: true });
		const artifact = join(external, "outside.png");
		await writeFile(artifact, validPng());
		let reads = 0;
		const renderer = createImageGenerationResultRenderer({
			getAgentDir: () => agentDir,
			getCapabilities: () => ({ images: "kitty", trueColor: true, hyperlinks: false }),
			readFileSync: (...args) => {
				reads += 1;
				return readFileSync(...args);
			},
			realpathSync,
			statSync,
		});
		const component = renderer(
			{
				content: [{ type: "text" as const, text: `Artifact: ${artifact}` }],
				details: imageDetails(artifact),
			},
			{ expanded: false, isPartial: false },
			theme,
			context(),
		);
		expect(component.render(100).join("\n")).toContain("not safe");
		expect(reads).toBe(0);
	});
});
