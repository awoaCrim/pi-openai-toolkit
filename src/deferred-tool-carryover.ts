import type { ResponsesCompatibleRequestPayload } from "./runtime";
import { isDeferredToolCarryover, type DeferredToolCarryoverV1 } from "./types";

type JsonObject = Record<string, unknown>;

type DeferredToolCompat = {
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
};

export type DeferredToolCarryoverMode = "additional-tools" | "tool-search";

export type DeferredToolCarryoverRewrite = {
	payload: ResponsesCompatibleRequestPayload;
	changed: boolean;
	mode?: DeferredToolCarryoverMode;
	movedToolNames: string[];
};

function isRecord(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function getDeferredToolName(value: unknown): string | undefined {
	if (!isRecord(value) || (value.type !== "function" && value.type !== "custom")) {
		return undefined;
	}

	return typeof value.name === "string" && value.name.trim().length > 0 ? value.name : undefined;
}

function hasOptionalBooleanField(value: JsonObject, field: string): boolean {
	return value[field] === undefined || typeof value[field] === "boolean";
}

function hasOptionalBooleanOrNullField(value: JsonObject, field: string): boolean {
	return value[field] === undefined || value[field] === null || typeof value[field] === "boolean";
}

function isCustomToolFormat(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.type === "text") return true;
	return (
		value.type === "grammar" &&
		(value.syntax === "lark" || value.syntax === "regex") &&
		typeof value.definition === "string"
	);
}

/** Validate only the provider-facing function/custom shapes emitted by official Pi. */
function isDeferredToolSchema(value: unknown): value is JsonObject {
	const name = getDeferredToolName(value);
	if (!name || !isRecord(value)) return false;

	if (value.type === "function") {
		return (
			"parameters" in value &&
			(value.parameters === null || isRecord(value.parameters)) &&
			hasOptionalBooleanOrNullField(value, "strict") &&
			hasOptionalBooleanField(value, "defer_loading") &&
			(value.description === undefined || value.description === null || typeof value.description === "string")
		);
	}

	return (
		hasOptionalBooleanField(value, "defer_loading") &&
		(value.description === undefined || typeof value.description === "string") &&
		(value.format === undefined || isCustomToolFormat(value.format))
	);
}

function addLoadedToolSchemas(tools: unknown, loaded: Set<string>): boolean {
	if (!Array.isArray(tools)) return false;
	for (const tool of tools) {
		const name = getDeferredToolName(tool);
		if (!name || !isDeferredToolSchema(tool)) return false;
		loaded.add(name);
	}
	return true;
}

function isCompletedClientToolSearchCall(value: JsonObject): value is JsonObject & { call_id: string } {
	if (
		value.type !== "tool_search_call" ||
		typeof value.call_id !== "string" ||
		value.call_id.length === 0 ||
		value.execution !== "client" ||
		value.status !== "completed" ||
		!isRecord(value.arguments)
	) {
		return false;
	}

	return (
		typeof value.arguments.query === "string" &&
		typeof value.arguments.limit === "number" &&
		Number.isInteger(value.arguments.limit) &&
		value.arguments.limit >= 0
	);
}

function collectLoadedToolNames(input: readonly unknown[], startIndex: number): Set<string> | undefined {
	const loaded = new Set<string>();

	for (let index = startIndex; index < input.length; index += 1) {
		const item = input[index];
		if (!isRecord(item)) continue;

		if (item.type === "additional_tools") {
			if (item.role !== "developer" || !addLoadedToolSchemas(item.tools, loaded)) return undefined;
			continue;
		}

		if (item.type === "tool_search_call") {
			if (!isCompletedClientToolSearchCall(item)) return undefined;
			const output = input[index + 1];
			if (
				!isRecord(output) ||
				output.type !== "tool_search_output" ||
				output.call_id !== item.call_id ||
				output.execution !== "client" ||
				output.status !== "completed" ||
				!addLoadedToolSchemas(output.tools, loaded)
			) {
				return undefined;
			}
			index += 1;
			continue;
		}

		if (item.type === "tool_search_output") return undefined;
	}

	return loaded;
}

