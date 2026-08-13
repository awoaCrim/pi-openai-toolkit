import type { ResponsesCompatibleRequestPayload } from "./runtime";

/**
 * Explicit allowlist of fields mirrored from the latest live Responses request.
 * remote_compaction_v2 has no provider payload at session_before_compact time, so
 * the extension reuses only these compact-relevant fields for the same runtime identity.
 * `stream`, `store`, `input`, and trigger semantics are always forced separately.
 */
export type CompactionRequestExtras = {
	tools?: unknown[];
	parallel_tool_calls?: boolean;
	reasoning?: Record<string, unknown>;
	service_tier?: string;
	prompt_cache_key?: string;
	text?: Record<string, unknown>;
};

export type RequestContextIdentity = {
	provider: string;
	api: string;
	model: string;
	baseUrl: string;
	sessionId?: string;
};

type CachedRequestContext = {
	identity: RequestContextIdentity;
	extras: CompactionRequestExtras;
};

let cached: CachedRequestContext | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameIdentity(cachedIdentity: RequestContextIdentity, current: RequestContextIdentity): boolean {
	return (
		cachedIdentity.provider === current.provider &&
		cachedIdentity.api === current.api &&
		cachedIdentity.model === current.model &&
		cachedIdentity.baseUrl === current.baseUrl &&
		cachedIdentity.sessionId === current.sessionId
	);
}

/**
 * Remember compact-relevant fields from a live Responses request payload.
 * Purely additive metadata: failures are swallowed so caching can never
 * break the provider request path.
 */
export function rememberRequestContext(
	payload: ResponsesCompatibleRequestPayload,
	identity: RequestContextIdentity,
): void {
	try {
		if (payload.model !== identity.model) {
			cached = undefined;
			return;
		}

		const extras: CompactionRequestExtras = {};
		if (Array.isArray(payload.tools)) {
			extras.tools = structuredClone(payload.tools);
		}
		if (typeof payload.parallel_tool_calls === "boolean") {
			extras.parallel_tool_calls = payload.parallel_tool_calls;
		}
		if (isRecord(payload.reasoning)) {
			extras.reasoning = structuredClone(payload.reasoning);
		}
		if (typeof payload.service_tier === "string" && payload.service_tier.trim().length > 0) {
			extras.service_tier = payload.service_tier;
		}
		if (typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0) {
			extras.prompt_cache_key = payload.prompt_cache_key;
		}
		if (isRecord(payload.text)) {
			extras.text = structuredClone(payload.text);
		}

		cached = {
			identity: structuredClone(identity),
			extras,
		};
	} catch {
		cached = undefined;
	}
}

/** Return cached extras only for the exact provider/API/model/base URL/session identity. */
export function getCompactionRequestExtras(identity: RequestContextIdentity): CompactionRequestExtras | undefined {
	if (!cached || !sameIdentity(cached.identity, identity)) {
		return undefined;
	}

	try {
		return structuredClone(cached.extras);
	} catch {
		return undefined;
	}
}

export function clearRequestContextCache(): void {
	cached = undefined;
}
