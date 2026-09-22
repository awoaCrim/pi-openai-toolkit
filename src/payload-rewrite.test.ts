import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { resolveLatestNativeCompactionEntry } from "./details-store";
import { removeNativeCompactionRetainedMessages, serializeLiveTailToResponsesInput, rewriteResponsesPayloadWithNativeReplay } from "./payload-rewrite";
import {
	createNativeCompactionDetails,
	NATIVE_COMPACTION_FALLBACK_SUMMARY,
	NATIVE_COMPACTION_INPUT_PROVENANCE,
} from "./types";

function fixture() {
	const manager = SessionManager.inMemory("C:/offline");
	manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
	const firstKeptEntryId = manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", {}, { id: "call_read|fc_read" }), { stopReason: "toolUse", timestamp: 2 }));
	manager.appendMessage({ role: "toolResult", toolCallId: "call_read|fc_read", toolName: "read", content: [{ type: "text", text: "real result" }], isError: false, timestamp: 3 });
	manager.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, firstKeptEntryId, 100,
		createNativeCompactionDetails({ provider: "openai", api: "openai-responses", model: "gpt-6-astra", baseUrl: "https://offline.invalid/v1", inputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE, compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }] }));
	manager.appendMessage({ role: "user", content: "new", timestamp: 4 });
	const branchEntries = manager.getBranch();
	const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: "https://offline.invalid/v1" });
	assert(latest.ok);
	return { manager, branchEntries, compactionEntry: latest.entry, messages: manager.buildSessionContext().messages };
}

function removeRetained(
	args: Omit<Parameters<typeof removeNativeCompactionRetainedMessages>[0], "expectedInputProvenance">,
) {
	return removeNativeCompactionRetainedMessages({
		...args,
		expectedInputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
	});
}

const liveTailModel: Model<"openai-responses"> = {
	provider: "openai", api: "openai-responses", id: "gpt-6-astra", name: "GPT-6 Astra",
	baseUrl: "https://offline.invalid/v1", reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
};

