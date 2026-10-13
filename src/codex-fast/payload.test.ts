import { describe, expect, test } from "bun:test";
import { isCodexFastModel, rewriteCodexFastPayload } from "./payload";

function model(overrides: Record<string, unknown> = {}) {
	return { provider: "relay", api: "openai-responses", id: "gpt-5.6-sol", baseUrl: "https://relay.invalid/v1", ...overrides } as never;
}

function payload(overrides: Record<string, unknown> = {}) {
	return { model: "gpt-5.6-sol", input: [{ role: "user", content: "hello" }], ...overrides };
}

describe("Codex Fast route eligibility", () => {
	test("native API and recognized gateway IDs need no Fast configuration", () => {
		expect(isCodexFastModel(model({ api: "openai-codex-responses", provider: "native-alias", id: "opaque-native" }))).toBe(true);
		for (const id of ["gpt-5.6-sol", "GPT-6-sol", "codex-mini-latest"]) expect(isCodexFastModel(model({ id }))).toBe(true);
		expect(isCodexFastModel(model({ baseUrl: "http://localhost:8080/v1" }))).toBe(true);
	});

	for (const overrides of [
		{ api: "anthropic-messages" }, { api: "azure-openai-responses" }, { api: "openai-completions" },
		{ id: "claude-fable-5" }, { id: "gptish" }, { id: "codexish" }, { id: "" },
		{ baseUrl: "https://api.openai.com/v1" }, { baseUrl: "https://API.OPENAI.COM/v1/responses" },
		{ baseUrl: "ftp://relay.invalid/v1" }, { baseUrl: "not-a-url" }, { baseUrl: undefined },
	]) {
		test("does not infer support from " + JSON.stringify(overrides), () => {
			expect(isCodexFastModel(model(overrides))).toBe(false);
		});
	}

	test("opaque aliases use only exact existing gateway identity", () => {
		const alias = model({ id: "opaque" });
		expect(isCodexFastModel(alias)).toBe(false);
		expect(isCodexFastModel(alias, ["relay/opaque"])).toBe(true);
		expect(isCodexFastModel(alias, ["relay/Opaque", "relay/*", "other/opaque"])).toBe(false);
		expect(isCodexFastModel(model({ id: "opaque", baseUrl: "https://api.openai.com/v1" }), ["relay/opaque"])).toBe(false);
		const virtual = model({ api: "pi-virtual", provider: "virtual", id: "logical" });
		expect(isCodexFastModel(alias, ["virtual/logical"], virtual)).toBe(true);
		expect(isCodexFastModel(alias, ["virtual/logical"], model({ provider: "virtual", id: "logical" }))).toBe(false);
		expect(isCodexFastModel(undefined)).toBe(false);
	});
});

describe("Codex Fast payload", () => {
	for (const existing of [undefined, "fast", "priority", "default", "flex", "auto"]) {
		for (const enabled of [false, true]) {
			test("explicit selection overrides tier " + existing + ", ON=" + enabled, () => {
				const source = payload({ service_tier: existing, reasoning: { effort: "max", summary: "auto" },
					prompt_cache_key: "same-key", prompt_cache_options: { ttl: "30m" }, previous_response_id: "existing",
					tools: [{ type: "function", name: "read" }], store: false, stream: true, unknown: { preserve: true } });
				const before = structuredClone(source);
				Object.freeze(source);
				const result = rewriteCodexFastPayload(source, "gpt-5.6-sol", enabled);
				const expected = enabled ? "priority" : "default";
				if (existing === expected) expect(result).toBeUndefined();
				else {
					expect(result).toEqual({ ...before, service_tier: expected });
					expect(result?.input).toBe(source.input);
					expect(result).not.toBe(source);
					expect(rewriteCodexFastPayload(result, "gpt-5.6-sol", enabled)).toBeUndefined();
				}
				expect(source).toEqual(before);
			});
		}
	}

	for (const source of [null, [], "text", {}, payload({ model: "foreign" }), payload({ input: "title" }),
		payload({ input: [null] }), payload({ input: [1] }), payload({ input: [{ type: "compaction_trigger" }] }),
		payload({ tools: [{ type: "remote_compaction_v2" }] })]) {
		test("malformed or synthetic shape is untouched: " + JSON.stringify(source), () => {
			const before = structuredClone(source);
			expect(rewriteCodexFastPayload(source, "gpt-5.6-sol", true)).toBeUndefined();
			expect(source).toEqual(before);
		});
	}

	test("ordinary opaque replay is still a conversation and unknown own keys survive", () => {
		const source = JSON.parse('{"model":"gpt-5.6-sol","input":[{"type":"compaction","encrypted_content":"opaque"},{"role":"user","content":"new"}],"__proto__":{"keep":true}}');
		const result = rewriteCodexFastPayload(source, "gpt-5.6-sol", true)!;
		expect(result.service_tier).toBe("priority");
		expect(Object.hasOwn(result, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
		expect(result.input).toBe(source.input);
	});
});
