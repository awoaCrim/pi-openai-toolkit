import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
] as const;

function runSmoke(args: string[]) {
	// Do not inherit provider credentials, model config, or agent settings.
	// Bun caches os.homedir() at startup, so isolate before starting the child.
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT"].includes(key.toUpperCase())) env[key] = value;
	}
	const root = mkdtempSync(join(tmpdir(), "pi-toolkit-smoke-"));
	env.PI_TOOLKIT_SMOKE_ROOT = root;
	env.HOME = join(root, "home");
	env.USERPROFILE = env.HOME;
	env.PI_OFFLINE = "1";
	try {
		return spawnSync(process.execPath, args, {
			cwd: packageDir, encoding: "utf8", env, timeout: 30000,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("pi smoke", () => {
	for (const tools of ["read", "read,web_run"]) {
		test(`standalone search route permits local read with --tools ${tools}`, () => {
			const result = runSmoke([join(import.meta.dir, "pi-search-allowlist-runner.ts"), "--tools", tools]);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe("OK");
		}, 40000);
	}

	for (const [name, target] of targets) {
		test(`loads the ${name} with the local official Pi runtime`, () => {
			const native = target.startsWith("native_");
			const result = runSmoke([native ? join(import.meta.dir, "pi-native-compaction-runner.ts") : runnerPath, native ? target.slice(7) : target]);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe("OK");
		}, 180000);
	}
});