describe("latest Pi retained context", () => {
	test("removes only verified retained copies, preserves transient/new messages and is immutable", () => {
		const args = fixture();
		const before = structuredClone(args.branchEntries);
		const transient = { role: "user" as const, content: "transient", timestamp: 5 };
		args.messages.splice(2, 0, transient);
		const messagesBefore = structuredClone(args.messages);
		const result = removeRetained(args);
		assert(result.ok);
		expect(result.messages).toEqual([args.messages[0], transient, args.messages.at(-1)]);
		expect(args.messages).toEqual(messagesBefore);
		expect(args.manager.getBranch()).toEqual(before);
		expect(removeRetained({ ...args, messages: result.messages })).toEqual({
			ok: false,
			reason: "retained-context-mismatch",
		});
	});
	test("ignores a Pi 0.86 leading system prompt moved before the summary", () => {
		const manager = SessionManager.inMemory("C:/offline");
		const firstKeptEntryId = manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("old answer", { timestamp: 2 }));
		manager.appendMessage({
			role: "system",
			content: "",
			sections: { preamble: "structured prompt" },
			toolsAdded: [],
			timestamp: 3,
		} as never);
		const compactionId = manager.appendCompaction(
			NATIVE_COMPACTION_FALLBACK_SUMMARY,
			firstKeptEntryId,
			100,
			createNativeCompactionDetails({
				provider: "openai",
				api: "openai-responses",
				model: "gpt-6-astra",
				baseUrl: "https://offline.invalid/v1",
				inputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
				compactedWindow: [{ type: "compaction", encrypted_content: "opaque-system" }],
			}),
		);
		manager.appendMessage({ role: "user", content: "new", timestamp: 4 });

		const branchEntries = manager.getBranch();
		const compactionEntry = branchEntries.find((entry) => entry.id === compactionId);
		assert(compactionEntry?.type === "compaction");
		const messages = manager.buildSessionContext().messages;
		const promotedSystem = messages.find((message) => (message.role as string) === "system");
		assert(promotedSystem);
		const promotedSystemShape = promotedSystem as unknown as { sections?: Record<string, string | null> };
		promotedSystemShape.sections = { preamble: "mutated after context rebuild" };
		const result = removeRetained({ messages, branchEntries, compactionEntry });

		assert(result.ok);
		expect(result.messages.map((message) => message.role)).toEqual(["system", "compactionSummary", "user"]);
		expect(result.messages[0]).toEqual(promotedSystem);
	});

	test("serializes a first live-tail system message as an update", () => {
		const manager = SessionManager.inMemory("C:/offline");
		manager.appendMessage({
			role: "system",
			content: "delta",
			sections: { rules: "updated", old: null },
			toolsAdded: [],
			timestamp: 1,
		} as never);

		expect(serializeLiveTailToResponsesInput({ model: liveTailModel, entries: manager.getBranch() })).toEqual([
			{
				role: "developer",
				content:
					'delta\n\nUpdated system prompt section "rules":\n\nupdated\n\nRemoved system prompt section "old".',
			},
		]);
	});

	test("rejects replay from a legacy opaque checkpoint without input provenance", () => {
		const args = fixture();
		assert(args.compactionEntry.details);
		delete (args.compactionEntry.details as unknown as Record<string, unknown>).inputProvenance;

		expect(removeRetained(args)).toEqual({
			ok: false,
			reason: "unverified-compaction-input",
		});
	});
	test("fails closed rather than removing half a modified tool batch", () => {
		const args = fixture();
		const messages = structuredClone(args.messages);
		const tool = messages.find((message) => message.role === "toolResult");
		assert(tool?.role === "toolResult");
		tool.content = [{ type: "text", text: "different" }];
		const before = structuredClone(messages);
		expect(removeRetained({ ...args, messages })).toEqual({ ok: false, reason: "retained-context-mismatch" });
		expect(messages).toEqual(before);
	});
	test("fails closed when every required retained message is modified", () => {
		const args = fixture();
		const messages = structuredClone(args.messages);
		for (const message of messages) {
			if (message.role === "assistant") {
				message.content = [{ type: "text", text: "modified assistant" }];
			}
			if (message.role === "toolResult") {
				message.content = [{ type: "text", text: "modified result" }];
			}
		}

		expect(removeRetained({ ...args, messages })).toEqual({
			ok: false,
			reason: "retained-context-mismatch",
		});
	});
	test("fails closed when the complete required retained span is missing", () => {
		const args = fixture();
		const summaryIndex = args.messages.findIndex((message) => message.role === "compactionSummary");
		assert(summaryIndex >= 0);
		const messages = args.messages.filter((message, index) =>
			index <= summaryIndex || (message.role !== "assistant" && message.role !== "toolResult"),
		);

		expect(removeRetained({ ...args, messages })).toEqual({
			ok: false,
			reason: "retained-context-mismatch",
		});
	});
	test("filtered custom content cannot hide a damaged required tool result", () => {
		const manager = SessionManager.inMemory("C:/offline");
		manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		const firstKeptEntryId = manager.appendMessage(
			fauxAssistantMessage(fauxToolCall("read", {}, { id: "call_read|fc_read" }), { stopReason: "toolUse", timestamp: 2 }),
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call_read|fc_read",
			toolName: "read",
			content: [{ type: "text", text: "real result" }],
			isError: false,
			timestamp: 3,
		});
		manager.appendCustomMessageEntry("state", "filtered state", true, { internal: true });
		const compactionId = manager.appendCompaction(
			NATIVE_COMPACTION_FALLBACK_SUMMARY,
			firstKeptEntryId,
			100,
			createNativeCompactionDetails({
				provider: "openai",
				api: "openai-responses",
				model: "gpt-6-astra",
				baseUrl: "https://offline.invalid/v1",
				inputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
				compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
			}),
		);
		manager.appendMessage({ role: "user", content: "new", timestamp: 4 });
		const branchEntries = manager.getBranch();
		const compactionEntry = branchEntries.find((entry) => entry.id === compactionId);
		assert(compactionEntry?.type === "compaction");
		const messages = structuredClone(manager.buildSessionContext().messages.filter(
			(message) => message.role !== "custom" || message.customType !== "state",
		));
		const tool = messages.find((message) => message.role === "toolResult");
		assert(tool?.role === "toolResult");
		tool.content = [{ type: "text", text: "tampered result" }];

		expect(removeRetained({ messages, branchEntries, compactionEntry })).toEqual({
			ok: false,
			reason: "retained-context-mismatch",
		});
	});
	test("removes exact retained custom copies when present", () => {
		const manager = SessionManager.inMemory("C:/offline");
		const firstKeptEntryId = manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		manager.appendCustomMessageEntry("state", "exact custom", true, { version: 1 });
		const compactionId = manager.appendCompaction(
			NATIVE_COMPACTION_FALLBACK_SUMMARY,
			firstKeptEntryId,
			100,
			createNativeCompactionDetails({
				provider: "openai",
				api: "openai-responses",
				model: "gpt-6-astra",
				baseUrl: "https://offline.invalid/v1",
				inputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
				compactedWindow: [{ type: "compaction", encrypted_content: "opaque-custom-exact" }],
			}),
		);
		manager.appendMessage({ role: "user", content: "new", timestamp: 4 });

		const branchEntries = manager.getBranch();
		const compactionEntry = branchEntries.find((entry) => entry.id === compactionId);
		assert(compactionEntry?.type === "compaction");
		const messages = manager.buildSessionContext().messages;
		const result = removeRetained({ messages, branchEntries, compactionEntry });

		assert(result.ok);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]?.role).toBe("compactionSummary");
		expect(result.messages[1]).toEqual({ role: "user", content: "new", timestamp: 4 });
	});

	test("provider-visible custom metadata differences do not block retained filtering", () => {
		const manager = SessionManager.inMemory("C:/offline");
		manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		const firstKeptEntryId = manager.appendMessage(
			fauxAssistantMessage(fauxToolCall("read", {}, { id: "call_custom|fc_custom" }), { stopReason: "toolUse", timestamp: 2 }),
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call_custom|fc_custom",
			toolName: "read",
			content: [{ type: "text", text: "real result" }],
			isError: false,
			timestamp: 3,
		});
		manager.appendCustomMessageEntry("state", "original custom", true, { version: 1 });
		const compactionId = manager.appendCompaction(
			NATIVE_COMPACTION_FALLBACK_SUMMARY,
			firstKeptEntryId,
			100,
			createNativeCompactionDetails({
				provider: "openai",
				api: "openai-responses",
				model: "gpt-6-astra",
				baseUrl: "https://offline.invalid/v1",
				inputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
				compactedWindow: [{ type: "compaction", encrypted_content: "opaque-custom" }],
			}),
		);
		manager.appendMessage({ role: "user", content: "new", timestamp: 4 });
		const branchEntries = manager.getBranch();
		const compactionEntry = branchEntries.find((entry) => entry.id === compactionId);
		assert(compactionEntry?.type === "compaction");
		const messages = structuredClone(manager.buildSessionContext().messages);
		const custom = messages.find((message) => message.role === "custom");
		assert(custom?.role === "custom");
		custom.content = "provider-visible custom clone";
		custom.details = { version: 2, changed: true };

		const result = removeRetained({ messages, branchEntries, compactionEntry });
		assert(result.ok);
		expect(result.messages).toContainEqual(custom);
		expect(result.messages.filter((message) => message.role === "assistant" || message.role === "toolResult")).toEqual([]);
	});
	test("filters recursive retained history without resurrecting an older summary", () => {
		const args = fixture();
		args.manager.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, args.compactionEntry.firstKeptEntryId, 200,
			createNativeCompactionDetails({ provider: "openai", api: "openai-responses", model: "gpt-6-astra",
				baseUrl: "https://offline.invalid/v1", inputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE, compactedWindow: [{ type: "compaction", encrypted_content: "opaque-recursive" }] }));
		args.manager.appendMessage({ role: "user", content: "After recursive compaction", timestamp: 6 });
		const branchEntries = args.manager.getBranch();
		const before = structuredClone(branchEntries);
		const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: "https://offline.invalid/v1" });
		assert(latest.ok);
		const messages = args.manager.buildSessionContext().messages;
		expect(messages.filter((message) => message.role === "compactionSummary")).toHaveLength(1);
		const result = removeRetained({ messages, branchEntries, compactionEntry: latest.entry });
		assert(result.ok);
		expect(result.messages).toEqual([messages[0], messages.at(-1)]);
		expect(args.manager.getBranch()).toEqual(before);
	});
	test("does not guess a missing boundary or summary", () => {
		const args = fixture();
		expect(removeRetained({ ...args, branchEntries: [] })).toEqual({ ok: false, reason: "compaction-boundary-not-found" });
		expect(removeRetained({ ...args, compactionEntry: { ...args.compactionEntry, firstKeptEntryId: "missing" } })).toEqual({ ok: false, reason: "first-kept-entry-not-found" });
		expect(removeRetained({ ...args, messages: args.messages.slice(1) })).toEqual({ ok: false, reason: "compaction-summary-not-found" });
	});
});


