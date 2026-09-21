import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertConfigValid, loadToolkitConfig, resolveToolkitConfig } from "../config";
import { previewToolkitMigration } from "./migration";
import { transformWebSearchPayload } from "../web-search/payload";

const dirs: string[] = [];
function fixture(raw: unknown): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-config-v2-"));
	dirs.push(dir);
	const file = path.join(dir, "config.json");
	fs.writeFileSync(file, JSON.stringify(raw));
	return file;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const model = { provider: "p", id: "m", api: "openai-responses" };

test("real loader exposes v2 provenance and anchors relative paths to the global config directory", () => {
	const file = fixture({ schemaVersion: 2, defaults: { webSearch: { route: "local" } }, models: { "p/m": { webSearch: { route: "hosted" } } }, diagnostics: { artifactRoot: "artifacts" } });
	const before = fs.readFileSync(file, "utf8");
	const resolved = resolveToolkitConfig(loadToolkitConfig(file), model);
	expect(resolved.policy.webSearch.route).toBe("hosted");
	expect(resolved.origins["webSearch.route"]).toEqual({ kind: "model", path: 'models["p/m"].webSearch.route', source: file });
	expect(resolved.policy.diagnostics.artifactRoot).toBe(path.join(path.dirname(file), "artifacts"));
	expect(fs.readFileSync(file, "utf8")).toBe(before);
});

test("one loaded snapshot survives file edits while the next load observes them", () => {
	const file = fixture({ schemaVersion: 2, defaults: { webSearch: { route: "hosted" } } });
	const snapshot = loadToolkitConfig(file);
	fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, defaults: { webSearch: { route: "local" } } }));
	const first = resolveToolkitConfig(snapshot, model);
	expect(first.policy.webSearch.route).toBe("hosted");
	expect(Object.isFrozen(first.policy.webSearch)).toBe(true);
	expect(resolveToolkitConfig(loadToolkitConfig(file), model).policy.webSearch.route).toBe("local");
});

test("gateway opt-in is exact and survives disabled context policy", () => {
	const file = fixture({ schemaVersion: 2, defaults: { context: { mode: "pi" } }, models: { "p/m": { compatibility: { transport: "codex-gateway" } } } });
	const resolved = resolveToolkitConfig(loadToolkitConfig(file), model);
	expect(resolved.config.compaction.enabled).toBe(false);
	expect(resolved.gatewayModelKeys).toEqual(["p/m"]);
	expect(resolveToolkitConfig(resolved.snapshot, { ...model, id: "other" }).policy.compatibility.transport).toBe("standard");
});

test("malformed or unsupported schema never behaves as an absent file", () => {
	for (const raw of [{ schemaVersion: 999 }, { defaults: {} }, []]) {
		const resolved = resolveToolkitConfig(loadToolkitConfig(fixture(raw)), model);
		expect(() => assertConfigValid(resolved, "webSearch")).toThrow("configuration is invalid");
	}
	const file = fixture({}); fs.writeFileSync(file, "{invalid");
	expect(() => assertConfigValid(resolveToolkitConfig(loadToolkitConfig(file), model), "context")).toThrow();
	fs.unlinkSync(file);
	expect(resolveToolkitConfig(loadToolkitConfig(file), model).invalidFeatures).toEqual([]);
});

test("legacy invalid selected route cannot fall through to its hosted allowlist", () => {
	const file = fixture({ webSearch: { models: ["p/m"], routes: { "p/m": "typo" } } });
	const resolved = resolveToolkitConfig(loadToolkitConfig(file), model);
	expect(() => assertConfigValid(resolved, "webSearch")).toThrow("No fallback");
});

test("valid legacy hosted failure behavior remains permissive and migration flags the difference", () => {
	const file = fixture({ webSearch: { models: ["p/m"] } });
	const bytes = fs.readFileSync(file, "utf8");
	const loaded = loadToolkitConfig(file);
	const legacy = resolveToolkitConfig(loaded, model);
	expect(transformWebSearchPayload({ model, config: legacy.config.webSearch, payload: { tools: 1 } }).fatal).toBeUndefined();
	const unsupported = resolveToolkitConfig(loaded, { ...model, api: "anthropic-messages" });
	expect(unsupported.policy.webSearch.route).toBe("unmanaged");
	const preview = previewToolkitMigration(loaded);
	expect(preview.status).toBe("needs-review");
	expect(preview.reasons.join(" ")).toContain("not behavior-equivalent");
	expect(fs.readFileSync(file, "utf8")).toBe(bytes);
});

