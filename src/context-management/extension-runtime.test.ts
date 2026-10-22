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
import { createNativeCompactionDetails, DEFAULT_COMPACTION_CONFIG, DEFAULT_TOOLKIT_CONFIG, LEGACY_REMOTE_V2_INPUT_PROVENANCE, CACHE_STACK_ACTIVATION_ENTRY_TYPE } from "../types";
import extension from "../extension-runtime";
import { createNativeCompactionResult } from "../types";
import { serializeMessagesToResponsesInput } from "../serializer";
import type { ExecuteRemoteV2CompactionOptions, RemoteV2CompactionClientResult } from "../remote-v2-client";
import { clearRequestContextCache } from "../request-context-cache";

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
	// This tool-registration fixture has no canonical branch/projection. A manual
	// request must fail closed rather than fabricate a window or send raw history.
	// Valid current-window production is covered below and by the real SDK runner.
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

function activeManualHarness(options: {
	mode?: "remote-compaction" | "remote-windows";
	result?: RemoteV2CompactionClientResult;
	producer?: "missing" | "auth-failed" | "incompatible";
	inputSource?: "legacy" | "pi-context-hook";
	projectCompactionContext?: (messages: readonly AgentMessage[]) => readonly AgentMessage[];
	beforeAuth?: () => Promise<void>;
	beforeReturn?: (sm: SessionManager) => void;
} = {}) {
	const sm = SessionManager.inMemory("/synthetic-project");
	const sessionId = sm.getSessionId();
	const headId = sm.appendMessage({ role: "system", content: "", sections: { preamble: "CURRENT-PROMPT-HEAD" },
		toolsAdded: [{ name: "read", description: "read", parameters: {} }], timestamp: 1 } as AgentMessage);
	sm.appendMessage({ role: "user", content: "RETIRED-BEFORE-WINDOW", timestamp: 2 });
	const addMarker = (windowId: string, windowNumber: number) => sm.appendCustomMessageEntry(
		CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, `window ${windowId}`, true, {
			protocol: 1, id: `marker-${windowId}`, sessionId,
			contextManagement: { protocol: 1, kind: "window", firstWindowId: "w0", currentWindowId: windowId,
				windowNumber, ...(windowNumber ? { previousWindowId: "w0", trimPreviousWindow: true } : {}) },
		},
	);
	addMarker("w0", 0);
	sm.appendMessage({ role: "user", content: "RETIRED-WINDOW-ZERO", timestamp: 3 });
	const boundaryId = addMarker("w1", 1);
	sm.appendMessage({ role: "user", content: "CURRENT-WINDOW-INPUT", timestamp: 4 });
	sm.appendMessage(fauxAssistantMessage("current answer"));
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const registered: Array<{ name: string }> = [];
	const requests: ExecuteRemoteV2CompactionOptions[] = [];
	const prompts: string[] = [];
	const notices: string[] = [];
	const forbidden: string[] = [];
	let active = ["read"];
	let thinking = "high";
	let pending = false;
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string }) => registered.push(tool),
		getAllTools: () => registered,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		getThinkingLevel: () => thinking,
		setThinkingLevel: () => { forbidden.push("thinking"); },
		setModel: async () => { forbidden.push("model"); return true; },
		sendUserMessage: (message: string) => { prompts.push(message); },
		sendMessage: () => { forbidden.push("window-message"); return false; },
	} as unknown as ExtensionAPI;
	const producer = { ...model, id: "producer",
		baseUrl: options.producer === "incompatible" ? "https://other.invalid/backend-api" : model.baseUrl };
	let selected = model;
	const ctx = {
		get model() { return selected; }, get thinkingLevel() { return thinking; }, sessionManager: sm, hasUI: true,
		ui: { notify: (message: string) => notices.push(message) },
		isIdle: () => true, hasPendingMessages: () => pending,
		getContextUsage: () => undefined, getSystemPrompt: () => "CURRENT-PROMPT-HEAD",
		modelRegistry: {
			find: (provider: string, id: string) => options.producer !== "missing" && provider === model.provider && id === "producer" ? producer : undefined,
			getApiKeyAndHeaders: async (requested: typeof model) => {
				await options.beforeAuth?.();
				return requested.id === "producer" && options.producer === "auth-failed"
					? { ok: false, error: "fixture auth unavailable" }
					: { ok: true, apiKey: `token-${requested.id}`, headers: { "chatgpt-account-id": "account" }, baseUrl: requested.baseUrl };
			},
		},
	} as never;
	const windows = new CodexContextWindowManager(async () => undefined);
	let mode: "remote-windows" | "remote-compaction" = "remote-windows";
	extension(pi, {
		loadConfig: () => v2Fixture({ defaults: { context: { mode, remoteCompaction: {
			model: `${model.provider}/producer`, inputSource: options.inputSource ?? "legacy",
		}, nativeFallback: { enabled: true, model: `${model.provider}/producer`, thinkingLevel: "off" } } } }),
		contextWindows: windows,
		projectCompactionContext: options.projectCompactionContext,
		remoteCompact: async (args) => {
			requests.push(args);
			options.beforeReturn?.(sm);
			return options.result ?? { ok: true, status: 200,
				compactedWindow: [{ type: "compaction", encrypted_content: "current-opaque" }],
				response: { status: "completed", output: [{ type: "compaction", encrypted_content: "current-opaque" }] } };
		},
		standaloneCompact: async () => { forbidden.push("standalone"); return { ok: false, reason: "network-error" }; },
		nativeFallback: async () => { forbidden.push("native-summary"); return { ok: false, reason: "compact-failed" }; },
	});
	return {
		sm, boundaryId, headId, windows, requests, prompts, forbidden, notices,
		get selected() { return selected; },
		setPending: () => { pending = true; },
		chooseThinking: () => { thinking = "low"; return handlers.get("thinking_level_select")!({ level: thinking } as never, ctx); },
		emit: (name: string, event = {}) => handlers.get(name)!(event as never, ctx),
		selectModel: (next: typeof model) => {
			const previousModel = selected; selected = next;
			sm.appendModelChange(next.provider, next.id);
			return handlers.get("model_select")!({ model: next, previousModel, source: "set" } as never, ctx);
		},
		start: () => handlers.get("session_start")!({} as never, ctx),
		stop: () => handlers.get("session_shutdown")!({} as never, ctx),
		beforeRequest: (payload: unknown) => handlers.get("before_provider_request")!({ payload } as never, ctx),
		compact: (reason = "manual", signal = new AbortController().signal) => {
			mode = options.mode ?? "remote-compaction";
			return handlers.get("session_before_compact")!({
				signal, reason, branchEntries: sm.getBranch(), customInstructions: "USER-COMPACT-GUIDANCE",
				preparation: { firstKeptEntryId: headId, tokensBefore: 1234, messagesToSummarize: [], turnPrefixMessages: [],
					settings: { enabled: false, keepRecentTokens: 1, reserveTokens: 2048 } },
			} as never, ctx);
		},
	};
}

