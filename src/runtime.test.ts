import { expect, test } from "bun:test";
import {
	buildAlphaSearchUrl,
	buildCompactUrl,
	buildResponsesUrl,
	resolveEffectiveModel,
	resolveNativeCompactionEnvironment,
} from "./runtime";

type TestModel = {
	provider: string;
	api: string;
	id: string;
	baseUrl: string;
	headers?: Record<string, string>;
};

function model(overrides: Partial<TestModel> = {}): TestModel {
	return {
		provider: "my-gateway",
		api: "openai-responses",
		id: "gpt-5.6-luna",
		baseUrl: "https://newapi.example/v1",
		...overrides,
	};
}

function context(
	currentModel: TestModel,
	sessionId?: string,
	options: {
		auth?: Record<string, unknown>;
		registry?: Record<string, unknown>;
	} = {},
): never {
	return {
		model: currentModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "newapi-key",
				baseUrl: currentModel.baseUrl,
				headers: { authorization: "Bearer inherited-value" },
				...options.auth,
			}),
			...options.registry,
		},
		sessionManager: {
			getSessionId: () => sessionId,
			buildSessionProjection: () => ({ messages: [] }),
		},
	} as never;
}

test("resolved allowlisted gateway runtimes carry bare model affinity and retain /v1", async () => {
	const currentModel = model();
	const result = await resolveNativeCompactionEnvironment(
		context(currentModel, "session-42"),
		{
			responsesApis: ["openai-responses"],
			codexGatewayModels: ["my-gateway/gpt-5.6-luna"],
		},
	);

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.runtime.baseUrl).toBe("https://newapi.example/v1");
	expect(result.runtime.responsesUrl).toBe("https://newapi.example/v1/responses");
	expect(result.runtime.codexAffinity).toEqual({
		model: "gpt-5.6-luna",
		scope: "codex-session-v1",
	});
	expect(result.runtime.sessionId).toBe("session-42");
});

test("unlisted gateway runtimes do not gain Codex affinity metadata", async () => {
	const result = await resolveNativeCompactionEnvironment(
		context(model(), "session-42"),
		{ responsesApis: ["openai-responses"], codexGatewayModels: [] },
	);

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.runtime.codexAffinity).toBeUndefined();
});

test("allowlisted gateway runtime fails closed without a session identity", async () => {
	const result = await resolveNativeCompactionEnvironment(
		context(model(), undefined),
		{ responsesApis: ["openai-responses"], codexGatewayModels: ["my-gateway/gpt-5.6-luna"] },
	);

	expect(result).toMatchObject({ ok: false, reason: "missing-session-id" });
});

test("virtual models resolve through Pi's runtime bridge before auth and endpoint selection", async () => {
	const virtual = model({ provider: "router", api: "pi-virtual", id: "auto", baseUrl: "" });
	const physical = model({ provider: "openai", api: "openai-responses", id: "gpt-6.1-sol", baseUrl: "https://api.openai.com/v1" });
	const result = await resolveNativeCompactionEnvironment(
		context(virtual, "session-virtual", {
			registry: {
				find: (_provider: string, id: string) => id === physical.id ? physical : undefined,
				runtime: {
					resolveModel: async () => ({ model: physical, thinkingLevel: "off" }),
				},
			},
			auth: {
				baseUrl: physical.baseUrl,
				apiKey: "physical-key",
			},
		}),
		{ responsesApis: ["openai-responses"], codexGatewayModels: ["router/auto"] },
	);

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.runtime.provider).toBe("openai");
	expect(result.runtime.model).toBe(physical.id);
	expect(result.runtime.currentModel).toBe(physical);
	expect(result.runtime.apiKey).toBe("physical-key");
	expect(result.runtime.codexAffinity).toEqual({
		model: physical.id,
		scope: "codex-session-v1",
	});
});

