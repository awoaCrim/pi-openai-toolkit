import { expect, test } from "bun:test";
import { redactCriticalValue } from "./debug";

test("always redacts Codex account ids and encrypted output fields", () => {
	const redacted = redactCriticalValue({
		headers: { "ChatGPT-Account-ID": "account-secret" },
		result: { encrypted_output: "opaque-secret", encrypted_content: "opaque-checkpoint" },
	});
	expect(redacted).toEqual({
		headers: { "ChatGPT-Account-ID": "[REDACTED]" },
		result: { encrypted_output: "[REDACTED]", encrypted_content: "[REDACTED]" },
	});
});

test("always redacts cookie headers even when optional redaction is disabled", () => {
	expect(redactCriticalValue({ headers: { Cookie: "session=secret", "Set-Cookie": "session=secret" } })).toEqual({
		headers: { Cookie: "[REDACTED]", "Set-Cookie": "[REDACTED]" },
	});
});

test("does not persist complete response/body fields in critical artifacts", () => {
	expect(redactCriticalValue({
		response: { status: 200, body: { output: "sensitive" } },
		responseText: "sensitive",
		completed: { output: "sensitive" },
	})).toEqual({
		response: "[REDACTED]",
		responseText: "[REDACTED]",
		completed: "[REDACTED]",
	});
});
