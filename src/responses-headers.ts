import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { mergeProviderHeaders } from "./provider-headers";

export const CODEX_AFFINITY_SCOPE = "codex-session-v1" as const;
export const CODEX_GATEWAY_ORIGINATOR = "codex_cli_rs" as const;

/** Headers permitted from Pi/provider configuration onto the gateway hop. */
export const CODEX_GATEWAY_FORWARD_HEADERS = [
	"accept",
	"content-type",
	"session-id",
	"thread-id",
	"x-parent-session-id",
	"x-codex-parent-thread-id",
	"x-client-request-id",
	"x-codex-model",
	"x-codex-affinity-scope",
	"x-codex-window-id",
	"x-codex-turn-metadata",
	"x-codex-beta-features",
	"x-openai-encrypted-tool-arguments",
	"x-openai-tool-output-truncation-policy",
	"x-openai-internal-codex-responses-lite",
	"version",
	"originator",
	"user-agent",
] as const;

const CODEX_GATEWAY_FORWARD_HEADER_SET = new Set<string>(CODEX_GATEWAY_FORWARD_HEADERS);

export function filterCodexGatewayHeaders(headers: ProviderHeaders | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (typeof value !== "string" || !CODEX_GATEWAY_FORWARD_HEADER_SET.has(name.toLowerCase())) continue;
		result[name] = value;
	}
	return result;
}

export type CodexAffinity = {
	/** Bare model id used by the gateway route selector, never provider/model. */
	model: string;
	scope: typeof CODEX_AFFINITY_SCOPE;
};

export type ResponsesHeaderRuntime = {
	api: string;
	apiKey: string;
	headers?: ProviderHeaders;
	sessionId?: string;
	/** Opt-in gateway Codex routing metadata for synthetic requests. */
	codexAffinity?: CodexAffinity;
	currentModel: {
		headers?: ProviderHeaders;
	};
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
		return isRecord(payload) ? payload : undefined;
	} catch {
		return undefined;
	}
}

function extractCodexAccountId(token: string): string | undefined {
	const authClaims = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
	if (!isRecord(authClaims)) return undefined;
	const accountId = authClaims.chatgpt_account_id;
	return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

function buildCodexUserAgent(): string {
	const platform = typeof process !== "undefined" ? process.platform : "browser";
	const arch = typeof process !== "undefined" ? process.arch : "unknown";
	return `pi (${platform}; ${arch})`;
}

export function buildCodexCliUserAgent(version: string): string {
	const platform = typeof process !== "undefined" ? process.platform : "browser";
	const arch = typeof process !== "undefined" ? process.arch : "unknown";
	return `codex_cli_rs/${version} (${platform}; ${arch})`;
}

/**
 * The Codex backend version-gates model availability on the `version` header
 * (the pinned @openai/codex client version). `gpt-6-astra` requires >= 0.153.0;
 * an older or absent pin makes the SKU invisible to discovery and rejects
 * requests that name it. Keep this in sync with the newest gate Oh My Pi pins
 * in @oh-my-pi/pi-wire/codex (`CODEX_CLIENT_VERSION`).
 */
export const CODEX_CLIENT_VERSION = "0.153.0";

/** Prompt cache keys are clamped by the same host rule (`OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH`). */
const CODEX_SESSION_ID_MAX_LENGTH = 64;

export function clampCodexSessionId(sessionId: string | undefined): string | undefined {
	if (!sessionId) return undefined;
	const chars = Array.from(sessionId);
	return chars.length <= CODEX_SESSION_ID_MAX_LENGTH ? sessionId : chars.slice(0, CODEX_SESSION_ID_MAX_LENGTH).join("");
}

export type ResponsesHeaderOptions = {
	accept: string;
	contentType?: string;
	/** Conversation identity for Codex cache-affinity headers; clamped to 64 chars here. */
	sessionId?: string;
};

export function buildResponsesRequestHeaders(
	runtime: ResponsesHeaderRuntime,
	options: ResponsesHeaderOptions,
): Headers {
	const mergedHeaders = mergeProviderHeaders(runtime.currentModel.headers, runtime.headers);
	const headers = new Headers(
		runtime.codexAffinity ? filterCodexGatewayHeaders(mergedHeaders) : mergedHeaders,
	);
	headers.set("accept", options.accept);
	headers.set("content-type", options.contentType ?? "application/json");
	if (!headers.has("authorization")) {
		headers.set("authorization", `Bearer ${runtime.apiKey}`);
	}

	const isNativeCodex = runtime.api === "openai-codex-responses";
	const gatewayAffinity = runtime.codexAffinity;
	if (isNativeCodex || gatewayAffinity) {
		if (gatewayAffinity) {
			// A gateway request must use the configured data-plane key, never an
			// inherited OAuth/account header from the model registry.
			headers.set("authorization", `Bearer ${runtime.apiKey}`);
			headers.delete("chatgpt-account-id");
			headers.delete("cookie");
			headers.delete("x-api-key");
			headers.set("originator", CODEX_GATEWAY_ORIGINATOR);
			headers.set("user-agent", buildCodexCliUserAgent(CODEX_CLIENT_VERSION));
			headers.set("x-codex-affinity-scope", gatewayAffinity.scope);
			headers.set("x-codex-model", gatewayAffinity.model);
		} else {
			const accountId = extractCodexAccountId(runtime.apiKey);
			if (accountId) headers.set("chatgpt-account-id", accountId);
			headers.set("originator", "pi");
			headers.set("user-agent", buildCodexUserAgent());
			headers.set("openai-beta", "responses=experimental");
		}
		// Codex backend gating: a request without a new-enough `version` never
		// reaches model SKUs that arrived behind the gate (gpt-6-astra).
		headers.set("version", CODEX_CLIENT_VERSION);
		// Prompt-cache/session affinity rides on the conversation identity. The
		// gateway path also uses the bare model hint above so NEWapi can route
		// context/compact requests without inspecting their body.
		const sessionId = clampCodexSessionId(options.sessionId ?? runtime.sessionId);
		if (sessionId) {
			// Header names match the installed host's live-request builder
			// (`buildSSEHeaders`: `session-id` + `x-client-request-id`) so our
			// synthetic requests land in the same conversation affinity group.
			headers.set("session-id", sessionId);
			headers.set("x-client-request-id", sessionId);
		}
	}

	return headers;
}

export const _responsesHeadersTest = {
	extractCodexAccountId,
};
