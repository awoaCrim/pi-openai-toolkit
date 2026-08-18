import { describe, expect, test } from "bun:test";
import {
	resolveNativeCompactionEnvironment,
	resolveRemoteCompactionExecution,
} from "../src/runtime";

describe("resolveNativeCompactionEnvironment", () => {
	test("uses getApiKeyAndHeaders to resolve request auth", async () => {
		const resolution = await resolveNativeCompactionEnvironment({
			model: {
				provider: "openai",
				api: "openai-responses",
				id: "gpt-5.4",
				baseUrl: "https://example.com/v1",
			},
			modelRegistry: {
				async getApiKeyAndHeaders(model: { provider: string; id: string }) {
					if (model.provider !== "openai" || model.id !== "gpt-5.4") {
						return { ok: false, error: "unexpected model" };
					}
					return {
						ok: true,
						apiKey: "sk-openai",
						headers: {
							"x-test-request-header": "present",
							"x-null-header": null,
						},
					};
				},
			},
		} as any);

		expect(resolution).toEqual({
			ok: true,
			runtime: expect.objectContaining({
				provider: "openai",
				api: "openai-responses",
				model: "gpt-5.4",
				baseUrl: "https://example.com/v1",
				apiKey: "sk-openai",
				headers: {
					"x-test-request-header": "present",
					"x-null-header": null,
				},
				responsesPath: "responses",
				responsesUrl: "https://example.com/v1/responses",
				compactPath: "responses/compact",
				compactUrl: "https://example.com/v1/responses/compact",
			}),
		});
	});

	test("returns auth-resolution-failed when credential lookup throws", async () => {
		const resolution = await resolveNativeCompactionEnvironment({
			model: {
				provider: "openai",
				api: "openai-responses",
				id: "gpt-5.4",
				baseUrl: "https://example.com/v1",
			},
			modelRegistry: {
				async getApiKeyAndHeaders() {
					throw new Error("credential lookup failed");
				},
			},
		} as any);

		expect(resolution).toEqual({
			ok: false,
			reason: "auth-resolution-failed",
			errorMessage: "credential lookup failed",
			provider: "openai",
			api: "openai-responses",
			model: "gpt-5.4",
			baseUrl: "https://example.com/v1",
		});
	});

	test("returns missing-api-key when request auth resolves without an api key", async () => {
		const resolution = await resolveNativeCompactionEnvironment({
			model: {
				provider: "openai",
				api: "openai-responses",
				id: "gpt-5.4",
				baseUrl: "https://example.com/v1",
			},
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return {
						ok: true,
						apiKey: undefined,
						headers: {
							"x-test-request-header": "present",
						},
					};
				},
			},
		} as any);

		expect(resolution).toEqual({
			ok: false,
			reason: "missing-api-key",
			provider: "openai",
			api: "openai-responses",
			model: "gpt-5.4",
			baseUrl: "https://example.com/v1",
		});
	});

	test("selects by API family: any provider speaking openai-responses qualifies by default", async () => {
		const resolution = await resolveNativeCompactionEnvironment({
			model: {
				provider: "custom-litellm",
				api: "openai-responses",
				id: "gpt-5.4",
				baseUrl: "https://proxy.example.com/v1",
			},
			modelRegistry: {
				async getApiKeyAndHeaders(model: { provider: string; id: string }) {
					if (model.provider !== "custom-litellm" || model.id !== "gpt-5.4") {
						return { ok: false, error: "unexpected model" };
					}
					return {
						ok: true,
						apiKey: "sk-custom-litellm",
						headers: {
							"x-proxy-header": "proxy-value",
						},
					};
				},
			},
		} as any);

		expect(resolution).toEqual({
			ok: true,
			runtime: expect.objectContaining({
				provider: "custom-litellm",
				api: "openai-responses",
				model: "gpt-5.4",
				baseUrl: "https://proxy.example.com/v1",
				apiKey: "sk-custom-litellm",
				headers: {
					"x-proxy-header": "proxy-value",
				},
				responsesPath: "responses",
				responsesUrl: "https://proxy.example.com/v1/responses",
				compactPath: "responses/compact",
				compactUrl: "https://proxy.example.com/v1/responses/compact",
			}),
		});
	});

	test("rejects non-Responses APIs so they take the native-method fallback path", async () => {
		const resolution = await resolveNativeCompactionEnvironment({
			model: {
				provider: "anthropic",
				api: "anthropic-messages",
				id: "claude-fable-5",
				baseUrl: "https://api.anthropic.com",
			},
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "sk-ant" };
				},
			},
		} as any);

		expect(resolution).toEqual({
			ok: false,
			reason: "unsupported-api",
			provider: "anthropic",
			api: "anthropic-messages",
			model: "claude-fable-5",
			baseUrl: "https://api.anthropic.com",
		});
	});

	test("honors compaction.responsesApis narrowing from config", async () => {
		const resolution = await resolveNativeCompactionEnvironment(
			{
				model: {
					provider: "openai",
					api: "openai-responses",
					id: "gpt-5.4",
					baseUrl: "https://example.com/v1",
				},
				modelRegistry: {
					async getApiKeyAndHeaders() {
						return { ok: true, apiKey: "sk-openai" };
					},
				},
			} as any,
			{
				responsesApis: ["openai-codex-responses"],
			},
		);

		expect(resolution).toEqual({
			ok: false,
			reason: "unsupported-api",
			provider: "openai",
			api: "openai-responses",
			model: "gpt-5.4",
			baseUrl: "https://example.com/v1",
		});
	});

	test("uses the active model when remoteCompactModel is unset", async () => {
		const resolution = await resolveRemoteCompactionExecution({
			model: {
				provider: "uwoacrimson",
				api: "openai-responses",
				id: "gpt-5.6-sol",
				baseUrl: "https://gateway.example/v1/",
			},
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "sk-sol" };
				},
			},
		} as any);

		expect(resolution.ok).toBe(true);
		if (resolution.ok) {
			expect(resolution.execution.consumer).toBe(resolution.execution.compactor);
			expect(resolution.execution.compactor.model).toBe("gpt-5.6-sol");
		}
	});

	test("accepts an explicit override that resolves to the active model", async () => {
		const sol = {
			provider: "uwoacrimson",
			api: "openai-responses",
			id: "gpt-5.6-sol",
			baseUrl: "https://gateway.example/v1",
		};
		const resolution = await resolveRemoteCompactionExecution(
			{
				model: sol,
				modelRegistry: {
					find: () => sol,
					async getApiKeyAndHeaders() {
						return { ok: true, apiKey: "sk-sol" };
					},
				},
			} as any,
			{},
			"uwoacrimson/gpt-5.6-sol",
		);

		expect(resolution.ok).toBe(true);
		if (resolution.ok) {
			expect(resolution.execution.consumer.model).toBe(sol.id);
			expect(resolution.execution.compactor.model).toBe(sol.id);
			expect(resolution.execution.compactor.currentModel).toBe(sol);
		}
	});

	test("resolves the override model, auth headers, metadata, and effective base URL", async () => {
		const sol = {
			provider: "uwoacrimson",
			api: "openai-responses",
			id: "gpt-5.6-sol",
			baseUrl: "https://model-config.example/v1",
		};
		const luna = {
			provider: "uwoacrimson",
			api: "openai-responses",
			id: "gpt-5.6-luna",
			baseUrl: "https://another-model-config.example/v1",
			headers: { "x-model": "luna" },
		};
		const resolution = await resolveRemoteCompactionExecution(
			{
				model: sol,
				modelRegistry: {
					find: (provider: string, modelId: string) =>
						provider === luna.provider && modelId === luna.id ? luna : undefined,
					async getApiKeyAndHeaders(model: { id: string }) {
						return model.id === luna.id
							? {
									ok: true,
									apiKey: "sk-luna",
									headers: { "x-auth": "luna" },
									baseUrl: "https://gateway.example/v1/",
								}
							: { ok: true, apiKey: "sk-sol", baseUrl: "https://gateway.example/v1" };
					},
				},
			} as any,
			{},
			"uwoacrimson/gpt-5.6-luna",
		);

		expect(resolution.ok).toBe(true);
		if (resolution.ok) {
			expect(resolution.execution.consumer).toEqual(
				expect.objectContaining({ model: "gpt-5.6-sol", baseUrl: "https://gateway.example/v1" }),
			);
			expect(resolution.execution.compactor).toEqual(
				expect.objectContaining({
					model: "gpt-5.6-luna",
					baseUrl: "https://gateway.example/v1",
					apiKey: "sk-luna",
					headers: { "x-auth": "luna" },
					currentModel: luna,
				}),
			);
		}
	});

	test("fails closed for cross-provider, cross-API, and cross-endpoint overrides", async () => {
		const sol = {
			provider: "uwoacrimson",
			api: "openai-responses",
			id: "gpt-5.6-sol",
			baseUrl: "https://gateway.example/v1",
		};
		const scenarios = [
			{
				reason: "provider-mismatch",
				spec: "other/gpt-5.6-luna",
				model: { ...sol, provider: "other", id: "gpt-5.6-luna" },
			},
			{
				reason: "api-mismatch",
				spec: "uwoacrimson/gpt-5.6-luna-codex",
				model: { ...sol, api: "openai-codex-responses", id: "gpt-5.6-luna-codex" },
			},
			{
				reason: "base-url-mismatch",
				spec: "uwoacrimson/gpt-5.6-luna-other-endpoint",
				model: {
					...sol,
					id: "gpt-5.6-luna-other-endpoint",
					baseUrl: "https://other-gateway.example/v1",
				},
			},
		] as const;

		for (const scenario of scenarios) {
			const resolution = await resolveRemoteCompactionExecution(
				{
					model: sol,
					modelRegistry: {
						find: () => scenario.model,
						async getApiKeyAndHeaders(model: { id: string }) {
							return { ok: true, apiKey: `sk-${model.id}` };
						},
					},
				} as any,
				{},
				scenario.spec,
			);

			expect(resolution).toEqual(expect.objectContaining({ ok: false, reason: scenario.reason }));
		}
	});

	test("reports invalid, missing, and unauthenticated override models without selecting the active model", async () => {
		const sol = {
			provider: "uwoacrimson",
			api: "openai-responses",
			id: "gpt-5.6-sol",
			baseUrl: "https://gateway.example/v1",
		};
		const luna = { ...sol, id: "gpt-5.6-luna" };
		const createContext = (find: () => unknown, auth: (model: { id: string }) => unknown) => ({
			model: sol,
			modelRegistry: {
				find,
				getApiKeyAndHeaders: auth,
			},
		});

		const invalid = await resolveRemoteCompactionExecution(
			createContext(() => luna, async () => ({ ok: true, apiKey: "sk" })) as any,
			{},
			"not-a-model-spec",
		);
		expect(invalid).toEqual({ ok: false, reason: "invalid-model-spec", modelSpec: "not-a-model-spec" });

		const missing = await resolveRemoteCompactionExecution(
			createContext(() => undefined, async () => ({ ok: true, apiKey: "sk" })) as any,
			{},
			"uwoacrimson/missing",
		);
		expect(missing).toEqual(
			expect.objectContaining({ ok: false, reason: "model-not-found", modelSpec: "uwoacrimson/missing" }),
		);

		const unauthenticated = await resolveRemoteCompactionExecution(
			createContext(
				() => luna,
				async (model) =>
					model.id === sol.id
						? { ok: true, apiKey: "sk-sol" }
						: { ok: false, error: "no credentials" },
			) as any,
			{},
			"uwoacrimson/gpt-5.6-luna",
		);
		expect(unauthenticated).toEqual(
			expect.objectContaining({
				ok: false,
				reason: "auth-resolution-failed",
				modelSpec: "uwoacrimson/gpt-5.6-luna",
				errorMessage: "no credentials",
			}),
		);
	});
});
