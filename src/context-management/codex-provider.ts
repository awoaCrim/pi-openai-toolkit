import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mergeProviderHeaders } from "../provider-headers";
import { CODEX_CLIENT_VERSION } from "../responses-headers";
import { normalizeBaseUrl } from "../runtime";
import { isExactModelAllowed } from "../model-scope";
import {
	isNonEmptyString,
	type CodexContextProvider,
	type CodexContextProviderResolution,
} from "./types";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const GATEWAY_API = "openai-responses";
const CODEX_TOOL_ORIGINATOR = "codex_cli_rs";
const CODEX_GATEWAY_ORIGINATOR = "codex_cli_rs";
const CODEX_TOOL_VERSION = "0.0.0";
const CODEX_SESSION_ID_MAX_LENGTH = 64;

export const CODEX_AFFINITY_SCOPE = "codex-session-v1";

export const CODEX_CONTEXT_PROVIDER_ERROR =
	"Remote Context management requires a configured Codex-compatible backend";

export function isNativeCodexModel(
	model: ExtensionContext["model"] | undefined,
): boolean {
	return model?.provider === CODEX_PROVIDER && model.api === CODEX_API;
}

export function isCodexGatewayModel(
	model: ExtensionContext["model"] | undefined,
	gatewayModels: readonly string[] = [],
): boolean {
	// Gateway coverage is an operator allowlist of exact "provider/model" keys
	// (compaction.gatewayContextModels). The backend relay must actually pass
	// hosted window markers through; models outside the list stay on remote
	// compaction v2.
	if (!model || model.api !== GATEWAY_API) return false;
	return isExactModelAllowed(model, gatewayModels);
}

export function normalizeCodexBackendBaseUrl(baseUrl: string | undefined | null): string | undefined {
	const normalized = normalizeBaseUrl(baseUrl);
	if (!normalized) return undefined;
	try {
		const url = new URL(normalized);
		const pathname = url.pathname.replace(/\/+$/, "");
		if (pathname.endsWith("/codex/responses")) {
			url.pathname = pathname.slice(0, -"/responses".length);
			return url.toString().replace(/\/$/, "");
		}
		if (pathname.endsWith("/codex")) return normalized;
		if (pathname.endsWith("/backend-api") || pathname.endsWith("/api")) {
			return `${normalized}/codex`;
		}
		if (pathname === "") return `${normalized}/api/codex`;
		if (pathname === "/") return `${normalized}/api/codex`;
		return undefined;
	} catch {
		return undefined;
	}
}

function headerValue(headers: ProviderHeaders | undefined, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (key.toLowerCase() === wanted && typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

function bearerToken(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const match = value.trim().match(/^Bearer\s+(.+)$/i);
	return (match?.[1] ?? value).trim() || undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const value: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
		return value && typeof value === "object" && !Array.isArray(value)
			? value as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

function accountIdFromToken(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const direct = payload?.chatgpt_account_id;
	if (isNonEmptyString(direct)) return direct.trim();
	const auth = payload?.["https://api.openai.com/auth"];
	if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
	const nested = (auth as Record<string, unknown>).chatgpt_account_id;
	return isNonEmptyString(nested) ? nested.trim() : undefined;
}

function userAgent(version: string): string {
	const platform = typeof process !== "undefined" ? process.platform : "unknown";
	const arch = typeof process !== "undefined" ? process.arch : "unknown";
	return `codex_cli_rs/${version} (${platform}; ${arch})`;
}

function clampSessionId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const chars = Array.from(value.trim());
	if (chars.length === 0) return undefined;
	return chars.length <= CODEX_SESSION_ID_MAX_LENGTH
		? chars.join("")
		: chars.slice(0, CODEX_SESSION_ID_MAX_LENGTH).join("");
}

function removeSensitiveGatewayHeaders(headers: ProviderHeaders): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value !== "string") continue;
		const lower = name.toLowerCase();
		if (lower === "authorization" || lower === "cookie" || lower === "chatgpt-account-id" || lower === "x-api-key") {
			continue;
		}
		result[name] = value;
	}
	return result;
}

export type CodexContextProviderHeaderOptions = {
	sessionId?: string;
	clientRequestId?: string;
};

