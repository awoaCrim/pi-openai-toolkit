import { v2Fixture } from "../config/test-helpers";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, CONTEXT_WINDOW_COMPACTION_SUMMARY, declaredToolNames } from "./messages";
import { CodexContextWindowManager } from "./window-manager";
import type { ContextWindowCompactionDetails } from "./types";
import { createNativeCompactionDetails, DEFAULT_COMPACTION_CONFIG, DEFAULT_TOOLKIT_CONFIG, LEGACY_REMOTE_V2_INPUT_PROVENANCE } from "../types";
import extension from "../extension-runtime";
import { createNativeCompactionResult } from "../types";
import { serializeMessagesToResponsesInput } from "../serializer";

const model = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.5",
	baseUrl: "https://chatgpt.com/backend-api",
	contextWindow: 100_000,
};

function makeContext(branchEntries: unknown[] = [], currentModel = model): never {
	return {
		model: currentModel,
		hasUI: false,
		ui: { notify: () => undefined },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "token",
				headers: { "chatgpt-account-id": "account" },
				baseUrl: model.baseUrl,
			}),
		},
		sessionManager: {
			getBranch: () => branchEntries,
			getSessionId: () => "session-1",
		},
		getContextUsage: () => undefined,
	} as never;
}

test("model selection evaluates the selected model rather than stale ctx.model", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	let active = ["read"];
	let loading = true;
	const registeredTools: Array<{ name: string; description: string; parameters: unknown; promptGuidelines?: string[] }> = [];
	const sentMessages: Array<{ customType?: string }> = [];
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string; description: string; parameters: unknown; promptGuidelines?: string[] }) => registeredTools.push(tool),
		sendMessage: (message: { customType?: string }) => { sentMessages.push(message); return true; },
		getAllTools: () => {
			if (loading) throw new Error("action method called during extension loading");
			return registeredTools;
		},
		getActiveTools: () => {
			if (loading) throw new Error("action method called during extension loading");
			return active;
		},
		setActiveTools: (names: string[]) => { active = names; },
	} as unknown as ExtensionAPI;
	const nonCodex = { ...model, provider: "openai", api: "openai-responses" };
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", artifactRoot: "/tmp" },
			},
			warnings: [],
		}),
	} as never);
	loading = false;

	await handlers.get("model_select")?.({ model, previousModel: nonCodex, source: "set" } as never, makeContext([], nonCodex));
	expect(active).toEqual(["read", "new_context", "get_context_remaining", "history", "notes"]);
});

test("switching to an unsupported model removes context tools already active at startup", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const registeredTools: Array<{ name: string; description: string; parameters: unknown; promptGuidelines?: string[] }> = [];
	let active = ["read", "new_context", "get_context_remaining", "history", "notes"];
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string; description: string; parameters: unknown; promptGuidelines?: string[] }) => registeredTools.push(tool),
		getAllTools: () => registeredTools,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		sendMessage: () => true,
	} as unknown as ExtensionAPI;
	const unsupported = { ...model, provider: "openai", api: "openai-responses" };
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", artifactRoot: "/tmp" },
			},
			warnings: [],
		}),
	} as never);

	await handlers.get("session_start")?.({} as never, makeContext([], model));
	await handlers.get("model_select")?.({ model: unsupported, previousModel: model, source: "set" } as never, makeContext([], model));

	expect(active).toEqual(["read"]);
});

test("a context-tool name conflict disables the Remote runtime instead of rewriting requests", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	let active = ["read"];
	let compactCalls = 0;
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: () => { throw new Error("must not replace an existing tool"); },
		getAllTools: () => [{ name: "history" }],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
	} as unknown as ExtensionAPI;
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", artifactRoot: "/tmp" },
			},
			warnings: [],
		}),
		remoteCompact: async () => { compactCalls += 1; throw new Error("must not run"); },
	} as never);

	await handlers.get("session_start")?.({} as never, makeContext());
	expect(active).toEqual(["read"]);
	const result = await handlers.get("session_before_compact")?.({
		signal: new AbortController().signal,
		reason: "threshold",
		branchEntries: [],
		preparation: { firstKeptEntryId: "keep", tokensBefore: 10, messagesToSummarize: [], turnPrefixMessages: [] },
	} as never, makeContext());
	// Remote is configured for this Codex model: Pi's native compaction stays
	// disabled even while the runtime is inactive, so nothing silently summarizes.
	expect(result).toEqual({ cancel: true });
	expect(compactCalls).toBe(0);
});

test("remote config on a non-Codex model leaves Pi native compaction untouched", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: () => undefined,
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => undefined,
	} as unknown as ExtensionAPI;
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", artifactRoot: "/tmp" },
			},
			warnings: [],
		}),
		remoteCompact: async () => { throw new Error("must not run"); },
	} as never);

	const anthropicModel = { provider: "anthropic", api: "anthropic-messages", id: "claude-x", baseUrl: "https://api.anthropic.com", contextWindow: 100_000 };
	await handlers.get("session_start")?.({} as never, makeContext([], anthropicModel));
	const result = await handlers.get("session_before_compact")?.({
		signal: new AbortController().signal,
		reason: "threshold",
		branchEntries: [],
		preparation: { firstKeptEntryId: "keep", tokensBefore: 10, messagesToSummarize: [], turnPrefixMessages: [] },
	} as never, makeContext([], anthropicModel));
	expect(result).toBeUndefined();
});

