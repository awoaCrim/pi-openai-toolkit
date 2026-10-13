import { describe, expect, test } from "bun:test";
import { runSmokeRunner } from "./pi-smoke-subprocess";

describe("offline Pi Codex Fast", () => {
	for (const mode of ["tui", "rpc"]) {
		for (const scenario of ["native-http", "native-ws", "gateway-http", "gateway-ws"]) {
			test("command, status, saved session and wire tier: " + mode + " / " + scenario, () => {
				const result = runSmokeRunner("pi-codex-fast-runner.ts", [scenario, mode]);
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout.trim()).toBe("OK");
			}, 180000);
		}
	}
});
