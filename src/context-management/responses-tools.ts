/**
 * Convert Pi tool declarations into Responses-API wire tools.
 *
 * Pi 1.3 exports `convertResponsesTools` only from
 * `@earendil-works/pi-ai/api/openai-responses-shared`, but Pi's extension module
 * aliases map a fixed allowlist of specifiers and do not include that subpath.
 * Importing it from an extension therefore fails at load time with
 * "Cannot find module", which silently disables every hook the extension owns.
 *
 * This module reproduces that conversion without the subpath import. The strict
 * JSON-schema rewrite is a faithful port of Pi's `makeStrictJsonSchema`: it must
 * stay byte-identical, because a compaction request has to declare the same tool
 * schema as the live request it continues.
 */
import type { Tool } from "@earendil-works/pi-ai";

export type ResponsesWireTool =
	| { type: "function"; name: string; description: string; parameters: unknown; strict?: boolean | null }
	| { type: "custom"; name: string; description: string; format: { type: string; syntax: string; definition: string } };

export type ConvertResponsesToolsOptions = {
	/** Value applied when a tool does not opt in explicitly. `null` means no default. */
	strict?: boolean | null;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
};

type JsonSchema = Record<string, unknown>;

type ConstrainedSampling = {
	type: "json_schema" | "grammar";
	strict?: "require" | "prefer" | "ignore";
	variants?: { openai_lark?: string; openai_regex?: string };
};

/** Keywords the strict subset cannot express. Kept in sync with Pi's implementation. */
const UNSUPPORTED_STRICT_SCHEMA_KEYS = [
	"$ref",
	"$defs",
	"definitions",
	"allOf",
	"oneOf",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"unevaluatedProperties",
	"propertyNames",
	"contains",
	"prefixItems",
	"not",
	"if",
	"then",
	"else",
];

class UnsupportedStrictJsonSchemaError extends Error {}

function isJsonSchemaObject(value: unknown): value is JsonSchema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStructuredSchema(schema: unknown): boolean {
	if (!isJsonSchemaObject(schema)) return false;
	const types = typeof schema["type"] === "string"
		? [schema["type"]]
		: Array.isArray(schema["type"]) ? schema["type"] : [];
	return types.includes("object")
		|| types.includes("array")
		|| schema["properties"] !== undefined
		|| schema["items"] !== undefined;
}

function schemaAllowsNull(schema: unknown): boolean {
	if (!isJsonSchemaObject(schema)) return false;
	if (schema["type"] === "null" || (Array.isArray(schema["type"]) && schema["type"].includes("null"))) return true;
	if (schema["const"] === null || (Array.isArray(schema["enum"]) && schema["enum"].includes(null))) return true;
	return Array.isArray(schema["anyOf"]) && schema["anyOf"].some((variant) => schemaAllowsNull(variant));
}

function makeJsonSchemaNodeStrict(schema: unknown): void {	if (!isJsonSchemaObject(schema)) throw new UnsupportedStrictJsonSchemaError("boolean schemas are unsupported");
	for (const key of UNSUPPORTED_STRICT_SCHEMA_KEYS) {
		if (schema[key] !== undefined) throw new UnsupportedStrictJsonSchemaError(`${key} schemas are unsupported`);
	}
	if (schema["anyOf"] !== undefined) {
		if (!Array.isArray(schema["anyOf"]) || schema["anyOf"].length === 0) {
			throw new UnsupportedStrictJsonSchemaError("anyOf must contain at least one schema");
		}
		for (const variant of schema["anyOf"]) {
			if (isStructuredSchema(variant)) throw new UnsupportedStrictJsonSchemaError("object and array unions are unsupported");
			makeJsonSchemaNodeStrict(variant);
		}
	}
	if (schema["items"] !== undefined) {
		if (Array.isArray(schema["items"])) throw new UnsupportedStrictJsonSchemaError("tuple schemas are unsupported");
		makeJsonSchemaNodeStrict(schema["items"]);
	}
	const isObjectSchema = schema["type"] === "object";
	if (schema["properties"] !== undefined && !isObjectSchema) {
		throw new UnsupportedStrictJsonSchemaError("properties require type object");
	}
	if (!isObjectSchema) return;
	if (schema["additionalProperties"] !== undefined && schema["additionalProperties"] !== false) {
		throw new UnsupportedStrictJsonSchemaError("schema-valued or true additionalProperties is unsupported");
	}
	if (schema["properties"] !== undefined && !isJsonSchemaObject(schema["properties"])) {
		throw new UnsupportedStrictJsonSchemaError("object properties must be a schema map");
	}
	if (schema["required"] !== undefined
		&& (!Array.isArray(schema["required"]) || schema["required"].some((key) => typeof key !== "string"))) {
		throw new UnsupportedStrictJsonSchemaError("object required must be a string array");
	}
	const properties = isJsonSchemaObject(schema["properties"]) ? schema["properties"] : {};
	const propertyNames = Object.keys(properties);
	const required = new Set(Array.isArray(schema["required"]) ? schema["required"] as string[] : []);
	if ([...required].some((key) => !propertyNames.includes(key))) {
		throw new UnsupportedStrictJsonSchemaError("required contains an unknown property");
	}
	for (const [key, property] of Object.entries(properties)) {
		makeJsonSchemaNodeStrict(property);
		if (!required.has(key) && !schemaAllowsNull(property)) {
			properties[key] = { anyOf: [property, { type: "null" }] };
		}
	}
	schema["required"] = propertyNames;
	schema["additionalProperties"] = false;
}