test("native Remote mode does not re-enter remote v2 when OAuth resolution fails", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	let compactCalls = 0;
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: () => undefined,
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => undefined,
	} as unknown as ExtensionAPI;
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", artifactRoot: "/tmp" },
			},
			warnings: [],
		}),
		remoteCompact: async () => { compactCalls += 1; throw new Error("must not run"); },
	} as never);
	const context = makeContext();
	(context as never as { modelRegistry: { getApiKeyAndHeaders: () => Promise<unknown> } }).modelRegistry = {
		getApiKeyAndHeaders: async () => ({ ok: false, error: "expired" }),
	};
	await handlers.get("session_start")?.({} as never, context);
	const result = await handlers.get("session_before_compact")?.({
		signal: new AbortController().signal,
		reason: "threshold",
		branchEntries: [],
		preparation: { firstKeptEntryId: "keep", tokensBefore: 10, messagesToSummarize: [], turnPrefixMessages: [] },
	} as never, context);
	// Inactive Remote-configured Codex sessions cancel native compaction
	// instead of falling through to a Pi summary.
	expect(result).toEqual({ cancel: true });
	expect(compactCalls).toBe(0);
});

test("native Remote mode skips legacy replay when context tools are unavailable", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	let aborted = false;
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: () => undefined,
		getAllTools: () => [{ name: "history" }],
		getActiveTools: () => [],
		setActiveTools: () => undefined,
	} as unknown as ExtensionAPI;
	const branch = [
		{ type: "message", id: "keep", parentId: null, timestamp: "2026-09-06T00:00:00.000Z", message: { role: "user", content: "keep", timestamp: 0 } },
		{
			type: "compaction", id: "compact-1", parentId: "keep", timestamp: "2026-09-06T00:00:01.000Z",
			summary: "summary", firstKeptEntryId: "keep", tokensBefore: 10,
			details: {
				strategy: "openai-remote-compaction-v2", provider: model.provider, api: model.api, model: model.id,
				baseUrl: model.baseUrl, compactedWindow: [{ type: "message", role: "user", content: "opaque" }],
				createdAt: "2026-09-06T00:00:01.000Z",
			},
		},
	] as never;
	const context = makeContext(branch);
	(context as never as { abort: () => void }).abort = () => { aborted = true; };
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", artifactRoot: "/tmp" },
			},
			warnings: [],
		}),
	} as never);

	await handlers.get("session_start")?.({} as never, context);
	const result = await handlers.get("before_provider_request")?.({
		payload: { model: model.id, input: [] },
	} as never, context);
	expect(result).toBeUndefined();
	expect(aborted).toBe(false);
});

test("remote context owns Codex compaction and activates only its four tools", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const registered: Array<{ name: string; description: string; parameters: unknown; promptGuidelines?: string[] }> = [];
	let active = ["read"];
	let sent: Array<Record<string, unknown>> = [];
	let compactCalls = 0;
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string; description: string; parameters: unknown; promptGuidelines?: string[] }) => registered.push(tool),
		getAllTools: () => registered,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		sendMessage: (message: Record<string, unknown>) => { sent.push(message); },
	} as unknown as ExtensionAPI;
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", artifactRoot: "/tmp" },
			},
			warnings: [],
		}),
		remoteCompact: async () => { compactCalls += 1; throw new Error("must not run"); },
	} as never);

	await handlers.get("session_start")?.({} as never, makeContext());
	expect(registered.map((tool) => tool.name)).toEqual(["new_context", "get_context_remaining", "history", "notes"]);
	expect(active).toEqual(["read", "new_context", "get_context_remaining", "history", "notes"]);
	expect(sent).toHaveLength(1);

	const routed = await handlers.get("message_end")?.({
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1|fc-1", name: "list_windows", namespace: "history", arguments: { limit: 2 } }],
		},
	} as never, makeContext());
	expect(routed).toEqual({
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1|fc-1", name: "history", namespace: "history", arguments: { action: "list_windows", limit: 2 } }],
		},
	});

	const projected = await handlers.get("context_with_system")?.({
		messages: [
			{ role: "custom", customType: "codex-context-window", details: sent[0]?.details },
			{
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "history",
				content: [{ type: "text", text: "history operation completed" }],
				details: { codexHistoryNotes: { encrypted_output: "opaque-value" } },
				isError: false,
				timestamp: Date.now(),
			},
		],
	} as never, makeContext());
	const projectedMessages = (projected as never as { messages: Array<{ role: string; content?: Array<{ text: string }> }> }).messages;
	expect(projectedMessages[1]?.content?.[0]?.text).toContain("opaque-value");
	const providerPayload = await handlers.get("before_provider_request")?.({
		payload: {
			model: model.id,
			input: [{ type: "function_call_output", call_id: "call-2", output: projectedMessages[1]?.content?.[0]?.text }],
		},
	} as never, makeContext());
	expect((providerPayload as never as { input: Array<{ output: unknown }> }).input[0]?.output).toEqual([
		{ type: "encrypted_content", encrypted_content: "opaque-value" },
	]);

	const result = await handlers.get("session_before_compact")?.({
		signal: new AbortController().signal,
		reason: "manual",
		branchEntries: [],
		preparation: {
			firstKeptEntryId: "keep",
			tokensBefore: 10,
			previousSummary: undefined,
			messagesToSummarize: [],
			turnPrefixMessages: [],
		},
	} as never, makeContext());
	// A manual /compact without a scheduled rollover must never write a
	// boundary: no-op compactions become Pi's latest-compaction anchor and
	// blind the budget fallback until the next assistant usage lands.
	expect(result).toEqual({ cancel: true });
	expect(compactCalls).toBe(0);

	await handlers.get("session_shutdown")?.({} as never, makeContext());
	expect(active).toEqual(["read"]);
});

