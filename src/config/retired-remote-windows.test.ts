import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertConfigValid, loadToolkitConfig, resolveToolkitConfig } from "../config";
import { describeToolkitConfig, registerToolkitConfigCommand } from "../config-command";
import { previewToolkitMigration } from "./migration";
import { notifyConfigIssues } from "./notifications";

const model = { provider: "p", id: "m", api: "openai-responses" };
const secret = "private-retired-window-setting";
const directories: string[] = [];
function fixture(raw: unknown) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-retired-windows-"));
	directories.push(dir);
	const file = path.join(dir, "config.json");
	const bytes = JSON.stringify(raw);
	fs.writeFileSync(file, bytes);
	return { file, bytes, loaded: loadToolkitConfig(file) };
}
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("Remote Windows configuration retirement", () => {
	for (const [index, remoteWindows] of [null, false, 42, secret, [secret], { leaveManagedMode: { [secret]: secret }, reminderThresholdPercent: -500 }].entries()) {
		for (const scope of ["defaults", "selected", "other"] as const) {
			test(`opaque ancillary value ${index} at ${scope} warns without effective policy or source changes`, () => {
				const key = scope === "selected" ? "p/m" : "p/other";
				const { loaded, file, bytes } = fixture({ schemaVersion: 2,
					defaults: { context: { mode: "pi", ...(scope === "defaults" ? { remoteWindows } : {}) }, webSearch: { route: "local" } },
					models: { [key]: { compatibility: { transport: "codex-gateway" }, ...(scope === "defaults" ? {} : { context: { remoteWindows } }) } },
				});
				const resolved = resolveToolkitConfig(loaded, model);
				expect(resolved.invalidFeatures).toEqual([]);
				expect(resolved.policy.context.mode).toBe("pi");
				expect(resolved.policy.webSearch.route).toBe("local");
				expect(resolved.gatewayModelKeys).toContain(key);
				expect(resolved.policy.context).not.toHaveProperty("remoteWindows");
				for (const name of ["contextManagement", "leaveManagedMode", "contextReminderThresholdPercent"]) expect(resolved.config.compaction).not.toHaveProperty(name);
				expect(Object.keys(resolved.origins).some((name) => name.includes("remoteWindows"))).toBe(false);
				expect(resolved.issues).toHaveLength(1);
				expect(resolved.issues[0]).toMatchObject({ severity: "warning", feature: "context",
					path: scope === "defaults" ? "defaults.context.remoteWindows" : `models["${key}"].context.remoteWindows`,
				});
				expect(resolved.issues[0].code).toMatch(/^retired\./);
				expect(() => assertConfigValid(resolved, "context", "webSearch", "compatibility")).not.toThrow();
				expect(describeToolkitConfig(resolved)).toMatch(/Remote Windows/i);
				expect(describeToolkitConfig(resolved)).not.toContain(secret);
				expect(JSON.stringify(resolved.issues)).not.toContain(secret);
				const preview = previewToolkitMigration(loaded);
				expect(preview.status).toBe("already-v2");
				expect(preview.reasons.join(" ")).toMatch(/Remote Windows/i);
				expect(fs.readFileSync(file, "utf8")).toBe(bytes);
			});
		}
	}

	for (const scope of ["defaults", "selected", "other"] as const) {
		test(`removed mode at ${scope} blocks only its selected context scope`, () => {
			const key = scope === "selected" ? "p/m" : "p/other";
			const { loaded, file, bytes } = fixture({ schemaVersion: 2,
				defaults: { webSearch: { route: "local" }, ...(scope === "defaults" ? { context: { mode: " remote-windows " } } : {}) },
				models: scope === "defaults" ? {} : { [key]: { context: { mode: "remote-windows" } } },
			});
			const resolved = resolveToolkitConfig(loaded, model);
			expect(resolved.invalidFeatures.includes("context")).toBe(scope !== "other");
			expect(resolved.invalidFeatures).not.toContain("webSearch");
			expect(resolved.policy.webSearch.route).toBe("local");
			expect(resolved.issues.some((issue) => issue.severity === "error" && issue.feature === "context")).toBe(true);
			if (scope !== "other") expect(() => assertConfigValid(resolved, "context")).toThrow();
			expect(fs.readFileSync(file, "utf8")).toBe(bytes);
		});
	}

	test("an explicit supported exact mode supersedes a removed default leaf", () => {
		const { loaded } = fixture({ schemaVersion: 2, defaults: { context: { mode: "remote-windows" } }, models: { "p/m": { context: { mode: "pi" } } } });
		const resolved = resolveToolkitConfig(loaded, model);
		expect(resolved.invalidFeatures).toEqual([]);
		expect(resolved.policy.context.mode).toBe("pi");
	});

	test("legacy retirement preview is non-equivalent, omits obsolete policy and preserves bytes", () => {
		const { loaded, file, bytes } = fixture({ compaction: { contextManagement: "remote", leaveManagedMode: { secret }, contextReminderThresholdPercent: secret }, webSearch: { defaultRoute: "local" } });
		const resolved = resolveToolkitConfig(loaded, model);
		expect(resolved.invalidFeatures).toContain("context");
		expect(resolved.invalidFeatures).not.toContain("webSearch");
		const preview = previewToolkitMigration(loaded);
		expect(preview.status).toBe("needs-review");
		expect(preview.reasons.join(" ")).toMatch(/Remote Windows/i);
		expect(JSON.stringify(preview.candidate ?? {})).not.toContain("remote-windows");
		expect(JSON.stringify(preview.candidate ?? {})).not.toContain("remoteWindows");
		expect(JSON.stringify(preview)).not.toContain(secret);
		expect(fs.readFileSync(file, "utf8")).toBe(bytes);
	});

	test("retirement does not mask unrelated errors", () => {
		const { loaded } = fixture({ schemaVersion: 2, defaults: { context: { remoteWindows: null }, webSearch: { route: "invalid" } } });
		expect(resolveToolkitConfig(loaded, model).invalidFeatures).toEqual(["webSearch"]);
	});

	test("notices are deduplicated and headless operation never uses UI", async () => {
		const { loaded } = fixture({ schemaVersion: 2, defaults: { context: { mode: "pi", remoteWindows: { secret } } } });
		const resolved = resolveToolkitConfig(loaded, model);
		const notices: string[] = [];
		const ctx = { model, hasUI: true, sessionManager: {}, ui: { notify: (text: string) => notices.push(text) } };
		notifyConfigIssues(ctx as never, resolved); notifyConfigIssues(ctx as never, resolved);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatch(/Remote Windows/i); expect(notices[0]).not.toContain(secret);
		notifyConfigIssues({ hasUI: false, ui: { notify: () => { throw new Error("headless UI accessed"); } } } as never, resolved);
		const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
		registerToolkitConfigCommand({ registerCommand: (name: string, command: never) => commands.set(name, command) } as never, () => loaded);
		notices.length = 0;
		for (const action of ["show", "validate", "migration-preview"]) await commands.get("toolkit-config")!.handler(action, ctx as never);
		expect(notices).toHaveLength(3);
		for (const notice of notices) { expect(notice).toMatch(/Remote Windows/i); expect(notice).not.toContain(secret); }
	});
});
