import { v2Fixture } from "../config/test-helpers";
import { expect, test } from "bun:test";
import type { CompactionResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE } from "./messages";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_TOOLKIT_CONFIG } from "../types";
import extension from "../extension-runtime";

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

	const projected = await handlers.get("context")?.({
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
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: () => undefined,
		getAllTools: () => [],
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
