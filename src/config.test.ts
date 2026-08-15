import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_PATH, loadToolkitConfig } from "./config";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_WEB_SEARCH_CONFIG } from "./types";

let tempDirs: string[] = [];

function writeTempConfig(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-openai-toolkit-config-"));
	tempDirs.push(dir);
	const configPath = path.join(dir, "config.json");
	fs.writeFileSync(configPath, content, "utf8");
	return configPath;
}

afterEach(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

describe("loadToolkitConfig", () => {
	test("uses the new canonical config path", () => {
		expect(CONFIG_PATH).toBe(
			path.join(os.homedir(), ".pi", "agent", "extensions", "pi-openai-toolkit", "config.json"),
		);
	});

	test("missing file yields independent defaults without warnings", () => {
		const missingPath = path.join(os.tmpdir(), "pi-openai-toolkit-missing", "config.json");
		const loaded = loadToolkitConfig(missingPath);

		expect(loaded.source).toBeUndefined();
		expect(loaded.warnings).toEqual([]);
		expect(loaded.config.compaction.enabled).toBe(true);
		expect(loaded.config.compaction.allowCompactionContinuityBreak).toBe(false);
		expect(loaded.config.compaction.model).toBeUndefined();
		expect(loaded.config.compaction.thinkingLevel).toBe("off");
		expect(loaded.config.compaction.responsesApis).toEqual([
			...DEFAULT_COMPACTION_CONFIG.responsesApis,
		]);
		expect(loaded.config.webSearch).toEqual({
			...DEFAULT_WEB_SEARCH_CONFIG,
			apis: [...DEFAULT_WEB_SEARCH_CONFIG.apis],
		});
	});

	test("nested feature sections override defaults", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				compaction: {
					enabled: true,
					allowCompactionContinuityBreak: true,
					model: " google/gemini-2.5-flash ",
					thinkingLevel: "medium",
					responsesApis: ["openai-responses"],
					debug: true,
					notifyOnLoad: true,
					artifactRoot: "~/artifacts/pot",
				},
				webSearch: {
					enabled: false,
					apis: [],
				},
			}),
		);

		const loaded = loadToolkitConfig(configPath);

		expect(loaded.source).toBe(configPath);
		expect(loaded.warnings).toEqual([]);
		expect(loaded.config.compaction.allowCompactionContinuityBreak).toBe(true);
		expect(loaded.config.compaction.model).toBe("google/gemini-2.5-flash");
		expect(loaded.config.compaction.thinkingLevel).toBe("medium");
		expect(loaded.config.compaction.responsesApis).toEqual(["openai-responses"]);
		expect(loaded.config.compaction.debug).toBe(true);
		expect(loaded.config.compaction.notifyOnLoad).toBe(true);
		expect(loaded.config.compaction.artifactRoot).toBe(path.join(os.homedir(), "artifacts/pot"));
		expect(loaded.config.webSearch).toEqual({ enabled: false, apis: [] });
	});

	test("compaction.model null clears the fallback spec", () => {
		const configPath = writeTempConfig(JSON.stringify({ compaction: { model: null } }));
		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config.compaction.model).toBeUndefined();
		expect(loaded.warnings).toEqual([]);
	});

	test("invalid fields warn and fall back per field while valid API entries remain", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				compaction: {
					enabled: "yes",
					allowCompactionContinuityBreak: "yes",
					model: 42,
					thinkingLevel: "ultra",
					responsesApis: ["openai-responses", "anthropic-messages"],
					artifactRoot: "",
				},
				webSearch: {
					enabled: "yes",
					apis: ["openai-responses", "azure-openai-responses"],
				},
			}),
		);

		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config.compaction.enabled).toBe(true);
		expect(loaded.config.compaction.allowCompactionContinuityBreak).toBe(false);
		expect(loaded.config.compaction.model).toBeUndefined();
		expect(loaded.config.compaction.thinkingLevel).toBe("off");
		expect(loaded.config.compaction.responsesApis).toEqual(["openai-responses"]);
		expect(loaded.config.webSearch).toEqual({ enabled: true, apis: ["openai-responses"] });
		expect(loaded.warnings).toContain(
			'Ignoring webSearch.apis entry "azure-openai-responses": only openai-responses are supported.',
		);
		expect(loaded.warnings.length).toBeGreaterThanOrEqual(8);
	});

	test("unknown fields and malformed feature sections warn without changing defaults", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				legacyEnabled: false,
				compaction: false,
				webSearch: { futureOption: true },
			}),
		);
		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config.compaction.enabled).toBe(true);
		expect(loaded.config.webSearch.enabled).toBe(true);
		expect(loaded.warnings).toEqual([
			"Ignoring legacyEnabled: unknown field.",
			"Ignoring compaction: expected a JSON object.",
			"Ignoring webSearch.futureOption: unknown field.",
		]);
	});

	test("legacy flat configuration is not treated as a runtime fallback", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				enabled: false,
				compactionModel: "google/gemini-2.5-flash",
				artifactRoot: "legacy-artifacts",
			}),
		);
		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config.compaction.enabled).toBe(true);
		expect(loaded.config.compaction.model).toBeUndefined();
		expect(loaded.config.compaction.artifactRoot).toContain(
			path.join(".pi", "agent", "artifacts", "pi-openai-toolkit", "compaction"),
		);
		expect(loaded.warnings).toHaveLength(3);
	});

	test("malformed JSON warns and yields defaults", () => {
		const configPath = writeTempConfig("{ not json");
		const loaded = loadToolkitConfig(configPath);

		expect(loaded.source).toBeUndefined();
		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.config.compaction.enabled).toBe(true);
		expect(loaded.config.webSearch.enabled).toBe(true);
	});

	test("relative artifactRoot resolves against the config directory", () => {
		const configPath = writeTempConfig(
			JSON.stringify({ compaction: { artifactRoot: "artifacts" } }),
		);
		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config.compaction.artifactRoot).toBe(
			path.resolve(path.dirname(configPath), "artifacts"),
		);
	});
});