test("virtual model resolution stays request-dynamic when Pi exposes its resolver", async () => {
	const virtual = model({ provider: "router", api: "pi-virtual", id: "auto", baseUrl: "" });
	const physical = model({ provider: "openai", api: "openai-responses", id: "gpt-6.1-sol", baseUrl: "https://api.openai.com/v1" });
	let routeCalls = 0;
	const runtime = {
		routeCalls: 0,
		resolveModel: async function () {
			this.routeCalls += 1;
			routeCalls += 1;
			return { model: physical, thinkingLevel: "off" };
		},
	};
	const ctx = context(virtual, "session-dynamic", {
		registry: {
			find: (_provider: string, id: string) => id === physical.id ? physical : undefined,
			runtime,
		},
	});

	await resolveEffectiveModel(ctx);
	await resolveEffectiveModel(ctx);
	expect(routeCalls).toBe(2);
	expect(runtime.routeCalls).toBe(2);
});

test("virtual models fail closed when Pi does not expose a physical resolver", async () => {
	const result = await resolveEffectiveModel(
		context(model({ provider: "router", api: "pi-virtual", id: "auto", baseUrl: "" })),
	);
	expect(result).toMatchObject({ ok: false, reason: "virtual-model-unresolved" });
});

test("Azure Responses runtimes preserve env, deployment mapping, and api-version URLs", async () => {
	const azure = model({
		provider: "azure-openai-responses",
		api: "azure-openai-responses",
		id: "gpt-6.1-sol",
		baseUrl: "",
	});
	const env = {
		AZURE_OPENAI_RESOURCE_NAME: "resource-one",
		AZURE_OPENAI_API_VERSION: "2025-01-01",
		AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-6.1-sol=sol-deployment",
	};
	const result = await resolveNativeCompactionEnvironment(
		context(azure, "session-azure", {
			auth: { apiKey: "azure-key", baseUrl: undefined, env },
		}),
		{ responsesApis: ["azure-openai-responses"],
		},
		{ model: "sol-deployment", input: [] },
	);

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.runtime.baseUrl).toBe("https://resource-one.openai.azure.com/openai/v1");
	expect(result.runtime.requestModel).toBe("sol-deployment");
	expect(result.runtime.env).toEqual(env);
	expect(result.runtime.responsesUrl).toBe("https://resource-one.openai.azure.com/openai/v1/responses?api-version=2025-01-01");
	expect(result.runtime.compactUrl).toBe("https://resource-one.openai.azure.com/openai/v1/responses/compact?api-version=2025-01-01");
});

test("Azure URL helpers normalize the Responses base path", () => {
	const env = { AZURE_OPENAI_API_VERSION: "v1" };
	expect(buildResponsesUrl("https://resource.openai.azure.com", "azure-openai-responses", env)).toBe(
		"https://resource.openai.azure.com/openai/v1/responses?api-version=v1",
	);
	expect(buildResponsesUrl("https://resource.openai.azure.com/openai/v1", "azure-openai-responses", env)).toBe(
		"https://resource.openai.azure.com/openai/v1/responses?api-version=v1",
	);
	expect(buildCompactUrl("https://resource.openai.azure.com/openai/v1/responses", "azure-openai-responses", env)).toBe(
		"https://resource.openai.azure.com/openai/v1/responses/compact?api-version=v1",
	);
});

test("buildAlphaSearchUrl appends provider-relative alpha/search exactly once", () => {
	expect(buildAlphaSearchUrl("https://gateway.example/v1")).toBe("https://gateway.example/v1/alpha/search");
	expect(buildAlphaSearchUrl("https://gateway.example/v1/")).toBe("https://gateway.example/v1/alpha/search");
	expect(buildAlphaSearchUrl("https://gateway.example/v1/alpha/search")).toBe("https://gateway.example/v1/alpha/search");
	expect(buildAlphaSearchUrl("https://gateway.example/v1/alpha/search/")).toBe("https://gateway.example/v1/alpha/search");
	expect(buildAlphaSearchUrl("https://gateway.example/v1/responses")).toBeUndefined();
	expect(buildAlphaSearchUrl("https://gateway.example/v1/codex/responses")).toBeUndefined();
	expect(buildAlphaSearchUrl("https://gateway.example/v1/responses/alpha/search")).toBeUndefined();
	expect(buildAlphaSearchUrl("https://gateway.example/v1/codex/responses/alpha/search")).toBeUndefined();
	expect(buildAlphaSearchUrl("https://user:password@gateway.example/v1")).toBeUndefined();
	expect(buildAlphaSearchUrl("ftp://gateway.example/v1")).toBeUndefined();
	expect(buildAlphaSearchUrl("https://gateway.example/v1?token=secret")).toBeUndefined();
});