describe("Pi 0.87 canonical context edits", () => {
	test("live tail applies omission and replacement without rewriting history", () => {
		const manager = SessionManager.inMemory("C:/offline");
		const hidden = manager.appendMessage({ role: "user", content: "HIDDEN", timestamp: 1 });
		const changed = manager.appendMessage(fauxAssistantMessage("OLD", { timestamp: 2 }));
		manager.appendContextEdit(hidden, null);
		manager.appendContextEdit(changed, { content: "REPLACEMENT" });
		const before = structuredClone(manager.getBranch());
		const input = serializeLiveTailToResponsesInput({ model: liveTailModel, entries: manager.getBranch() });
		expect(JSON.stringify(input)).not.toContain("HIDDEN");
		expect(JSON.stringify(input)).not.toContain("OLD");
		expect(JSON.stringify(input)).toContain("REPLACEMENT");
		expect(manager.getBranch()).toEqual(before);
		manager.branch(changed);
		expect(JSON.stringify(serializeLiveTailToResponsesInput({ model: liveTailModel, entries: manager.getBranch() }))).toContain("HIDDEN");
	});
	test("retained entries use edits already included in the checkpoint", () => {
		const manager = SessionManager.inMemory("C:/offline");
		const hidden = manager.appendMessage({ role: "user", content: "HIDDEN", timestamp: 1 });
		const changed = manager.appendMessage(fauxAssistantMessage("OLD", { timestamp: 2 }));
		manager.appendContextEdit(hidden, null);
		manager.appendContextEdit(changed, { content: "REPLACEMENT" });
		const details = fixture().compactionEntry.details;
		manager.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, hidden, 100, details);
		manager.appendMessage({ role: "user", content: "new", timestamp: 4 });
		const branchEntries = manager.getBranch();
		const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: "https://offline.invalid/v1" });
		assert(latest.ok);
		const messages = manager.buildSessionProjection().messages;
		const result = removeRetained({ branchEntries, compactionEntry: latest.entry, messages });
		assert(result.ok);
		expect(result.messages.map(m => m.role)).toEqual(["compactionSummary", "user"]);
		expect(JSON.stringify(result.messages)).not.toContain("REPLACEMENT");
	});
	for (const replacement of [null, { content: "redacted" }]) {
		test(`edit of checkpoint-covered input refuses opaque replay (${JSON.stringify(replacement)})`, () => {
			const args = fixture();
			args.manager.appendContextEdit(args.compactionEntry.firstKeptEntryId, replacement);
			const branchEntries = args.manager.getBranch();
			const messages = args.manager.buildSessionProjection().messages;
			expect(removeRetained({ ...args, branchEntries, messages })).toEqual({ ok: false, reason: "checkpoint-context-edited" });
			expect(rewriteResponsesPayloadWithNativeReplay({ model: liveTailModel, branchEntries, compactionEntry: args.compactionEntry,
				expectedInputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
				payload: { input: [{ role: "user", content: `<summary>${args.compactionEntry.summary}</summary>` }] },
			})).toEqual({ ok: false, reason: "checkpoint-context-edited" });
		});
	}
	test("retain-none compaction replays with no preceding retained entries", () => {
		const args = fixture();
		args.manager.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, null, 200, args.compactionEntry.details);
		args.manager.appendMessage({ role: "user", content: "after retain-none", timestamp: 8 });
		const branchEntries = args.manager.getBranch();
		const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: "https://offline.invalid/v1" });
		assert(latest.ok);
		expect(latest.entry.firstKeptEntryId).toBe(latest.entry.id);
		const messages = args.manager.buildSessionProjection().messages;
		expect(removeRetained({ branchEntries, compactionEntry: latest.entry, messages })).toEqual({ ok: true, messages });
		const result = rewriteResponsesPayloadWithNativeReplay({ model: liveTailModel, branchEntries, compactionEntry: latest.entry,
			expectedInputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
			payload: { input: [{ role: "user", content: `<summary>${latest.entry.summary}</summary>` }, { role: "user", content: "after retain-none" }] },
		});
		assert(result.ok);
		expect(result.rewrittenPayload.input).toEqual([{ type: "compaction", encrypted_content: "opaque" }, { role: "user", content: "after retain-none" }]);
	});
});


