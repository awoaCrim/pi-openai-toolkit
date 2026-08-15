import { describe, expect, test } from "bun:test";
import { appendWebSearchPrompt, WEB_SEARCH_PROMPT_SECTION } from "./prompt";

const enabled = { enabled: true, apis: ["openai-responses"] };

describe("appendWebSearchPrompt", () => {
	test("adds guidance exactly once for supported turns", () => {
		const first = appendWebSearchPrompt({
			api: "openai-responses",
			config: enabled,
			systemPrompt: "Base prompt",
			activeToolNames: [],
		});
		const second = appendWebSearchPrompt({
			api: "openai-responses",
			config: enabled,
			systemPrompt: first,
			activeToolNames: [],
		});

		expect(first).toBe(`Base prompt\n\n${WEB_SEARCH_PROMPT_SECTION}`);
		expect(second).toBe(first);
		expect(first.match(/## Web Search/g)).toHaveLength(1);
	});

	test("omits guidance when disabled, unsupported, or a local conflict is active", () => {
		const base = "Base prompt";
		expect(
			appendWebSearchPrompt({
				api: "openai-responses",
				config: { ...enabled, enabled: false },
				systemPrompt: base,
				activeToolNames: [],
			}),
		).toBe(base);
		expect(
			appendWebSearchPrompt({
				api: "openai-codex-responses",
				config: enabled,
				systemPrompt: base,
				activeToolNames: [],
			}),
		).toBe(base);
		expect(
			appendWebSearchPrompt({
				api: "openai-responses",
				config: enabled,
				systemPrompt: base,
				activeToolNames: ["read", "web_search"],
			}),
		).toBe(base);
	});
});
