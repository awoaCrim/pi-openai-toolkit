import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, type CompactionResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { v2Fixture } from "../config/test-helpers";
import extension from "../extension-runtime";
import { serializeMessagesToResponsesInput } from "../serializer";
import {
	createNativeCompactionDetails,
	createNativeCompactionResult,
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_TOOLKIT_CONFIG,
	LEGACY_REMOTE_V2_INPUT_PROVENANCE,
} from "../types";
import { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, CONTEXT_WINDOW_COMPACTION_SUMMARY, declaredToolNames } from "./messages";
import type { ContextWindowCompactionDetails } from "./types";
import { CodexContextWindowManager } from "./window-manager";

const policies = ["remote-compaction", "pi", "legacy-off", "legacy-disabled"] as const;
type LocalPolicy = typeof policies[number];
type FixtureModel = { provider: string; api: string; id: string; baseUrl: string; contextWindow: number };
type Handler = (event: never, ctx: never) => unknown;
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(policy: LocalPolicy, options: { boundary?: boolean; olderOpaque?: boolean; responses?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "toolkit-model-mode-"));
	roots.push(root);
	const sm = SessionManager.inMemory(root);
	const remote: FixtureModel = { provider: "openai-codex", api: "openai-codex-responses", id: "remote-fixture",
		baseUrl: "https://window.invalid/backend-api", contextWindow: 1_000_000 };
	const local: FixtureModel = { ...remote, provider: "local-fixture", id: "local-fixture",
		api: options.responses ? "openai-responses" : "openai-completions" };
	const handlers = new Map<string, Handler>();
	const registered: Array<{ name: string }> = [];
	const sent: unknown[] = [];
	const auth: string[] = [];
	let active = ["read"];
	let localPolicy = false;
	let aborted = false;
	let remoteCalls = 0;
	let nativeCalls = 0;
	const windows = new CodexContextWindowManager(async () => undefined);
	const head = { role: "system", content: "", sections: { preamble: "MODE-SWITCH-SYSTEM" },
		toolsAdded: [{ name: "read", description: "read", parameters: {} }], timestamp: 1 } as AgentMessage;
	const headId = sm.appendMessage(head);
	const opaque = (value: string, firstKeptEntryId: string) => createNativeCompactionResult({ firstKeptEntryId, tokensBefore: 100,
		details: createNativeCompactionDetails({ provider: remote.provider, api: remote.api, model: remote.id, baseUrl: remote.baseUrl,
			inputProvenance: LEGACY_REMOTE_V2_INPUT_PROVENANCE, compactedWindow: [{ type: "compaction", encrypted_content: value }] }),
	});
	if (options.olderOpaque) {
		const result = opaque("PRE-WINDOW-OPAQUE", headId);
		sm.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details);
	}
	const addMarker = (id: string, windowNumber: number) => sm.appendCustomMessageEntry(
		CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, `INTERNAL-MARKER-${id}`, true, {
			protocol: 1, id: `marker-${id}`, sessionId: sm.getSessionId(),
			contextManagement: { protocol: 1, kind: "window", firstWindowId: "window-0", currentWindowId: id,
				windowNumber, ...(windowNumber > 0 ? { trimPreviousWindow: true } : {}) },
		},
	);
	if (options.boundary !== false) addMarker("window-0", 0);
	const retired = { role: "user", content: "RETIRED-MODE-SWITCH-HISTORY ".repeat(10_000), timestamp: 2 } as AgentMessage;
	const retiredId = sm.appendMessage(retired);
	const markerId = options.boundary !== false ? addMarker("window-1", 1) : undefined;
	const current = { role: "user", content: "CURRENT-MODE-SWITCH-WINDOW", timestamp: 3 } as AgentMessage;
	const currentId = sm.appendMessage(current);
	sm.appendMessage(fauxAssistantMessage("current work", { timestamp: 4 }));
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (tool: { name: string }) => registered.push(tool),
		getAllTools: () => registered, getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; }, sendMessage: (message: unknown) => { sent.push(message); },
	} as unknown as ExtensionAPI;
	extension(pi, {
		contextWindows: windows,
		loadConfig: () => {
			if (policy === "legacy-off" || policy === "legacy-disabled") return {
				config: { ...DEFAULT_TOOLKIT_CONFIG, compaction: { ...DEFAULT_COMPACTION_CONFIG,
					contextManagement: localPolicy && policy === "legacy-off" ? "off" : "remote",
					enabled: !(localPolicy && policy === "legacy-disabled"), notifyOnLoad: false, artifactRoot: root } }, warnings: [],
			};
			return v2Fixture({ defaults: { context: { mode: "remote-compaction" } }, models: {
				[`${remote.provider}/${remote.id}`]: { context: { mode: "remote-windows" } },
				...(policy === "pi" ? { [`${local.provider}/${local.id}`]: { context: { mode: "pi" } } } : {}),
			}, diagnostics: { level: "error", notifyOnLoad: false, artifactRoot: root } });
		},
		remoteCompact: async () => { remoteCalls++; throw new Error("retired history reached Remote V2"); },
		nativeFallback: async () => { nativeCalls++; return { ok: false, reason: "no-model-configured" }; },
	});
	const context = (model = local) => ({
		model, cwd: root, hasUI: false, ui: { notify: () => undefined }, sessionManager: sm,
		getContextUsage: () => undefined, abort: () => { aborted = true; },
		modelRegistry: { getApiKeyAndHeaders: async (requested: FixtureModel) => {
			auth.push(`${requested.provider}/${requested.id}`);
			return { ok: true, apiKey: "synthetic-token", headers: { "chatgpt-account-id": "synthetic-account" }, baseUrl: requested.baseUrl };
		} },
	}) as never;
	const call = (name: string, event: unknown = {}, model = local) => handlers.get(name)!(event as never, context(model));
	return {
		sm, windows, local, remote, markerId, currentId, retiredId, retired, current, sent, auth, opaque, call, context,
		get active() { return active; }, get aborted() { return aborted; },
		get producerCalls() { return [remoteCalls, nativeCalls]; },
		async selectLocal(bootstrapRemote = true) {
			if (bootstrapRemote) {
				await call("session_start", {}, remote);
				expect(active).toContain("new_context");
			}
			localPolicy = true;
			if (bootstrapRemote) await call("model_select", { model: local, previousModel: remote, source: "set" }, remote);
			else await call("session_start");
			auth.length = 0;
		},
		async returnToRemote() {
			localPolicy = false;
			await call("model_select", { model: remote, previousModel: local, source: "set" });
		},
		async project() {
			const incoming = sm.buildSessionProjection().messages;
			const result = await call("context_with_system", { messages: incoming }) as { messages: AgentMessage[] } | undefined;
			return result?.messages ?? incoming;
		},
		compaction(reason = "threshold") {
			return call("session_before_compact", { reason, signal: new AbortController().signal, branchEntries: sm.getBranch(),
				preparation: { firstKeptEntryId: retiredId, tokensBefore: 700_000, messagesToSummarize: [retired, current], turnPrefixMessages: [] } });
		},
	};
}

