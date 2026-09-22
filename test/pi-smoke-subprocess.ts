import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Isolate credentials/settings and native HOME lookup before the SDK process starts. */
export function runSmokeRunner(runner: string, args: string[]) {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT"].includes(key.toUpperCase())) env[key] = value;
	}
	const root = mkdtempSync(join(tmpdir(), "pi-openai-toolkit-smoke-"));
	const home = join(root, "home");
	try {
		mkdirSync(home, { recursive: true });
		Object.assign(env, {
			TOOLKIT_SMOKE_ROOT: root, HOME: home, USERPROFILE: home,
			APPDATA: join(home, "AppData", "Roaming"),
			LOCALAPPDATA: join(home, "AppData", "Local"),
			PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_OFFLINE: "1",
		});
		return spawnSync(process.execPath, [join(import.meta.dir, runner), ...args], {
			cwd: resolve(import.meta.dir, ".."), encoding: "utf8", env, timeout: 30000,
		});
	} finally {
		// The child also disposes its sandbox; cover timeout/early startup failures.
		rmSync(root, { recursive: true, force: true });
	}
}
