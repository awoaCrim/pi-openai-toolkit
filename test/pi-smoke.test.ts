import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageDir = resolve(import.meta.dir, "..");
const runnerPath = join(import.meta.dir, "pi-smoke-runner.ts");
const targets = [
	["native post-tool compaction", "native_threshold"],
	["Pi-disabled compaction", "native_disabled"],
	["below-threshold continuation", "native_under"],
	["manual compaction with auto disabled", "native_manual"],
	["cooperative compaction cancellation", "native_cancel"],
	["remote failure and native fallback", "native_failure"],
	["complete package", "package"],
	["standalone search (openai-responses)", "web_openai-responses"],
	["standalone search (openai-codex-responses)", "web_openai-codex-responses"],
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
				// Bun's POSIX homedir lookup can read native startup environment rather
				// than later process.env edits. Isolate HOME before the child exists.
				const root = mkdtempSync(join(tmpdir(), "pi-openai-toolkit-smoke-"));
				const home = join(root, "home");
				try {
					mkdirSync(home, { recursive: true });
					Object.assign(env, {
						TOOLKIT_SMOKE_ROOT: root, HOME: home, USERPROFILE: home,
						APPDATA: join(home, "AppData", "Roaming"),
						LOCALAPPDATA: join(home, "AppData", "Local"),
						PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
					});
					const native = target.startsWith("native_");
					const webSearch = target.startsWith("web_");
					const runner = native ? join(import.meta.dir, "pi-native-compaction-runner.ts")
						: webSearch ? join(import.meta.dir, "pi-web-search-runner.ts") : runnerPath;
					const argument = native ? target.slice(7) : webSearch ? target.slice(4) : target;
					const result = spawnSync(process.execPath, [runner, argument], {
						cwd: packageDir,
						encoding: "utf8",
						env,
						timeout: 30000,
					});

					expect(result.status, result.stderr).toBe(0);
					expect(result.stdout.trim()).toBe("OK");
				} finally {
					// Also clean up if the subprocess is killed before its own finally.
					rmSync(root, { recursive: true, force: true });
				}
			},
			180000,
		);
	}
});
