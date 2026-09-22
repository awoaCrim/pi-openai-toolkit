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
	["manual compaction with a completed but open HTTP response", "native_manual-open"],
	["cooperative compaction cancellation", "native_cancel"],
	["remote failure and native fallback", "native_failure"],
	["complete package", "package"],
	["standalone search (openai-responses)", "web_openai-responses"],
	["standalone search (openai-codex-responses)", "web_openai-codex-responses"],
] as const;

function runSmoke(args: string[], command = process.execPath) {
	// Do not inherit provider credentials, model config, or agent settings.
	// Bun caches os.homedir() at startup, so isolate before starting the child.
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT"].includes(key.toUpperCase())) env[key] = value;
	}
	const root = mkdtempSync(join(tmpdir(), "pi-toolkit-smoke-"));
	const home = join(root, "home");
	try {
		mkdirSync(home, { recursive: true });
		Object.assign(env, {
			PI_TOOLKIT_SMOKE_ROOT: root, TOOLKIT_SMOKE_ROOT: root,
			HOME: home, USERPROFILE: home, PI_OFFLINE: "1",
			APPDATA: join(home, "AppData", "Roaming"),
			LOCALAPPDATA: join(home, "AppData", "Local"),
			PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		});
		return spawnSync(command, args, {
			cwd: packageDir, encoding: "utf8", env, timeout: 30000,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("pi smoke", () => {
	for (const entry of ["dist/cli.js", "dist/bundle/cli.js"]) {
		test(`standalone exclusion works through the actual Pi ${entry} entrypoint`, () => {
			const result = runSmoke([
				join(packageDir, "node_modules/@earendil-works/pi-coding-agent", entry),
				"--mode", "json", "--no-session", "--offline", "--model", "toolkit-smoke/local",
				"--tools", "read", "--no-extensions", "--extension", join(import.meta.dir, "pi-search-cli-extension.ts"),
				"--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "-p", "Read the fixture and finish.",
			], "node");
			expect(result.status, result.stderr).toBe(0);
			const events = result.stdout.trim().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
			const toolResults = events.filter((event) => event.type === "tool_execution_end");
			expect(toolResults).toHaveLength(1);
			expect(toolResults[0]).toMatchObject({ toolName: "read", isError: false });
			const last = events.filter((event) => event.type === "message_end" && event.message.role === "assistant").at(-1)?.message;
			expect(last).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "CLI-DONE" }] });
		}, 40000);
	}

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
			const webSearch = target.startsWith("web_");
			const runner = native ? join(import.meta.dir, "pi-native-compaction-runner.ts")
				: webSearch ? join(import.meta.dir, "pi-web-search-runner.ts") : runnerPath;
			const argument = native ? target.slice(7) : webSearch ? target.slice(4) : target;
			const result = runSmoke([runner, argument]);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe("OK");
		}, 180000);
	}
});
