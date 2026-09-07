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
