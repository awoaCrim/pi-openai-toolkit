import { describe, expect, test } from "bun:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOLKIT_CONFIG } from "../types";
import type { loadToolkitConfig } from "../config";
import { resolveEffectiveModel } from "../runtime";
import { registerCodexFastExtension, CODEX_FAST_STATUS_KEY } from "./extension";
import { CODEX_FAST_ENTRY_TYPE } from "./state";

type Handler = (event: never, ctx: never) => unknown | Promise<unknown>;
type Command = { handler: (args: string, ctx: never) => Promise<void> };
function model(overrides: Record<string, unknown> = {}): NonNullable<ExtensionContext["model"]> {
	return { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol",
		baseUrl: "https://chatgpt.com/backend-api", ...overrides } as never;
}
function request() {
	return { model: "gpt-5.6-sol", input: [{ role: "user", content: "hello" }], reasoning: { effort: "max" } };
}
function harness(options: { sm?: SessionManager; model?: ExtensionContext["model"];
	loadConfig?: typeof loadToolkitConfig; resolveModel?: typeof resolveEffectiveModel } = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const statuses = new Map<string, string | undefined>([["other", "keep"]]);
	const notices: string[] = [];
	const ctx = { model: options.model ?? model(), sessionManager: options.sm ?? SessionManager.inMemory("/fixture"),
		hasUI: true, mode: "tui" as "tui" | "rpc" | "print", ui: {
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			notify: (text: string) => notices.push(text),
		} };
	let failSave = false;
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		appendEntry: (type: string, data: unknown) => {
			if (failSave) throw new Error("synthetic save failure");
			ctx.sessionManager.appendCustomEntry(type, data);
		},
	};
	registerCodexFastExtension(pi as never, options.loadConfig ?? (() => { throw new Error("unexpected config load"); }), options.resolveModel);
	const fire = async (name: string, event: unknown = {}, context: unknown = ctx) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = await handler(event as never, context as never) ?? result;
		return result;
	};
	const toggle = (args = "", context: unknown = ctx) => commands.get("fast")!.handler(args, context as never);
	const wire = (payload: unknown = request(), context: unknown = ctx) => fire("before_provider_request", { payload }, context);
	return { ctx, handlers, commands, notices, statuses, fire, toggle, wire, failSave: () => { failSave = true; } };
}

