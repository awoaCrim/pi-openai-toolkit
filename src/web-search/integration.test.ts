import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	clearRequestContextCache,
	getCompactionRequestExtras,
	rememberRequestContext,
} from "../request-context-cache";
import { rewritePayloadWithDeferredToolCarryover } from "../deferred-tool-carryover";
import { CACHE_STACK_ACTIVATION_ENTRY_TYPE } from "../types";
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

describe("Compaction and Web Search integration", () => {
	test("package extension order is compaction before Web Search", () => {
		const packageJson = JSON.parse(
			fs.readFileSync(path.resolve(import.meta.dir, "../..", "package.json"), "utf8"),
		) as { pi?: { extensions?: string[] } };

		expect(packageJson.pi?.extensions).toEqual([
			"./extensions/compaction.ts",
			"./extensions/web-search.ts",
			"./extensions/image-generation.ts",
			"./extensions/auto-mode.ts",
			"./extensions/codex-astra.ts",
		]);
		const extensions = packageJson.pi?.extensions ?? [];
		expect(extensions.indexOf("./extensions/compaction.ts")).toBeLessThan(
			extensions.indexOf("./extensions/web-search.ts"),
		);
		// Auto mode gates tool execution, so it must not sit between the two
		// provider-payload hooks whose relative order is semantic.
		expect(extensions.indexOf("./extensions/auto-mode.ts")).toBeGreaterThan(
			extensions.indexOf("./extensions/web-search.ts"),
		);
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
});
