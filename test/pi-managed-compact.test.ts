import { describe, expect, test } from "bun:test";
import { runSmokeRunner } from "./pi-smoke-subprocess";

describe("Remote Window manual compaction with the official Pi request and persistence lifecycle", () => {
	const scopedCases = ["plain", "repeat", "rollover"].flatMap((scenario) =>
		[scenario, `${scenario}-hook`, `native-${scenario}`, `native-${scenario}-hook`]);
	for (const scenario of [...scopedCases,
		"cleaned", "cleaned-hook", "native-cleaned-hook", "old-opaque", "old-opaque-hook", "native-old-opaque",
		"failure", "invalid-output", "abort", "invalid-model", "select-during", "user-select", "user-input", "queues", "navigate",
		"same-model", "unset-model", "sealed-edit", "open-stream", "excluded-notes", "legacy-recovery",
		"native-failure", "native-abort", "native-queues", "native-select-during",
		"select-before-persist", "native-select-before-persist", "queues-before-persist", "native-queues-before-persist",
	]) {
		test(scenario, () => {
			const result = runSmokeRunner("pi-managed-compact-runner.ts", [scenario]);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe("OK");
		}, 40000);
	}
});
