import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { mergeProviderHeaders } from "./provider-headers";

export type ResponsesHeaderRuntime = {
	api: string;
	apiKey: string;
	headers?: ProviderHeaders;
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

export function buildResponsesRequestHeaders(
	runtime: ResponsesHeaderRuntime,
	options: { accept: string; contentType?: string },
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
	}

	return headers;
}

export const _responsesHeadersTest = {
	extractCodexAccountId,
};
