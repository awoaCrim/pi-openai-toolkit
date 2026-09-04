import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_PATH, loadToolkitConfig } from "./config";
import {
	DEFAULT_AUTO_MODE_CONFIG,
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_NATIVE_FALLBACK_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
} from "./types";

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
		expect(loaded.config.compaction.remoteCompactModel).toBeUndefined();
		expect(loaded.config.compaction.nativeFallback).toEqual({ ...DEFAULT_NATIVE_FALLBACK_CONFIG });
		expect(loaded.config.compaction.autoCompaction).toEqual({
			enabled: true,
			continuation: "inline",
			unsupportedFallback: "followUp",
			reserveTokens: undefined,
		});
		expect(loaded.config.compaction.responsesApis).toEqual([
			...DEFAULT_COMPACTION_CONFIG.responsesApis,
		]);
		expect(loaded.config.webSearch).toEqual({
			...DEFAULT_WEB_SEARCH_CONFIG,
			models: [...DEFAULT_WEB_SEARCH_CONFIG.models],
		});
		expect(loaded.config.imageGeneration).toEqual({ ...DEFAULT_IMAGE_GENERATION_CONFIG });
		expect(loaded.config.autoMode).toEqual({
			...DEFAULT_AUTO_MODE_CONFIG,
			models: [...DEFAULT_AUTO_MODE_CONFIG.models],
			extraTools: [...DEFAULT_AUTO_MODE_CONFIG.extraTools],
		});
	});

	test("nested feature sections override defaults", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				compaction: {
					enabled: true,
					allowCompactionContinuityBreak: true,
					remoteCompactModel: " uwoacrimson/gpt-5.6-luna ",
					nativeFallback: {
						enabled: true,
						model: " google/gemini-2.5-flash ",
						thinkingLevel: "medium",
					},
					autoCompaction: {
						enabled: true,
						continuation: "followUp",
						unsupportedFallback: "off",
						reserveTokens: 4096,
					},
					responsesApis: ["openai-responses"],
					debug: true,
					notifyOnLoad: true,
					artifactRoot: "~/artifacts/pot",
				},
				webSearch: {
					enabled: false,
					models: [" provider/model ", "provider/model", ""],
				},
				imageGeneration: {
					enabled: false,
				},
				autoMode: {
					enabled: true,
					models: [" uwoacrimson/gpt-5.6-luna ", "uwoacrimson/gpt-5.6-luna", ""],
					reviewerModel: " uwoacrimson/gpt-5.6-sol ",
					gate: "all",
					extraTools: [" openai_generate_image ", "openai_generate_image", ""],
					timeoutMs: 45000,
				},
			}),
		);

		const loaded = loadToolkitConfig(configPath);

		expect(loaded.source).toBe(configPath);
		expect(loaded.warnings).toEqual([]);
		expect(loaded.config.compaction.allowCompactionContinuityBreak).toBe(true);
		expect(loaded.config.compaction.remoteCompactModel).toBe("uwoacrimson/gpt-5.6-luna");
		expect(loaded.config.compaction.nativeFallback).toEqual({
			enabled: true,
			model: "google/gemini-2.5-flash",
			thinkingLevel: "medium",
		});
		expect(loaded.config.compaction.autoCompaction).toEqual({
			enabled: true,
			continuation: "followUp",
			unsupportedFallback: "off",
			reserveTokens: 4096,
		});
		expect(loaded.config.compaction.responsesApis).toEqual(["openai-responses"]);
		expect(loaded.config.compaction.debug).toBe(true);
		expect(loaded.config.compaction.notifyOnLoad).toBe(true);
		expect(loaded.config.compaction.artifactRoot).toBe(path.join(os.homedir(), "artifacts/pot"));
		expect(loaded.config.webSearch).toEqual({ enabled: false, models: ["provider/model"] });
		expect(loaded.config.imageGeneration).toEqual({ enabled: false });
		expect(loaded.config.autoMode).toEqual({
			enabled: true,
			models: ["uwoacrimson/gpt-5.6-luna"],
			reviewerModel: "uwoacrimson/gpt-5.6-sol",
			gate: "all",
			extraTools: ["openai_generate_image"],
			timeoutMs: 45000,
		});
	});

	test("null model specs preserve the default remote path and clear the fallback spec", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				compaction: { remoteCompactModel: null, nativeFallback: { model: null } },
			}),
		);
		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config.compaction.remoteCompactModel).toBeUndefined();
		expect(loaded.config.compaction.nativeFallback.model).toBeUndefined();
		expect(loaded.config.compaction.nativeFallback.enabled).toBe(true);
		expect(loaded.warnings).toEqual([]);
	});

	test("invalid fields warn and fall back per field while valid API entries remain", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				compaction: {
					enabled: "yes",
					allowCompactionContinuityBreak: "yes",
					remoteCompactModel: { provider: "uwoacrimson" },
					nativeFallback: {
						enabled: "yes",
						model: 42,
						thinkingLevel: "ultra",
						futureOption: true,
					},
					autoCompaction: {
						enabled: "yes",
						continuation: "later",
						unsupportedFallback: "retry",
						reserveTokens: -1,
					},
					responsesApis: ["openai-responses", "anthropic-messages"],
					artifactRoot: "",
				},
				webSearch: {
					enabled: "yes",
					models: [" provider/model ", "provider/model", ""],
				},
				imageGeneration: {
					enabled: "yes",
					models: ["provider/image-model"],
				},
				autoMode: {
					enabled: "yes",
					models: 42,
					reviewerModel: 42,
					gate: "everything",
					extraTools: "bash",
					timeoutMs: 0,
				},
			}),
		);

		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config.compaction.enabled).toBe(true);
		expect(loaded.config.compaction.allowCompactionContinuityBreak).toBe(false);
		expect(loaded.config.compaction.remoteCompactModel).toBeUndefined();
		expect(loaded.config.compaction.nativeFallback).toEqual({ ...DEFAULT_NATIVE_FALLBACK_CONFIG });
		expect(loaded.config.compaction.autoCompaction).toEqual({
			enabled: true,
			continuation: "inline",
			unsupportedFallback: "followUp",
			reserveTokens: undefined,
		});
		expect(loaded.config.compaction.responsesApis).toEqual(["openai-responses"]);
		expect(loaded.config.webSearch).toEqual({ enabled: true, models: ["provider/model"] });
		expect(loaded.config.imageGeneration).toEqual({ enabled: false });
		expect(loaded.config.autoMode).toEqual({
			...DEFAULT_AUTO_MODE_CONFIG,
			models: [],
			extraTools: [],
		});
		expect(loaded.warnings.length).toBeGreaterThanOrEqual(21);
	});

	test("unknown fields and malformed feature sections warn without changing defaults", () => {
		const configPath = writeTempConfig(
			JSON.stringify({
				legacyEnabled: false,
				compaction: false,
				webSearch: { futureOption: true, apis: ["openai-responses"] },
				imageGeneration: { futureOption: true, apis: ["openai-responses"], models: ["openai/gpt-5"] },
				autoMode: { futureOption: true, reviewer: "openai/gpt-5" },
			}),
		);
		const loaded = loadToolkitConfig(configPath);

		expect(loaded.config.compaction.enabled).toBe(true);
		expect(loaded.config.webSearch.enabled).toBe(true);
		expect(loaded.config.imageGeneration.enabled).toBe(false);
		expect(loaded.config.autoMode.reviewerModel).toBeUndefined();
		expect(loaded.warnings).toEqual([
			"Ignoring legacyEnabled: unknown field.",
			"Ignoring compaction: expected a JSON object.",
			"Ignoring webSearch.futureOption: unknown field.",
			"Ignoring webSearch.apis: unknown field.",
			"Ignoring imageGeneration.futureOption: unknown field.",
			"Ignoring imageGeneration.apis: unknown field.",
			"Ignoring imageGeneration.models: unknown field.",
			"Ignoring autoMode.futureOption: unknown field.",
			"Ignoring autoMode.reviewer: unknown field.",
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
		expect(loaded.config.compaction.nativeFallback.model).toBeUndefined();
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
		expect(loaded.config.imageGeneration.enabled).toBe(false);
		expect(loaded.config.autoMode.enabled).toBe(true);
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
