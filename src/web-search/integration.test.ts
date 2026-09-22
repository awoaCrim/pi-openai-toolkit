import { afterEach, describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	clearRequestContextCache,
	getCompactionRequestExtras,
	rememberRequestContext,
} from "../request-context-cache";
import { rewritePayloadWithDeferredToolCarryover } from "../deferred-tool-carryover";
import { CACHE_STACK_ACTIVATION_ENTRY_TYPE } from "../types";
import { registerWebSearchExtension } from "./extension";
import { transformWebSearchPayload } from "./payload";
import { WEB_SEARCH_SOURCE_INCLUDE } from "./types";

const enabled = { enabled: true, models: ["newapi/gpt-5.5"] };
const model = { provider: "newapi", api: "openai-responses", id: "gpt-5.5" };
const identity = {
	provider: "newapi",
	api: "openai-responses",
	model: "gpt-5.5",
	baseUrl: "https://newapi.example/v1",
	sessionId: "session-web-search-order",
};

afterEach(() => clearRequestContextCache());

function registeredStandaloneDefinition() {
	const registered: Array<Pick<ToolDefinition, "name" | "description" | "parameters">> = [];
	registerWebSearchExtension({
		registerTool: (tool: (typeof registered)[number]) => registered.push(tool),
		on: () => undefined,
	} as never);
	expect(registered).toHaveLength(1);
	const tool = registered[0]!;
	return { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false };
}

