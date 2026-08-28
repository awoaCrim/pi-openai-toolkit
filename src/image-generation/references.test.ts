import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPreparedReferences, prepareReferenceImages } from "./references";
import { validJpeg, validPng, validWebp } from "./test-helpers";

let dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-image-refs-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
	dirs = [];
});

describe("reference image preparation", () => {
	test("validates, deduplicates, and confirms local PNG/JPEG/WebP files", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "a.png"), validPng());
		await writeFile(join(cwd, "b.jpg"), validJpeg());
		await writeFile(join(cwd, "c.webp"), validWebp());
		let confirmation = "";
		const prepared = await prepareReferenceImages({
			paths: ["a.png", "./a.png", "b.jpg", "c.webp"],
			ctx: {
				cwd,
				hasUI: true,
				ui: {
					confirm: async (_title: string, message: string) => {
						confirmation = message;
						return true;
					},
				} as never,
			},
		});

		expect(prepared.map((item) => item.mimeType)).toEqual([
			"image/png",
			"image/jpeg",
			"image/webp",
		]);
		expect(confirmation).toContain("a.png");
		expect(confirmation).toContain("paid image request");
		clearPreparedReferences(prepared);
		expect(prepared.every((item) => item.bytes.every((byte) => byte === 0))).toBe(true);
	});

	test("rejects reference upload in headless mode", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "a.png"), validPng());
		await expect(
			prepareReferenceImages({
				paths: ["a.png"],
				ctx: { cwd, hasUI: false, ui: {} as never },
			}),
		).rejects.toThrow("interactive approval");
	});

	test("rejects invalid or truncated signatures and declined upload", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "fake.png"), "not an image");
		await expect(
			prepareReferenceImages({
				paths: ["fake.png"],
				ctx: { cwd, hasUI: true, ui: { confirm: async () => true } as never },
			}),
		).rejects.toThrow("PNG, JPEG, or WebP");

		await writeFile(join(cwd, "truncated.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
		await expect(
			prepareReferenceImages({
				paths: ["truncated.jpg"],
				ctx: { cwd, hasUI: true, ui: { confirm: async () => true } as never },
			}),
		).rejects.toThrow("PNG, JPEG, or WebP");

		await writeFile(join(cwd, "real.png"), validPng());
		await expect(
			prepareReferenceImages({
				paths: ["real.png"],
				ctx: { cwd, hasUI: true, ui: { confirm: async () => false } as never },
			}),
		).rejects.toThrow("declined");
	});

	test("honors caller cancellation before reading", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "a.png"), validPng());
		const controller = new AbortController();
		controller.abort();
		await expect(
			prepareReferenceImages({
				paths: ["a.png"],
				ctx: { cwd, hasUI: true, ui: { confirm: async () => true } as never },
				signal: controller.signal,
			}),
		).rejects.toThrow("cancelled");
	});
});
