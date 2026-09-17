import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import {
	getPiContextHookProjector,
	installPiContextHookPatch,
	PI_CONTEXT_PROJECTOR_FIELD,
	reportPiContextHookFailure,
} from "./pi-context-hook";

test("patches Pi contexts with an ordered projector backed by emitContext", async () => {
	const patch = installPiContextHookPatch();
	expect(patch.ok).toBe(true);

	let received: AgentMessage[] | undefined;
	const runner = Object.create(ExtensionRunner.prototype) as {
		createContext: typeof ExtensionRunner.prototype.createContext;
		emitContext: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
	};
	runner.emitContext = async (messages) => {
		received = messages;
		return [...messages, { role: "user", content: "projected" } as never];
	};

	const context = runner.createContext();
	const projector = getPiContextHookProjector(context);
	expect(projector).toBeDefined();
	expect(Object.prototype.propertyIsEnumerable.call(context, PI_CONTEXT_PROJECTOR_FIELD)).toBe(false);

	const input = [{ role: "user", content: "original" } as never];
	const projected = await projector?.(input);

	expect(received).toEqual(input);
	expect(received).not.toBe(input);
	expect(projected).toEqual([
		{ role: "user", content: "original" },
		{ role: "user", content: "projected" },
	]);
	expect(input).toEqual([{ role: "user", content: "original" }]);
});

test("propagates context-hook failures across Pi's emitContext boundary", async () => {
	const runner = Object.create(ExtensionRunner.prototype) as {
		createContext: typeof ExtensionRunner.prototype.createContext;
		emitContext: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
	};
	let context: ReturnType<typeof runner.createContext> | undefined;
	runner.emitContext = async (messages) => {
		const emittedContext = runner.createContext();
		reportPiContextHookFailure(emittedContext, "replay-failed:retained-context-mismatch");
		return messages;
	};

	context = runner.createContext();
	const projector = getPiContextHookProjector(context);
	expect(projector).toBeDefined();
	await expect(projector?.([{ role: "user", content: "original" } as never])).rejects.toThrow(
		"context projection failed: replay-failed:retained-context-mismatch",
	);
});

test("installs the context patch idempotently", () => {
	const first = installPiContextHookPatch();
	const second = installPiContextHookPatch();
	expect(first.ok).toBe(true);
	expect(second.ok).toBe(true);
});
