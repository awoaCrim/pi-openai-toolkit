import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const packageDir = path.resolve(import.meta.dir, "..");
const targets = [
	["compaction entry", path.join(packageDir, "extensions", "compaction.ts")],
	["Web Search entry", path.join(packageDir, "extensions", "web-search.ts")],
	["Reasoning Translation entry", path.join(packageDir, "extensions", "reasoning-translation.ts")],
	["complete package", packageDir],
] as const;

describe("pi smoke", () => {
	for (const [name, target] of targets) {
		test(
			`loads the ${name}`,
			() => {
				const result = spawnSync(
					"pi",
					[
						"--no-session",
						"--offline",
						"--no-extensions",
						"--no-skills",
						"--no-prompt-templates",
						"-e",
						target,
						"-p",
						"Reply with the single word OK.",
					],
					{ encoding: "utf8" },
				);

				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout.trim()).toBe("OK");
			},
			180000,
		);
	}
});
