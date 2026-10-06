import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactCriticalValue, writeDebugArtifact, writeReplayFailureArtifact } from "./debug";
import { DEFAULT_COMPACTION_CONFIG } from "./types";

test("same-millisecond diagnostic and replay failures never overwrite earlier records", () => {
	const root = mkdtempSync(join(tmpdir(), "toolkit-debug-collision-"));
	const timestamp = "2026-10-06T17:58:28.965Z";
	const clock = spyOn(Date.prototype, "toISOString").mockReturnValue(timestamp);
	try {
		const settings = { ...DEFAULT_COMPACTION_CONFIG, artifactRoot: root, debug: true };
		const context = { cwd: root, sessionId: "same-millisecond" };
		const paths = [
			writeDebugArtifact("compaction-event", { event: "remote-to-native-summary", authorization: "Bearer synthetic-secret" }, settings, context),
			writeDebugArtifact("compaction-event", { event: "fallback-skip" }, settings, context),
			writeReplayFailureArtifact({ reason: "first-replay-failure" }, settings, context),
			writeReplayFailureArtifact({ reason: "second-replay-failure" }, settings, context),
		];
		expect(new Set(paths).size).toBe(4);
		const records = paths.map((path) => {
			if (!path) throw new Error("Diagnostic record was not written");
			const text = readFileSync(path, "utf8");
			expect(text).not.toContain("synthetic-secret");
			return JSON.parse(text);
		});
		expect(records.map((record) => record.timestamp)).toEqual(Array(4).fill(timestamp));
		expect(records.map((record) => record.data.reason ?? record.data.event)).toEqual([
			"remote-to-native-summary", "fallback-skip", "first-replay-failure", "second-replay-failure",
		]);
	} finally {
		clock.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("always redacts Codex account ids and encrypted output fields", () => {
	const redacted = redactCriticalValue({
		headers: { "ChatGPT-Account-ID": "account-secret" },
		result: { encrypted_output: "opaque-secret", encrypted_content: "opaque-checkpoint" },
	});
	expect(redacted).toEqual({
		headers: { "ChatGPT-Account-ID": "[REDACTED]" },
		result: { encrypted_output: "[REDACTED]", encrypted_content: "[REDACTED]" },
	});
});

test("always redacts cookie headers even when optional redaction is disabled", () => {
	expect(redactCriticalValue({ headers: { Cookie: "session=secret", "Set-Cookie": "session=secret" } })).toEqual({
		headers: { Cookie: "[REDACTED]", "Set-Cookie": "[REDACTED]" },
	});
});

test("does not persist complete response/body fields in critical artifacts", () => {
	expect(redactCriticalValue({
		response: { status: 200, body: { output: "sensitive" } },
		responseText: "sensitive",
		completed: { output: "sensitive" },
	})).toEqual({
		response: "[REDACTED]",
		responseText: "[REDACTED]",
		completed: "[REDACTED]",
	});
});
