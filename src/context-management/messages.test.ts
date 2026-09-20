import { expect, test } from "bun:test";
import {
	CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
	declaredToolNames,
	preserveSystemHead,
	renderContextWindowMessage,
} from "./messages";
import type { ContextWindowIdentity, NotesCheckpointReceipt } from "./types";

function marker(windowId: string): unknown {
	return {
		role: "custom",
		customType: CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
		content: "",
		details: {
			protocol: 1,
			id: `marker-${windowId}`,
			contextManagement: { protocol: 1, kind: "window", firstWindowId: windowId, currentWindowId: windowId, windowNumber: 0 },
		},
		timestamp: 1,
	};
}

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

function systemMessage(input: {
	sections?: Record<string, string | null>;
	toolsAdded?: string[];
	toolsRemoved?: string[];
}): unknown {
	return {
		role: "system",
		content: "",
		...(input.sections ? { sections: input.sections } : {}),
		...(input.toolsAdded ? { toolsAdded: input.toolsAdded.map((name) => ({ name, description: name, parameters: {} })) } : {}),
		...(input.toolsRemoved ? { toolsRemoved: input.toolsRemoved.map((name) => ({ name })) } : {}),
		timestamp: 1,
	};
}

const turn = (text: string): unknown => ({ role: "user", content: [{ type: "text", text }], timestamp: 2 });

test("a window trim re-anchors the system head that declares every tool", () => {
	const messages = [
		systemMessage({ sections: { preamble: "prompt" }, toolsAdded: ["read", "bash"] }),
		turn("old"),
		turn("boundary"),
	] as unknown as Parameters<typeof preserveSystemHead>[0]["messages"];

	const result = preserveSystemHead({ messages, boundaryIndex: 2 });

	expect(result.repaired).toBe(true);
	expect(result.shrinkRejected).toBe(false);
	expect((result.messages[0] as unknown as { role?: string }).role).toBe("system");
	expect(declaredToolNames(result.messages)).toEqual(["read", "bash"]);
	expect(result.messages[result.messages.length - 1]).toBe(messages[2]);
});

test("trimming to a window whose head is only a patch is refused instead of shipping no tools", () => {
	const messages = [
		systemMessage({ toolsAdded: ["read", "bash"] }),
		turn("old"),
		marker("w1"),
		systemMessage({ toolsAdded: ["notes"] }),
		turn("after switch"),
	] as unknown as Parameters<typeof preserveSystemHead>[0]["messages"];

	const result = preserveSystemHead({ messages, boundaryIndex: 3 });

	expect(result.shrinkRejected).toBe(true);
	expect(result.lostToolNames.sort()).toEqual(["bash", "read"]);
	expect(result.messages).toBe(messages);
});

test("system patches before the boundary are folded into the rebuilt head", () => {
	const messages = [
		systemMessage({ toolsAdded: ["read", "bash"] }),
		systemMessage({ toolsAdded: ["notes"], toolsRemoved: ["bash"] }),
		turn("boundary"),
	] as unknown as Parameters<typeof preserveSystemHead>[0]["messages"];

	const result = preserveSystemHead({ messages, boundaryIndex: 2 });

	expect(declaredToolNames(result.messages)).toEqual(["read", "notes"]);
});

test("the window keeps its own head when it already declares the full loadout", () => {
	const head = systemMessage({ toolsAdded: ["read", "bash"] });
	const messages = [turn("old"), marker("w1"), head, turn("first turn")] as unknown as Parameters<typeof preserveSystemHead>[0]["messages"];

	const result = preserveSystemHead({ messages, boundaryIndex: 2 });

	expect(result.repaired).toBe(false);
	expect(result.shrinkRejected).toBe(false);
	expect(result.messages[0]).toBe(head);
});

test("transcripts without system messages keep the plain trim", () => {
	const messages = [turn("old"), marker("w1"), turn("current")] as unknown as Parameters<typeof preserveSystemHead>[0]["messages"];

	const result = preserveSystemHead({ messages, boundaryIndex: 1 });

	expect(result.messages).toEqual([messages[1], messages[2]]);
	expect(result.repaired).toBe(false);
});

test("a remembered head is re-anchored when the branch no longer carries one", () => {
	const messages = [turn("old"), marker("w2"), turn("current")] as unknown as Parameters<typeof preserveSystemHead>[0]["messages"];
	const fallback = systemMessage({ sections: { preamble: "prompt" }, toolsAdded: ["read", "bash"] }) as never;

	const result = preserveSystemHead({ messages, boundaryIndex: 1, fallbackHead: fallback });

	expect(result.repaired).toBe(true);
	expect(result.head).toBe(fallback);
	expect(declaredToolNames(result.messages)).toEqual(["read", "bash"]);
	expect(result.messages[result.messages.length - 1]).toBe(messages[2]);
});

test("a trim without any head to anchor still refuses to drop declared tools", () => {
	const messages = [
		systemMessage({ toolsAdded: ["read"] }),
		marker("w2"),
		turn("current"),
	] as unknown as Parameters<typeof preserveSystemHead>[0]["messages"];

	const result = preserveSystemHead({ messages, boundaryIndex: 1 });

	expect(result.shrinkRejected).toBe(result.lostToolNames.length > 0);
});