test("explicit local and unmanaged retain different payload behavior", () => {
	const payload = { tools: [{ type: "web_search" }, { type: "function", name: "web_run" }, { type: "function", name: "read" }] };
	const unmanaged = resolveToolkitConfig(loadToolkitConfig(fixture({ schemaVersion: 2, defaults: { webSearch: { route: "unmanaged" } } })), model);
	const local = resolveToolkitConfig(loadToolkitConfig(fixture({ schemaVersion: 2, defaults: { webSearch: { route: "local" } } })), model);
	expect(transformWebSearchPayload({ model, config: unmanaged.config.webSearch, payload }).payload).toBe(payload);
	expect(transformWebSearchPayload({ model, config: local.config.webSearch, payload }).payload).toEqual({ tools: [{ type: "function", name: "read" }] });
});

test("migration leaves unknown/dormant content in source and never includes raw unknown values", () => {
	const file = fixture({ webSearch: { enabled: false, models: ["p/m"] }, unknownSecret: "sk-private-do-not-copy" });
	const bytes = fs.readFileSync(file, "utf8");
	const preview = previewToolkitMigration(loadToolkitConfig(file));
	expect(preview.status).toBe("needs-review");
	expect(preview.unmappedPaths).toContain("webSearch.models");
	expect(JSON.stringify(preview)).not.toContain("sk-private-do-not-copy");
	expect(fs.readFileSync(file, "utf8")).toBe(bytes);
});

test("simple migration preview retains provenance mode and explicit image default", () => {
	const preview = previewToolkitMigration(loadToolkitConfig(fixture({
		compaction: { remoteV2ContextSource: "legacy", remoteCompactModel: "p/producer", nativeFallback: { model: "p/fallback" } },
		webSearch: { defaultRoute: "local" }, imageGeneration: { models: ["first", "second"] },
	})));
	expect(preview.status).toBe("ready");
	expect(preview.candidate).toMatchObject({ schemaVersion: 2, defaults: {
		context: { remoteCompaction: { inputSource: "legacy", model: "p/producer" }, nativeFallback: { model: "p/fallback" } },
		imageGeneration: { defaultModel: "first", allowedModels: ["first", "second"] },
		webSearch: { route: "local" },
	} });
});


test("legacy exact route provenance supports dotted IDs and normalized keys", () => {
	const file = fixture({ webSearch: { defaultRoute: "invalid", routes: { " p/gpt-5.6 ": "local" } } });
	const resolved = resolveToolkitConfig(loadToolkitConfig(file), { ...model, id: "gpt-5.6" });
	expect(resolved.invalidFeatures).toEqual([]);
	expect(resolved.origins["webSearch.route"]).toEqual({ kind: "legacy", path: 'webSearch.routes[" p/gpt-5.6 "]', source: file });
});


test("migration normalizes legacy route keys before building the candidate and retains raw-key origin", () => {
	const loaded = loadToolkitConfig(fixture({ webSearch: { routes: { " p/m ": "local" } } }));
	expect(loaded.config.webSearch.routes).toEqual({ "p/m": "local" });
	const preview = previewToolkitMigration(loaded);
	expect(preview.status).toBe("ready");
	expect(preview.candidate).toMatchObject({ models: { "p/m": { webSearch: { route: "local" } } } });
	expect(preview.origins?.['models["p/m"].webSearch.route'].path).toBe('webSearch.routes[" p/m "]');
});

test("legacy route diagnostics do not parse identity from warning punctuation", () => {
	const file = fixture({ webSearch: { models: ["p/m:1"], routes: { "p/m:1": "invalid" } } });
	const resolved = resolveToolkitConfig(loadToolkitConfig(file), { ...model, id: "m:1" });
	expect(resolved.invalidFeatures).toContain("webSearch");
	expect(resolved.issues[0].modelKey).toBe("p/m:1");
});

test("legacy unsupported API diagnostics never echo raw input values", () => {
	const loaded = loadToolkitConfig(fixture({ compaction: { responsesApis: ["private-arbitrary-value"] } }));
	const resolved = resolveToolkitConfig(loaded, model);
	expect(JSON.stringify(resolved.issues)).not.toContain("private-arbitrary-value");
	expect(resolved.issues[0].path).toBe("compaction.responsesApis");
});
