import { describe, expect, test } from "bun:test";
import { runSmokeRunner } from "./pi-smoke-subprocess";

describe("Retired Remote Windows are refused by the real Pi lifecycle without migration", () => {
	for (const evidence of ["window", "malformed-window", "strategy", "sentinel", "manual", "terminal-manual", "superseded"]) {
		for (const mode of ["remote-compaction", "pi", "disabled"]) {
			test(`${evidence} / ${mode}`, () => {
				const result = runSmokeRunner("pi-retired-window-session-runner.ts", [evidence, mode]);
				expect(result.status, result.stderr || result.error?.message).toBe(0);
				expect(result.stdout.trim()).toBe("OK");
			}, 40000);
		}
	}
});
