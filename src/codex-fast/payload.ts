import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isExactModelAllowed } from "../model-scope";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** This checks route identity, never backend entitlement or actual speed. */
export function isCodexFastModel(
	model: ExtensionContext["model"],
	gatewayModels: readonly string[] = [],
	logicalModel?: ExtensionContext["model"],
): boolean {
	if (!model || typeof model.id !== "string" || !model.id.trim()) return false;
	if (model.api === "openai-codex-responses") return true;
	if (model.api !== "openai-responses") return false;
	try {
		const url = new URL(model.baseUrl);
		if (!["http:", "https:"].includes(url.protocol) || url.hostname.toLowerCase() === "api.openai.com") return false;
	} catch {
		return false;
	}
	return /^(?:gpt|codex)(?:-|$)/iu.test(model.id)
		|| isExactModelAllowed(model, gatewayModels)
		|| (logicalModel?.api === "pi-virtual" && isExactModelAllowed(logicalModel, gatewayModels));
}

/** Only ordinary matching conversation payloads are owned by the session switch. */
export function rewriteCodexFastPayload(payload: unknown, modelId: string, enabled: boolean): Record<string, unknown> | undefined {
	if (!isRecord(payload) || payload.model !== modelId || !Array.isArray(payload.input)) return undefined;
	if (!payload.input.every(isRecord)) return undefined;
	if (payload.input.some((item) => item.type === "compaction_trigger")) return undefined;
	if (Array.isArray(payload.tools) && payload.tools.some((tool) => isRecord(tool) && tool.type === "remote_compaction_v2")) return undefined;
	const tier = enabled ? "priority" : "default";
	return payload.service_tier === tier ? undefined : { ...payload, service_tier: tier };
}