function createToolSearchCallId(compactionEntryId: string, names: readonly string[]): string {
	let hash = 2166136261;
	for (const value of `${compactionEntryId}\u0000${names.join("\u0000")}`) {
		hash ^= value.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return `pi_tool_load_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function cloneTool(value: JsonObject): JsonObject | undefined {
	try {
		return structuredClone(value);
	} catch {
		return undefined;
	}
}

function selectMode(compat: DeferredToolCompat | undefined): DeferredToolCarryoverMode | undefined {
	if (compat?.supportsAdditionalTools === true) return "additional-tools";
	if (compat?.supportsToolSearch === true) return "tool-search";
	return undefined;
}

function createLoadPoint(
	mode: DeferredToolCarryoverMode,
	compactionEntryId: string,
	schemas: readonly JsonObject[],
): JsonObject[] | undefined {
	const clonedSchemas: JsonObject[] = [];
	for (const schema of schemas) {
		const clone = cloneTool(schema);
		if (!clone) return undefined;
		if (mode === "tool-search") clone.defer_loading = true;
		clonedSchemas.push(clone);
	}

	if (mode === "additional-tools") {
		return [{ type: "additional_tools", role: "developer", tools: clonedSchemas }];
	}

	const names = clonedSchemas.map((schema) => getDeferredToolName(schema));
	if (names.some((name): name is undefined => name === undefined)) return undefined;
	const callId = createToolSearchCallId(compactionEntryId, names as string[]);
	return [
		{
			type: "tool_search_call",
			call_id: callId,
			execution: "client",
			status: "completed",
			arguments: { query: (names as string[]).join(" "), limit: names.length },
		},
		{
			type: "tool_search_output",
			call_id: callId,
			execution: "client",
			status: "completed",
			tools: clonedSchemas,
		},
	];
}

/**
 * Restore cache-stack's activated function/custom schemas after an opaque
 * compaction checkpoint. This is deliberately fail-open: malformed state or
 * payloads leave the provider request untouched so Pi keeps its immediate-tool
 * fallback behavior.
 */
export function rewritePayloadWithDeferredToolCarryover(args: {
	payload: ResponsesCompatibleRequestPayload;
	carryover?: DeferredToolCarryoverV1;
	compactionEntryId: string;
	checkpointEndIndex: number;
	compat?: DeferredToolCompat;
}): DeferredToolCarryoverRewrite {
	const unchanged: DeferredToolCarryoverRewrite = {
		payload: args.payload,
		changed: false,
		movedToolNames: [],
	};

	const mode = selectMode(args.compat);
	if (!mode || !args.carryover || !isDeferredToolCarryover(args.carryover) || !Array.isArray(args.payload.input)) {
		return unchanged;
	}
	if (!Number.isInteger(args.checkpointEndIndex) || args.checkpointEndIndex < 0 || args.checkpointEndIndex > args.payload.input.length) {
		return unchanged;
	}
	if (!Array.isArray(args.payload.tools)) return unchanged;

	const carryoverNames = new Set(
		args.carryover.toolNames
			.map((name) => name.trim())
			.filter((name) => name.length > 0 && name !== "web_search"),
	);
	if (carryoverNames.size === 0) return unchanged;

	const schemasByName = new Map<string, JsonObject>();
	const duplicateNames = new Set<string>();
	for (const tool of args.payload.tools) {
		const name = getDeferredToolName(tool);
		if (!name || !carryoverNames.has(name)) continue;
		if (!isDeferredToolSchema(tool)) return unchanged;
		const schema = tool;
		if (schemasByName.has(name)) {
			duplicateNames.add(name);
			continue;
		}
		schemasByName.set(name, schema);
	}
	for (const name of duplicateNames) schemasByName.delete(name);
	if (schemasByName.size === 0) return unchanged;

	const loadedNames = collectLoadedToolNames(args.payload.input, args.checkpointEndIndex);
	if (!loadedNames) return unchanged;
	const matchingNames = [...schemasByName.keys()];
	const movedNames = matchingNames.filter((name) => !loadedNames.has(name));
	const matchingNameSet = new Set(matchingNames);
	const nextTools = args.payload.tools.filter((tool) => {
		const name = getDeferredToolName(tool);
		return !name || !matchingNameSet.has(name);
	});
	const toolsChanged = nextTools.length !== args.payload.tools.length;
	if (movedNames.length === 0 && !toolsChanged) return unchanged;

	const nextInput = [...args.payload.input];
	if (movedNames.length > 0) {
		const schemas = movedNames.map((name) => schemasByName.get(name));
		if (schemas.some((schema): schema is undefined => schema === undefined)) return unchanged;
		const loadPoint = createLoadPoint(mode, args.compactionEntryId, schemas as JsonObject[]);
		if (!loadPoint) return unchanged;
		nextInput.splice(args.checkpointEndIndex, 0, ...loadPoint);
	}

	return {
		payload: {
			...args.payload,
			tools: nextTools,
			input: nextInput,
		},
		changed: true,
		mode,
		movedToolNames: movedNames,
	};
}
