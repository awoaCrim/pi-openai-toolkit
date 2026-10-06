import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertConfigValid, loadToolkitConfig, resolveToolkitConfig } from "../config";
import { describeToolkitConfig, registerToolkitConfigCommand } from "../config-command";
import { previewToolkitMigration } from "./migration";
import { formatConfigIssues, notifyConfigIssues } from "./notifications";
import { CONFIG_FEATURES, RETIRED_AUTO_MODE_ISSUE, RETIRED_AUTO_MODE_MESSAGE } from "./policy";
import { v2Fixture } from "./test-helpers";

const model = { provider: "p", id: "m", api: "openai-responses" };
const secret = "private-retired-reviewer-value";
const retiredValues = [
	{ available: true, enabled: true, models: ["p/m"], reviewerModel: "p/reviewer" },
	null, false, 42, secret, [secret],
	{ classifier: { [secret]: secret, timeoutMs: -1 }, circuitBreaker: false, reviewerModel: { secret } },
];
const dirs: string[] = [];
function fixture(raw: unknown) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-retired-auto-"));
	dirs.push(dir);
	const file = path.join(dir, "config.json");
	const bytes = JSON.stringify(raw);
	fs.writeFileSync(file, bytes);
	return { file, bytes, loaded: loadToolkitConfig(file) };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("retired Auto Mode configuration", () => {
	for (const [index, autoMode] of retiredValues.entries()) {
		test(`legacy value ${index} warns without parsing, rewriting or disabling other features`, () => {
			const { loaded, file, bytes } = fixture({ compaction: { enabled: false }, webSearch: { defaultRoute: "local" }, autoMode });
			const resolved = resolveToolkitConfig(loaded, model);
			expect(loaded.warnings).toEqual([`Ignoring autoMode: ${RETIRED_AUTO_MODE_MESSAGE}`]);
			expect(resolved.issues).toEqual([{ severity: "warning", code: RETIRED_AUTO_MODE_ISSUE, path: "autoMode", feature: "document" }]);
			expect(resolved.invalidFeatures).toEqual([]);
			expect(() => assertConfigValid(resolved, ...CONFIG_FEATURES)).not.toThrow();
			expect(resolved.policy.context.mode).toBe("pi");
			expect(resolved.policy.webSearch.route).toBe("local");
			expect(resolved.policy).not.toHaveProperty("autoMode");
			expect(resolved.config).not.toHaveProperty("autoMode");
			expect(Object.keys(resolved.origins).some((key) => key.startsWith("autoMode"))).toBe(false);
			expect(formatConfigIssues(resolved.issues)).toContain(RETIRED_AUTO_MODE_MESSAGE);
			expect(JSON.stringify(loaded.warnings)).not.toContain(secret);
			const migration = previewToolkitMigration(loaded);
			expect(migration.status).toBe("needs-review");
			expect(migration.reasons.join("\n")).toContain(RETIRED_AUTO_MODE_MESSAGE);
			expect(migration.unmappedPaths).toContain("autoMode");
			expect(JSON.stringify(migration.candidate)).not.toContain("autoMode");
			expect(JSON.stringify(migration)).not.toContain(secret);
			expect(fs.readFileSync(file, "utf8")).toBe(bytes);
		});

		for (const scope of ["defaults", "selected", "other"] as const) {
			test(`v2 ${scope} value ${index} warns without changing selected policy`, () => {
				const key = scope === "selected" ? "p/m" : "p/other";
				const document = { schemaVersion: 2,
					defaults: { webSearch: { route: "local" }, context: { mode: "pi" }, ...(scope === "defaults" ? { autoMode } : {}) },
					models: { [key]: { compatibility: { transport: "codex-gateway" }, ...(scope !== "defaults" ? { autoMode } : {}) } },
				};
				const { loaded, file, bytes } = fixture(document);
				const resolved = resolveToolkitConfig(loaded, model);
				expect(resolved.issues).toEqual([{
					severity: "warning", code: RETIRED_AUTO_MODE_ISSUE, feature: "document",
					path: scope === "defaults" ? "defaults.autoMode" : `models["${key}"].autoMode`,
					...(scope === "defaults" ? {} : { modelKey: key }),
				}]);
				expect(resolved.invalidFeatures).toEqual([]);
				expect(() => assertConfigValid(resolved, ...CONFIG_FEATURES)).not.toThrow();
				expect(resolved.policy.context.mode).toBe("pi");
				expect(resolved.policy.webSearch.route).toBe("local");
				expect(resolved.gatewayModelKeys).toContain(key);
				expect(resolved.policy).not.toHaveProperty("autoMode");
				expect(resolved.config).not.toHaveProperty("autoMode");
				expect(Object.keys(resolved.origins).some((leaf) => leaf.startsWith("autoMode"))).toBe(false);
				expect(describeToolkitConfig(resolved)).toContain(RETIRED_AUTO_MODE_MESSAGE);
				expect(describeToolkitConfig(resolved)).not.toContain(secret);
				const migration = previewToolkitMigration(loaded);
				expect(migration.status).toBe("already-v2");
				expect(migration.candidate).toBeUndefined();
				expect(migration.reasons.join("\n")).toContain(RETIRED_AUTO_MODE_MESSAGE);
				expect(fs.readFileSync(file, "utf8")).toBe(bytes);
			});
		}
	}

	test("retirement does not excuse unrelated invalid fields or mixed-format roots", () => {
		for (const raw of [
			{ schemaVersion: 2, defaults: { autoMode: null, webSearch: { route: "bad" } } },
			{ schemaVersion: 2, defaults: { autoMode: {}, webSerach: {} } },
			{ schemaVersion: 2, models: { "p/m": { autoMode: {}, unknown: true } } },
			{ schemaVersion: 2, autoMode: {} },
			{ autoMode: {}, webSearch: { defaultRoute: "bad" } },
		]) {
			const { loaded } = fixture(raw);
			expect(resolveToolkitConfig(loaded, model).invalidFeatures).toContain("webSearch");
		}
	});

	test("retirement warnings remain visible with other features off, are deduplicated and do not use headless UI", () => {
		const resolved = resolveToolkitConfig(v2Fixture({ defaults: { context: { mode: "pi" }, autoMode: { reviewerModel: secret } } }), model);
		const notices: Array<{ message: string; level: string }> = [];
		const ctx = { hasUI: true, sessionManager: {}, ui: { notify: (message: string, level: string) => notices.push({ message, level }) } };
		notifyConfigIssues(ctx as never, resolved);
		notifyConfigIssues(ctx as never, resolved);
		expect(notices).toHaveLength(1);
		expect(notices[0].level).toBe("warning");
		expect(notices[0].message).toContain(RETIRED_AUTO_MODE_MESSAGE);
		expect(notices[0].message).not.toContain(secret);
		notifyConfigIssues({ hasUI: false, ui: { notify: () => { throw new Error("headless UI accessed"); } } } as never, resolved);
		expect(resolved.issues[0].code).toBe(RETIRED_AUTO_MODE_ISSUE);
	});

	test("all human inspection actions explain that the old gate no longer exists", async () => {
		const loaded = v2Fixture({ defaults: { autoMode: true } });
		const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
		registerToolkitConfigCommand({ registerCommand: (name: string, command: never) => commands.set(name, command) } as never, () => loaded);
		const notices: string[] = [];
		const ctx = { hasUI: true, model, ui: { notify: (text: string) => notices.push(text) } } as never;
		for (const action of ["show", "validate", "migration-preview"]) await commands.get("toolkit-config")!.handler(action, ctx);
		expect(notices).toHaveLength(3);
		for (const notice of notices) expect(notice).toContain(RETIRED_AUTO_MODE_MESSAGE);
	});
});