/** Convert a tool schema to the strict subset expected by provider constrained sampling. */
function makeStrictJsonSchema(schema: unknown): unknown {
	const cloned = structuredClone(schema);
	if (!isJsonSchemaObject(cloned)) throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	makeJsonSchemaNodeStrict(cloned);
	if (cloned["type"] !== "object") throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	return cloned;
}

function constrainedSamplingOf(tool: Tool): ConstrainedSampling | undefined {	const value = (tool as { constrainedSampling?: unknown }).constrainedSampling;
	if (!value || typeof value !== "object") return undefined;
	const type = (value as { type?: unknown }).type;
	if (type !== "json_schema" && type !== "grammar") return undefined;
	return value as ConstrainedSampling;
}

/** Only `openai_lark` / `openai_regex` variants can be expressed on the Responses wire. */
function grammarOf(tool: Tool): { syntax: string; definition: string } | undefined {
	const sampling = constrainedSamplingOf(tool);
	if (sampling?.type !== "grammar") return undefined;
	const lark = sampling.variants?.openai_lark;
	const regex = sampling.variants?.openai_regex;
	const hasLark = typeof lark === "string" && lark.trim().length > 0;
	const hasRegex = typeof regex === "string" && regex.trim().length > 0;
	if (!hasLark && !hasRegex) {
		throw new Error(`Tool "${tool.name}" cannot use grammar constrained sampling: no supported grammar variant was provided.`);
	}
	return hasLark ? { syntax: "lark", definition: lark! } : { syntax: "regex", definition: regex! };
}

/** Whether the schema can be expressed in the strict subset at all. */
function isStrictExpressible(parameters: unknown): boolean {
	try {
		makeStrictJsonSchema(parameters);
		return true;
	} catch (error) {
		if (error instanceof UnsupportedStrictJsonSchemaError) return false;
		throw error;
	}
}

/** The reason `makeStrictJsonSchema` refused, for fail-closed error text. */
function strictUnsupportedReason(parameters: unknown): string {
	try {
		makeStrictJsonSchema(parameters);
		return "the schema is unsupported";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * Resolve the effective strict flag for one tool, mirroring Pi's
 * `resolveJsonSchemaStrictSampling` + `defaultStrict` composition.
 *
 * For any `json_schema` constrained sampling, Pi ignores the declared
 * `strict` mode when the schema is expressible: it simply returns `true`.
 * The mode only matters on the failure path, where `require` throws and
 * everything else falls back to the caller's default. Pi's `defaultStrict`
 * is `options.strict === undefined ? false : options.strict`, so an explicit
 * `null` is forwarded verbatim onto the wire.
 */
function strictFor(tool: Tool, options: ConvertResponsesToolsOptions): boolean | null {
	const supportsStrictMode = options.supportsStrictMode ?? true;
	const sampling = constrainedSamplingOf(tool);
	const fallback = options.strict === undefined ? false : options.strict;
	if (sampling?.type !== "json_schema") return fallback;
	if (supportsStrictMode) {
		if (isStrictExpressible(tool.parameters)) return true;
		if (sampling.strict === "require") {
			throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but ${strictUnsupportedReason(tool.parameters)}.`);
		}
		return fallback;
	}
	if (sampling.strict === "require") {
		throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`);
	}
	return fallback;
}

/** Mirror Pi's wire shape so compaction requests match ordinary Responses requests. */
export function convertResponsesTools(
	tools: readonly Tool[],
	options: ConvertResponsesToolsOptions = {},
): ResponsesWireTool[] {
	const supportsStrictMode = options.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = options.supportsOpenAIGrammarTools ?? false;
	return tools.map((tool) => {
		if (supportsOpenAIGrammarTools) {
			const grammar = grammarOf(tool);
			if (grammar) {
				return {
					type: "custom" as const,
					name: tool.name,
					description: tool.description,
					format: { type: "grammar", ...grammar },
				};
			}
		}
		const strict = strictFor(tool, options);
		const wire: ResponsesWireTool = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: strict === true ? makeStrictJsonSchema(tool.parameters) : tool.parameters,
		};
		// Pi writes `strict` whenever the transport supports it, including `false` and `null`.
		if (supportsStrictMode) wire.strict = strict;
		return wire;
	});
}
