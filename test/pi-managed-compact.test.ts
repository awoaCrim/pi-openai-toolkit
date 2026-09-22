import { describe, expect, test } from "bun:test";
import { runSmokeRunner } from "./pi-smoke-subprocess";

describe("managed /compact with the official Pi request and persistence lifecycle", () => {
	for (const scenario of ["native-codex", "native-steer", "native-followUp", "native-mixed", "plain", "steer", "followUp", "mixed", "duplicate", "same-model", "unset-model", "notes-failed", "no-rollover", "cancel-notes", "cancel-after-schedule", "user-select", "queues", "repeat-compact", "approval-refused", "excluded-notes"]) {
		test(scenario, () => {
			const result = runSmokeRunner("pi-managed-compact-runner.ts", [scenario]);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe("OK");
		}, 40000);
	}
});
