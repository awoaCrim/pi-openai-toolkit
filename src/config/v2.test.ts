import { describe, expect, test } from "bun:test";
import { resolveV2Config } from "./v2";

const key = "provider/model";
const resolve = (raw: unknown, modelKey: string | undefined = key) => resolveV2Config(raw, modelKey);

describe("v2 policy resolution", () => {
	test("retains shipped defaults and supplies an origin for every effective leaf", () => {
		const result = resolve({ schemaVersion: 2 });
		expect(result.issues).toEqual([]);
		expect(result.invalidFeatures).toEqual([]);
		expect(result.policy.context.mode).toBe("remote-compaction");
		expect(result.policy.context.remoteCompaction.inputSource).toBe("legacy");
		expect(result.policy.webSearch.route).toBe("unmanaged");
		expect(result.policy).not.toHaveProperty("autoMode");
		expect(result.policy.imageGeneration.enabled).toBe(false);
		const visit = (value: unknown, prefix = "") => {
			if (value && typeof value === "object" && !Array.isArray(value)) {
				for (const [name, child] of Object.entries(value)) visit(child, prefix ? `${prefix}.${name}` : name);
			} else expect(result.origins[prefix]).toEqual({ kind: "builtin" });
		};
		visit(result.policy);
	});

	test("keeps the Responses WebSocket feature disabled until explicitly enabled in defaults", () => {
		expect(resolve({ schemaVersion: 2 }).policy.responsesWebSocket.enabled).toBe(false);
		const enabled = resolve({ schemaVersion: 2, defaults: { responsesWebSocket: { enabled: true } } });
		expect(enabled.invalidFeatures).not.toContain("responsesWebSocket");
		expect(enabled.policy.responsesWebSocket.enabled).toBe(true);
		expect(enabled.origins["responsesWebSocket.enabled"]).toEqual({
			kind: "defaults",
			path: "defaults.responsesWebSocket.enabled",
		});
		const invalid = resolve({ schemaVersion: 2, defaults: { responsesWebSocket: { enabled: "yes" } } });
		expect(invalid.invalidFeatures).toContain("responsesWebSocket");
		expect(invalid.policy.responsesWebSocket.enabled).toBe(false);
		const modelScoped = resolve({ schemaVersion: 2, models: { [key]: { responsesWebSocket: { enabled: true } } } });
		expect(modelScoped.invalidFeatures).toContain("responsesWebSocket");
	});

	test("merges known fields, replaces arrays, preserves false/zero, and clears nullable references", () => {
		const result = resolve({ schemaVersion: 2, defaults: {
			context: { remoteCompaction: { model: " p/producer ", apis: ["openai-responses"] }, nativeFallback: { enabled: true, model: "p/summary" } },
		}, models: { [key]: {
			context: { remoteCompaction: { model: null, apis: [] }, remoteWindows: { reminderThresholdPercent: 0 }, nativeFallback: { enabled: false, model: null } },
			compatibility: { transport: "codex-gateway" },
		} } });
		expect(result.invalidFeatures).toEqual([]);
		expect(result.policy.context.remoteCompaction).toMatchObject({ model: null, apis: [], inputSource: "legacy" });
		expect(result.policy.context.remoteWindows.reminderThresholdPercent).toBe(0);
		expect(result.policy.context.nativeFallback).toMatchObject({ enabled: false, model: null });
		expect(result.policy.compatibility.transport).toBe("codex-gateway");
		expect(result.origins["context.nativeFallback.model"]).toEqual({ kind: "model", path: `models["${key}"].context.nativeFallback.model` });
	});

	test("omitted leaves inherit and diagnostics have global provenance", () => {
		const result = resolve({ schemaVersion: 2, defaults: { webSearch: { route: "local" } },
			models: { [key]: { context: { mode: "pi" } } }, diagnostics: { captureResponses: true } });
		expect(result.policy.webSearch.route).toBe("local");
		expect(result.origins["webSearch.route"]).toEqual({ kind: "defaults", path: "defaults.webSearch.route" });
		expect(result.origins["diagnostics.captureResponses"].path).toBe("diagnostics.captureResponses");
	});

	for (const raw of [null, [], {}, { schemaVersion: 3 }, { schemaVersion: 2, compaction: {} }, { schemaVersion: 2, defaults: null }]) {
		test(`rejects malformed/version-mixed document ${JSON.stringify(raw)}`, () => {
			expect(resolve(raw).invalidFeatures).toContain("webSearch");
			expect(resolve(raw).invalidFeatures).toContain("context");
		});
	}

	test("invalid present selected route is blocked instead of selecting inherited hosted", () => {
		const result = resolve({ schemaVersion: 2, defaults: { webSearch: { route: "hosted" } }, models: { [key]: { webSearch: { route: "typo" } } } });
		expect(result.invalidFeatures).toContain("webSearch");
		expect(result.issues.some((issue) => issue.path.endsWith("webSearch.route") && issue.modelKey === key)).toBe(true);
	});

	test("reports unrelated model errors without invalidating this model", () => {
		const result = resolve({ schemaVersion: 2, models: { "other/model": { webSearch: { route: "typo" }, context: null }, [key]: { webSearch: { route: "local" } } } });
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.invalidFeatures).toEqual([]);
		expect(result.policy.webSearch.route).toBe("local");
	});

	test("valid exact value masks invalid default leaf but not an unknown feature field", () => {
		const raw = { schemaVersion: 2, defaults: { webSearch: { route: "typo" } }, models: { [key]: { webSearch: { route: "local" } } } };
		expect(resolve(raw).invalidFeatures).toEqual([]);
		expect(resolve({ ...raw, defaults: { webSearch: { wrong: true } } }).invalidFeatures).toContain("webSearch");
	});

	test("unknown root/default/model policy names cannot silently become a permissive default", () => {
		for (const raw of [
			{ schemaVersion: 2, defautls: {} },
			{ schemaVersion: 2, defaults: { webSerach: {} } },
			{ schemaVersion: 2, models: { [key]: { webSerach: {} } } },
		]) expect(resolve(raw).invalidFeatures).toContain("webSearch");
	});

	test("forbids model-scoped image/diagnostics and defaults-wide gateway transport", () => {
		const result = resolve({ schemaVersion: 2, defaults: { compatibility: { transport: "codex-gateway" } }, models: { [key]: { imageGeneration: { enabled: true }, diagnostics: { captureRequests: true } } } });
		expect(result.invalidFeatures).toEqual(expect.arrayContaining(["compatibility", "imageGeneration", "diagnostics"]));
	});

	test("rejects duplicate normalized model keys and never consults inherited entries", () => {
		expect(resolve({ schemaVersion: 2, models: { [key]: { webSearch: { route: "local" } }, [` ${key} `]: { webSearch: { route: "hosted" } } } }).invalidFeatures).toContain("webSearch");
		const models = Object.create({ [key]: { webSearch: { route: "hosted" } } });
		expect(resolve({ schemaVersion: 2, models }).policy.webSearch.route).toBe("unmanaged");
		expect(resolve(JSON.parse('{"schemaVersion":2,"models":{"__proto__/model":{"webSearch":{"route":"local"}}}}'), "__proto__/model").policy.webSearch.route).toBe("local");
	});

	test("rejects patterns/model-less references but accepts nested model ids", () => {
		for (const model of ["p/*", "model-without-provider"]) {
			const bad = resolve({ schemaVersion: 2, defaults: { context: { nativeFallback: { model } } }, models: { "p/*": {} } });
			expect(bad.invalidFeatures).toContain("context");
			expect(bad.issues.length).toBeGreaterThan(1);
		}
		expect(resolve({ schemaVersion: 2, defaults: { context: { nativeFallback: { model: "p/family/model" } } } }).policy.context.nativeFallback.model).toBe("p/family/model");
	});

	test("validates image membership independently of list order", () => {
		const result = resolve({ schemaVersion: 2, defaults: { imageGeneration: { defaultModel: "second", allowedModels: ["first", "second"], enabled: true } } });
		expect(result.policy.imageGeneration.defaultModel).toBe("second");
		expect(result.policy.imageGeneration.allowedModels).toEqual(["first", "second"]);
		expect(result.invalidFeatures).toEqual([]);
		for (const imageGeneration of [{ allowedModels: [] }, { defaultModel: "missing" }, { defaultModel: null }, { allowedModels: ["x".repeat(257)] }]) {
			expect(resolve({ schemaVersion: 2, defaults: { imageGeneration } }).invalidFeatures).toContain("imageGeneration");
		}
	});

	test("invalid API narrowing and numeric limits are errors rather than fallback policies", () => {
		expect(resolve({ schemaVersion: 2, defaults: { context: { remoteCompaction: { apis: ["other-api"] } } } }).invalidFeatures).toContain("context");
		for (const reminderThresholdPercent of [-1, 101, 0.5]) {
			expect(resolve({ schemaVersion: 2, defaults: { context: { remoteWindows: { reminderThresholdPercent } } } }).invalidFeatures).toContain("context");
		}
	});

	test("diagnostics never copy unknown field values/names and defaults do not alias", () => {
		const secret = "sk-config-should-not-leak";
		const result = resolve({ schemaVersion: 2, defaults: { webSearch: { [secret]: { secret } } } });
		expect(JSON.stringify(result.issues)).not.toContain(secret);
		result.policy.context.remoteCompaction.apis.push("mutated");
		expect(resolve({ schemaVersion: 2 }).policy.context.remoteCompaction.apis).not.toContain("mutated");
	});
});


test("gateway keys are collected from the same validation pass with scoped errors", () => {
	const result = resolve({ schemaVersion: 2, models: {
		"p/valid": { compatibility: { transport: "codex-gateway" }, webSearch: { route: "invalid" } },
		"p/bad": { compatibility: { transport: "codex-gateway", unknown: true } },
		"p/unknown": { compatibility: { transport: "codex-gateway" }, typo: {} },
		"p/standard": { compatibility: { transport: "standard" } },
		"p/duplicate": { compatibility: { transport: "codex-gateway" } },
		" p/duplicate ": { compatibility: { transport: "codex-gateway" } },
	} });
	expect(result.gatewayModelKeys).toEqual(["p/valid"]);
	expect(resolve({ schemaVersion: 2, typo: {}, models: { "p/m": { compatibility: { transport: "codex-gateway" } } } }).gatewayModelKeys).toEqual([]);
});


test("gateway collection ignores inherited transport settings", () => {
	const compatibility = Object.create({ transport: "codex-gateway" });
	const result = resolve({ schemaVersion: 2, models: { [key]: { compatibility } } });
	expect(result.policy.compatibility.transport).toBe("standard");
	expect(result.gatewayModelKeys).toEqual([]);
});
