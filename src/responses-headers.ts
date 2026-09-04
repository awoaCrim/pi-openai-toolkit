import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { mergeProviderHeaders } from "./provider-headers";

export type ResponsesHeaderRuntime = {
	api: string;
	apiKey: string;
	headers?: ProviderHeaders;
	sessionId?: string;
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
	const headers = new Headers(
		mergeProviderHeaders(runtime.currentModel.headers, runtime.headers),
	);
	headers.set("accept", options.accept);
	headers.set("content-type", options.contentType ?? "application/json");
	if (!headers.has("authorization")) {
		headers.set("authorization", `Bearer ${runtime.apiKey}`);
	}

	if (runtime.api === "openai-codex-responses") {
		const accountId = extractCodexAccountId(runtime.apiKey);
		if (accountId) headers.set("chatgpt-account-id", accountId);
		headers.set("originator", "pi");
		headers.set("user-agent", buildCodexUserAgent());
		headers.set("openai-beta", "responses=experimental");
		// Codex backend gating: a request without a new-enough `version` never
		// reaches model SKUs that arrived behind the gate (gpt-6-astra).
		headers.set("version", CODEX_CLIENT_VERSION);
		// Prompt-cache affinity rides on the conversation identity: the backend
		// keeps a conversation's cache prefix on the node that wrote it, so our
		// synthetic compaction requests must present the same id the live
		// transcript requests used, or every compact pays a full cache miss.
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
