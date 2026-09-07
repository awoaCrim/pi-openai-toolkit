import { expect, test } from "bun:test";
import { routeContextNamespaceToolMessage } from "./namespace-tools";

test("routes Codex namespace calls to the registered history tool before execution", () => {
	const message = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call-1|item-1",
				name: "list_windows",
				namespace: "history",
				arguments: { limit: 3 },
			},
		],
	} as never;

	const routed = routeContextNamespaceToolMessage(message) as never as {
		content: Array<{ name: string; namespace?: string; arguments: Record<string, unknown> }>;
	};

	expect(routed).not.toBe(message);
	expect(routed.content[0]).toEqual({
		type: "toolCall",
		id: "call-1|item-1",
		name: "history",
		namespace: "history",
		arguments: { action: "list_windows", limit: 3 },
	});
});

test("leaves ordinary assistant messages unchanged", () => {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
	} as never;

	expect(routeContextNamespaceToolMessage(message)).toBe(message);
});
