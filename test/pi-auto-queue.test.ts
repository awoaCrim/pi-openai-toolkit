import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function runQueueScenario(mode: string, scenario: string, sameContent = false) {
	// Set HOME before Bun starts: os.homedir() is cached at startup.
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT"].includes(key.toUpperCase())) env[key] = value;
	}
	const root = mkdtempSync(join(tmpdir(), "pi-auto-queue-"));
	env.PI_TOOLKIT_SMOKE_ROOT = root;
	env.HOME = join(root, "home");
	env.USERPROFILE = env.HOME;
	env.PI_OFFLINE = "1";
	try {
		const runner = scenario === "classifier" ? "pi-auto-classifier-runner.ts" : "pi-auto-queue-runner.ts";
		const result = spawnSync(process.execPath, [join(import.meta.dir, runner), mode, scenario, sameContent ? "same" : "different"], {
			cwd: resolve(import.meta.dir, ".."), encoding: "utf8", env, timeout: 30000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("OK");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("auto mode actual Pi request delivery", () => {
	for (const mode of ["idle", "steer", "followUp"]) {
		for (const sameContent of [false, true]) {
			test(`${mode} delivery gives ${sameContent ? "identical" : "different"} user text a fresh denial budget`, () => {
				runQueueScenario(mode, "fresh", sameContent);
			}, 40000);
		}
	}
	for (const mode of ["steer", "followUp"]) {
		test(`enqueueing ${mode} retains A's denial history until B is delivered`, () => {
			runQueueScenario(mode, "queued-active", true);
		}, 40000);
		test(`${mode} delivery invalidates identical-text classifier work without unlocking a newer sample`, () => {
			runQueueScenario(mode, "classifier");
		}, 40000);
	}
	test("assistant/tool continuations reach the denial threshold within one request", () => {
		runQueueScenario("idle", "continuation");
	}, 40000);
});
