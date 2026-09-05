import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { resolveLatestNativeCompactionEntry } from "./details-store";
import { removeNativeCompactionRetainedMessages } from "./payload-rewrite";
import { createNativeCompactionDetails, NATIVE_COMPACTION_FALLBACK_SUMMARY } from "./types";

function fixture() {
	const manager = SessionManager.inMemory("C:/offline");
	manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
	const firstKeptEntryId = manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", {}, { id: "call_read|fc_read" }), { stopReason: "toolUse", timestamp: 2 }));
	manager.appendMessage({ role: "toolResult", toolCallId: "call_read|fc_read", toolName: "read", content: [{ type: "text", text: "real result" }], isError: false, timestamp: 3 });
	manager.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, firstKeptEntryId, 100,
		createNativeCompactionDetails({ provider: "openai", api: "openai-responses", model: "gpt-6-astra", baseUrl: "https://offline.invalid/v1", compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }] }));
	manager.appendMessage({ role: "user", content: "new", timestamp: 4 });
	const branchEntries = manager.getBranch();
	const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: "https://offline.invalid/v1" });
	assert(latest.ok);
	return { manager, branchEntries, compactionEntry: latest.entry, messages: manager.buildSessionContext().messages };
}

describe("latest Pi retained context", () => {
	test("removes only verified retained copies, preserves transient/new messages and is immutable", () => {
		const args = fixture();
		const before = structuredClone(args.branchEntries);
		const transient = { role: "user" as const, content: "transient", timestamp: 5 };
		args.messages.splice(2, 0, transient);
		const messagesBefore = structuredClone(args.messages);
		const result = removeNativeCompactionRetainedMessages(args);
		assert(result.ok);
		expect(result.messages).toEqual([args.messages[0], transient, args.messages.at(-1)]);
		expect(args.messages).toEqual(messagesBefore);
		expect(args.manager.getBranch()).toEqual(before);
		const repeated = removeNativeCompactionRetainedMessages({ ...args, messages: result.messages });
		assert(repeated.ok);
		expect(repeated.messages).toBe(result.messages);
	});
	test("fails closed rather than removing half a modified tool batch", () => {
		const args = fixture();
		const messages = structuredClone(args.messages);
		const tool = messages.find((message) => message.role === "toolResult");
		assert(tool?.role === "toolResult");
		tool.content = [{ type: "text", text: "different" }];
		const before = structuredClone(messages);
		expect(removeNativeCompactionRetainedMessages({ ...args, messages })).toEqual({ ok: false, reason: "retained-context-mismatch" });
		expect(messages).toEqual(before);
	});
	test("filters recursive retained history including an earlier compaction summary", () => {
		const args = fixture();
		args.manager.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, args.compactionEntry.firstKeptEntryId, 200,
			createNativeCompactionDetails({ provider: "openai", api: "openai-responses", model: "gpt-6-astra",
				baseUrl: "https://offline.invalid/v1", compactedWindow: [{ type: "compaction", encrypted_content: "opaque-recursive" }] }));
		args.manager.appendMessage({ role: "user", content: "After recursive compaction", timestamp: 6 });
		const branchEntries = args.manager.getBranch();
		const before = structuredClone(branchEntries);
		const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: "https://offline.invalid/v1" });
		assert(latest.ok);
		const messages = args.manager.buildSessionContext().messages;
		expect(messages.filter((message) => message.role === "compactionSummary")).toHaveLength(2);
		const result = removeNativeCompactionRetainedMessages({ messages, branchEntries, compactionEntry: latest.entry });
		assert(result.ok);
		expect(result.messages).toEqual([messages[0], messages.at(-1)]);
		expect(args.manager.getBranch()).toEqual(before);
	});
	test("does not guess a missing boundary or summary", () => {
		const args = fixture();
		expect(removeNativeCompactionRetainedMessages({ ...args, branchEntries: [] })).toEqual({ ok: false, reason: "compaction-boundary-not-found" });
		expect(removeNativeCompactionRetainedMessages({ ...args, compactionEntry: { ...args.compactionEntry, firstKeptEntryId: "missing" } })).toEqual({ ok: false, reason: "first-kept-entry-not-found" });
		expect(removeNativeCompactionRetainedMessages({ ...args, messages: args.messages.slice(1) })).toEqual({ ok: false, reason: "compaction-summary-not-found" });
	});
});