for (const change of ["abort", "queues", "model", "thinking", "branch", "shutdown", "newer-compact", "user-input"] as const) {
	test(`scoped compaction rechecks ${change} after later before-compact observers without draining queues`, async () => {
		const h = activeManualHarness();
		try {
			await h.start();
			const controller = new AbortController();
			const result = await h.compact("manual", controller.signal) as { cancel: boolean; compaction: CompactionResult };
			expect(result.compaction).toBeDefined();
			expect(result.cancel).toBe(false);
			if (change === "abort") controller.abort();
			else if (change === "queues") h.setPending();
			else if (change === "model") await h.selectModel({ ...model, id: "new-user-model" });
			else if (change === "thinking") await h.chooseThinking();
			else if (change === "branch") h.sm.appendMessage({ role: "user", content: "LATER-OBSERVER-WORK", timestamp: 100 });
			else if (change === "shutdown") await h.stop();
			else if (change === "newer-compact") await h.compact();
			else await h.emit("input", { source: "interactive", text: "queued user text" });
			expect(result.cancel).toBe(true);
			expect(h.sm.getBranch().filter((entry) => entry.type === "compaction")).toEqual([]);
			expect(h.prompts).toEqual([]);
			expect(h.forbidden).toEqual([]);
		} finally { await h.stop(); }
	});
}

