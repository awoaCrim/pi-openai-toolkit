import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The parent sets HOME before spawning; call before dynamically importing Pi. */
export async function createSmokeEnvironment() {
	const root = process.env.TOOLKIT_SMOKE_ROOT ?? await mkdtemp(join(tmpdir(), "pi-openai-toolkit-smoke-"));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.APPDATA = join(home, "AppData", "Roaming");
	process.env.LOCALAPPDATA = join(home, "AppData", "Local");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	assert.equal(homedir(), home, "Smoke HOME was not isolated before startup; run through pi-smoke.test.ts");
	const previousCwd = process.cwd();
	process.chdir(cwd);
	const originalFetch = globalThis.fetch;
	let deniedRequests = 0;
	globalThis.fetch = (async () => {
		deniedRequests++;
		throw new Error("External networking is forbidden in Pi smoke tests");
	}) as typeof fetch;
	return {
		cwd, home, agentDir,
		assertNoNetwork() {
			if (deniedRequests) throw new Error(`Pi smoke attempted ${deniedRequests} unexpected network request(s)`);
		},
		async dispose() {
			globalThis.fetch = originalFetch;
			process.chdir(previousCwd);
			await rm(root, { recursive: true, force: true });
		},
	};
}
