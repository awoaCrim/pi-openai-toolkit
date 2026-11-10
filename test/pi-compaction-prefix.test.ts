import { describe, expect, test } from "bun:test";
import { runSmokeRunner } from "./pi-smoke-subprocess";

describe("remote compaction preserves the actual Pi encoder prefix", () => {
	for (const transport of ["gateway-sse", "gateway-ws", "native-sse", "native-ws"]) {
		for (const source of ["legacy", "hook"]) {
			test(`${transport} ${source}`, () => {
				const result = runSmokeRunner("pi-compaction-prefix-runner.ts", [transport, source]);
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toContain("OK");
			}, 30000);
		}
	}
	for (const transport of ["gateway-sse", "gateway-ws", "native-sse", "native-ws"]) {
		for (const source of ["hook-loadout", "hook-loadout-wrapped", "hook-loadout-reload"]) {
			test(`${transport} ${source} uses the final host projection`, () => {
				const result = runSmokeRunner("pi-compaction-prefix-runner.ts", [transport, source]);
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toContain("OK");
			}, 30000);
		}
	}
	test("a failed ordered payload hook cancels without any remote or native dispatch", () => {
		const result = runSmokeRunner("pi-compaction-prefix-runner.ts", ["gateway-sse", "hook-error"]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("OK");
	}, 30000);
});
