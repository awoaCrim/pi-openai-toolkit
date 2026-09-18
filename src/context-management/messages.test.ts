import { expect, test } from "bun:test";
import { renderContextWindowMessage } from "./messages";
import type { ContextWindowIdentity, NotesCheckpointReceipt } from "./types";

const identity: ContextWindowIdentity = {
	firstWindowId: "window-first",
	currentWindowId: "window-current",
	windowNumber: 1,
};

const checkpoint: NotesCheckpointReceipt = {
	path: "/active-task.md",
	toolCallId: "notes-call",
};

test("initial context guidance keeps the rollover instructions pre-rollover", () => {
	const content = renderContextWindowMessage({
		...identity,
		windowNumber: 0,
		currentWindowId: "window-first",
	});

	expect(content).toContain("Before calling new_context");
	expect(content).not.toContain("Context switch completed");
	expect(content).not.toContain("Do not immediately create another checkpoint");
});

test("completed rollover handoff reads the receipt once and resumes the task", () => {
	const content = renderContextWindowMessage(identity, undefined, checkpoint);

	expect(content).toContain("Context switch completed. This is the first turn in the new context window.");
	expect(content).toContain('Read this note before doing anything else with notes action "read_file": "/active-task.md"');
	expect(content).toContain("After reading the checkpoint receipt, resume the active user task.");
	expect(content).toContain("Do not immediately create another checkpoint or call new_context as part of this handoff.");
	expect(content).toContain("Only prepare a new checkpoint when a later context rollover is actually needed.");
});

test("receipt guidance remains fail-safe when the thread hint is unavailable", () => {
	const content = renderContextWindowMessage(identity, undefined, checkpoint);

	expect(content).toContain("Checkpoint successfully written:");
	expect(content).toContain("resume the active user task");
	expect(content).not.toContain("thread hint is required");
});
