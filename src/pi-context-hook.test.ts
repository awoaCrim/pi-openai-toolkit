import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import {
	getPiContextHookProjector,
	getCompactionPayloadProjector,
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

test("payload projection propagates caught hook errors and unsubscribes", async () => {
	installPiContextHookPatch();
	let listener: ((error: { event: string; error: string }) => void) | undefined;
	let subscribed = false;
	const runner = Object.create(ExtensionRunner.prototype);
	runner.onError = (callback: typeof listener) => {
		listener = callback; subscribed = true;
		return () => { subscribed = false; };
	};
	runner.emitBeforeProviderRequest = async (payload: unknown) => {
		listener?.({ event: "before_provider_request", error: "failed transform" });
		return payload;
	};
	const project = getCompactionPayloadProjector(runner.createContext())!;
	await expect(project({})).rejects.toThrow("failed transform");
	expect(subscribed).toBe(false);
	runner.emitBeforeProviderRequest = async (payload: unknown) => payload;
	await expect(project({ input: [] })).resolves.toEqual({ input: [] });
	expect(subscribed).toBe(false);
});

test("reload upgrades an existing context-only bridge without requiring a host restart", () => {
	const prototype = ExtensionRunner.prototype;
	const before = prototype.createContext;
	try {
		const old = () => ({}) as ReturnType<typeof before>;
		Object.defineProperty(old, "__piOpenAiToolkitContextHookPatch", { value: true });
		prototype.createContext = old;
		expect(installPiContextHookPatch()).toEqual({ ok: true, installed: true });
		const runner = Object.create(prototype);
		expect(getCompactionPayloadProjector(runner.createContext())).toBeFunction();
		expect(installPiContextHookPatch()).toEqual({ ok: true, installed: false, reason: "already-installed" });
	} finally {
		prototype.createContext = before;
	}
});
