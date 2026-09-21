import { expect, test } from "bun:test";
import { describeToolkitConfig, registerToolkitConfigCommand } from "./config-command";
import { resolveToolkitConfig } from "./config";
import { notifyConfigIssues } from "./config/notifications";
import { v2Fixture } from "./config/test-helpers";

const model = { provider: "p", id: "m", api: "openai-responses" };

test("human command reads once per invocation with no action APIs, auth or state writes", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	let reads = 0;
	const loaded = v2Fixture({ defaults: { webSearch: { route: "local" } }, models: { "p/m": { webSearch: { route: "hosted" } } } });
	const before = JSON.stringify(loaded);
	const pi = new Proxy({ registerCommand: (name: string, command: never) => commands.set(name, command) }, {
		get(target, key) { if (key === "registerCommand") return target.registerCommand; throw new Error(`Unexpected action: ${String(key)}`); },
	});
	registerToolkitConfigCommand(pi as never, () => { reads++; return loaded; });
	expect(reads).toBe(0);
	const notices: string[] = [];
	const ctx = { hasUI: true, model, ui: { notify: (text: string) => notices.push(text) } } as never;
	for (const action of ["", "validate", "migration-preview"]) await commands.get("toolkit-config")!.handler(action, ctx);
	expect(reads).toBe(3);
	expect(notices[0]).toContain('webSearch.route = "hosted" [model: models["p/m"].webSearch.route]');
	expect(notices[0]).toContain("backend capability are not verified");
	expect(notices[1]).toContain("valid");
	expect(notices[2]).toContain("already-v2");
	expect(JSON.stringify(loaded)).toBe(before);
	await expect(commands.get("toolkit-config")!.handler("show", { hasUI: false } as never)).rejects.toThrow("does not write reports to stdout");
	expect(reads).toBe(3);
});

test("validation reports unrelated errors; reports are bounded and critically redacted", () => {
	const raw = v2Fixture({
		models: { "p/other": { webSearch: { route: "bad" } } },
		diagnostics: { artifactRoot: "sk-private-path" },
	});
	const resolved = resolveToolkitConfig(raw, model);
	expect(resolved.invalidFeatures).toEqual([]);
	const report = describeToolkitConfig(resolved);
	expect(report).toContain('models["p/other"].webSearch.route');
	expect(report).not.toContain("sk-private-path");
	const large = resolveToolkitConfig(v2Fixture({ diagnostics: { artifactRoot: "x".repeat(30_000) } }), model);
	expect(describeToolkitConfig(large).length).toBeLessThan(24_200);
});

test("issue notifications ignore feature enablement/debug and deduplicate within one session", () => {
	const notices: string[] = [];
	const sessionManager = {};
	const ctx = { hasUI: true, sessionManager, ui: { notify: (message: string) => notices.push(message) } } as never;
	const invalid = resolveToolkitConfig(v2Fixture({ defaults: { context: { mode: "pi" }, webSearch: { route: "bad" } } }), model);
	notifyConfigIssues(ctx, invalid);
	notifyConfigIssues({ ...ctx as object, sessionManager } as never, invalid);
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain("defaults.webSearch.route");
	notifyConfigIssues({ hasUI: false } as never, invalid);
	notifyConfigIssues(ctx, resolveToolkitConfig(v2Fixture({}), model));
	notifyConfigIssues(ctx, invalid);
	expect(notices).toHaveLength(2);
	const secretKey = resolveToolkitConfig(v2Fixture({ models: { "p/sk-private-model": { webSearch: { route: "bad" } } } }), model);
	notifyConfigIssues(ctx, secretKey);
	expect(notices.at(-1)).not.toContain("sk-private-model");
});
