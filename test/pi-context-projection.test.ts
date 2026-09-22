import { describe, expect, test } from "bun:test";
import { runSmokeRunner } from "./pi-smoke-subprocess";

describe("Pi 0.87 canonical projection with the actual Responses encoder", () => {
	for (const scenario of ["legacy", "pi-context-hook", "retain-none", "edited-checkpoint", "edited-checkpoint-hook", "boundary"]) {
		test(scenario, () => {
			const result = runSmokeRunner("pi-context-projection-runner.ts", [scenario]);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe("OK");
		}, 40000);
	}
});
