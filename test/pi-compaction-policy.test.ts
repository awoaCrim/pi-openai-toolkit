import { describe, expect, test } from "bun:test";
import { runSmokeRunner } from "./pi-smoke-subprocess";

describe("Mode-gated compaction through the public Pi lifecycle", () => {
	const cases: string[][] = [["remote-compaction", "standalone", "legacy", "official"],
		["remote-compaction", "standalone", "pi-context-hook", "official"]];
	for (const source of ["legacy", "pi-context-hook"]) {
		for (const transport of ["gateway", "native"]) {
			for (const mode of ["remote-windows", "pi"]) {
				for (const scenario of ["default", "owning-opaque", "owning-native", "owning-malformed"]) cases.push([mode, scenario, source, transport]);
			}
			for (const scenario of ["remote", "remote-failure", "native-fallback", "default", "disabled", "same-model", "cleaned", "threshold", "overflow", "abort", "summary-failure", "owning-remote", "owning-native", "owning-fallback"]) {
				cases.push(["remote-compaction", scenario, source, transport]);
			}
		}
	}
	for (const args of cases) {
		test(args.join(" / "), () => {
			const result = runSmokeRunner("pi-compaction-policy-runner.ts", args);
			expect(result.status, result.stderr || result.error?.message).toBe(0);
			expect(result.stdout.trim()).toBe("OK");
		}, 40000);
	}
});