test("registered compaction callback restores trim after navigating before the commit without synchronization", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const registered: Array<{ name: string }> = [];
	let active = ["read"];
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string }) => registered.push(tool),
		getAllTools: () => registered,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		sendMessage: () => { throw new Error("persisted window must not initialize again"); },
	} as unknown as ExtensionAPI;
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", artifactRoot: "/tmp" },
			},
			warnings: [],
		}),
		remoteCompact: async () => { throw new Error("window trim must not call a provider"); },
	} as never);
	const sm = SessionManager.inMemory("/synthetic-project");
	sm.appendMessage({ role: "user", content: "old task", timestamp: 1 });
	const marker = sm.appendCustomMessageEntry(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, "rollover", true, {
		protocol: 1, id: "marker", sessionId: sm.getSessionId(),
		contextManagement: {
			protocol: 1, kind: "window", firstWindowId: "w1", currentWindowId: "w2",
			windowNumber: 1, trimPreviousWindow: true,
		},
	});
	const beforeCommit = sm.appendMessage(fauxAssistantMessage("work after rollover"));
	const ctx = { ...makeContext(), sessionManager: sm } as never;
	await handlers.get("session_start")!({} as never, ctx);
	// Automatic trim maintenance still uses the persisted-boundary contract.
	const prepare = () => handlers.get("session_before_compact")!({
		signal: new AbortController().signal,
		reason: "threshold",
		branchEntries: sm.getBranch(),
		preparation: { firstKeptEntryId: marker, tokensBefore: 100, messagesToSummarize: [], turnPrefixMessages: [] },
	} as never, ctx);
	const proposal = await prepare() as { compaction: CompactionResult };
	expect(proposal.compaction?.firstKeptEntryId).toBe(marker);
	// No append means cancellation: invoking the actual hook again can retry.
	expect(await prepare()).toEqual(proposal);
	const { summary, firstKeptEntryId, tokensBefore, details } = proposal.compaction;
	const compactId = sm.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, true);
	await handlers.get("session_compact")!({ compactionEntry: sm.getEntry(compactId) } as never, ctx);
	// No context/model hook runs between acknowledgment and branch navigation.
	sm.branch(beforeCommit);
	expect(await prepare()).toEqual(proposal);
	sm.branch(compactId);
	expect(await prepare()).toEqual({ cancel: true });
});

test("history and notes tools carry usage guidance in promptGuidelines", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const registered: Array<
		{ name: string; description: string; parameters: unknown; promptSnippet?: string; promptGuidelines?: string[] }
	> = [];
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: (tool: {
			name: string;
			description: string;
			parameters: unknown;
			promptSnippet?: string;
			promptGuidelines?: string[];
		}) => registered.push(tool),
		getAllTools: () => registered,
		getActiveTools: () => [],
		setActiveTools: () => undefined,
	} as unknown as ExtensionAPI;
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", artifactRoot: "/tmp" },
			},
			warnings: [],
		}),
	} as never);

	await handlers.get("session_start")?.({} as never, makeContext());

	const historyTool = registered.find((tool) => tool.name === "history");
	const notesTool = registered.find((tool) => tool.name === "notes");

	expect(historyTool?.promptGuidelines?.length).toBeGreaterThan(0);
	expect(historyTool?.promptGuidelines?.join(" ")).toContain("history first");
	expect(notesTool?.promptGuidelines?.length).toBeGreaterThan(0);
	expect(notesTool?.promptGuidelines?.join(" ")).toContain("new_context");
});

test("a non-covered gateway model never writes a window boundary or warns on session_start", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const sentMessages: Array<{ customType?: string }> = [];
	const notices: string[] = [];
	let active: string[] = ["read"];
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: () => undefined,
		getAllTools: () => [],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		sendMessage: (message: { customType?: string }) => { sentMessages.push(message); },
	} as unknown as ExtensionAPI;
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", artifactRoot: "/tmp" },
			},
			warnings: [],
		}),
	} as never);

	// Gateway but not Astra: outside the built-in Remote Context coverage.
	const solModel = { provider: "uwoacrimson", api: "openai-responses", id: "gpt-5.6-sol", baseUrl: "https://newapi.example/v1", contextWindow: 272_000 };
	const ctx = {
		...makeContext([], solModel),
		hasUI: true,
		ui: { notify: (_id: string, message: string) => notices.push(message) },
	} as never;
	await handlers.get("session_start")?.({} as never, ctx);

	// Regression: inactive models still synchronize the tool set successfully;
	// activation must key off the resolved model, not the sync result, or every
	// gateway model receives a codex-context-window boundary message.
	expect(sentMessages.filter((message) => message.customType === "codex-context-window")).toEqual([]);
	expect(active).toEqual(["read"]);
	expect(notices).toEqual([]);
});

test("covered gateway traffic aborts when its session transport is unavailable", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	let aborted = false;
	const registeredTools: Array<{ name: string; description: string; parameters: unknown; promptGuidelines?: string[] }> = [];
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string; description: string; parameters: unknown; promptGuidelines?: string[] }) => registeredTools.push(tool),
		getAllTools: () => registeredTools,
		getActiveTools: () => [],
		setActiveTools: () => undefined,
	} as unknown as ExtensionAPI;
	const gatewayModel = {
		provider: "my-gateway",
		api: "openai-responses",
		id: "gpt-5.6-luna",
		baseUrl: "https://newapi.example/v1",
		contextWindow: 272_000,
	};
	const ctx = {
		...makeContext([], gatewayModel),
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => undefined,
		},
		abort: () => { aborted = true; },
	} as never;
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: {
					...DEFAULT_COMPACTION_CONFIG,
					contextManagement: "remote",
					gatewayContextModels: ["my-gateway/gpt-5.6-luna"],
					artifactRoot: "/tmp",
				},
			},
			warnings: [],
		}),
	} as never);

	await handlers.get("before_provider_request")?.({ payload: { model: gatewayModel.id, input: [] } } as never, ctx);
	await handlers.get("before_provider_headers")?.({ headers: {} } as never, ctx);
	expect(aborted).toBe(true);
});

