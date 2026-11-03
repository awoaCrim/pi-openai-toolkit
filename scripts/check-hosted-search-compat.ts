import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSmokeRunner } from "../test/pi-smoke-subprocess";

assert(process.versions.bun, "Run this compatibility check with Bun");
const requested = process.argv.slice(2);
const versions = requested.length ? requested : ["0.87.0", "0.99.0"];
for (const version of versions) {
	assert(["0.87.0", "0.99.0"].includes(version), "Use a declared compatibility boundary");
	const root = mkdtempSync(join(tmpdir(), "pi-openai-toolkit-compat-"));
	try {
		const dependencies = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"]
			.map(name => [`@earendil-works/${name}`, version]));
		writeFileSync(join(root, "package.json"), JSON.stringify({
			private: true, type: "module", dependencies, overrides: dependencies,
		}));
		// Only public package installation uses the network. The SDK child uses
		// the existing isolated HOME and deny-all-network smoke environment.
		const installed = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
			["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
			{ cwd: root, encoding: "utf8", timeout: 180000 });
		assert.equal(installed.status, 0, installed.error?.message ?? installed.stderr);
		const result = runSmokeRunner("pi-hosted-search-runtime-runner.ts", [root, version]);
		assert.equal(result.status, 0, result.error?.message ?? result.stderr);
		assert(result.stdout.includes(`OK Pi ${version}: capture=${version === "0.99.0"}`));
		if (version === "0.87.0") assert(result.stderr.includes("raw provider stream events"));
		process.stdout.write(result.stdout);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
