import { describe, expect, test } from "bun:test";
import {
	CACHE_STACK_ACTIVATION_ENTRY_TYPE,
	createNativeCompactionDetails,
	getLatestDeferredToolCarryover,
	isNativeCompactionDetails,
	type DeferredToolCarryoverV1,
} from "./types";
import { rewritePayloadWithDeferredToolCarryover } from "./deferred-tool-carryover";

const carryover: DeferredToolCarryoverV1 = {
	version: 1,
	source: CACHE_STACK_ACTIVATION_ENTRY_TYPE,
	toolNames: ["search_docs", "read_file"],
	catalogHash: "catalog-v1",
};

function createEntry(data: unknown, customType = CACHE_STACK_ACTIVATION_ENTRY_TYPE): never {
	return {
		type: "custom",
		customType,
		data,
	} as never;
}

function createPayload(overrides: Record<string, unknown> = {}) {
	return {
		model: "gpt-5.4",
		input: [
			{ role: "developer", content: "fresh instructions" },
			{ type: "compaction", encrypted_content: "opaque-checkpoint" },
			{ role: "user", content: [{ type: "input_text", text: "continue" }] },
		],
		tools: [
			{
				type: "function",
				name: "read_file",
				description: "Read a file",
				parameters: { type: "object", properties: {} },
				strict: false,
			},
			{
				type: "function",
				name: "search_docs",
				description: "Search docs",
				parameters: { type: "object", properties: { query: { type: "string" } } },
				strict: false,
			},
			{ type: "web_search" },
		],
		prompt_cache_key: "session-cache-key",
		previous_response_id: "resp_previous",
		reasoning: { effort: "medium" },
		service_tier: "flex",
		include: ["reasoning.encrypted_content"],
		unknown_field: { preserve: true },
		...overrides,
	};
}