test("host-excluded gateway context continues ordinary provider hooks and records a downgrade", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	let aborted = false;
	const artifactRoot = fs.mkdtempSync(join(os.tmpdir(), "pi-context-excluded-"));
	const registeredTools: Array<{ name: string; description: string; parameters: unknown; promptGuidelines?: string[] }> = [];
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string; description: string; parameters: unknown; promptGuidelines?: string[] }) => registeredTools.push(tool),
		// A readable empty registry is the Pi host-filtering signal.
		getAllTools: () => [],
		getActiveTools: () => ["read"],
		setActiveTools: () => undefined,
		sendMessage: () => true,
	} as unknown as ExtensionAPI;
	const gatewayModel = {
		provider: "my-gateway",
		api: "openai-responses",
		id: "gpt-5.6-luna",
		baseUrl: "https://newapi.example/v1",
		contextWindow: 272_000,
	};
	const ctx = makeContext([], gatewayModel) as never as {
		cwd: string;
		hasUI: boolean;
		model: typeof gatewayModel;
		abort: () => void;
		sessionManager: {
			getBranch: () => never[];
			getSessionId: () => string;
			getSessionFile: () => string;
			getSessionDir: () => string;
		};
	};
	ctx.cwd = "/tmp/pi-openai-toolkit-context-excluded";
	ctx.hasUI = false;
	ctx.abort = () => { aborted = true; };
	ctx.sessionManager = {
		getBranch: () => [],
		getSessionId: () => "session-excluded",
		getSessionFile: () => "/tmp/pi-openai-toolkit-context-excluded/session.json",
		getSessionDir: () => "/tmp/pi-openai-toolkit-context-excluded",
	};

	try {
		extension(pi, {
			loadConfig: () => ({
				config: {
					...DEFAULT_TOOLKIT_CONFIG,
					compaction: {
						...DEFAULT_COMPACTION_CONFIG,
						contextManagement: "remote",
						gatewayContextModels: ["my-gateway/gpt-5.6-luna"],
						debug: true,
						artifactRoot,
					},
				},
				warnings: [],
			}),
		} as never);

		await handlers.get("session_start")?.({} as never, ctx as never);
		const lifecycleDir = join(artifactRoot, "sessions", "session-excluded", "lifecycle");
		const lifecycleFiles = fs.readdirSync(lifecycleDir).filter((file) => file.endsWith(".json"));
		expect(lifecycleFiles).toHaveLength(1);
		const lifecycle = JSON.parse(fs.readFileSync(join(lifecycleDir, lifecycleFiles[0]!), "utf8")) as {
			data: { activation?: { reason?: string } };
		};
		expect(lifecycle.data.activation?.reason).toBe("context-tools-excluded");

		const contextResult = await handlers.get("context_with_system")?.({ messages: [] } as never, ctx as never);
		expect(contextResult).toBeUndefined();

		const payload = { model: gatewayModel.id, input: [] };
		expect(await handlers.get("before_provider_request")?.({ payload } as never, ctx as never)).toBeUndefined();
		const headers = { authorization: "caller-token", "x-keep": "yes" };
		await handlers.get("before_provider_headers")?.({ headers } as never, ctx as never);
		expect(headers).toEqual({ authorization: "caller-token", "x-keep": "yes" });
		expect(aborted).toBe(false);
	} finally {
		fs.rmSync(artifactRoot, { recursive: true, force: true });
	}
});

test("switching into a covered model mid-session initializes the window lifecycle", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	let active: string[] = ["read"];
	const registeredTools: Array<{ name: string; description: string; parameters: unknown; promptGuidelines?: string[] }> = [];
	const branch: Array<{ type: string; customType?: string; id: string; details: unknown }> = [];
	let markerCount = 0;
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string; description: string; parameters: unknown; promptGuidelines?: string[] }) => registeredTools.push(tool),
		getAllTools: () => registeredTools,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		sendMessage: (message: { customType?: string; details?: unknown }) => {
			if (message.customType === "codex-context-window") {
				markerCount += 1;
				branch.push({ type: "custom_message", customType: message.customType, id: `marker-${markerCount}`, details: message.details });
			}
			return true;
		},
	} as unknown as ExtensionAPI;
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", artifactRoot: "/tmp" },
			},
			warnings: [],
		}),
	} as never);

	const statefulContext = (currentModel: unknown) => ({
		...makeContext(branch, currentModel),
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "session-1",
		},
	}) as never;

	const solModel = { provider: "uwoacrimson", api: "openai-responses", id: "gpt-5.6-sol", baseUrl: "https://newapi.example/v1", contextWindow: 272_000 };
	await handlers.get("session_start")?.({} as never, statefulContext(solModel));
	expect(branch).toEqual([]);

	// sol -> covered model: the switch must open the window so later requests
	// carry window metadata and the backend ingests from this point on.
	await handlers.get("model_select")?.({ model, previousModel: solModel, source: "set" } as never, statefulContext(solModel));
	expect(markerCount).toBe(1);

	// Idempotence: re-selecting a covered model with an existing window adds none.
	await handlers.get("model_select")?.({ model, previousModel: model, source: "set" } as never, statefulContext(model));
	expect(markerCount).toBe(1);

	// Switching away to a non-covered model adds no boundary of its own.
	await handlers.get("model_select")?.({ model: solModel, previousModel: model, source: "set" } as never, statefulContext(model));
	expect(markerCount).toBe(1);
	expect(active).toEqual(["read"]);
});

