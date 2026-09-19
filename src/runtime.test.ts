import { expect, test } from "bun:test";
import { buildAlphaSearchUrl, resolveNativeCompactionEnvironment } from "./runtime";

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

function context(currentModel: TestModel, sessionId?: string): never {
	return {
		model: currentModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "newapi-key",
				baseUrl: currentModel.baseUrl,
				headers: { authorization: "Bearer inherited-value" },
			}),
		},
		sessionManager: {
			getSessionId: () => sessionId,
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

