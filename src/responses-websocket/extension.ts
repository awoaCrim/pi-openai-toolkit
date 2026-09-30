import { getApiProvider, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig, resolveToolkitConfig } from "../config";
import { createResponsesWebSocketProvider } from "./transport";

const SOURCE_ID = "pi-openai-toolkit:openai-responses-websocket";
let baseProvider: ReturnType<typeof getApiProvider>;

/**
 * Add the transport branch at the API-adapter boundary instead of registering
 * a provider. Existing provider ids, models, credentials, and base URLs remain
 * untouched; only openai-responses models eligible for transport=auto/websocket
 * are handled by the wrapper.
 */
export function installResponsesWebSocketTransport(
	loadConfig: typeof loadToolkitConfig = loadToolkitConfig,
): boolean {
	// Re-installation can happen during Pi reloads. Remove only this extension's prior
	// adapter so a config change cannot leave a stale enabled wrapper behind.
	unregisterApiProviders(SOURCE_ID);
	const resolved = resolveToolkitConfig(loadConfig());
	if (!resolved.policy.responsesWebSocket.enabled || resolved.invalidFeatures.includes("responsesWebSocket")) {
		return false;
	}
	baseProvider ??= getApiProvider("openai-responses");
	if (!baseProvider) return false;
	registerApiProvider(createResponsesWebSocketProvider(baseProvider, true), SOURCE_ID);
	return true;
}

export default function responsesWebSocketExtension(_pi: ExtensionAPI): void {
	installResponsesWebSocketTransport();
}