test("context tools activate on the first turn when Pi rejects the session_start read", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const registeredTools: Array<{ name: string; description: string; parameters: unknown; promptGuidelines?: string[] }> = [];
	const sentMessages: Array<{ customType?: string }> = [];
	const notices: string[] = [];
	let active = ["read"];
	let registrationReads = 0;
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string; description: string; parameters: unknown; promptGuidelines?: string[] }) => { registeredTools.push(tool); },
		getAllTools: () => {
			if (registrationReads++ === 0) throw new Error("This extension ctx is stale after session replacement or reload.");
			return registeredTools;
		},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		sendMessage: (message: { customType?: string }) => { sentMessages.push(message); return true; },
	} as unknown as ExtensionAPI;
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", artifactRoot: "/tmp" },
			},
			warnings: [],
		}),
	} as never);

	const ctx = {
		...makeContext([], model),
		hasUI: true,
		ui: { notify: (message: string) => notices.push(message) },
	} as never;
	await handlers.get("session_start")?.({} as never, ctx);

	// Regression: Pi 0.86 can reject the registration read while a session
	// replacement is still binding. That was cached as a permanent name conflict,
	// which left the four context tools unexposed for the rest of the process.
	expect(active).toEqual(["read"]);
	expect(registrationReads).toBe(1);
	expect(notices.filter((notice) => notice.includes("tool-name-conflict"))).toEqual([]);
	expect(notices.filter((notice) => notice.includes("codex-context-unavailable"))).toEqual([]);
	expect(sentMessages.filter((message) => message.customType === "codex-context-window")).toEqual([]);
	await handlers.get("before_agent_start")?.({ prompt: "continue", systemPromptOptions: {} } as never, ctx);

	expect(active).toEqual(["read", "new_context", "get_context_remaining", "history", "notes"]);
	// A late activation must open the window lifecycle too, or the request rewrite
	// sends no window metadata and the backend never ingests the turns.
	expect(sentMessages.filter((message) => message.customType === "codex-context-window")).toHaveLength(1);
});

test("late activation fails closed when the context window cannot initialize", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const registeredTools: Array<{ name: string; description: string; parameters: unknown; promptGuidelines?: string[] }> = [];
	const notices: string[] = [];
	let active = ["read"];
	let registrationReads = 0;
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string; description: string; parameters: unknown; promptGuidelines?: string[] }) => { registeredTools.push(tool); },
		getAllTools: () => {
			if (registrationReads++ === 0) throw new Error("This extension ctx is stale after session replacement or reload.");
			return registeredTools;
		},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		sendMessage: () => { throw new Error("window message rejected"); },
	} as unknown as ExtensionAPI;
	extension(pi, {
		loadConfig: () => ({
			config: {
				...DEFAULT_TOOLKIT_CONFIG,
				compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", artifactRoot: "/tmp" },
			},
			warnings: [],
		}),
	} as never);

	const ctx = {
		...makeContext([], model),
		hasUI: true,
		ui: { notify: (message: string) => notices.push(message) },
	} as never;
	await handlers.get("session_start")?.({} as never, ctx);
	expect(active).toEqual(["read"]);
	expect(notices.filter((notice) => notice.includes("malformed-window-state"))).toEqual([]);

	await handlers.get("before_agent_start")?.({ prompt: "continue", systemPromptOptions: {} } as never, ctx);
	expect(active).toEqual(["read"]);
	expect(notices.filter((notice) => notice.includes("malformed-window-state"))).toHaveLength(1);
});


