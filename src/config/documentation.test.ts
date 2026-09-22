import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { createPolicyDefaults } from "./policy";
import { resolveV2Config } from "./v2";

const root = new URL("../../", import.meta.url);
function read(name: string): string { return fs.readFileSync(new URL(name, root), "utf8"); }
function examples(name: string): Record<string, unknown>[] {
	return [...read(name).matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((match) => JSON.parse(match[1]));
}

test("bilingual README examples stay aligned and all documented v2 examples resolve", () => {
	expect(examples("README.zh.md")).toEqual(examples("README.md"));
	for (const file of ["README.md", "README.zh.md", "docs/configuration.md"]) {
		for (const raw of examples(file)) {
			if (raw.schemaVersion !== 2) continue; // The one Pi models.json example has separate ownership.
			for (const key of [undefined, ...Object.keys((raw.models ?? {}) as object)]) {
				expect(resolveV2Config(raw, key).issues).toEqual([]);
			}
		}
	}
});

test("editor schema covers every effective field and its built-in value", () => {
	const schema = JSON.parse(read("config.schema.json"));
	const policy = createPolicyDefaults();
	const inspect = (value: unknown, node: any): void => {
		if (node.$ref) return inspect(value, schema.$defs[node.$ref.split("/").at(-1)]);
		if (node.anyOf) {
			expect(value === null || typeof value === "string").toBe(true);
			return;
		}
		if (node.enum) expect(node.enum).toContain(value);
		if (typeof value === "number") {
			expect(value).toBeGreaterThanOrEqual(node.minimum);
			expect(value).toBeLessThanOrEqual(node.maximum);
		}
		if (Array.isArray(value)) {
			for (const item of value) inspect(item, node.items);
		} else if (value && typeof value === "object") {
			expect(Object.keys(node.properties).sort()).toEqual(Object.keys(value).sort());
			expect(node.additionalProperties).toBe(false);
			for (const [key, child] of Object.entries(value)) inspect(child, node.properties[key]);
		}
	};
	for (const [feature, value] of Object.entries(policy)) inspect(value, schema.$defs[feature]);
});

test("package includes configuration runtime/schema/reference but no test helpers", () => {
	const files: string[] = JSON.parse(read("package.json")).files;
	for (const file of ["src/config.ts", "src/config-command.ts", "config.schema.json", "docs/configuration.md",
		...['legacy', 'v2', 'policy', 'migration', 'notifications'].map((name) => `src/config/${name}.ts`)]) {
		expect(files).toContain(file);
	}
	expect(files.some((file) => file.includes(".test.") || file.includes("test-helpers"))).toBe(false);
});