test("active Remote captures live extras without entering ordinary replay and keeps the current synthetic tool head", async () => {
	clearRequestContextCache();
	const h = activeManualHarness();
	try {
		await h.start();
		const payload = { model: model.id, input: [{ role: "user", content: "CURRENT-PROVIDER-REQUEST" }],
			tools: [{ type: "function", name: "STALE-CACHED-TOOL" }], parallel_tool_calls: false,
			prompt_cache_key: "current-cache-key", prompt_cache_retention: "24h", prompt_cache_options: { mode: "ephemeral" },
			reasoning: { effort: "high" }, service_tier: "flex", text: { verbosity: "low" } };
		const before = structuredClone(payload);
		const live = await h.beforeRequest(payload) as { client_metadata: Record<string, string> };
		expect(JSON.parse(live.client_metadata["x-codex-turn-metadata"]!).context_window_id).toBe("w1");
		expect(payload).toEqual(before);
		await h.compact();
		const request = h.requests[0]!.request;
		expect(request).toMatchObject({ parallel_tool_calls: false, prompt_cache_key: "current-cache-key",
			reasoning: { effort: "high" }, service_tier: "flex", text: { verbosity: "low" } });
		expect(request.prompt_cache_retention).toBeUndefined(); // Native Codex producer compatibility.
		expect(request.prompt_cache_options).toBeUndefined();
		expect(JSON.stringify(request.tools)).toContain("read");
		expect(JSON.stringify(request.tools)).not.toContain("STALE-CACHED-TOOL");
		expect(JSON.stringify(request)).not.toContain("history_ingest_requested");
	} finally { await h.stop(); clearRequestContextCache(); }
});

test("active Remote manual keeps only current-head deferred tools from the current activation snapshot", async () => {
	const h = activeManualHarness();
	try {
		await h.start();
		h.sm.appendCustomEntry(CACHE_STACK_ACTIVATION_ENTRY_TYPE, { version: 1, catalogHash: "current-catalog", activatedTools: ["read", "retired-tool"] });
		const result = await h.compact() as { compaction: CompactionResult };
		expect(h.requests).toHaveLength(1);
		expect(result.compaction.details).toMatchObject({ deferredToolCarryover: { version: 1, source: CACHE_STACK_ACTIVATION_ENTRY_TYPE,
			catalogHash: "current-catalog", toolNames: ["read"] } });
		expect(h.forbidden).toEqual([]);
	} finally { await h.stop(); }
});

test("active Remote manual compact sends only the canonical current window to the separate producer", async () => {
	const h = activeManualHarness();
	try {
		await h.start();
		const before = structuredClone(h.sm.getBranch());
		const result = await h.compact() as { compaction: CompactionResult };
		expect(h.requests).toHaveLength(1);
		const request = h.requests[0]!;
		expect(request.runtime.model).toBe("producer");
		expect(request.runtime.apiKey).toBe("token-producer");
		expect(request.request.model).toBe("producer");
		const wireInput = JSON.stringify(request.request.input);
		expect(wireInput).toContain("CURRENT-WINDOW-INPUT");
		expect(wireInput).not.toContain("RETIRED-BEFORE-WINDOW");
		expect(wireInput).not.toContain("RETIRED-WINDOW-ZERO");
		expect(request.request.instructions).toContain("CURRENT-PROMPT-HEAD");
		expect(request.request.instructions).toContain("USER-COMPACT-GUIDANCE");
		expect(h.sm.getEntry(result.compaction.firstKeptEntryId)).toBeDefined();
		expect(result.compaction.firstKeptEntryId).not.toBe(h.headId);
		expect(result.compaction.tokensBefore).toBeLessThan(1234);
		expect(result.compaction.details).toMatchObject({ model: model.id, compactionModel: { model: "producer" },
			inputProvenance: LEGACY_REMOTE_V2_INPUT_PROVENANCE, compactedWindow: [{ type: "compaction", encrypted_content: "current-opaque" }] });
		expect(h.sm.getBranch()).toEqual(before);
		expect(h.prompts).toEqual([]); // Only the host's later durable event can arm continuation.
		expect(h.forbidden).toEqual([]);
	} finally { await h.stop(); }
});

test("manual superseded during runtime auth cannot borrow the inactive native fallback", async () => {
	let blocked = false;
	let entered!: () => void, release!: () => void;
	const authEntered = new Promise<void>((done) => { entered = done; });
	const authReleased = new Promise<void>((done) => { release = done; });
	const h = activeManualHarness({ beforeAuth: async () => {
		if (!blocked) return;
		blocked = false; entered(); await authReleased;
		throw new Error("fixture capability unavailable");
	} });
	try {
		await h.start(); const before = structuredClone(h.sm.getBranch());
		blocked = true; const pending = h.compact(); await authEntered;
		await h.selectModel({ ...model, provider: "local", api: "anthropic-messages", id: "new-user-choice" });
		release();
		expect(await pending).toEqual({ cancel: true });
		expect(h.requests).toEqual([]); expect(h.forbidden).toEqual([]); expect(h.prompts).toEqual([]);
		expect(h.selected.id).toBe("new-user-choice"); expect(h.sm.getBranch().slice(0, before.length)).toEqual(before);
	} finally { release(); await h.stop(); }
});

