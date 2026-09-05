import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const packageDir = resolve(import.meta.dir, "..");
const runnerPath = join(import.meta.dir, "pi-smoke-runner.ts");
const targets = [
	["compaction entry", "compaction"],
	["native post-tool compaction", "native_threshold"],
	["Pi-disabled compaction", "native_disabled"],
	["below-threshold continuation", "native_under"],
	["manual compaction with auto disabled", "native_manual"],
	["cooperative compaction cancellation", "native_cancel"],
	["remote failure and native fallback", "native_failure"],
	["Web Search entry", "web_search"],
	["image generation entry", "image_generation"],
	["auto mode entry", "auto_mode"],
	["codex astra entry", "codex_astra"],
	["complete package", "package"],
] as const;

describe("pi smoke", () => {
	for (const [name, target] of targets) {
		test(
			`loads the ${name} with the local official Pi runtime`,
			() => {
				// Do not inherit provider credentials, model config, or agent settings.
				const env: NodeJS.ProcessEnv = {};
				for (const [key, value] of Object.entries(process.env)) {
					if (["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT"].includes(key.toUpperCase())) env[key] = value;
				}
				const native = target.startsWith("native_");
				const result = spawnSync(process.execPath, [native ? join(import.meta.dir, "pi-native-compaction-runner.ts") : runnerPath, native ? target.slice(7) : target], {
					cwd: packageDir,
					encoding: "utf8",
					env,
					timeout: 30000,
				});

				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout.trim()).toBe("OK");
			},
			180000,
		);
	}
});