test("canonical tail preserves tool pairs, normalizes latest replacement and omits custom context", () => {
	const manager = SessionManager.inMemory("C:/offline");
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", {}, { id: "call_edit|fc_edit" }), { stopReason: "toolUse", timestamp: 1 }));
	const resultId = manager.appendMessage({ role: "toolResult", toolCallId: "call_edit|fc_edit", toolName: "read", content: [{ type: "text", text: "old-result" }], isError: false, timestamp: 2 });
	const customId = manager.appendCustomMessageEntry("hidden", "hidden-custom", false);
	manager.appendContextEdit(resultId, { content: "intermediate-result" });
	manager.appendContextEdit(resultId, { content: "latest-result" });
	manager.appendContextEdit(customId, null);
	const before = structuredClone(manager.getBranch());
	const input = serializeLiveTailToResponsesInput({ model: liveTailModel, entries: manager.getBranch() });
	expect(input.filter(item => item.type === "function_call")).toHaveLength(1);
	expect(input.filter(item => item.type === "function_call_output")).toHaveLength(1);
	expect(JSON.stringify(input)).toContain("latest-result");
	for (const hidden of ["old-result", "intermediate-result", "hidden-custom"]) expect(JSON.stringify(input)).not.toContain(hidden);
	expect(manager.getBranch()).toEqual(before);
});

test("editing only post-checkpoint input keeps replay valid and navigation restores checkpoint reuse", () => {
	const args = fixture();
	const post = args.manager.getLeafId()!;
	args.manager.appendContextEdit(post, { content: "newly-edited-tail" });
	const safeLeaf = args.manager.getLeafId()!;
	const remove = () => removeRetained({ ...args, branchEntries: args.manager.getBranch(), messages: args.manager.buildSessionProjection().messages });
	let result = remove();
	assert(result.ok);
	expect(JSON.stringify(result.messages)).toContain("newly-edited-tail");
	args.manager.appendContextEdit(args.compactionEntry.firstKeptEntryId, null);
	expect(remove()).toEqual({ ok: false, reason: "checkpoint-context-edited" });
	args.manager.branch(safeLeaf);
	result = remove();
	assert(result.ok);
	expect(JSON.stringify(result.messages)).toContain("newly-edited-tail");
});