for (const api of ["anthropic-messages", "openai-responses"]) {
	test(`manual superseded during capability resolution cannot enter the unavailable ${api} fallback`, async () => {
		const h = activeManualHarness();
		try {
			await h.start(); const before = structuredClone(h.sm.getBranch());
			const pending = h.compact(); // Capability resolution yields before active/inactive routing.
			await h.selectModel({ ...model, provider: "local", api, id: "new-user-choice" });
			expect(await pending).toEqual({ cancel: true });
			expect(h.requests).toEqual([]); expect(h.forbidden).toEqual([]);
			expect(h.prompts).toEqual([]); expect(h.selected.id).toBe("new-user-choice");
			expect(h.sm.getBranch().slice(0, before.length)).toEqual(before);
			expect(h.sm.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		} finally { await h.stop(); }
	});
}

for (const reason of ["threshold", "overflow"]) {
	test(`active Remote ${reason} retains its automatic compaction contract`, async () => {
		const h = activeManualHarness({ mode: "remote-windows" });
		try {
			await h.start();
			const result = await h.compact(reason) as { compaction: CompactionResult };
			expect(result.compaction.summary).toBe(CONTEXT_WINDOW_COMPACTION_SUMMARY);
			expect(result.compaction.firstKeptEntryId).toBe(h.boundaryId);
			expect(result.compaction.details).toEqual({ protocol: 1, strategy: "codex-context-window", windowId: "w1" });
			h.sm.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId,
				result.compaction.tokensBefore, result.compaction.details, true);
			expect(await h.compact(reason)).toEqual({ cancel: true }); // Cleanup stays one-shot.
			expect(h.requests).toEqual([]);
			expect(h.prompts).toEqual([]);
			expect(h.forbidden).toEqual([]);
		} finally { await h.stop(); }
	});
}

for (const failure of ["non-2xx", "network-error", "invalid-sse", "malformed-compaction-item", "aborted"] as const) {
	test(`scoped remote-compaction ${failure} follows ordinary fallback eligibility`, async () => {
		const h = activeManualHarness({ result: { ok: false, reason: failure, ...(failure === "non-2xx" ? { status: 500 } : {}) } });
		try {
			await h.start();
			const before = structuredClone(h.sm.getBranch());
			expect(await h.compact()).toEqual({ cancel: true });
			expect(h.requests).toHaveLength(1);
			expect(h.sm.getBranch()).toEqual(before);
			expect(h.prompts).toEqual([]);
			expect(h.forbidden).toEqual(failure === "aborted" ? [] : ["native-summary"]);
			expect(h.notices.some((notice) => /continuing with native summary/i.test(notice))).toBe(false);
		} finally { await h.stop(); }
	});
}

for (const producer of ["missing", "auth-failed", "incompatible"] as const) {
	test(`scoped remote-compaction ${producer} producer reaches the configured native fallback`, async () => {
		const h = activeManualHarness({ producer });
		try {
			await h.start();
			const before = structuredClone(h.sm.getBranch());
			expect(await h.compact()).toEqual({ cancel: true });
			expect(h.requests).toEqual([]);
			expect(h.sm.getBranch()).toEqual(before);
			expect(h.prompts).toEqual([]);
			expect(h.forbidden).toEqual(["native-summary"]);
		} finally { await h.stop(); }
	});
}

test("active Remote manual compact rejects a removed current boundary without sending retired input", async () => {
	const h = activeManualHarness();
	try {
		await h.start();
		h.sm.appendContextEdit(h.boundaryId, null);
		const before = structuredClone(h.sm.getBranch());
		expect(await h.compact()).toEqual({ cancel: true });
		expect(h.requests).toEqual([]);
		expect(h.sm.getBranch()).toEqual(before);
		expect(h.prompts).toEqual([]);
		expect(h.forbidden).toEqual([]);
	} finally { await h.stop(); }
});

