import { getApiProvider, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig, resolveToolkitConfig } from "../config";
import { closeResponsesWebSocketSessions, createResponsesWebSocketProvider } from "./transport";
import { createFallbackNotifier, observeContinuation } from "./notifications";
import { clearSendStats, formatSendStats } from "./stats";

const SOURCE_ID = "pi-openai-toolkit:openai-responses-websocket";
type ApiProviderInternal = NonNullable<ReturnType<typeof getApiProvider>>;
type ResponsesWebSocketRegistryState = {
	baseProvider?: ApiProviderInternal;
	installedProvider?: ApiProviderInternal;
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
	pi.registerCommand("ws-status", {
		description: "查看当前会话的全量／增量发送情况（内存统计）。",
		handler: async (args, ctx) => {
			if (args.trim()) { ctx.ui.notify("用法：/ws-status", "warning"); return; }
			if (ctx.hasUI) ctx.ui.notify(formatSendStats(ctx.sessionManager.getSessionId()), "info");
		},
	});
	pi.on("session_start", (_event, ctx) => {
		dispose?.();
		sessionId = ctx.sessionManager.getSessionId();
		const notify = createFallbackNotifier((message) => {
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
		});
		dispose = observeContinuation(sessionId, notify);
	});
	pi.on("session_shutdown", () => {
		dispose?.();
		dispose = undefined;
		if (sessionId) {
			closeResponsesWebSocketSessions(sessionId);
			clearSendStats(sessionId);
		}
		sessionId = undefined;
	});
}
