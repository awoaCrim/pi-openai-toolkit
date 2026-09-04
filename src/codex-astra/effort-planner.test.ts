import { describe, expect, test } from "bun:test";
import { createEffortControlState, getEffortControlState, planStableEffort } from "./effort-planner";

function user(text: string) {
	return { role: "user", content: [{ type: "input_text", text }] };
}

function assistant(text: string, id?: string) {
	return { type: "message", role: "assistant", content: [{ type: "output_text", text }], status: "completed", ...(id ? { id } : {}) };
}

function toolResult(callId: string) {
	return { type: "function_call_output", call_id: callId, output: "ok" };
}

describe("planStableEffort", () => {
	test("first request baselines without splicing", () => {
		const state = createEffortControlState();
		const input = [user("hello")];
		const { input: next, result } = planStableEffort(state, input, "medium");

		expect(result.effort).toBe("medium");
		expect(result.spliced).toBe(0);
		expect(next).toEqual(input);
	});

	test("unchanged effort sends nothing new", () => {
		const state = createEffortControlState();
		planStableEffort(state, [user("a")], "high");
		const { input, result } = planStableEffort(state, [user("a"), assistant("x"), user("b")], "high");

		expect(result.effort).toBe("high");
		expect(result.spliced).toBe(0);
		expect(input.some((item) => item.type === "configuration_update")).toBe(false);
	});

	test("changed effort pins request level and splices one item at the tail", () => {
		const state = createEffortControlState();
		planStableEffort(state, [user("a")], "low");

		const history = [user("a"), assistant("x"), user("b")];
		const { input, result } = planStableEffort(state, history, "max");

		expect(result.effort).toBe("low");
		// The update takes effect on the trailing user turn, so it sits before it.
		expect(input[2]).toEqual({ type: "configuration_update", reasoning: { effort: "max" } });
		expect(input[3]).toEqual(user("b"));
		expect(result.spliced).toBe(1);
	});

	test("later requests replay the same item at the same position", () => {
		const state = createEffortControlState();
		planStableEffort(state, [user("a")], "low");
		planStableEffort(state, [user("a"), assistant("x"), user("b")], "max");

		const grown = [user("a"), assistant("x"), user("b"), assistant("y"), user("c")];
		const { input, result } = planStableEffort(state, grown, "max");

		expect(result.effort).toBe("low");
		expect(input[2]).toEqual({ type: "configuration_update", reasoning: { effort: "max" } });
		expect(input[3]).toEqual(user("b"));
		// No duplicate item is injected for the same transition.
		expect(input.filter((item) => item.type === "configuration_update")).toHaveLength(1);
	});

	test("a second change adds a second item and the baseline stays pinned", () => {
		const state = createEffortControlState();
		planStableEffort(state, [user("a")], "low");
		planStableEffort(state, [user("a"), user("b")], "high");
		const { input, result } = planStableEffort(state, [user("a"), user("b"), user("c")], "low");

		// Both transitions are carried as items; the request level never moves
		// off the baseline. Only a change back to the effort already in force at
		// that position would collapse instead of splicing.
		expect(result.effort).toBe("low");
		const updates = input.filter((item) => item.type === "configuration_update");
		expect(updates).toEqual([
			{ type: "configuration_update", reasoning: { effort: "high" } },
			{ type: "configuration_update", reasoning: { effort: "low" } },
		]);
		// Items never sit adjacent: each is separated by at least one turn.
		expect(input.indexOf(updates[0]!) + 1).not.toBe(input.indexOf(updates[1]!));
	});

	test("mid-tool-loop change splices after the latest tool result", () => {
		const state = createEffortControlState();
		planStableEffort(state, [user("a")], "low");

		const inLoop = [user("a"), assistant("thinking"), toolResult("call_1")];
		const { input } = planStableEffort(state, inLoop, "xhigh");
		expect(input[input.length - 1]).toEqual({ type: "configuration_update", reasoning: { effort: "xhigh" } });
		expect(input).toHaveLength(4);
	});

	test("rewritten or shrunk history resets the baseline instead of misplacing items", () => {
		const state = createEffortControlState();
		planStableEffort(state, [user("a")], "low");
		planStableEffort(state, [user("a"), user("b")], "max");

		// Compaction replaced the history: the anchor under transition index 1
		// no longer matches, so state resets and this request re-baselines.
		const compacted = [user("summarized context"), user("c")];
		const { input, result } = planStableEffort(state, compacted, "medium");

		expect(result.effort).toBe("medium");
		expect(result.spliced).toBe(0);
		expect(input).toEqual(compacted);
	});

	test("output-only lifecycle fields do not break anchors", () => {
		const state = createEffortControlState();
		// Live item with id/status becomes sanitized replay without them:
		// the anchor must treat both spellings as the same item.
		planStableEffort(state, [user("a"), assistant("x", "resp_1")], "low");
		const { input, result } = planStableEffort(state, [user("a"), assistant("x"), user("b")], "max");

		expect(result.spliced).toBe(1);
		expect(input[2]).toEqual({ type: "configuration_update", reasoning: { effort: "max" } });
	});

	test("planner input is never mutated in place", () => {
		const state = createEffortControlState();
		planStableEffort(state, [user("a")], "low");
		const history = [user("a"), user("b")];
		planStableEffort(state, history, "high");
		expect(history).toHaveLength(2);
	});
});

describe("getEffortControlState", () => {
	test("keys are isolated and the map stays bounded with LRU eviction", () => {
		const states = new Map<string, ReturnType<typeof createEffortControlState>>();
		const first = getEffortControlState(states, "a");
		first.baseEffort = "low";
		expect(getEffortControlState(states, "b")).not.toBe(first);
		expect(getEffortControlState(states, "a")).toBe(first);

		for (let i = 0; i < 15; i++) {
			getEffortControlState(states, `fill-${i}`);
		}
		expect(states.size).toBe(16);
		// "a" was refreshed to the newest slot before the fill, so only "b"
		// (the oldest) is evicted by the fifteenth insertion.
		expect(states.has("a")).toBe(true);
		expect(states.has("b")).toBe(false);
	});
});