test("active Remote manual compact ignores a stale result after newer branch work", async () => {
	const h = activeManualHarness({ beforeReturn: (sm) => { sm.appendMessage({ role: "user", content: "NEWER-USER-WORK", timestamp: 20 }); } });
	try {
		await h.start();
		expect(await h.compact()).toEqual({ cancel: true });
		expect(h.requests).toHaveLength(1);
		expect(h.sm.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(JSON.stringify(h.sm.getBranch())).toContain("NEWER-USER-WORK");
		expect(h.prompts).toEqual([]);
		expect(h.forbidden).toEqual([]);
	} finally { await h.stop(); }
});

for (const pairing of ["missing-result", "orphan-result", "duplicate-result", "normalized-id-collision"] as const) {
	test(`active Remote manual ${pairing} never sends incomplete or ambiguous tool pairs`, async () => {
		const h = activeManualHarness();
		try {
			await h.start();
			const addCall = (id: string) => h.sm.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path: "/fixture.txt" }, { id })));
			const addResult = (id: string) => h.sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read",
				content: [{ type: "text", text: "read result" }], isError: false, timestamp: 10 });
			if (pairing === "orphan-result") addResult("orphan");
			else {
				addCall("fixture-call|fc-one");
				if (pairing !== "missing-result") addResult("fixture-call|fc-one");
				if (pairing === "duplicate-result") addResult("fixture-call|fc-one");
				if (pairing === "normalized-id-collision") { addCall("fixture-call|fc-two"); addResult("fixture-call|fc-two"); }
			}
			const before = structuredClone(h.sm.getBranch());
			expect(await h.compact()).toEqual({ cancel: true });
			expect(h.requests).toEqual([]);
			expect(h.sm.getBranch()).toEqual(before);
			expect(h.prompts).toEqual([]); expect(h.forbidden).toEqual([]);
		} finally { await h.stop(); }
	});
}

for (const checkpoint of ["foreign-summary", "wrong-provenance", "wrong-endpoint"] as const) {
	test(`active Remote manual ${checkpoint} does not bypass continuity safety`, async () => {
		const h = activeManualHarness();
		try {
			await h.start();
			h.sm.appendCompaction("newer checkpoint", h.boundaryId, 500, checkpoint === "foreign-summary" ? undefined : createNativeCompactionDetails({
				provider: model.provider, api: model.api, model: model.id,
				baseUrl: checkpoint === "wrong-endpoint" ? "https://other.invalid/backend-api" : model.baseUrl,
				inputProvenance: checkpoint === "wrong-provenance" ? "pi-context-hook-v1" : LEGACY_REMOTE_V2_INPUT_PROVENANCE,
				compactedWindow: [{ type: "compaction", encrypted_content: "newer-opaque" }],
			}), true);
			const before = structuredClone(h.sm.getBranch());
			expect(await h.compact()).toEqual({ cancel: true });
			expect(h.requests).toEqual([]); expect(h.sm.getBranch()).toEqual(before);
			expect(h.prompts).toEqual([]); expect(h.forbidden).toEqual([]);
		} finally { await h.stop(); }
	});
}

test("active Remote manual unexpected service exceptions cancel rather than escape into Pi fallback", async () => {
	const h = activeManualHarness({ beforeReturn: () => { throw new Error("provider-private-body"); } });
	try {
		await h.start(); const before = structuredClone(h.sm.getBranch());
		expect(await h.compact()).toEqual({ cancel: true });
		expect(h.requests).toHaveLength(1); expect(h.sm.getBranch()).toEqual(before);
		expect(h.prompts).toEqual([]); expect(h.forbidden).toEqual([]);
		expect(h.notices.join("\n")).not.toContain("provider-private-body");
	} finally { await h.stop(); }
});

for (const projection of ["unavailable", "head-removed", "retained-removed"] as const) {
	test(`active Remote manual ${projection} hook projection cannot fall back to raw history`, async () => {
		let projections = 0;
		const h = activeManualHarness({ inputSource: "pi-context-hook", ...(projection === "unavailable" ? {} : {
			projectCompactionContext: (messages: readonly AgentMessage[]) => {
				projections++;
				return messages.filter((message) => projection === "head-removed" ? (message.role as string) !== "system" : message.role !== "assistant");
			},
		}) });
		try {
			await h.start(); const before = structuredClone(h.sm.getBranch());
			expect(await h.compact()).toEqual({ cancel: true });
			expect(projections).toBe(projection === "unavailable" ? 0 : 1);
			expect(h.requests).toEqual([]); expect(h.sm.getBranch()).toEqual(before);
			expect(h.prompts).toEqual([]); expect(h.forbidden).toEqual([]);
		} finally { await h.stop(); }
	});
}