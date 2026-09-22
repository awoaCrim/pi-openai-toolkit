import { describe, expect, test } from "bun:test";
import { runSmokeRunner } from "./pi-smoke-subprocess";

function runQueueScenario(mode: string, scenario: string, sameContent = false) {
	const runner = scenario === "classifier" ? "pi-auto-classifier-runner.ts" : "pi-auto-queue-runner.ts";
	const result = runSmokeRunner(runner, [mode, scenario, sameContent ? "same" : "different"]);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout.trim()).toBe("OK");
}

describe("auto mode actual Pi request delivery", () => {
	for (const mode of ["idle", "steer", "followUp"]) {
		for (const sameContent of [false, true]) {
			test(`${mode} delivery gives ${sameContent ? "identical" : "different"} user text a fresh denial budget`, () => {
				runQueueScenario(mode, "fresh", sameContent);
			}, 40000);
		}
	}
	for (const mode of ["steer", "followUp"]) {
		test(`enqueueing ${mode} retains A's denial history until B is delivered`, () => {
			runQueueScenario(mode, "queued-active", true);
		}, 40000);
		test(`${mode} delivery invalidates identical-text classifier work without unlocking a newer sample`, () => {
			runQueueScenario(mode, "classifier");
		}, 40000);
	}
	test("assistant/tool continuations reach the denial threshold within one request", () => {
		runQueueScenario("idle", "continuation");
	}, 40000);
});
