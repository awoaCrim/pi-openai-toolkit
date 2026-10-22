import { describe, expect, test } from "bun:test";
import { runSmokeRunner } from "./pi-smoke-subprocess";

describe("Pi default compact handoffs keep a late ownership fence", () => {
	for (const mode of ["pi", "disabled", "intentional-default"]) {
		for (const change of ["clean", "retired-evidence", "selection", "queues"]) {
			test(`${mode} / ${change}`, () => {
				const result = runSmokeRunner("pi-default-compact-fence-runner.ts", [mode, change]);
				expect(result.status, result.stderr || result.error?.message).toBe(0);
				expect(result.stdout.trim()).toBe("OK");
			}, 40000);
		}
	}
});
