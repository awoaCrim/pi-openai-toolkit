import { describe, expect, test } from "bun:test";
import { runSmokeRunner } from "./pi-smoke-subprocess";

describe("Toolkit WS recovery with the actual Pi agent", () => {
	for (const scenario of ["recover", "failed", "disabled", "exhausted", "cancel", "compacted", "bootstrap"]) {
		test(scenario, () => {
			const result = runSmokeRunner("pi-responses-recovery-runner.ts", [scenario]);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe("OK");
		}, 40000);
	}
});