describe("Compaction and Web Search integration", () => {
	test("package publishes the current extension entrypoints without deleted ones", () => {
		const packageJson = JSON.parse(
			fs.readFileSync(path.resolve(import.meta.dir, "../..", "package.json"), "utf8"),
		) as { pi?: { extensions?: string[] }; files?: string[] };

		expect(packageJson.pi?.extensions).toEqual([
			"./src/extension-runtime.ts",
			"./src/web-search/extension.ts",
			"./src/image-generation/extension.ts",
			"./src/auto-mode/extension.ts",
			"./src/codex-astra/extension.ts",
		]);
		expect(packageJson.files ?? []).not.toContain("extensions/compaction.ts");
		expect(packageJson.files ?? []).not.toContain("extensions/web-search.ts");
		expect(packageJson.files ?? []).not.toContain("extensions/image-generation.ts");
		expect(packageJson.files ?? []).not.toContain("extensions/auto-mode.ts");
		expect(packageJson.files ?? []).not.toContain("extensions/codex-astra.ts");
	});

	test("compaction caches pre-search tools while the final live payload receives native search", () => {
		const originalPayload = {
			model: "gpt-5.5",
			input: [{ role: "user", content: "latest news" }],
			tools: [{ type: "function", name: "read_file" }],
			reasoning: { effort: "medium" },
		};

		rememberRequestContext(originalPayload, identity);
		const replayRewrittenPayload = {
			...originalPayload,
			input: [{ type: "compaction", encrypted_content: "opaque" }, originalPayload.input[0]],
		};
		const live = transformWebSearchPayload({
			model,
			config: enabled,
			payload: replayRewrittenPayload,
		});
		const compactExtras = getCompactionRequestExtras(identity);

		expect(live.changed).toBe(true);
		expect((live.payload as Record<string, unknown>).input).toEqual(replayRewrittenPayload.input);
		expect((live.payload as Record<string, unknown>).tools).toEqual([
			{ type: "function", name: "read_file" },
			{ type: "web_search" },
		]);
		expect((live.payload as Record<string, unknown>).include).toEqual([WEB_SEARCH_SOURCE_INCLUDE]);
		expect(compactExtras?.tools).toEqual([{ type: "function", name: "read_file" }]);
		expect(compactExtras?.tools).not.toContainEqual({ type: "web_search" });
		expect(compactExtras).not.toHaveProperty("include");
	});

	test("toolkit Web Search takes precedence without polluting compaction extras", () => {
		const localTool = { type: "function", name: "web_search", description: "local search" };
		const payload = { model: "gpt-5.5", input: [], tools: [localTool] };
		rememberRequestContext(payload, identity);

		const live = transformWebSearchPayload({ model, config: enabled, payload });

		expect((live.payload as { tools: unknown[] }).tools).toEqual([{ type: "web_search" }]);
		expect((live.payload as { include: unknown[] }).include).toEqual([WEB_SEARCH_SOURCE_INCLUDE]);
		expect(live.changed).toBe(true);
		expect(getCompactionRequestExtras(identity)?.tools).toEqual([localTool]);
	});

	test("carryover is inserted before the later native Web Search transform", () => {
		const payload = {
			model: "gpt-5.5",
			input: [
				{ role: "developer", content: "fresh" },
				{ type: "compaction", encrypted_content: "opaque" },
				{ role: "user", content: "continue" },
			],
			tools: [
				{ type: "function", name: "read_file", parameters: { type: "object" }, strict: false },
				{ type: "function", name: "web_search", parameters: { type: "object" }, strict: false },
			],
		};
		const carryover = rewritePayloadWithDeferredToolCarryover({
			payload,
			carryover: {
				version: 1,
				source: CACHE_STACK_ACTIVATION_ENTRY_TYPE,
				toolNames: ["read_file", "web_search"],
				catalogHash: "catalog-v1",
			},
			compactionEntryId: "compaction-search-order",
			checkpointEndIndex: 2,
			compat: { supportsAdditionalTools: true },
		});
		const live = transformWebSearchPayload({
			model,
			config: enabled,
			payload: carryover.payload,
		});
		const finalPayload = live.payload as { input: unknown[]; tools: unknown[]; include: unknown[] };

		expect(finalPayload.input[2]).toEqual({
			type: "additional_tools",
			role: "developer",
			tools: [payload.tools[0]],
		});
		expect(finalPayload.tools).toEqual([{ type: "web_search" }]);
		expect(finalPayload.include).toEqual([WEB_SEARCH_SOURCE_INCLUDE]);
	});

	for (const [mode, compat] of [
		["additional-tools", { supportsAdditionalTools: true }],
		["tool-search", { supportsToolSearch: true }],
	] as const) {
		for (const withOrdinaryTool of [false, true]) {
			test(`standalone search stays callable after ${mode} replay (${withOrdinaryTool ? "mixed tools" : "search only"})`, () => {
				const standalone = registeredStandaloneDefinition();
				const ordinary = { type: "function", name: "read_file", parameters: { type: "object" }, strict: false };
				const payload = {
					model: model.id,
					input: [
						{ role: "developer", content: "fresh" },
						{ type: "compaction", encrypted_content: "opaque" },
						{ role: "user", content: "continue" },
					],
					tools: withOrdinaryTool ? [standalone, ordinary] : [standalone],
				};
				const snapshot = structuredClone(payload);
				const carryover = rewritePayloadWithDeferredToolCarryover({
					payload,
					carryover: {
						version: 1, source: CACHE_STACK_ACTIVATION_ENTRY_TYPE,
						toolNames: withOrdinaryTool ? [" web_run ", "read_file"] : [" web_run "],
					},
					compactionEntryId: "standalone-replay",
					checkpointEndIndex: 2,
					compat,
				});
				const live = transformWebSearchPayload({
					model,
					config: { enabled: true, models: [], defaultRoute: "standalone-alpha" },
					payload: carryover.payload,
				});

				expect(live.fatal).not.toBe(true);
				expect(live).toMatchObject({ outcome: "standalone-route", changed: false });
				expect(carryover.movedToolNames).toEqual(withOrdinaryTool ? ["read_file"] : []);
				expect(carryover.payload.tools).toEqual([standalone]);
				if (!withOrdinaryTool) {
					expect(carryover.changed).toBe(false);
					expect(carryover.payload).toBe(payload);
				} else if (mode === "additional-tools") {
					expect(carryover.payload.input).toEqual([
						...payload.input.slice(0, 2),
						{ type: "additional_tools", role: "developer", tools: [ordinary] },
						payload.input[2],
					]);
				} else {
					const call = carryover.payload.input[2] as Record<string, unknown>;
					expect(call).toMatchObject({
						type: "tool_search_call", execution: "client", status: "completed",
						arguments: { query: "read_file", limit: 1 },
					});
					expect(call.call_id).toBeString();
					expect(carryover.payload.input).toEqual([
						...payload.input.slice(0, 2), call,
						{ type: "tool_search_output", call_id: call.call_id, execution: "client", status: "completed",
							tools: [{ ...ordinary, defer_loading: true }] },
						payload.input[2],
					]);
				}
				expect(payload).toEqual(snapshot);
			});
		}

		test(`${mode} replay preserves legacy search history without restoring a dotted callable`, () => {
			const standalone = registeredStandaloneDefinition();
			const ordinary = { type: "function", name: "read_file", parameters: { type: "object" }, strict: false };
			const history = [
				{ type: "function_call", id: "fc_old", call_id: "old_call", name: "web.run", arguments: '{"search_query":[{"q":"old"}]}' },
				{ type: "function_call_output", call_id: "old_call", output: "old search result" },
			];
			const payload = {
				model: model.id,
				input: [
					{ role: "developer", content: "fresh" },
					{ type: "compaction", encrypted_content: "opaque" },
					...history,
					{ role: "user", content: "continue" },
				],
				tools: [standalone, ordinary],
			};
			const snapshot = structuredClone(payload);
			const replay = rewritePayloadWithDeferredToolCarryover({
				payload,
				carryover: { version: 1, source: CACHE_STACK_ACTIVATION_ENTRY_TYPE, toolNames: ["web.run", "read_file"] },
				compactionEntryId: "legacy-search-replay", checkpointEndIndex: 2, compat,
			});
			const live = transformWebSearchPayload({
				model, config: { enabled: true, models: [], defaultRoute: "standalone-alpha" }, payload: replay.payload,
			});
			const finalPayload = live.payload as { tools: unknown[]; input: Array<Record<string, unknown>> };

			expect(live.fatal).not.toBe(true);
			expect(replay.movedToolNames).toEqual(["read_file"]);
			expect(finalPayload.tools).toEqual([standalone]);
			expect(finalPayload.input.filter((item) => item.type === "function_call" || item.type === "function_call_output")).toEqual(history);
			const loadPoints = finalPayload.input.filter((item) => item.type === "additional_tools" || item.type === "tool_search_output");
			expect(loadPoints).toHaveLength(1);
			expect(loadPoints[0].tools).toEqual([mode === "tool-search" ? { ...ordinary, defer_loading: true } : ordinary]);
			expect(payload).toEqual(snapshot);
		});
	}

	test("registered standalone search stays live but is excluded from synthetic compaction extras", () => {
		const payload = {
			model: "gpt-5.5",
			input: [{ role: "user", content: "latest news" }],
			tools: [
				registeredStandaloneDefinition(),
				{ type: "function", name: "read_file" },
				{ type: "function", name: "web_search" },
				{ type: "web_search" },
			],
		};
		const snapshot = structuredClone(payload);
		rememberRequestContext(payload, identity, { excludeWebSearchTools: true });
		const live = transformWebSearchPayload({
			model, config: { enabled: true, models: [], defaultRoute: "standalone-alpha" }, payload,
		});

		expect(live.fatal).not.toBe(true);
		expect((live.payload as typeof payload).tools.map((tool) => tool.name)).toEqual(["web_run", "read_file"]);
		expect(getCompactionRequestExtras(identity)?.tools).toEqual([{ type: "function", name: "read_file" }]);
		expect(payload).toEqual(snapshot);
		// Filtering one standalone request must not latch into subsequent captures.
		rememberRequestContext(payload, identity);
		expect(getCompactionRequestExtras(identity)?.tools).toEqual(payload.tools);
	});
});