export function codexContextProviderHeaders(
	provider: CodexContextProvider,
	options: CodexContextProviderHeaderOptions = {},
): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(provider.headers)) {
		if (typeof value === "string") headers.set(name, value);
	}

	if (provider.kind === "native-codex") {
		headers.set("Authorization", `Bearer ${provider.token}`);
		headers.set("ChatGPT-Account-ID", provider.accountId);
		headers.set("originator", CODEX_TOOL_ORIGINATOR);
		headers.set("User-Agent", userAgent(CODEX_TOOL_VERSION));
		headers.set("version", CODEX_TOOL_VERSION);
	} else {
		headers.set("Authorization", `Bearer ${provider.apiKey}`);
		headers.delete("ChatGPT-Account-ID");
		headers.delete("Cookie");
		headers.set("originator", CODEX_GATEWAY_ORIGINATOR);
		headers.set("User-Agent", userAgent(CODEX_CLIENT_VERSION));
		headers.set("version", CODEX_CLIENT_VERSION);
		headers.set("X-Codex-Affinity-Scope", CODEX_AFFINITY_SCOPE);
		headers.set("X-Codex-Model", provider.model);
	}

	const sessionId = clampSessionId(options.sessionId);
	if (sessionId) {
		headers.set("Session-Id", sessionId);
		headers.set("X-Client-Request-Id", options.clientRequestId?.trim() || sessionId);
	}
	headers.set("content-type", "application/json");
	return headers;
}

export async function resolveCodexContextProvider(
	ctx: ExtensionContext,
	modelOverride: ExtensionContext["model"] = ctx.model,
	gatewayModels: readonly string[] = [],
): Promise<CodexContextProviderResolution> {
	const model = modelOverride;
	const descriptor = {
		provider: model?.provider,
		api: model?.api,
		model: model?.id,
		baseUrl: normalizeBaseUrl(model?.baseUrl),
	};
	if (!model) return { ok: false, reason: "unsupported-model" };

	const isNative = isNativeCodexModel(model);
	const isGateway = isCodexGatewayModel(model, gatewayModels);
	if (!isNative && !isGateway) {
		return { ok: false, reason: "unsupported-model", ...descriptor };
	}
	if (!isNative && model.api !== GATEWAY_API) {
		return { ok: false, reason: "unsupported-api", ...descriptor };
	}
	if (isNative && model.api !== CODEX_API) {
		return { ok: false, reason: "unsupported-api", ...descriptor };
	}

	let auth: Awaited<ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders>>;
	try {
		auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as Model<Api>);
	} catch {
		return { ok: false, reason: "auth-resolution-failed", ...descriptor };
	}
	if (!auth.ok) return { ok: false, reason: "auth-resolution-failed", ...descriptor };

	const rawBaseUrl = normalizeBaseUrl(auth.baseUrl) ?? normalizeBaseUrl(model.baseUrl);
	if (!rawBaseUrl) return { ok: false, reason: "missing-base-url", ...descriptor };

	if (isGateway) {
		const apiKey = bearerToken(auth.apiKey) ?? bearerToken(headerValue(auth.headers, "authorization"));
		if (!apiKey) return { ok: false, reason: "missing-api-key", ...descriptor, baseUrl: rawBaseUrl };
		return {
			ok: true,
			provider: {
				kind: "codex-gateway",
				route: "codex-gateway",
				provider: model.provider,
				api: GATEWAY_API,
				model: model.id,
				baseUrl: rawBaseUrl,
				apiKey,
				headers: removeSensitiveGatewayHeaders(mergeProviderHeaders(model.headers, auth.headers)),
			},
		};
	}

	const token = bearerToken(auth.apiKey) ?? bearerToken(headerValue(auth.headers, "authorization"));
	if (!token) return { ok: false, reason: "missing-token", ...descriptor };
	const accountId = headerValue(auth.headers, "chatgpt-account-id") ?? accountIdFromToken(token);
	if (!accountId) return { ok: false, reason: "missing-account-id", ...descriptor };
	const baseUrl = normalizeCodexBackendBaseUrl(rawBaseUrl);
	if (!baseUrl) return { ok: false, reason: "unsupported-backend", ...descriptor };

	const headers = mergeProviderHeaders(model.headers, auth.headers);
	return {
		ok: true,
		provider: {
			kind: "native-codex",
			route: "openai-codex",
			provider: CODEX_PROVIDER,
			api: CODEX_API,
			model: model.id,
			baseUrl,
			token,
			accountId,
			headers,
		},
	};
}

export const _codexProviderTest = {
	accountIdFromToken,
	bearerToken,
	clampSessionId,
	decodeJwtPayload,
	headerValue,
	isCodexGatewayModel,
	userAgent,
};
