import { getApiProvider, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig, resolveToolkitConfig } from "../config";
import { closeResponsesWebSocketSessions, createResponsesWebSocketProvider } from "./transport";
import { createFallbackNotifier, observeContinuation } from "./notifications";
import { clearSendStats, formatSendStats } from "./stats";
import { clearWireDiagnostics, formatWireDiagnostics } from "./wire-diagnostics";

const SOURCE_ID = "pi-openai-toolkit:openai-responses-websocket";
type ApiProviderInternal = NonNullable<ReturnType<typeof getApiProvider>>;
type ResponsesWebSocketRegistryState = {
	baseProvider?: ApiProviderInternal;
	installedProvider?: ApiProviderInternal;
	owners?: Map<string, Set<symbol>>;
};

const REGISTRY_STATE_KEY = Symbol.for("pi-openai-toolkit.responses-websocket.registry");

function registryState(): ResponsesWebSocketRegistryState {
	const global = globalThis as typeof globalThis & { [key: symbol]: ResponsesWebSocketRegistryState | undefined };
	return global[REGISTRY_STATE_KEY] ??= {};
}

function rememberInstalledProvider(state: ResponsesWebSocketRegistryState): void {
	state.installedProvider = getApiProvider("openai-responses");
}

/**
 * Add the transport branch at the API-adapter boundary instead of registering
 * a provider. Existing provider ids, models, credentials, and base URLs remain
 * untouched; only openai-responses models eligible for transport=auto/websocket
 * are handled by the wrapper.
 */
export function installResponsesWebSocketTransport(
	loadConfig: typeof loadToolkitConfig = loadToolkitConfig,
): boolean {
	const state = registryState();
	const currentProvider = getApiProvider("openai-responses");
	const ownsCurrentProvider = currentProvider !== undefined && currentProvider === state.installedProvider;
	if (currentProvider && !ownsCurrentProvider) state.baseProvider = currentProvider;
	const baseProvider = state.baseProvider ?? currentProvider;
	const resolved = resolveToolkitConfig(loadConfig());

	// Re-installation can happen during Pi reloads. Remove only this extension's prior
	// adapter so a config change cannot leave a stale enabled wrapper behind. When the
	// current entry is ours, the saved base is re-registered as a pass-through below
	// for disabled config; this keeps the compat registry populated without resetting
	// providers owned by other extensions.
	unregisterApiProviders(SOURCE_ID);
	state.installedProvider = undefined;
	const enabled = resolved.policy.responsesWebSocket.enabled && !resolved.invalidFeatures.includes("responsesWebSocket");
	if (!enabled) {
		if ((ownsCurrentProvider || !currentProvider) && baseProvider) {
			registerApiProvider(baseProvider, SOURCE_ID);
			rememberInstalledProvider(state);
		}
		return false;
	}
	if (!baseProvider) return false;
	registerApiProvider(createResponsesWebSocketProvider(baseProvider, true), SOURCE_ID);
	rememberInstalledProvider(state);
	return true;
}

export default function responsesWebSocketExtension(pi: ExtensionAPI): void {
	installResponsesWebSocketTransport();
	let dispose: (() => void) | undefined;
	let sessionId: string | undefined;
	const owner = Symbol("websocket-session-owner");
	const owners = registryState().owners ??= new Map<string, Set<symbol>>();
	function releaseSession(): void {
		dispose?.();
		dispose = undefined;
		if (!sessionId) return;
		const group = owners.get(sessionId);
		if (group?.delete(owner) && group.size === 0) {
			owners.delete(sessionId);
			closeResponsesWebSocketSessions(sessionId);
			clearSendStats(sessionId);
			clearWireDiagnostics(sessionId);
		}
		sessionId = undefined;
	}
	pi.registerCommand("ws-status", {
		description: "查看当前会话的全量／增量发送情况（内存统计）。",
		handler: async (args, ctx) => {
			if (args.trim()) { ctx.ui.notify("用法：/ws-status", "warning"); return; }
			if (ctx.hasUI) ctx.ui.notify(formatSendStats(ctx.sessionManager.getSessionId()), "info");
		},
	});
	pi.registerCommand("ws-diagnostics", {
		description: "查看脱敏请求、响应 usage、档位和低缓存现场；可加会话 ID 或 json。",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/u).filter(Boolean);
			const json = parts.at(-1) === "json";
			if (json) parts.pop();
			if (parts.length > 1 || (parts[0] !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(parts[0]))) {
				if (ctx.hasUI) ctx.ui.notify("用法：/ws-diagnostics [会话 ID] [json]", "warning");
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(formatWireDiagnostics(parts[0] ?? ctx.sessionManager.getSessionId(), json), "info");
		},
	});
	pi.on("session_start", (_event, ctx) => {
		const nextId = ctx.sessionManager.getSessionId();
		if (sessionId && sessionId !== nextId) releaseSession();
		dispose?.();
		sessionId = nextId;
		const group = owners.get(sessionId) ?? new Set<symbol>();
		group.add(owner);
		owners.set(sessionId, group);
		const notify = createFallbackNotifier((message) => {
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
		});
		dispose = observeContinuation(sessionId, notify);
	});
	pi.on("session_shutdown", () => {
		releaseSession();
	});
}
