import { describe, expect, test } from "bun:test";
import { resolveWebSearchRoute } from "./types";

const baseConfig = { enabled: true, models: [] as string[] };
const responsesModel = { provider: "gateway", api: "openai-responses", id: "gpt-6-astra" };

function resolve(
	modelOrUndefined?: typeof responsesModel | { provider: string; api: string; id: string },
	config: Partial<typeof baseConfig> & Record<string, unknown> = {},
) {
	const model = arguments.length === 0 ? responsesModel : modelOrUndefined;
	return resolveWebSearchRoute({ model, config: { ...baseConfig, ...config } as never });
}

describe("resolveWebSearchRoute", () => {
	test("disabled is a total switch even when explicit routes exist", () => {
		expect(
			resolve(responsesModel, {
				enabled: false,
				defaultRoute: "standalone-alpha",
				routes: { "gateway/gpt-6-astra": "hosted" },
			}),
		).toEqual({
			route: "none",
			source: "none",
			modelKey: "gateway/gpt-6-astra",
			reason: "disabled",
		});
	});

	test("exact model route wins over the global default and legacy hosted allowlist", () => {
		expect(
			resolve(responsesModel, {
				defaultRoute: "hosted",
				models: ["gateway/gpt-6-astra"],
				routes: { "gateway/gpt-6-astra": "standalone-alpha" },
			}),
		).toEqual({
			route: "standalone-alpha",
			source: "exact",
			modelKey: "gateway/gpt-6-astra",
			available: true,
		});
	});

	test("default route wins over legacy models for every non-overridden model", () => {
		expect(
			resolve(
				{ provider: "gateway", api: "openai-responses", id: "gpt-5.6-luna" },
				{ defaultRoute: "local", models: ["gateway/gpt-5.6-luna"] },
			),
		).toEqual({
			route: "local",
			source: "default",
			modelKey: "gateway/gpt-5.6-luna",
			available: true,
		});
	});

	test("legacy models retain hosted behavior only for Responses-family APIs", () => {
		expect(resolve(responsesModel, { models: ["gateway/gpt-6-astra"] })).toEqual({
			route: "hosted",
		source: "legacy",
		modelKey: "gateway/gpt-6-astra",
		available: true,
	});
		expect(
			resolve(
				{ provider: "gateway", api: "openai-completions", id: "gpt-6-astra" },
				{ models: ["gateway/gpt-6-astra"] },
			),
		).toEqual({
			route: "none",
			source: "none",
			modelKey: "gateway/gpt-6-astra",
			reason: "unconfigured",
		});
	});

	test("explicit hosted and standalone routes fail closed on unsupported APIs", () => {
		const model = { provider: "gateway", api: "openai-completions", id: "gpt-6-astra" };
		expect(resolve(model, { routes: { "gateway/gpt-6-astra": "hosted" } })).toMatchObject({
			route: "hosted",
			source: "exact",
			available: false,
			reason: "unsupported-api",
		});
		expect(resolve(model, { defaultRoute: "standalone-alpha" })).toMatchObject({
			route: "standalone-alpha",
			source: "default",
			available: false,
			reason: "unsupported-api",
		});
	});

	test("explicit local route is available on a non-Responses model", () => {
		expect(
			resolve(
				{ provider: "gateway", api: "openai-completions", id: "gpt-5.6-luna" },
				{ defaultRoute: "local" },
			),
		).toEqual({
			route: "local",
			source: "default",
			modelKey: "gateway/gpt-5.6-luna",
			available: true,
		});
	});

	test("a default route without a current model remains selected but unavailable", () => {
		expect(resolve(undefined, { defaultRoute: "hosted" })).toEqual({
			route: "hosted",
		source: "default",
		available: false,
		reason: "missing-model",
	});
	});
});
