import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string; description: string; parameters: unknown; promptGuidelines?: string[] }) => registeredTools.push(tool),
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
	expect(result).toMatchObject({ compaction: { summary: expect.stringContaining("no conversation summary") } });
	expect(compactCalls).toBe(0);

	await handlers.get("session_shutdown")?.({} as never, makeContext());
	expect(active).toEqual(["read"]);
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