for (const leaveManagedMode of ["warn", "compact"] as const) {
	for (const reason of ["manual", "threshold", "overflow"] as const) {
		test(`non-window ${reason} detaches without any compactor and reuses Remote identity (${leaveManagedMode})`, async () => {
			const handlers = new Map<string, (event: never, ctx: never) => unknown>();
			const registered: Array<{ name: string }> = [];
			const sent: Array<{ customType?: string }> = [];
			const notices: string[] = [];
			let active = ["read"];
			let remoteCalls = 0;
			let nativeCalls = 0;
			let compactCalls = 0;
			let localAuthCalls = 0;
			let aborted = false;
			const pi = {
				on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
				registerTool: (tool: { name: string }) => registered.push(tool),
				getAllTools: () => registered, getActiveTools: () => active,
				setActiveTools: (names: string[]) => { active = names; },
				sendMessage: (message: { customType?: string }) => { sent.push(message); },
			} as unknown as ExtensionAPI;
			const windows = new CodexContextWindowManager(async () => undefined);
			extension(pi, {
				loadConfig: () => ({ config: {
					...DEFAULT_TOOLKIT_CONFIG, compaction: {
						...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", leaveManagedMode,
						remoteCompactModel: "uwoacrimson/gpt-6-luna",
						nativeFallback: { enabled: true, model: "uwoacrimson/gpt-6-luna", thinkingLevel: "off" },
					},
				}, warnings: [] }),
				contextWindows: windows,
				remoteCompact: async () => { remoteCalls++; throw new Error("must not summarize Remote history"); },
				nativeFallback: async () => { nativeCalls++; throw new Error("must not send even the filtered current window to Luna"); },
			});
			const sm = SessionManager.inMemory("/synthetic-project");
			const sessionId = sm.getSessionId();
			const head = { role: "system", content: "", sections: { preamble: "prompt" },
				toolsAdded: [{ name: "read", description: "read", parameters: {} }], timestamp: 1 } as AgentMessage;
			const headId = sm.appendMessage(head);
			// A checkpoint from before the Remote window must not be replayed into
			// the local projection, even on the same endpoint.
			sm.appendCompaction("old opaque checkpoint", headId, 10, createNativeCompactionDetails({
				provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl,
				inputProvenance: LEGACY_REMOTE_V2_INPUT_PROVENANCE,
				compactedWindow: [{ type: "compaction", encrypted_content: "old-opaque" }],
			}));
			const addMarker = (windowId: string, windowNumber: number) => sm.appendCustomMessageEntry(
				CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, "window", true, {
					protocol: 1, id: `marker-${windowId}`, sessionId,
					contextManagement: { protocol: 1, kind: "window", firstWindowId: "w1", currentWindowId: windowId, windowNumber },
				},
			);
			addMarker("w1", 0);
			const retired = { role: "user", content: "retired history ".repeat(100_000), timestamp: 2 } as AgentMessage;
			sm.appendMessage(retired);
			const boundaryId = addMarker("w2", 1);
			// Already-Remote-managed current history can itself exceed Luna's
			// physical window. Detachment is NOT a filtered summary request.
			const current = { role: "user", content: reason === "manual" ? "current remote window ".repeat(60_000) : "current remote window", timestamp: 3 } as AgentMessage;
			sm.appendMessage(current);
			sm.appendMessage(fauxAssistantMessage("current work"));
			const localModel = reason === "overflow"
				? { provider: "anthropic", api: "anthropic-messages", id: "claude-x", baseUrl: "https://api.anthropic.com", contextWindow: 100_000 }
				: { ...model, provider: "uwoacrimson", api: "openai-responses", id: "gpt-6-luna", contextWindow: 272_000 };
			const context = (currentModel: typeof model) => ({
				...makeContext([], currentModel), sessionManager: sm, hasUI: true,
				ui: { notify: (message: string) => notices.push(message) },
				abort: () => { aborted = true; },
				compact: () => { compactCalls++; },
				modelRegistry: { getApiKeyAndHeaders: async (requestedModel: typeof model) => {
					if (requestedModel.provider !== model.provider || requestedModel.id !== model.id) { localAuthCalls++; throw new Error("no local provider/compactor resolution needed"); }
					return { ok: true, apiKey: "token", headers: { "chatgpt-account-id": "account" }, baseUrl: model.baseUrl };
				} },
			}) as never;
			const remoteCtx = context(model);
			const localCtx = context(localModel);
			await handlers.get("session_start")!({} as never, remoteCtx);
			const identity = windows.currentIdentity();
			expect(identity?.currentWindowId).toBe("w2");
			const rawBranch = structuredClone(sm.getBranch());
			await handlers.get("model_select")!({ model: localModel, previousModel: model, source: "set" } as never, remoteCtx);
			await handlers.get("agent_settled")!({} as never, localCtx);
			expect(active).toEqual(["read"]);
			expect(windows.currentIdentity()).toEqual(identity);
			const projected = await handlers.get("context_with_system")!({ messages: sm.buildSessionProjection().messages } as never, localCtx) as { messages: AgentMessage[] };
			expect(declaredToolNames(projected.messages)).toEqual(["read"]);
			expect(projected.messages).toContainEqual(current);
			expect(projected.messages).not.toContainEqual(retired);
			expect(projected.messages.some((message) => message.role === "custom" || message.role === "compactionSummary")).toBe(false);
			expect(await handlers.get("before_provider_request")!({ payload: { model: localModel.id, input: [] } } as never, localCtx)).toBeUndefined();
			expect(sm.getBranch()).toEqual(rawBranch);
			const prepare = () => handlers.get("session_before_compact")!({
				signal: new AbortController().signal, reason, branchEntries: sm.getBranch(),
				preparation: { firstKeptEntryId: "wrong-boundary", tokensBefore: 700_000,
					messagesToSummarize: [retired, current], turnPrefixMessages: [] },
			} as never, localCtx);
			const result = await prepare() as { compaction: CompactionResult<ContextWindowCompactionDetails> };
			expect(result.compaction.summary).toBe(CONTEXT_WINDOW_COMPACTION_SUMMARY);
			expect(result.compaction.firstKeptEntryId).toBe(boundaryId);
			expect(result.compaction.tokensBefore).toBeLessThan(700_000);
			expect(result.compaction.details).toEqual({ protocol: 1, strategy: "codex-context-window", windowId: "w2" });
			expect(await prepare()).toEqual(result); // An unpersisted proposal remains retryable.
			expect(sm.getBranch()).toEqual(rawBranch);
			const { summary, firstKeptEntryId, tokensBefore, details } = result.compaction;
			const compactionId = sm.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, true);
			await handlers.get("session_compact")!({ compactionEntry: sm.getEntry(compactionId) } as never, localCtx);
			const after = await handlers.get("context_with_system")!({ messages: sm.buildSessionProjection().messages } as never, localCtx) as { messages: AgentMessage[] };
			expect(after.messages.slice(1)).toEqual(projected.messages.slice(1));
			expect(declaredToolNames(after.messages)).toEqual(["read"]);
			expect(sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CODEX_CONTEXT_WINDOW_MESSAGE_TYPE)).toHaveLength(2);
			await handlers.get("model_select")!({ model, previousModel: localModel, source: "set" } as never, localCtx);
			await handlers.get("agent_settled")!({} as never, remoteCtx);
			expect(active).toEqual(["read", "new_context", "get_context_remaining", "history", "notes"]);
			expect(windows.currentIdentity()).toEqual(identity);
			const replay = await handlers.get("before_provider_request")!({ payload: { model: model.id, input: [] } } as never, remoteCtx) as { client_metadata: { "x-codex-turn-metadata": string } };
			expect(JSON.parse(replay.client_metadata["x-codex-turn-metadata"]).context_window_id).toBe("w2");
			expect(sent).toEqual([]); // No duplicate initialization or handoff marker.
			expect(notices).toEqual([]);
			expect([remoteCalls, nativeCalls, compactCalls, localAuthCalls]).toEqual([0, 0, 0, 0]);
			expect(aborted).toBe(false);
		});
	}
}

