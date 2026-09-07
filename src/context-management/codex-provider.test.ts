import { expect, test } from "bun:test";
import { codexContextProviderHeaders, resolveCodexContextProvider, _codexProviderTest } from "./codex-provider";

type TestModel = {
	provider: string;
	api: string;
	id: string;
	baseUrl: string;
};

function model(overrides: Partial<TestModel> = {}): TestModel {
	return {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt-5.5",
		baseUrl: "https://chatgpt.com/backend-api",
		...overrides,
	};
}

function context(
	currentModel: TestModel | undefined,
	auth: unknown,
): never {
	return {
		model: currentModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => auth,
		},
	} as never;
}

const token = "access-token";

test("resolves native Codex auth from ModelRegistry and preserves account/header precedence", async () => {
	const result = await resolveCodexContextProvider(context(model(), {
		ok: true,
		apiKey: token,
		headers: { "ChatGPT-Account-ID": "account-1", "X-Test": "keep" },
		baseUrl: "https://chatgpt.com/backend-api/",
	}));

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.provider.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
	expect(result.provider.token).toBe(token);
	expect(result.provider.accountId).toBe("account-1");
	expect(result.provider.headers["x-test"]).toBe("keep");
});

test("rejects a gateway or other provider even when Codex OAuth is available", async () => {
	const gateway = await resolveCodexContextProvider(context(model({ provider: "openai" }), {
		ok: true,
		apiKey: token,
		baseUrl: "https://gateway.example/v1",
	}));
	expect(gateway).toMatchObject({ ok: false, reason: "unsupported-model" });

	const api = await resolveCodexContextProvider(context(model({ api: "openai-responses" }), {
		ok: true,
		apiKey: token,
		baseUrl: "https://chatgpt.com/backend-api",
	}));
	expect(api).toMatchObject({ ok: false, reason: "unsupported-model" });
});

test("resolves an explicitly allowlisted gateway without native Codex account derivation", async () => {
	const gatewayModel = model({
		provider: "uwoacrimson",
		api: "openai-responses",
		baseUrl: "https://newapi.example/v1",
	});
	const result = await resolveCodexContextProvider(
		context(gatewayModel, {
			ok: true,
			apiKey: "newapi-key",
			headers: { "ChatGPT-Account-ID": "must-not-forward", Cookie: "must-not-forward" },
		}),
		gatewayModel,
		["uwoacrimson/gpt-5.5"],
	);
	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.provider.kind).toBe("codex-gateway");
		expect(result.provider.baseUrl).toBe("https://newapi.example/v1");
		expect(result.provider.apiKey).toBe("newapi-key");
		expect(result.provider.headers).not.toHaveProperty("Cookie");
		expect(result.provider.headers).not.toHaveProperty("ChatGPT-Account-ID");
	}
});

test("preserves the bare gateway model and affinity headers", () => {
	const headers = codexContextProviderHeaders({
		kind: "codex-gateway",
		route: "codex-gateway",
		provider: "uwoacrimson",
		api: "openai-responses",
		model: "gpt-5.5",
		baseUrl: "https://newapi.example/v1",
		apiKey: "newapi-key",
		headers: {},
	}, { sessionId: "session-1" });
	expect(headers.get("X-Codex-Model")).toBe("gpt-5.5");
	expect(headers.get("X-Codex-Affinity-Scope")).toBe("codex-session-v1");
	expect(headers.get("Session-Id")).toBe("session-1");
});

test("normalizes thrown and explicit auth failures without exposing credential text", async () => {
	const thrown = await resolveCodexContextProvider({
		model: model(),
		modelRegistry: { getApiKeyAndHeaders: async () => { throw new Error("secret-token"); } },
	} as never);
	expect(thrown).toMatchObject({ ok: false, reason: "auth-resolution-failed" });
	expect(JSON.stringify(thrown)).not.toContain("secret-token");

	const failed = await resolveCodexContextProvider(context(model(), { ok: false, error: "secret-token" }));
	expect(failed).toMatchObject({ ok: false, reason: "auth-resolution-failed" });
	expect(JSON.stringify(failed)).not.toContain("secret-token");
});

test("uses Authorization when apiKey is absent and extracts a JWT account id", async () => {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "jwt-account" },
	})).toString("base64url");
	const jwt = `header.${payload}.signature`;
	const result = await resolveCodexContextProvider(context(model(), {
		ok: true,
		headers: { authorization: `Bearer ${jwt}` },
		baseUrl: "https://chatgpt.com/backend-api",
	}));
	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.provider.token).toBe(jwt);
		expect(result.provider.accountId).toBe("jwt-account");
	}
});

test("requires token, account id and a native backend URL", async () => {
	const missingToken = await resolveCodexContextProvider(context(model(), { ok: true, baseUrl: model().baseUrl }));
	expect(missingToken).toMatchObject({ ok: false, reason: "missing-token" });

	const missingAccount = await resolveCodexContextProvider(context(model(), { ok: true, apiKey: token, baseUrl: model().baseUrl }));
	expect(missingAccount).toMatchObject({ ok: false, reason: "missing-account-id" });

	const badBackend = await resolveCodexContextProvider(context(model(), {
		ok: true,
		apiKey: token,
		headers: { "chatgpt-account-id": "account" },
		baseUrl: "https://gateway.example/v1",
	}));
	expect(badBackend).toMatchObject({ ok: false, reason: "unsupported-backend" });

	const fallbackModelBase = await resolveCodexContextProvider(context(model(), {
		ok: true,
		apiKey: token,
		headers: { "chatgpt-account-id": "account" },
		baseUrl: "   ",
	}));
	expect(fallbackModelBase).toMatchObject({ ok: true });
});

test("keeps JWT parsing bounded and bearer normalization local", () => {
	expect(_codexProviderTest.bearerToken("Bearer abc")).toBe("abc");
	expect(_codexProviderTest.bearerToken("abc")).toBe("abc");
	expect(_codexProviderTest.decodeJwtPayload("not-a-jwt")).toBeUndefined();
});

test("filters nullable provider header values before constructing Headers", () => {
	const headers = codexContextProviderHeaders({
		kind: "native-codex",
		route: "openai-codex",
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-5.5",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		token,
		accountId: "account",
		headers: { "x-remove": null } as unknown as Record<string, string>,
	});
	expect(headers.get("x-remove")).toBeNull();
});
