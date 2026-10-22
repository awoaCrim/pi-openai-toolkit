import { describe, expect, test } from "bun:test";
import { runSmokeRunner } from "./pi-smoke-subprocess";

describe("Ordinary remote compaction preserves the Pi session and persistence lifecycle", () => {
	const cases = ["plain", "repeat", "same-model", "unset-model"].flatMap((scenario) => [scenario, `${scenario}-hook`, `native-${scenario}`, `native-${scenario}-hook`]);
	cases.push("abort", "select-during", "select-before-persist", "queues-before-persist", "queues", "user-select", "navigate", "sealed-edit", "open-stream", "native-abort", "native-select-during", "native-select-before-persist", "native-queues-before-persist");
	for (const scenario of cases) {
		test(scenario, () => {
			const result = runSmokeRunner("pi-managed-compact-runner.ts", [scenario]);
			expect(result.status, result.stderr || result.error?.message).toBe(0);
			expect(result.stdout.trim()).toBe("OK");
		}, 40000);
	}
});