for (const policy of policies) {
	test(`model-scoped window survives policy switch to ${policy}`, async () => {
		const f = fixture(policy);
		await f.selectLocal();
		const raw = structuredClone(f.sm.getBranch());
		const messages = await f.project();
		expect(JSON.stringify(messages).includes("RETIRED-MODE-SWITCH-HISTORY")).toBe(false);
		expect(JSON.stringify(messages).includes("CURRENT-MODE-SWITCH-WINDOW")).toBe(true);
		expect(messages.some((message) => message.role === "custom")).toBe(false);
		expect(declaredToolNames(messages)).toEqual(["read"]);
		expect(f.active).toEqual(["read"]);
		expect(f.auth).toEqual([]);
		expect(f.sm.getBranch()).toEqual(raw);
		expect(f.windows.currentIdentity()?.currentWindowId).toBe("window-1");
		expect(f.aborted).toBe(false);
		await f.returnToRemote();
		expect(f.windows.currentIdentity()?.currentWindowId).toBe("window-1");
		expect(f.sent).toEqual([]);
		expect(f.active).toEqual(["read", "new_context", "get_context_remaining", "history", "notes"]);
	});

	test(`local reload restores inherited window under ${policy}`, async () => {
		const f = fixture(policy);
		await f.selectLocal(false);
		const messages = await f.project();
		expect(JSON.stringify(messages).includes("RETIRED-MODE-SWITCH-HISTORY")).toBe(false);
		expect(JSON.stringify(messages).includes("CURRENT-MODE-SWITCH-WINDOW")).toBe(true);
		expect(f.windows.currentIdentity()?.currentWindowId).toBe("window-1");
		expect(f.auth).toEqual([]);
		expect(f.sent).toEqual([]);
	});

	test(`${policy} branch rewind and restore follows owned ancestry`, async () => {
		const f = fixture(policy);
		await f.selectLocal(false);
		const leaf = f.sm.getLeafId()!;
		const entries = structuredClone(f.sm.getEntries());
		f.sm.branch(f.retiredId);
		const previousWindow = await f.project();
		expect(JSON.stringify(previousWindow).includes("RETIRED-MODE-SWITCH-HISTORY")).toBe(true);
		expect(JSON.stringify(previousWindow).includes("CURRENT-MODE-SWITCH-WINDOW")).toBe(false);
		expect(f.windows.currentIdentity()?.currentWindowId).toBe("window-0");
		f.sm.branch(leaf);
		const restored = await f.project();
		expect(JSON.stringify(restored).includes("RETIRED-MODE-SWITCH-HISTORY")).toBe(false);
		expect(JSON.stringify(restored).includes("CURRENT-MODE-SWITCH-WINDOW")).toBe(true);
		expect(f.windows.currentIdentity()?.currentWindowId).toBe("window-1");
		expect(f.sm.getEntries()).toEqual(entries);
		expect(f.aborted).toBe(false);
		expect(f.auth).toEqual([]);
	});

	for (const reason of ["manual", "threshold", "overflow"]) {
		test(`${policy} ${reason} detaches before disabled/producer paths and remains retryable`, async () => {
			const f = fixture(policy);
			await f.selectLocal(false);
			const before = structuredClone(f.sm.getBranch());
			const result = await f.compaction(reason) as { compaction: CompactionResult<ContextWindowCompactionDetails> };
			expect(result?.compaction?.summary).toBe(CONTEXT_WINDOW_COMPACTION_SUMMARY);
			expect(result.compaction.firstKeptEntryId).toBe(f.markerId!);
			expect(result.compaction.tokensBefore).toBeLessThan(1000);
			expect(await f.compaction(reason)).toEqual(result);
			expect(f.sm.getBranch()).toEqual(before);
			const { summary, firstKeptEntryId, tokensBefore, details } = result.compaction;
			f.sm.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, true);
			// A consumed boundary is no longer a dead end: the ordinary chain continues.
			// Disabled/Pi selections exit before any producer; other local policies reach
			// the native fallback tier, which this fixture reports as unconfigured.
			expect(await f.compaction(reason)).toBeUndefined();
			expect(f.producerCalls).toEqual([0, policy === "pi" || policy === "legacy-disabled" ? 0 : 1]);
			expect(f.auth).toEqual([]);
			expect(f.windows.currentIdentity()?.currentWindowId).toBe("window-1");
		});
	}

	for (const replacement of [null, { content: "edited boundary" }]) {
		test(`${policy} rejects ${replacement === null ? "omitted" : "replaced"} inherited boundary`, async () => {
			const f = fixture(policy);
			await f.selectLocal(false);
			f.sm.appendContextEdit(f.markerId!, replacement);
			await f.project();
			expect(f.aborted).toBe(true);
			expect(await f.compaction()).toEqual({ cancel: true });
			expect(f.producerCalls).toEqual([0, 0]);
			expect(f.auth).toEqual([]);
		});
	}

	test(`${policy} keeps no-boundary behavior and ignores a provably foreign malformed marker`, async () => {
		const f = fixture(policy, { boundary: false });
		f.sm.appendCustomMessageEntry(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, "foreign marker", true,
			{ sessionId: "another-session", protocol: "invalid", contextManagement: { kind: "window" } });
		await f.selectLocal(false);
		const messages = await f.project();
		expect(JSON.stringify(messages).includes("RETIRED-MODE-SWITCH-HISTORY")).toBe(true);
		expect(JSON.stringify(messages).includes("CURRENT-MODE-SWITCH-WINDOW")).toBe(true);
		expect(f.windows.currentIdentity()).toBeUndefined();
		expect(f.aborted).toBe(false);
		expect(f.auth).toEqual([]);
		expect(await f.compaction()).toBeUndefined();
		expect(f.producerCalls).toEqual([0, policy === "pi" || policy === "legacy-disabled" ? 0 : 1]);
	});

	test(`${policy} provider hook cannot rehydrate a pre-window opaque checkpoint`, async () => {
		const f = fixture(policy, { olderOpaque: true, responses: true });
		await f.selectLocal(false);
		// Isolate the later provider phase: projection has already been correctly
		// restricted, so retrying old opaque replay must not even resolve auth.
		f.windows.synchronize(f.context());
		const messages = f.windows.project(f.sm.buildSessionProjection().messages, "local");
		const payload = { model: f.local.id, input: serializeMessagesToResponsesInput(f.local as never, messages) };
		expect(await f.call("before_provider_request", { payload })).toBeUndefined();
		expect(f.auth).toEqual([]);
		expect(f.aborted).toBe(false);
		expect(JSON.stringify(payload).includes("PRE-WINDOW-OPAQUE")).toBe(false);
	});

	for (const keepMarker of [false, true]) {
		test(`${policy} preserves a newer native summary (marker retained=${keepMarker})`, async () => {
			const f = fixture(policy);
			await f.selectLocal();
			f.sm.appendCompaction("NEWER-NATIVE-SUMMARY", keepMarker ? f.markerId! : f.currentId, 100);
			f.sm.appendMessage({ role: "user", content: "NEWER-SUMMARY-TAIL", timestamp: 5 });
			const raw = structuredClone(f.sm.getBranch());
			const messages = await f.project();
			expect(messages.some((message) => message.role === "compactionSummary" && message.summary === "NEWER-NATIVE-SUMMARY")).toBe(true);
			expect(JSON.stringify(messages).includes("NEWER-SUMMARY-TAIL")).toBe(true);
			expect(f.sm.getBranch()).toEqual(raw);
			expect(await f.compaction()).toBeUndefined();
			expect(f.producerCalls).toEqual([0, policy === "pi" || policy === "legacy-disabled" ? 0 : 1]);
			expect(f.aborted).toBe(false);
		});
	}
}

