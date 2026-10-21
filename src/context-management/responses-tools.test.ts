import { describe, expect, test } from "bun:test";
import { convertResponsesTools } from "./responses-tools";

type ToolLike = Parameters<typeof convertResponsesTools>[0][number];

function tool(overrides: Partial<ToolLike> = {}): ToolLike {
	return {
		name: "demo",
		description: "A demo tool",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		...overrides,
	} as ToolLike;
}

const READ_SCHEMA = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path to the file to read" },
		limit: { type: "number", description: "Max lines" },
	},
	required: ["path"],
	additionalProperties: false,
};

describe("convertResponsesTools", () => {
	// Pi's openai-responses transport calls this without `strict`, so the default is false.
	test("a plain tool keeps its schema verbatim and reports strict: false", () => {
		const [wire] = convertResponsesTools([tool({ parameters: READ_SCHEMA })]);
		expect(wire).toEqual({
			type: "function",
			name: "demo",
			description: "A demo tool",
			parameters: READ_SCHEMA,
			strict: false,
		});
	});

	test("an explicit strict default rewrites the schema into the strict subset", () => {
		const [wire] = convertResponsesTools([tool({ parameters: READ_SCHEMA })], { strict: true });
		expect(wire).toMatchObject({ type: "function", strict: true });
		const parameters = (wire as { parameters: Record<string, unknown> }).parameters;
		// Strict mode forces every property required and allows null for optional ones.
		expect(parameters["required"]).toEqual(["path", "limit"]);
		expect(parameters["additionalProperties"]).toBe(false);
		const properties = parameters["properties"] as Record<string, Record<string, unknown>>;
		expect(properties["path"]).toEqual(READ_SCHEMA.properties.path);
		expect(properties["limit"]).toEqual({ anyOf: [READ_SCHEMA.properties.limit, { type: "null" }] });
	});

	test("strict: null is forwarded verbatim so the Codex backend decides", () => {
		const [wire] = convertResponsesTools([tool({ parameters: READ_SCHEMA })], { strict: null });
		expect(wire).toMatchObject({ strict: null, parameters: READ_SCHEMA });
	});

	test("drops the strict field entirely when the transport does not support it", () => {
		const [wire] = convertResponsesTools([tool({ parameters: READ_SCHEMA })], { supportsStrictMode: false });
		expect(wire).not.toHaveProperty("strict");
		expect(wire).toMatchObject({ parameters: READ_SCHEMA });
	});

	test("a tool requiring strict JSON-schema sampling forces strict on", () => {
		const [wire] = convertResponsesTools([
			tool({ parameters: READ_SCHEMA, constrainedSampling: { type: "json_schema", strict: "require" } } as Partial<ToolLike>),
		]);
		expect(wire).toMatchObject({ strict: true });
	});

	test("a tool requiring strict sampling fails closed without strict support", () => {
		expect(() =>
			convertResponsesTools(
				[tool({ constrainedSampling: { type: "json_schema", strict: "require" } } as Partial<ToolLike>)],
				{ supportsStrictMode: false },
			),
		).toThrow(/requires JSON-schema constrained sampling/);
	});

	test("json_schema sampling turns strict on whenever the schema is expressible", () => {
		const ignoring = tool({
			parameters: READ_SCHEMA,
			constrainedSampling: { type: "json_schema", strict: "ignore" },
		} as Partial<ToolLike>);
		// Pi ignores the declared mode on the success path: it returns true for every mode.
		for (const strict of [undefined, true, false] as const) {
			const [wire] = convertResponsesTools([ignoring], strict === undefined ? {} : { strict });
			expect(wire).toMatchObject({ strict: true });
		}
	});

	test("an inexpressible schema falls back to the caller default unless it is required", () => {
		const inexpressible = tool({
			parameters: { type: "object", properties: {}, $ref: "#/x" },
			constrainedSampling: { type: "json_schema", strict: "prefer" },
		} as Partial<ToolLike>);
		const [wire] = convertResponsesTools([inexpressible], { strict: null });
		expect(wire).toMatchObject({ strict: null });
		const required = tool({
			parameters: { type: "object", properties: {}, $ref: "#/x" },
			constrainedSampling: { type: "json_schema", strict: "require" },
		} as Partial<ToolLike>);
		expect(() => convertResponsesTools([required])).toThrow(/requires JSON-schema constrained sampling/);
	});

	test("grammar tools become custom tools only when the transport supports them", () => {
		const grammarTool = tool({
			constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /a+/" } },
		} as Partial<ToolLike>);
		const [supported] = convertResponsesTools([grammarTool], { supportsOpenAIGrammarTools: true });
		expect(supported).toEqual({
			type: "custom",
			name: "demo",
			description: "A demo tool",
			format: { type: "grammar", syntax: "lark", definition: "start: /a+/" },
		});
		const [unsupported] = convertResponsesTools([grammarTool], { supportsOpenAIGrammarTools: false });
		expect(unsupported).toMatchObject({ type: "function" });
	});

	test("a grammar tool without a supported variant fails closed", () => {
		expect(() =>
			convertResponsesTools(
				[tool({ constrainedSampling: { type: "grammar", variants: {} } } as Partial<ToolLike>)],
				{ supportsOpenAIGrammarTools: true },
			),
		).toThrow(/no supported grammar variant/);
	});

	test("rejects schemas the strict subset cannot express", () => {
		expect(() =>
			convertResponsesTools([tool({ parameters: { type: "object", properties: {}, anyOf: [] } })], { strict: true }),
		).toThrow(/anyOf must contain at least one schema/);
		expect(() =>
			convertResponsesTools([tool({ parameters: { type: "object", properties: {}, $ref: "#/x" } })], { strict: true }),
		).toThrow(/\$ref schemas are unsupported/);
	});

	test("preserves declaration order and count", () => {
		const wire = convertResponsesTools([
			tool({ name: "a" }),
			tool({ name: "b" }),
			tool({ name: "c" }),
		]);
		expect(wire.map((entry) => entry.name)).toEqual(["a", "b", "c"]);
	});
});
