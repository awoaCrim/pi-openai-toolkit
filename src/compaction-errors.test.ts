import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCompactionError, qualifiesForStandaloneCompaction } from "./compaction-errors";
import { executeRemoteV2Compaction } from "./remote-v2-client";
import { executeNativeCompaction } from "./compact-client";
import { DEFAULT_COMPACTION_CONFIG } from "./types";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const runtime = {
	provider: "openai", api: "openai-responses", model: "test", baseUrl: "https://api.openai.com/v1",
	apiKey: "synthetic-credential", compactPath: "responses/compact", compactUrl: "https://api.openai.com/v1/responses/compact",
	responsesPath: "responses", responsesUrl: "https://api.openai.com/v1/responses", currentModel: { headers: {} },
} as never;
const request = { model: "test", input: [], instructions: "compact" };

test("error decoder emits only controlled vocabulary and hints, never arbitrary identifiers/messages", () => {
	const info = decodeCompactionError({ error: { code: "subscription_sharing_unsupported_capability", type: "invalid_request_error", param: "input", message: "Bearer secret opaque checkpoint account-123" } });
	expect(info).toMatchObject({ errorCode: "subscription_sharing_unsupported_capability", errorCategory: "auth", errorParam: "input" });
	expect(info.errorMessage).toContain("subscription-sharing");
	for (const secret of ["sk-secret", "opaque_secret", "account_123", "unknown\nsecret", "x".repeat(4096), { code: "bad" }]) {
		expect(decodeCompactionError({ error: { code: secret, type: secret, param: secret, message: secret } })).toEqual({});
	}
	expect(decodeCompactionError({ error: { code: "custom_auth_rejection", message: "secret" } })).toEqual({ errorCategory: "auth" });
	expect(decodeCompactionError({ response: { error: { code: "hardened_oauth_rule_missing" } } }).errorCategory).toBe("auth");
	expect(decodeCompactionError({ error: { code: "invalid_request_error", message: "Missing scopes: api.responses.write; token secret" } }).errorMessage).toContain("authorization scope");
});

test("standalone qualification excludes auth/quota/network/abort and generic outages", () => {
	for (const status of [400, 404, 405, 422, 501]) expect(qualifiesForStandaloneCompaction({ reason: "non-2xx", status })).toBe(true);
	for (const status of [401, 403, 429, 500, 502, 503]) expect(qualifiesForStandaloneCompaction({ reason: "non-2xx", status })).toBe(false);
	for (const code of ["subscription_sharing_unsupported_capability", "hardened_oauth_rule_missing", "invalid_api_key", "insufficient_quota", "rate_limit_exceeded"]) {
		expect(qualifiesForStandaloneCompaction({ reason: "non-2xx", status: 400, ...decodeCompactionError({ error: { code } }) })).toBe(false);
	}
	for (const reason of ["network-error", "aborted", "unknown", "error-event"]) expect(qualifiesForStandaloneCompaction({ reason, status: 200 })).toBe(false);
	expect(qualifiesForStandaloneCompaction({ reason: "error-event", status: 200, errorCategory: "protocol" })).toBe(true);
	expect(qualifiesForStandaloneCompaction({ reason: "invalid-sse", status: 200 })).toBe(true);
});

for (const capture of [false, true]) for (const redact of [false, true]) {
	test(`both HTTP clients retain issue hints without leaking raw errors (capture=${capture}, redact=${redact})`, async () => {
		const root = mkdtempSync(join(tmpdir(), "toolkit-compaction-errors-"));
		try {
			globalThis.fetch = (async () => new Response(JSON.stringify({ error: {
				code: "subscription_sharing_unsupported_capability", type: "invalid_request_error", param: "input",
				message: "Bearer synthetic-credential account-123 opaque-secret", encrypted_content: "opaque-secret",
			} }), { status: 400 })) as typeof fetch;
			for (const client of [executeRemoteV2Compaction, executeNativeCompaction]) {
				const result = await client({ runtime, request, settings: {
					...DEFAULT_COMPACTION_CONFIG, debug: true, logCompactResponses: capture, redactSensitiveData: redact, artifactRoot: root,
				}, context: { cwd: root, sessionId: "error-test" } });
				expect(result).toMatchObject({ ok: false, reason: "non-2xx", status: 400, errorCode: "subscription_sharing_unsupported_capability" });
				if (!result.ok) expect(result.errorMessage).not.toContain("opaque-secret");
			}
			const files = readdirSync(root, { recursive: true }).filter((file) => typeof file === "string" && file.endsWith(".json"));
			if (!capture) { expect(files).toHaveLength(0); return; }
			expect(files.length).toBeGreaterThan(0);
			const text = files.map((file) => readFileSync(join(root, String(file)), "utf8")).join("\n");
			for (const secret of ["synthetic-credential", "account-123", "opaque-secret"]) expect(text).not.toContain(secret);
			expect(text).toContain("subscription_sharing_unsupported_capability");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
}

test("network diagnostics never repeat a credential-bearing thrown message", async () => {
	globalThis.fetch = (async () => { throw new Error("https://secret@host/?api_key=secret opaque-secret"); }) as typeof fetch;
	for (const client of [executeRemoteV2Compaction, executeNativeCompaction]) {
		const result = await client({ runtime, request });
		expect(result).toMatchObject({ ok: false, reason: "network-error" });
		expect(JSON.stringify(result)).not.toContain("secret");
	}
});