for (const policy of ["remote-compaction", "legacy-off"] as const) {
	for (const keepMarker of [false, true]) {
		test(`${policy} still replays the newer opaque owner (marker retained=${keepMarker})`, async () => {
			const f = fixture(policy, { responses: true });
			await f.selectLocal();
			const checkpoint = f.opaque("NEWER-OPAQUE-OWNER", keepMarker ? f.markerId! : f.currentId);
			f.sm.appendCompaction(checkpoint.summary, checkpoint.firstKeptEntryId, checkpoint.tokensBefore, checkpoint.details);
			f.sm.appendMessage({ role: "user", content: "NEWER-OPAQUE-TAIL", timestamp: 5 });
			const raw = structuredClone(f.sm.getBranch());
			const messages = await f.project();
			const payload = { model: f.local.id, input: serializeMessagesToResponsesInput(f.local as never, messages) };
			const result = await f.call("before_provider_request", { payload }) as { input: unknown[]; client_metadata?: unknown };
			expect(JSON.stringify(result?.input).includes("NEWER-OPAQUE-OWNER")).toBe(true);
			expect(JSON.stringify(result.input).includes("NEWER-OPAQUE-TAIL")).toBe(true);
			expect(JSON.stringify(result.input).includes("RETIRED-MODE-SWITCH-HISTORY")).toBe(false);
			expect(result.client_metadata).toBeUndefined();
			expect(f.windows.hasSupersededWindow()).toBe(true);
			expect(f.sm.getBranch()).toEqual(raw);
			expect(f.aborted).toBe(false);
		});
	}
}
