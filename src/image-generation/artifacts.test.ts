import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	copyImageToExplicitPath,
	prepareExplicitOutputPath,
	saveCanonicalImage,
} from "./artifacts";
import { validPng } from "./test-helpers";

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

describe("image artifacts", () => {
	test("atomically publishes canonical artifacts without overwriting", async () => {
		const agentDir = await tempDir("pi-image-agent-");
		const bytes = validPng();
		const first = await saveCanonicalImage({
			bytes,
			agentDir,
			sessionId: "session/unsafe",
			imageCallId: "ig:test",
		});
		const second = await saveCanonicalImage({
			bytes,
			agentDir,
			sessionId: "session/unsafe",
			imageCallId: "ig:test",
		});

		expect(first).not.toBe(second);
		expect(first).toEndWith("ig-test.png");
		expect(second).toEndWith("ig-test-2.png");
		expect(await readFile(first)).toEqual(bytes);
		expect(await readFile(second)).toEqual(bytes);
	});

	test("allows trusted project output and writes a non-overwriting copy", async () => {
		const agentDir = await tempDir("pi-image-agent-");
		const project = await tempDir("pi-image-project-");
		const plan = await prepareExplicitOutputPath({
			rawPath: "assets/generated.png",
			agentDir,
			ctx: {
				cwd: project,
				hasUI: true,
				isProjectTrusted: () => true,
				ui: { confirm: async () => true } as never,
			},
		});
		expect(plan?.path).toBe(join(await realpath(project), "assets", "generated.png"));
		await copyImageToExplicitPath({ bytes: validPng(), plan: plan! });
		expect(await readFile(plan!.path)).toEqual(validPng());
		await expect(copyImageToExplicitPath({ bytes: validPng(), plan: plan! })).rejects.toThrow();
	});

	test("rejects untrusted project output", async () => {
		const agentDir = await tempDir("pi-image-agent-");
		const project = await tempDir("pi-image-project-");
		await expect(
			prepareExplicitOutputPath({
				rawPath: "generated.png",
				agentDir,
				ctx: {
					cwd: project,
					hasUI: true,
					isProjectTrusted: () => false,
					ui: { confirm: async () => true } as never,
				},
			}),
		).rejects.toThrow("untrusted project");
	});

	test("requires confirmation for an external output path and rejects it headlessly", async () => {
		const agentDir = await tempDir("pi-image-agent-");
		const project = await tempDir("pi-image-project-");
		const external = await tempDir("pi-image-external-");
		let confirmedPath = "";
		const plan = await prepareExplicitOutputPath({
			rawPath: join(external, "external.png"),
			agentDir,
			ctx: {
				cwd: project,
				hasUI: true,
				isProjectTrusted: () => true,
				ui: {
					confirm: async (_title: string, message: string) => {
						confirmedPath = message;
						return true;
					},
				} as never,
			},
		});
		expect(confirmedPath).toContain(plan!.path);

		await expect(
			prepareExplicitOutputPath({
				rawPath: join(external, "headless.png"),
				agentDir,
				ctx: {
					cwd: project,
					hasUI: false,
					isProjectTrusted: () => true,
					ui: {} as never,
				},
			}),
		).rejects.toThrow("interactive approval");
	});

	test("rejects non-PNG and existing destinations before dispatch", async () => {
		const agentDir = await tempDir("pi-image-agent-");
		const project = await tempDir("pi-image-project-");
		const existing = join(project, "existing.png");
		await writeFile(existing, "existing");
		const ctx = {
			cwd: project,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: { confirm: async () => true } as never,
		};
		await expect(
			prepareExplicitOutputPath({ rawPath: "bad.jpg", agentDir, ctx }),
		).rejects.toThrow(".png");
		await expect(
			prepareExplicitOutputPath({ rawPath: existing, agentDir, ctx }),
		).rejects.toThrow("already exists");
		expect(dirname(existing)).toBe(project);
	});
});
