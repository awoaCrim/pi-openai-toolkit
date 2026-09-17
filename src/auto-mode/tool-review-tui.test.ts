import { describe, expect, test } from "bun:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatToolReviewLine,
	installToolReviewRenderer,
	type ToolReviewDisplayState,
} from "./tool-review-tui";

class FakeToolExecutionComponent {
	toolCallId: string;

	constructor(toolCallId: string) {
		this.toolCallId = toolCallId;
	}

	render(_width: number): string[] {
		return ["tool call", "tool output"];
	}
}

describe("tool review TUI renderer", () => {
	test("patches Pi's exported tool component without replacing its normal output", () => {
		initTheme();
		const bridge = installToolReviewRenderer();
		bridge.clear();
		bridge.setState("pi-call", { phase: "reviewing", toolName: "bash" });

		const component = new ToolExecutionComponent(
			"bash",
			"pi-call",
			{ command: "echo hi" },
			{},
			undefined,
			{ requestRender: () => undefined },
			process.cwd(),
		);
		const lines = component.render(50);

		expect(bridge.supported).toBe(true);
		expect(lines.join("\n")).toContain("echo hi");
		expect(lines.at(-1)).toContain("reviewing bash");
	});

	test("appends a bounded reviewing line to the tool block", () => {
		const bridge = installToolReviewRenderer(FakeToolExecutionComponent);
		bridge.clear();
		bridge.setState("call-1", { phase: "reviewing", toolName: "bash" });

		const lines = new FakeToolExecutionComponent("call-1").render(48);
		expect(lines).toHaveLength(3);
		expect(lines.at(-1)).toContain("reviewing bash");
		expect(visibleWidth(lines.at(-1)!)).toBe(48);
	});

	test("renders final decisions and truncates untrusted detail to one line", () => {
		const states: ToolReviewDisplayState[] = [
			{ phase: "skipped", toolName: "read", detail: "outside the configured gate" },
			{ phase: "allowed", toolName: "write", source: "reviewer", detail: "low risk · authorization high" },
			{ phase: "denied", toolName: "bash", detail: "line one\nline two\u0000" },
			{ phase: "blocked", toolName: "edit", detail: "timeout · reviewer unavailable" },
		];

		for (const state of states) {
			const line = formatToolReviewLine(state, 36);
			expect(visibleWidth(line)).toBe(36);
			expect(line).not.toContain("\n");
		}

		expect(formatToolReviewLine(states[1], 80)).toContain("allowed by reviewer");
		expect(formatToolReviewLine(states[2], 80)).toContain("denied");
		expect(formatToolReviewLine(states[3], 80)).toContain("blocked");
	});

	test("is idempotent and shares state across repeated installs", () => {
		const first = installToolReviewRenderer(FakeToolExecutionComponent);
		const second = installToolReviewRenderer(FakeToolExecutionComponent);
		first.clear();
		first.setState("call-2", { phase: "awaiting-user", toolName: "edit" });

		const lines = new FakeToolExecutionComponent("call-2").render(60);
		expect(first.supported).toBe(true);
		expect(second.supported).toBe(true);
		expect(lines.filter((line) => line.includes("waiting for approval")).length).toBe(1);

		second.clear();
		expect(new FakeToolExecutionComponent("call-2").render(60)).toHaveLength(2);
	});

	test("fails open when the Pi renderer shape is unavailable", () => {
		const bridge = installToolReviewRenderer({});
		expect(bridge.supported).toBe(false);
		expect(bridge.reason).toContain("prototype");
		bridge.setState("call-3", { phase: "reviewing", toolName: "bash" });
	});
});