describe("Codex Fast extension", () => {
	test("default OFF and one command toggles ON/OFF without tools, flags or configuration", async () => {
		const h = harness();
		expect([...h.commands.keys()]).toEqual(["fast"]);
		expect(h.handlers.has("before_provider_headers")).toBe(false);
		await h.fire("session_start");
		expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast OFF");
		expect(await h.wire()).toMatchObject({ service_tier: "default", reasoning: { effort: "max" } });
		await h.toggle();
		expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast ON");
		expect(await h.wire()).toMatchObject({ service_tier: "priority" });
		expect(h.notices.at(-1)).toContain("increase usage/cost");
		await h.toggle();
		expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast OFF");
		expect(await h.wire()).toMatchObject({ service_tier: "default" });
		expect(h.ctx.sessionManager.getBranch().filter((e) => e.type === "custom")).toHaveLength(2);
		expect(h.ctx.sessionManager.buildSessionProjection().messages).toEqual([]);
		expect(h.statuses.get("other")).toBe("keep");
	});

	test("reload and a same-session remote window marker retain ON", async () => {
		const h = harness();
		await h.fire("session_start");
		await h.toggle();
		h.ctx.sessionManager.appendCustomMessageEntry("codex-context-window", "window", true, { id: "new-window", sessionId: h.ctx.sessionManager.getSessionId() });
		await h.fire("session_start");
		expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast ON");
		const reloaded = harness({ sm: h.ctx.sessionManager });
		await reloaded.fire("session_start");
		expect(await reloaded.wire()).toMatchObject({ service_tier: "priority" });
	});

	test("independent new session or copied fork preference is OFF", async () => {
		const h = harness();
		await h.fire("session_start");
		await h.toggle();
		const data = h.ctx.sessionManager.getBranch().find((e) => e.type === "custom" && e.customType === CODEX_FAST_ENTRY_TYPE);
		expect(data?.type).toBe("custom");
		const fork = SessionManager.inMemory("/fork");
		if (data?.type === "custom") fork.appendCustomEntry(data.customType, data.data);
		h.ctx.sessionManager = fork;
		await h.fire("session_start");
		expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast OFF");
		expect(await h.wire()).toMatchObject({ service_tier: "default" });
	});

	test("tree navigation restores only the live branch", async () => {
		const h = harness();
		const root = h.ctx.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		await h.fire("session_start");
		await h.toggle();
		const onLeaf = h.ctx.sessionManager.getLeafId()!;
		h.ctx.sessionManager.branch(root);
		await h.fire("session_tree");
		expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast OFF");
		expect(await h.wire()).toMatchObject({ service_tier: "default" });
		h.ctx.sessionManager.branch(onLeaf);
		await h.fire("session_tree");
		expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast ON");
	});

	test("model switching shows N/A without erasing selection", async () => {
		const h = harness();
		await h.fire("session_start");
		await h.toggle();
		h.ctx.model = model({ api: "anthropic-messages", id: "claude-fable-5" });
		await h.fire("model_select", { model: h.ctx.model });
		expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast N/A");
		expect(await h.wire()).toBeUndefined();
		await h.toggle();
		expect(h.notices.at(-1)).toContain("unavailable");
		h.ctx.model = model();
		await h.fire("model_select", { model: h.ctx.model });
		expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast ON");
		expect(await h.wire()).toMatchObject({ service_tier: "priority" });
	});

	for (const api of ["openai-codex-responses", "openai-responses"]) {
		test("works without reading config on " + api, async () => {
			const h = harness({ model: model({ provider: "alias", api, baseUrl: "https://relay.invalid/v1" }) });
			await h.fire("session_start");
			await h.toggle();
			expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast ON");
			expect(await h.wire()).toMatchObject({ service_tier: "priority" });
		});
	}

	test("opaque gateway aliases reuse existing exact markers, not a Fast setting", async () => {
		const config = structuredClone(DEFAULT_TOOLKIT_CONFIG);
		config.compaction.gatewayContextModels = ["relay/opaque"];
		let reads = 0;
		const h = harness({ model: model({ provider: "relay", api: "openai-responses", id: "opaque", baseUrl: "https://relay.invalid/v1" }),
			loadConfig: () => { reads++; return { config, warnings: [] }; } });
		await h.fire("session_start");
		await h.toggle();
		expect(await h.wire({ ...request(), model: "opaque" })).toMatchObject({ service_tier: "priority" });
		expect(reads).toBe(3);
	});

	test("virtual route uses the physical model, not the logical name", async () => {
		const physical = model({ provider: "relay", api: "openai-responses", baseUrl: "https://relay.invalid/v1" });
		const h = harness({ model: model({ api: "pi-virtual", id: "logical" }),
			resolveModel: async () => ({ ok: true, model: physical, virtual: true }) });
		await h.fire("session_start");
		await h.toggle();
		expect(await h.wire()).toMatchObject({ model: physical.id, service_tier: "priority" });
		expect(h.ctx.model.id).toBe("logical");
		expect(await h.wire({ ...request(), model: "logical" })).toBeUndefined();
	});

	test("argument, non-terminal, missing-identity and save failure do not toggle", async () => {
		const h = harness();
		await h.fire("session_start");
		await h.toggle("on");
		expect(h.notices.at(-1)).toContain("Usage");
		h.ctx.mode = "rpc";
		await h.toggle();
		expect(h.notices.at(-1)).toContain("interactive terminal");
		h.ctx.mode = "tui";
		const missing = { ...h.ctx, sessionManager: { getSessionId: () => { throw new Error("missing"); }, getBranch: () => [] } };
		await h.fire("session_start", {}, missing);
		await h.toggle("", missing);
		expect(h.notices.at(-1)).toContain("unchanged");
		expect(await h.wire(request(), missing)).toBeUndefined();
		await h.fire("session_start");
		h.failSave();
		await h.toggle();
		expect(h.notices.at(-1)).toContain("could not save");
		expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast OFF");
		expect(h.ctx.sessionManager.getBranch()).toHaveLength(0);
		expect(await h.wire()).toMatchObject({ service_tier: "default" });
	});

	test("headless restore/request does not use UI; shutdown clears only owned status", async () => {
		const h = harness();
		const headless = { ...h.ctx, hasUI: false, ui: new Proxy({}, { get() { throw new Error("unexpected UI"); } }) };
		await h.fire("session_start", {}, headless);
		expect(await h.wire(request(), headless)).toMatchObject({ service_tier: "default" });
		await h.toggle("", headless);
		await h.fire("session_shutdown", {}, headless);
		await h.fire("session_start");
		await h.fire("session_shutdown");
		expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBeUndefined();
		expect(h.statuses.get("other")).toBe("keep");
	});

	test("an in-flight request retains its captured mode after a later toggle", async () => {
		let blockNext = false;
		let release: (value: Awaited<ReturnType<typeof resolveEffectiveModel>>) => void = () => {};
		const h = harness({ resolveModel: async (_ctx, selected) => {
			if (blockNext) { blockNext = false; return new Promise((resolve) => { release = resolve; }); }
			return { ok: true, model: selected!, virtual: false };
		} });
		await h.fire("session_start");
		blockNext = true;
		const pending = h.wire();
		await h.toggle();
		release({ ok: true, model: h.ctx.model, virtual: false });
		expect(await pending).toMatchObject({ service_tier: "default" });
		expect(await h.wire()).toMatchObject({ service_tier: "priority" });
	});

	for (const changed of ["session", "model"]) {
		for (const operation of ["request", "command"]) {
			test(`${operation} refuses a stale ${changed} after async route resolution`, async () => {
				let blockNext = false;
				let release: (value: Awaited<ReturnType<typeof resolveEffectiveModel>>) => void = () => {};
				const h = harness({ resolveModel: async (_ctx, selected) => {
					if (blockNext) { blockNext = false; return new Promise((resolve) => { release = resolve; }); }
					return { ok: true, model: selected!, virtual: false };
				} });
				await h.fire("session_start");
				const original = h.ctx.model;
				blockNext = true;
				const pending = operation === "request" ? h.wire() : h.toggle();
				if (changed === "session") h.ctx.sessionManager = SessionManager.inMemory("/new-session");
				else h.ctx.model = model({ api: "anthropic-messages", id: "claude-fable-5" });
				release({ ok: true, model: original, virtual: false });
				expect(await pending).toBeUndefined();
				expect(h.ctx.sessionManager.getBranch()).toHaveLength(0);
				if (operation === "command") expect(h.notices.at(-1)).toContain("unchanged");
				await h.fire("session_start");
				expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe(changed === "session" ? "Fast OFF" : "Fast N/A");
			});
		}
	}

	test("unresolved or throwing virtual route cannot enable or rewrite Fast", async () => {
		for (const throws of [false, true]) {
			const h = harness({ model: model({ api: "pi-virtual", id: "logical" }), resolveModel: async () => {
				if (throws) throw new Error("synthetic unavailable route");
				return { ok: false, reason: "virtual-model-unresolved" };
			} });
			await h.fire("session_start");
			await h.toggle();
			expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast N/A");
			expect(h.notices.at(-1)).toContain("unavailable");
			expect(h.ctx.sessionManager.getBranch()).toHaveLength(0);
			expect(await h.wire()).toBeUndefined();
		}
	});

	test("older interactive context without mode still supports the terminal command", async () => {
		const h = harness();
		const older = { ...h.ctx, mode: undefined };
		await h.fire("session_start", {}, older);
		await h.toggle("", older);
		expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast ON");
		expect(await h.wire(request(), older)).toMatchObject({ service_tier: "priority" });
	});

	test("stale async status refresh cannot overwrite a newer model state", async () => {
		let blockNext = true;
		let release: (value: Awaited<ReturnType<typeof resolveEffectiveModel>>) => void = () => {};
		const h = harness({ resolveModel: async (_ctx, selected) => {
			if (blockNext) { blockNext = false; return new Promise((resolve) => { release = resolve; }); }
			return { ok: true, model: selected!, virtual: false };
		} });
		const stale = h.fire("session_start");
		const native = h.ctx.model;
		h.ctx.model = model({ api: "anthropic-messages", id: "claude-fable-5" });
		await h.fire("model_select", { model: h.ctx.model });
		release({ ok: true, model: native, virtual: false });
		await stale;
		expect(h.statuses.get(CODEX_FAST_STATUS_KEY)).toBe("Fast N/A");
	});
});
