import { describe, expect, test } from "bun:test";
import type { Message, Model } from "@earendil-works/pi-ai";
import { serializeMessagesToResponsesInput } from "./serializer";

const model: Model<"openai-responses"> = {
	provider: "openai", api: "openai-responses", id: "gpt-6-astra", name: "GPT-6 Astra",
	baseUrl: "https://offline.invalid/v1", reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
};
const calls = [
	{ type: "toolCall" as const, id: "call_a|fc_a", name: "read", arguments: { path: "a" } },
	{ type: "toolCall" as const, id: "call_b|fc_b", name: "read", arguments: { path: "b" } },
];
function assistant(stopReason: "toolUse" | "error" | "aborted" = "toolUse"): Message {
	return {
		role: "assistant", provider: model.provider, api: model.api, model: model.id,
		content: structuredClone(calls), stopReason, timestamp: 1,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
function result(index: number): Message {
	return { role: "toolResult", toolCallId: calls[index].id, toolName: "read", isError: false,
		content: [{ type: "text", text: `real-${index}` }], timestamp: 2 + index };
}

describe("Responses trailing tool pairing", () => {
	for (const completed of [0, 1, 2]) {
		test(`completes a trailing batch with ${completed} real results without mutating history`, () => {
			const messages = [assistant(), ...Array.from({ length: completed }, (_, index) => result(index))];
			const before = structuredClone(messages);
			const input = serializeMessagesToResponsesInput(model, messages);
			const outputs = input.filter((item) => item.type === "function_call_output");
			expect(outputs).toHaveLength(2);
			for (let index = 0; index < calls.length; index++) {
				expect(outputs[index]).toMatchObject({ type: "function_call_output", call_id: `call_${index === 0 ? "a" : "b"}` });
				expect(JSON.stringify(outputs[index].output)).toContain(index < completed ? `real-${index}` : "No result provided");
			}
			expect(input.filter((item) => item.type === "function_call").map((item) => item.call_id)).toEqual(["call_a", "call_b"]);
			expect(messages).toEqual(before);
		});
	}
	test("leaves empty/text-only histories alone and skips failed assistant calls", () => {
		expect(serializeMessagesToResponsesInput(model, [])).toEqual([]);
		for (const messages of [
			[{ role: "user", content: "hello", timestamp: 1 } as Message],
			[assistant("error")], [assistant("aborted")],
		]) {
			expect(serializeMessagesToResponsesInput(model, messages).some((item) => item.type === "function_call_output")).toBe(false);
		}
	});
});
