import { describe, expect, test } from "bun:test";
import { transformWebSearchPayload } from "./payload";
import { WEB_SEARCH_SOURCE_INCLUDE } from "./types";

const enabled = { enabled: true, apis: ["openai-responses"] };

describe("transformWebSearchPayload", () => {
	test("leaves disabled and unsupported requests unchanged", () => {
		const payload = { model: "gpt-5.5", input: [] };

		expect(
			transformWebSearchPayload({ api: "openai-responses", config: { ...enabled, enabled: false }, payload }),
		).toEqual({ payload, outcome: "disabled", changed: false });
		expect(
			transformWebSearchPayload({ api: "openai-codex-responses", config: enabled, payload }),
		).toEqual({ payload, outcome: "unsupported-api", changed: false });
	});

	test("injects one native tool and source include without mutating the input", () => {
		const existingTool = { type: "function", name: "read_docs", parameters: { type: "object" } };
		const payload = {
			model: "gpt-5.5",
			input: [],
			tools: [existingTool],
			include: ["reasoning.encrypted_content"],
		};
		const snapshot = structuredClone(payload);

		const transformed = transformWebSearchPayload({ api: "openai-responses", config: enabled, payload });

		expect(transformed.outcome).toBe("injected-native-tool");
		expect(transformed.changed).toBe(true);
		expect(transformed.payload).toEqual({
			...payload,
			tools: [existingTool, { type: "web_search" }],
			include: ["reasoning.encrypted_content", WEB_SEARCH_SOURCE_INCLUDE],
		});
		expect(payload).toEqual(snapshot);
		expect((transformed.payload as typeof payload).tools).not.toBe(payload.tools);
		expect((transformed.payload as typeof payload).include).not.toBe(payload.include);
	});

	test("is idempotent after native injection", () => {
		const first = transformWebSearchPayload({
			api: "openai-responses",
			config: enabled,
			payload: { model: "gpt-5.5", input: [] },
		});
		const second = transformWebSearchPayload({
			api: "openai-responses",
			config: enabled,
			payload: first.payload,
		});

		expect(second).toEqual({
			payload: first.payload,
			outcome: "existing-native-tool",
			changed: false,
		});
	});

	test("preserves an existing preview tool and only adds source metadata", () => {
		const preview = { type: "web_search_preview", search_context_size: "high" };
		const payload = { model: "gpt-5.5", input: [], tools: [preview] };
		const transformed = transformWebSearchPayload({ api: "openai-responses", config: enabled, payload });

		expect(transformed.outcome).toBe("existing-native-tool");
		expect(transformed.changed).toBe(true);
		expect(transformed.payload).toEqual({
			...payload,
			include: [WEB_SEARCH_SOURCE_INCLUDE],
		});
		expect((transformed.payload as typeof payload & { include: string[] }).tools).toBe(payload.tools);
	});

	test("normalizes duplicate native tools and source include values to one", () => {
		const preview = { type: "web_search_preview", search_context_size: "low" };
		const payload = {
			model: "gpt-5.5",
			input: [],
			tools: [preview, { type: "web_search" }, { type: "function", name: "read_file" }],
			include: [WEB_SEARCH_SOURCE_INCLUDE, "reasoning.encrypted_content", WEB_SEARCH_SOURCE_INCLUDE],
		};
		const transformed = transformWebSearchPayload({ api: "openai-responses", config: enabled, payload });

		expect(transformed.outcome).toBe("existing-native-tool");
		expect(transformed.changed).toBe(true);
		expect((transformed.payload as typeof payload).tools).toEqual([
			preview,
			{ type: "function", name: "read_file" },
		]);
		expect((transformed.payload as typeof payload).include).toEqual([
			WEB_SEARCH_SOURCE_INCLUDE,
			"reasoning.encrypted_content",
		]);
	});

	test("local function web_search wins and the payload remains untouched", () => {
		const payload = {
			model: "gpt-5.5",
			input: [],
			tools: [{ type: "function", name: "web_search", parameters: { type: "object" } }],
		};
		const transformed = transformWebSearchPayload({ api: "openai-responses", config: enabled, payload });

		expect(transformed).toEqual({
			payload,
			outcome: "local-function-conflict",
			changed: false,
		});
	});

	test("does not destructively replace invalid tools or include values", () => {
		const invalidTools = { model: "gpt-5.5", input: [], tools: "invalid" };
		const invalidInclude = { model: "gpt-5.5", input: [], include: "invalid" };

		expect(
			transformWebSearchPayload({ api: "openai-responses", config: enabled, payload: invalidTools }),
		).toEqual({ payload: invalidTools, outcome: "invalid-tools", changed: false });
		expect(
			transformWebSearchPayload({ api: "openai-responses", config: enabled, payload: invalidInclude }),
		).toEqual({ payload: invalidInclude, outcome: "invalid-include", changed: false });
	});
});
