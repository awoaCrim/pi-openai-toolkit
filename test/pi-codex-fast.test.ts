import { describe, expect, test } from "bun:test";
import { runSmokeRunner } from "./pi-smoke-subprocess";

describe("offline Pi Codex Fast", () => {
	for (const scenario of ["native-http", "native-ws", "gateway-http", "gateway-ws"]) {
		test("command, status, saved session and wire tier: " + scenario, () => {
			const result = runSmokeRunner("pi-codex-fast-runner.ts", [scenario]);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe("OK");
		}, 180000);
	}
});
