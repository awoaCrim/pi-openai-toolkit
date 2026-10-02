import { expect, test } from "bun:test";
import {
	CONTEXT_MANAGEMENT_TOOL_NAMES,
	ensureContextManagementToolsInAllowlist,
} from "./tool-contract";

test("the launcher contract has one stable set of four context tools", () => {
	expect(CONTEXT_MANAGEMENT_TOOL_NAMES).toEqual([
		"new_context",
		"get_context_remaining",
		"history",
		"notes",
	]);
});

test("eligible allowlists receive context tools without duplicates", () => {
	expect(ensureContextManagementToolsInAllowlist({ tools: ["read", "history"] }, true)).toEqual([
		"read",
		"history",
		"new_context",
		"get_context_remaining",
		"notes",
	]);
});

test("no-tools remains an explicit opt-out", () => {
	expect(ensureContextManagementToolsInAllowlist({ noTools: "all", tools: [] }, true)).toEqual([]);
	expect(ensureContextManagementToolsInAllowlist({ noTools: "builtin" }, true)).toBeUndefined();
});

test("explicit exclusions are never re-added", () => {
	expect(ensureContextManagementToolsInAllowlist({
		tools: ["read"],
		excludeTools: ["history", "notes"],
	}, true)).toEqual([
		"read",
		"new_context",
		"get_context_remaining",
	]);
});

test("non-eligible models keep the caller selection unchanged", () => {
	expect(ensureContextManagementToolsInAllowlist({ tools: ["read", "bash"] }, false)).toEqual(["read", "bash"]);
	expect(ensureContextManagementToolsInAllowlist({}, false)).toBeUndefined();
});

test("an omitted allowlist keeps Pi's default selection policy", () => {
	expect(ensureContextManagementToolsInAllowlist({ excludeTools: ["history"] }, true)).toBeUndefined();
});