describe("cache-stack activation and deferred tool carryover", () => {
	test("reads the latest valid current-branch activation entry and ignores malformed versions", () => {
		const latest = getLatestDeferredToolCarryover([
			createEntry({ version: 1, activatedTools: ["old_tool"], catalogHash: "old" }),
			createEntry({ version: 2, activatedTools: ["unknown_version"], catalogHash: "invalid" }),
			createEntry({ version: 1, activatedTools: [" search_docs ", "read_file", "search_docs"], catalogHash: "latest" }),
			createEntry({ version: 1, activatedTools: ["broken"], catalogHash: 42 }),
		]);

		expect(latest).toEqual({
			version: 1,
			source: CACHE_STACK_ACTIVATION_ENTRY_TYPE,
			toolNames: ["read_file", "search_docs"],
			catalogHash: "latest",
		});
	});

	test("keeps legacy details valid and rejects malformed carryover details", () => {
		const details = createNativeCompactionDetails({
			provider: "openai",
			api: "openai-responses",
			model: "gpt-5.4",
			baseUrl: "https://api.openai.com/v1",
			compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
		});

		expect(isNativeCompactionDetails(details)).toBe(true);
		expect(
			isNativeCompactionDetails({
				...details,
				deferredToolCarryover: { version: 2, source: CACHE_STACK_ACTIVATION_ENTRY_TYPE, toolNames: [] },
			}),
		).toBe(false);
	});

	test("moves matching function schemas into additional_tools after the opaque checkpoint", () => {
		const payload = createPayload();
		const originalTools = structuredClone(payload.tools);
		const result = rewritePayloadWithDeferredToolCarryover({
			payload,
			carryover,
			compactionEntryId: "compaction-additional",
			checkpointEndIndex: 2,
			compat: { supportsAdditionalTools: true },
		});

		expect(result.changed).toBe(true);
		expect(result.mode).toBe("additional-tools");
		expect(result.movedToolNames).toEqual(["read_file", "search_docs"]);
		expect(result.payload.tools).toEqual([{ type: "web_search" }]);
		expect(result.payload.input).toEqual([
			payload.input[0],
			payload.input[1],
			{
				type: "additional_tools",
				role: "developer",
				tools: originalTools.slice(0, 2),
			},
			payload.input[2],
		]);
		expect(result.payload.prompt_cache_key).toBe(payload.prompt_cache_key);
		expect(result.payload.previous_response_id).toBe(payload.previous_response_id);
		expect(result.payload.reasoning).toEqual(payload.reasoning);
		expect(result.payload.service_tier).toBe(payload.service_tier);
		expect(result.payload.include).toEqual(payload.include);
		expect(result.payload.unknown_field).toEqual(payload.unknown_field);
		expect(payload.tools).toEqual(originalTools);
	});

	test("moves matching custom schemas without dropping provider-specific fields", () => {
		const customTool = {
			type: "custom",
			name: "regex_tool",
			description: "Run a constrained expression",
			format: { type: "grammar", syntax: "regex", definition: "[a-z]+" },
			provider_field: { keep: true },
		};
		const result = rewritePayloadWithDeferredToolCarryover({
			payload: createPayload({ tools: [customTool] }),
			carryover: { ...carryover, toolNames: ["regex_tool"] },
			compactionEntryId: "compaction-custom",
			checkpointEndIndex: 2,
			compat: { supportsAdditionalTools: true },
		});

		expect(result.changed).toBe(true);
		expect(result.payload.tools).toEqual([]);
		expect(result.payload.input[2]).toEqual({
			type: "additional_tools",
			role: "developer",
			tools: [customTool],
		});
	});

	test("uses the official client-completed tool-search shape with deterministic IDs", () => {
		const first = rewritePayloadWithDeferredToolCarryover({
			payload: createPayload(),
			carryover,
			compactionEntryId: "compaction-tool-search",
			checkpointEndIndex: 2,
			compat: { supportsToolSearch: true },
		});
		const second = rewritePayloadWithDeferredToolCarryover({
			payload: createPayload(),
			carryover,
			compactionEntryId: "compaction-tool-search",
			checkpointEndIndex: 2,
			compat: { supportsToolSearch: true },
		});

		expect(first).toEqual(second);
		expect(first.mode).toBe("tool-search");
		expect(first.payload.input.slice(2, 4)).toEqual([
			{
				type: "tool_search_call",
				call_id: expect.stringMatching(/^pi_tool_load_[0-9a-f]{8}$/),
				execution: "client",
				status: "completed",
				arguments: { query: "read_file search_docs", limit: 2 },
			},
			{
				type: "tool_search_output",
				call_id: (first.payload.input[2] as { call_id: string }).call_id,
				execution: "client",
				status: "completed",
				tools: [
					{ ...(createPayload().tools[0] as Record<string, unknown>), defer_loading: true },
					{ ...(createPayload().tools[1] as Record<string, unknown>), defer_loading: true },
				],
			},
		]);
	});

	test("ignores missing schemas and removes duplicate top-level schemas when a load point already exists", () => {
		const missing = rewritePayloadWithDeferredToolCarryover({
			payload: createPayload({ tools: [{ type: "function", name: "other_tool" }] }),
			carryover,
			compactionEntryId: "compaction-missing",
			checkpointEndIndex: 2,
			compat: { supportsAdditionalTools: true },
		});
		expect(missing.changed).toBe(false);

		const existingLoadPoint = {
			type: "additional_tools",
			role: "developer",
			tools: [createPayload().tools[0]],
		};
		const payload = createPayload({
			input: [
				{ role: "developer", content: "fresh instructions" },
				{ type: "compaction", encrypted_content: "opaque-checkpoint" },
				existingLoadPoint,
			],
		});
		const deduped = rewritePayloadWithDeferredToolCarryover({
			payload,
			carryover: { ...carryover, toolNames: ["read_file"] },
			compactionEntryId: "compaction-existing",
			checkpointEndIndex: 2,
			compat: { supportsAdditionalTools: true },
		});

		expect(deduped.changed).toBe(true);
		expect(deduped.payload.input).toEqual(payload.input);
		expect(deduped.payload.tools).toEqual([
			payload.tools[1],
			payload.tools[2],
		]);
	});

	test("recognizes only an exact completed client tool-search pair as an existing load point", () => {
		const schema = createPayload().tools[0];
		const existingCallId = "pi_tool_load_existing";
		const payload = createPayload({
			input: [
				{ role: "developer", content: "fresh instructions" },
				{ type: "compaction", encrypted_content: "opaque-checkpoint" },
				{
					type: "tool_search_call",
					call_id: existingCallId,
					execution: "client",
					status: "completed",
					arguments: { query: "read_file", limit: 1 },
				},
				{
					type: "tool_search_output",
					call_id: existingCallId,
					execution: "client",
					status: "completed",
					tools: [{ ...(schema as Record<string, unknown>), defer_loading: true }],
				},
			],
		});
		const result = rewritePayloadWithDeferredToolCarryover({
			payload,
			carryover: { ...carryover, toolNames: ["read_file"] },
			compactionEntryId: "compaction-existing-tool-search",
			checkpointEndIndex: 2,
			compat: { supportsToolSearch: true },
		});

		expect(result.changed).toBe(true);
		expect(result.movedToolNames).toEqual([]);
		expect(result.payload.input).toEqual(payload.input);
		expect(result.payload.tools).toEqual([payload.tools[1], payload.tools[2]]);
	});

	test("normalizes carryover names before excluding the local Web Search name", () => {
		const payload = createPayload({
			tools: [{ type: "function", name: "web_search", parameters: { type: "object" } }],
		});
		const result = rewritePayloadWithDeferredToolCarryover({
			payload,
			carryover: { ...carryover, toolNames: [" web_search "] },
			compactionEntryId: "compaction-web-search-whitespace",
			checkpointEndIndex: 2,
			compat: { supportsAdditionalTools: true },
		});

		expect(result.changed).toBe(false);
		expect(result.payload).toBe(payload);
	});

	test("fails open when a matching provider schema is malformed", () => {
		const payload = createPayload({
			tools: [{ type: "function", name: "read_file" }],
		});
		const result = rewritePayloadWithDeferredToolCarryover({
			payload,
			carryover,
			compactionEntryId: "compaction-malformed-schema",
			checkpointEndIndex: 2,
			compat: { supportsAdditionalTools: true },
		});

		expect(result.changed).toBe(false);
		expect(result.payload).toBe(payload);

		for (const malformedItem of [
			{ type: "additional_tools", role: "developer", tools: [{ type: "function", name: "read_file" }] },
			{ type: "additional_tools", role: "user", tools: [createPayload().tools[0]] },
			{
				type: "tool_search_output",
				call_id: "unpaired",
				execution: "client",
				status: "completed",
				tools: [{ ...(createPayload().tools[0] as Record<string, unknown>), defer_loading: true }],
			},
		]) {
			const malformedExistingLoadPointPayload = createPayload({
				input: [...createPayload().input, malformedItem],
			});
			const malformedExistingLoadPoint = rewritePayloadWithDeferredToolCarryover({
				payload: malformedExistingLoadPointPayload,
				carryover,
				compactionEntryId: "compaction-malformed-existing-load-point",
				checkpointEndIndex: 2,
				compat: { supportsAdditionalTools: true },
			});

			expect(malformedExistingLoadPoint.changed).toBe(false);
			expect(malformedExistingLoadPoint.payload).toBe(malformedExistingLoadPointPayload);
		}
	});

	test("fails open for unsupported compatibility, malformed carryover/tools, and native web search", () => {
		const unsupported = rewritePayloadWithDeferredToolCarryover({
			payload: createPayload(),
			carryover,
			compactionEntryId: "compaction-unsupported",
			checkpointEndIndex: 2,
			compat: {},
		});
		expect(unsupported.changed).toBe(false);

		const malformedCarryover = rewritePayloadWithDeferredToolCarryover({
			payload: createPayload(),
			carryover: { ...carryover, toolNames: ["read_file", 42] } as never,
			compactionEntryId: "compaction-malformed-carryover",
			checkpointEndIndex: 2,
			compat: { supportsAdditionalTools: true },
		});
		expect(malformedCarryover.changed).toBe(false);

		const malformed = rewritePayloadWithDeferredToolCarryover({
			payload: createPayload({ tools: "not-an-array" }),
			carryover,
			compactionEntryId: "compaction-malformed",
			checkpointEndIndex: 2,
			compat: { supportsAdditionalTools: true },
		});
		expect(malformed.changed).toBe(false);

		const nativeSearchOnly = rewritePayloadWithDeferredToolCarryover({
			payload: createPayload({ tools: [{ type: "web_search" }] }),
			carryover: { ...carryover, toolNames: ["web_search"] },
			compactionEntryId: "compaction-web-search",
			checkpointEndIndex: 2,
			compat: { supportsAdditionalTools: true },
		});
		expect(nativeSearchOnly.changed).toBe(false);
	});
});
