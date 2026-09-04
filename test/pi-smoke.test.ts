import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const packageDir = resolve(import.meta.dir, "..");
const runnerPath = join(import.meta.dir, "pi-smoke-runner.ts");
const targets = [
	["compaction entry", "compaction"],
	["inline compaction loop", "inline_compaction"],
	["Web Search entry", "web_search"],
	["image generation entry", "image_generation"],
	["auto mode entry", "auto_mode"],
	["complete package", "package"],
] as const;

describe("pi smoke", () => {
	for (const [name, target] of targets) {
		test(
			`loads the ${name} with the local official Pi runtime`,
			() => {
				const result = spawnSync(process.execPath, [runnerPath, target], {
					cwd: packageDir,
					encoding: "utf8",
				});

				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout.trim()).toBe("OK");
			},
			180000,
		);
	}
});
