import { describe, expect, test } from "bun:test";
import { runSmokeRunner } from "./pi-smoke-subprocess";

describe("Remote Window mode switches through the real SDK encoders", () => {
	for (const api of ["openai-responses", "openai-completions"]) {
		for (const mode of ["remote-compaction", "pi"]) {
			test(`${api} / ${mode}`, () => {
				const result = runSmokeRunner("pi-window-mode-switch-runner.ts", [api, mode]);
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout.trim()).toBe("OK");
			}, 40000);
		}
	}
});