for (const remote of [false, true]) {
	for (const keepMarker of [false, true]) {
		test(`newer opaque replay survives historical window (${remote ? "remote" : "local"}, marker retained=${keepMarker})`, async () => {
			const handlers = new Map<string, (event: never, ctx: never) => unknown>();
			const registered: Array<{ name: string }> = [];
			let active = ["read"];
			let aborted = false;
			let providerCalls = 0;
			const sent: Array<{ customType: string; content: string; display: boolean; details: unknown }> = [];
			const pi = {
				on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
				registerTool: (tool: { name: string }) => registered.push(tool),
				getAllTools: () => registered, getActiveTools: () => active,
				setActiveTools: (names: string[]) => { active = names; },
				sendMessage: (message: typeof sent[number]) => { sent.push(message); },
			} as unknown as ExtensionAPI;
			const windows = new CodexContextWindowManager(async () => undefined);
			extension(pi, {
				contextWindows: windows,
				loadConfig: () => ({ config: { ...DEFAULT_TOOLKIT_CONFIG, compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", responsesApis: [] } }, warnings: [] }),
				remoteCompact: async () => { providerCalls++; throw new Error("no generation expected"); },
				nativeFallback: async () => { providerCalls++; throw new Error("no generation expected"); },
			});
			const sm = SessionManager.inMemory("/synthetic-project");
			sm.appendMessage({ role: "user", content: "retired pre-window history", timestamp: 1 });
			const marker = sm.appendCustomMessageEntry(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, "window", true, {
				protocol: 1, id: "marker", sessionId: sm.getSessionId(),
				contextManagement: { protocol: 1, kind: "window", firstWindowId: "w1", currentWindowId: "w2", windowNumber: 1, trimPreviousWindow: true },
			});
			const kept = sm.appendMessage({ role: "user", content: "covered kept copy", timestamp: 2 });
			const appendNotes = (id: string) => {
				sm.appendMessage(fauxAssistantMessage([fauxToolCall("notes", { action: "read_file", path: "/checkpoint.md" }, { id })]));
				sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: "notes", isError: false,
					content: [{ type: "text", text: "notes operation completed" }],
					details: { codexHistoryNotes: { encrypted_output: `${id}-encrypted` } }, timestamp: 3 });
			};
			appendNotes("covered-notes");
			const result = createNativeCompactionResult({ firstKeptEntryId: keepMarker ? marker : kept, tokensBefore: 100,
				details: createNativeCompactionDetails({ provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl,
					inputProvenance: LEGACY_REMOTE_V2_INPUT_PROVENANCE, compactedWindow: [{ type: "compaction", encrypted_content: "new-opaque" }] }),
			});
			sm.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details);
			sm.appendMessage({ role: "user", content: "live tail", timestamp: 3 });
			appendNotes("live-notes");
			const consumer = remote ? model : { ...model, provider: "openai", api: "openai-responses" };
			const ctx = { ...makeContext([], consumer), sessionManager: sm, abort: () => { aborted = true; } } as never;
			await handlers.get("session_start")!({} as never, ctx);
			const incoming = sm.buildSessionProjection().messages;
			const projection = await handlers.get("context_with_system")!({ messages: incoming } as never, ctx) as { messages: AgentMessage[] } | undefined;
			expect(windows.currentIdentity()?.currentWindowId).toBe("w2");
			expect(windows.hasEffectiveWindow()).toBe(false);
			const messages = projection?.messages ?? incoming;
			expect(messages.some((message) => message.role === "compactionSummary")).toBe(true);
			expect(JSON.stringify(messages)).not.toContain("covered kept copy");
			const payload = { model: consumer.id, input: serializeMessagesToResponsesInput(consumer as never, messages) };
			const replay = await handlers.get("before_provider_request")!({ payload } as never, ctx) as { input: unknown[]; client_metadata?: Record<string, string> };
			expect(JSON.stringify(replay.input)).toContain("new-opaque");
			expect(JSON.stringify(replay.input)).toContain("live tail");
			expect(JSON.stringify(replay.input)).not.toContain("covered kept copy");
			expect(JSON.stringify(replay.input)).not.toContain("retired pre-window history");
			expect(JSON.stringify(replay.input)).not.toContain("covered-notes");
			expect(JSON.stringify(replay.input)).toContain("live-notes");
			if (remote) {
				expect(replay.input).toContainEqual({ type: "function_call_output", call_id: "live-notes",
					output: [{ type: "encrypted_content", encrypted_content: "live-notes-encrypted" }] });
				expect(JSON.parse(replay.client_metadata!["x-codex-turn-metadata"]!).context_window_id).toBe("w2");
				for (const reason of ["threshold", "overflow"]) {
					expect(await handlers.get("session_before_compact")!({ reason, signal: new AbortController().signal,
						branchEntries: sm.getBranch(), preparation: { firstKeptEntryId: kept, tokensBefore: 100, messagesToSummarize: [], turnPrefixMessages: [] } } as never, ctx)).toEqual({ cancel: true });
				}
			} else {
				expect(JSON.stringify(replay.input)).not.toContain("live-notes-encrypted");
				expect(JSON.stringify(replay.input)).toContain("notes operation completed");
			}
			expect(aborted).toBe(false);
			expect(providerCalls).toBe(0);
			expect(sent).toEqual([]); // Historical identity must not be reinitialized.

			if (remote) {
				expect(await windows.startNewWindow(pi, ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(true);
				const queued = sent[0]!;
				const targetWindow = windows.currentIdentity()!.currentWindowId;
				const requestMessages = [...incoming, { role: "custom", ...queued, timestamp: 4 } as AgentMessage];
				const preview = await handlers.get("context_with_system")!({ messages: requestMessages } as never, ctx) as { messages: AgentMessage[] };
				expect(preview.messages.some((message) => message.role === "compactionSummary")).toBe(false);
				expect(JSON.stringify(preview.messages)).not.toContain("live tail");
				expect(windows.hasPendingRollover(ctx)).toBe(true);
				expect(windows.prepareCompaction({ branchEntries: sm.getBranch(), preparation: {} } as never)).toEqual({ cancel: true });
				const previewPayload = { model: consumer.id, input: serializeMessagesToResponsesInput(consumer as never, preview.messages) };
				const previewRequest = await handlers.get("before_provider_request")!({ payload: previewPayload } as never, ctx) as typeof replay;
				expect(JSON.stringify(previewRequest.input)).not.toContain("new-opaque");
				expect(JSON.parse(previewRequest.client_metadata!["x-codex-turn-metadata"]!).context_window_id).toBe(targetWindow);

				// A later request without the queued marker must not reuse that preview.
				const withoutQueued = await handlers.get("context_with_system")!({ messages: incoming } as never, ctx) as { messages: AgentMessage[] };
				expect(withoutQueued.messages.some((message) => message.role === "compactionSummary")).toBe(true);
				expect(windows.currentIdentity()?.currentWindowId).toBe("w2");
				expect(windows.hasPendingRollover(ctx)).toBe(true);
				expect(await windows.startNewWindow(pi, ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(false);
				expect(sent).toHaveLength(1);

				sm.appendCustomMessageEntry(queued.customType, queued.content, queued.display, queued.details);
				const persisted = await handlers.get("context_with_system")!({ messages: sm.buildSessionProjection().messages } as never, ctx) as { messages: AgentMessage[] };
				expect(persisted.messages.some((message) => message.role === "compactionSummary")).toBe(false);
				expect(windows.currentIdentity()?.currentWindowId).toBe(targetWindow);
				expect(windows.hasPendingRollover(ctx)).toBe(false);
				expect(aborted).toBe(false);
			}
		});
	}
}

for (const failure of ["unsupported-api", "auth-resolution-failed", "latest-native-compaction-mismatch"] as const) {
	test(`inherited opaque replay aborts instead of sending a sentinel (${failure})`, async () => {
		const artifactRoot = fs.mkdtempSync(join(os.tmpdir(), "toolkit-inherited-replay-"));
		try {
			const handlers = new Map<string, (event: never, ctx: never) => unknown>();
			const registered: Array<{ name: string }> = [];
			let active = ["read"];
			let aborted = false;
			const notices: string[] = [];
			const pi = {
				on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
				registerTool: (tool: { name: string }) => registered.push(tool),
				getAllTools: () => registered, getActiveTools: () => active,
				setActiveTools: (names: string[]) => { active = names; }, sendMessage: () => undefined,
			} as unknown as ExtensionAPI;
			extension(pi, { loadConfig: () => ({ config: { ...DEFAULT_TOOLKIT_CONFIG, compaction: {
				...DEFAULT_COMPACTION_CONFIG, contextManagement: "remote", responsesApis: [], artifactRoot,
			} }, warnings: [] }) });
			const sm = SessionManager.inMemory("/synthetic-project");
			sm.appendCustomMessageEntry(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, "old window", true, {
				protocol: 1, id: "old-window", sessionId: sm.getSessionId(),
				contextManagement: { protocol: 1, kind: "window", firstWindowId: "w1", currentWindowId: "w1", windowNumber: 0 },
			});
			const kept = sm.appendMessage({ role: "user", content: "checkpoint-covered", timestamp: 1 });
			const checkpoint = createNativeCompactionResult({ firstKeptEntryId: kept, tokensBefore: 100,
				details: createNativeCompactionDetails({ provider: model.provider, api: model.api, model: model.id,
					baseUrl: model.baseUrl, inputProvenance: LEGACY_REMOTE_V2_INPUT_PROVENANCE,
					compactedWindow: [{ type: "compaction", encrypted_content: "must-not-leak" }] }),
			});
			sm.appendCompaction(checkpoint.summary, checkpoint.firstKeptEntryId, checkpoint.tokensBefore, checkpoint.details);
			const branch = structuredClone(sm.getBranch());
			const consumer = { ...model, provider: "local", api: failure === "unsupported-api" ? "anthropic-messages" : "openai-responses" };
			const ctx = {
				...makeContext([], consumer), sessionManager: sm, hasUI: true,
				ui: { notify: (message: string) => notices.push(message) }, abort: () => { aborted = true; },
				modelRegistry: { getApiKeyAndHeaders: async () => failure === "auth-resolution-failed"
					? { ok: false, error: "fixture credentials unavailable" }
					: { ok: true, apiKey: "test", headers: {}, baseUrl: "https://different.example/v1" } },
			} as never;
			expect(await handlers.get("context_with_system")!({ messages: sm.buildSessionProjection().messages } as never, ctx)).toBeUndefined();
			expect(aborted).toBe(true);
			aborted = false;
			expect(await handlers.get("before_provider_request")!({ payload: { model: consumer.id, input: [] } } as never, ctx)).toBeUndefined();
			expect(aborted).toBe(true);
			expect(notices.some((notice) => notice.includes(failure))).toBe(true);
			expect(sm.getBranch()).toEqual(branch);
		} finally {
			fs.rmSync(artifactRoot, { recursive: true, force: true });
		}
	});
}

test("v2 context lifecycle reads one snapshot across awaited activation and sees edits next operation", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const registered: any[] = [];
	let active: string[] = ["read"];
	let reads = 0;
	let raw: Record<string, unknown> = { defaults: { context: { mode: "remote-windows" } } };
	const pi = {
		on: (name: string, handler: never) => handlers.set(name, handler),
		registerTool: (tool: unknown) => registered.push(tool),
		getAllTools: () => registered, getActiveTools: () => active,
		setActiveTools: (tools: string[]) => { active = tools; }, sendMessage: () => true,
	};
	extension(pi as never, { loadConfig: () => { reads++; return v2Fixture(raw); } });
	const ctx = makeContext() as any;
	ctx.modelRegistry.getApiKeyAndHeaders = async () => {
		raw = { defaults: { context: { mode: "pi" } } };
		return { ok: true, apiKey: "token", headers: { "chatgpt-account-id": "account" }, baseUrl: model.baseUrl };
	};
	await handlers.get("session_start")!({} as never, ctx);
	expect(reads).toBe(1);
	expect(active).toContain("new_context");
	await handlers.get("model_select")!({ model, previousModel: model, source: "set" } as never, ctx);
	expect(reads).toBe(2);
	expect(active).toEqual(["read"]);
});
