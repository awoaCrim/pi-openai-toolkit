import { describe, expect, test } from "bun:test";
import { appendWebSearchPrompt, WEB_SEARCH_PROMPT_SECTION } from "./prompt";

const model = { provider: "newapi", api: "openai-responses", id: "gpt-5.5" };
const codexModel = { provider: "newapi", api: "openai-codex-responses", id: "gpt-5.5" };
const enabled = { enabled: true, models: ["newapi/gpt-5.5"] };

describe("appendWebSearchPrompt", () => {
	test("adds guidance exactly once for allowlisted supported turns", () => {
		const first = appendWebSearchPrompt({
			model,
			config: enabled,
			systemPrompt: "Base prompt",
		});
		const second = appendWebSearchPrompt({
			model,
			config: enabled,
			systemPrompt: first,
		});

		expect(first).toBe(`Base prompt\n\n${WEB_SEARCH_PROMPT_SECTION}`);
		expect(second).toBe(first);
		expect(first.match(/## Web Search/g)).toHaveLength(1);
	});

	test("adds guidance for allowlisted openai-codex-responses turns", () => {
		expect(
			appendWebSearchPrompt({
				model: codexModel,
				config: enabled,
				systemPrompt: "Base prompt",
			}),
		).toContain("## Web Search");
	});

	test("omits guidance when disabled, unlisted, or unsupported", () => {
		const base = "Base prompt";
		expect(
			appendWebSearchPrompt({
				model,
				config: { ...enabled, enabled: false },
				systemPrompt: base,
			}),
		).toBe(base);
		expect(
			appendWebSearchPrompt({
				model: { ...model, id: "gpt-5.6" },
				config: enabled,
				systemPrompt: base,
			}),
		).toBe(base);
		expect(
			appendWebSearchPrompt({
				model: { ...model, api: "anthropic-messages" },
				config: enabled,
				systemPrompt: base,
			}),
		).toBe(base);
	});
});
