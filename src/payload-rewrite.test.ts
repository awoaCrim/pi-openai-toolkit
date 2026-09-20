import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { resolveLatestNativeCompactionEntry } from "./details-store";
import { removeNativeCompactionRetainedMessages, serializeLiveTailToResponsesInput } from "./payload-rewrite";
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
	test("filters recursive retained history including an earlier compaction summary", () => {
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
		expect(messages.filter((message) => message.role === "compactionSummary")).toHaveLength(2);
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
