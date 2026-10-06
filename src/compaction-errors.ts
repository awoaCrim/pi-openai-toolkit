/** Content-free diagnostics shared by the compaction HTTP/stream boundaries. */
export type CompactionErrorInfo = {
	errorCode?: string;
	errorType?: string;
	errorParam?: string;
	/** Controlled text, never a provider-authored message. */
	errorMessage?: string;
	errorCategory?: "auth" | "quota" | "protocol";
};

const HINTS: Record<string, string> = {
	subscription_sharing_unsupported_capability: "This OpenAI subscription-sharing grant does not authorize compaction. Use a separately authenticated supported API-key or native Codex route; credentials are not interchangeable.",
	hardened_oauth_rule_missing: "This OAuth grant does not authorize this operation. Select a separately authenticated supported route; Toolkit will not switch credentials.",
	rejected_by_hardened_oauth_boundary: "This OAuth grant does not authorize this operation. Select a separately authenticated supported route; Toolkit will not switch credentials.",
	missing_scope: "The credential lacks the required Responses authorization scope. Authenticate the intended route separately.",
	invalid_api_key: "The selected route rejected its credential. Check authentication for that route.",
	insufficient_quota: "The selected route has insufficient quota. Check its billing and quota.",
	rate_limit_exceeded: "The selected route is rate limited. Retry later.",
	unsupported_capability: "The endpoint does not support the requested compaction protocol.",
	unsupported_compaction: "The endpoint does not support the requested compaction protocol.",
	unsupported_protocol: "The endpoint does not support the requested compaction protocol.",
	unsupported_parameter: "The endpoint rejected a compaction request parameter.",
	unknown_parameter: "The endpoint rejected a compaction request parameter.",
	invalid_request_error: "The endpoint rejected the compaction request.",
};
const PROTOCOL_CODES = new Set(["unsupported_capability", "unsupported_compaction", "unsupported_protocol", "unsupported_parameter", "unknown_parameter"]);
const SAFE_TYPES = new Set(["invalid_request_error", "authentication_error", "permission_error", "rate_limit_error", "insufficient_quota", "server_error"]);
const SAFE_PARAMS = new Set(["input", "model", "compaction_trigger", "stream", "store", "tools", "instructions", "reasoning", "text"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function decodeCompactionError(value: unknown): CompactionErrorInfo {
	if (!isRecord(value)) return {};
	const source = isRecord(value.error) ? value.error
		: isRecord(value.response) && isRecord(value.response.error) ? value.response.error : value;
	// Unknown identifiers may themselves contain secrets. Only public vocabulary
	// is emitted; classification can conservatively exclude an unknown auth code.
	const code = typeof source.code === "string" && source.code.length <= 128 ? source.code : undefined;
	const type = typeof source.type === "string" && source.type.length <= 128 ? source.type : undefined;
	const excluded = [code, type].filter((item): item is string => !!item).join(" ");
	const missingScope = typeof source.message === "string" && source.message.length <= 4096 && /missing (?:required )?scopes?\b/i.test(source.message);
	const errorCategory = missingScope || /auth|oauth|permission|subscription|scope|access_denied|forbidden|api_key|token|credential|invalid_grant/i.test(excluded) ? "auth"
		: /quota|billing|rate_limit|too_many_requests/i.test(excluded) ? "quota"
		: code && PROTOCOL_CODES.has(code) ? "protocol" : undefined;
	const errorCode = code && Object.hasOwn(HINTS, code) ? code : undefined;
	return {
		...(errorCode ? { errorCode } : {}),
		...(type && SAFE_TYPES.has(type) ? { errorType: type } : {}),
		...(typeof source.param === "string" && SAFE_PARAMS.has(source.param) ? { errorParam: source.param } : {}),
		...(missingScope ? { errorMessage: HINTS.missing_scope } : errorCode ? { errorMessage: HINTS[errorCode] } : {}),
		...(errorCategory ? { errorCategory } : {}),
	};
}

/** One protocol probe, not a transport/auth retry. Unknown failures fail closed. */
export function qualifiesForStandaloneCompaction(failure: CompactionErrorInfo & { reason: string; status?: number }): boolean {
	if (failure.errorCategory === "auth" || failure.errorCategory === "quota") return false;
	if (failure.reason === "non-2xx") return [400, 404, 405, 422, 501].includes(failure.status ?? 0);
	if (failure.reason === "error-event") return failure.errorCategory === "protocol";
	return failure.status !== undefined && failure.status >= 200 && failure.status < 300 && [
		"empty-body", "invalid-sse", "missing-completed-event", "incomplete-response",
		"invalid-compaction-count", "malformed-compaction-item", "conflicting-compaction-item",
		"invalid-compaction-metadata", "invalid-event-order", "duplicate-completed-event",
	].includes(failure.reason);
}

/** Body collection must be cancellable even with a stalled mocked/custom transport. */
export async function readCompactionResponseText(response: Response, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw new DOMException("Compaction aborted", "AbortError");
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new DOMException("Compaction aborted", "AbortError"));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		while (true) {
			if (signal?.aborted) throw new DOMException("Compaction aborted", "AbortError");
			const chunk = await Promise.race([reader.read(), aborted]);
			if (signal?.aborted) throw new DOMException("Compaction aborted", "AbortError");
			parts.push(chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true }));
			if (chunk.done) return parts.join("");
		}
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		// Abort/completion never waits for transport cleanup. Cancel the reader,
		// not the locked body, and observe late rejection before releasing it.
		try { void reader.cancel().catch(() => undefined); } catch { /* Custom transport cleanup. */ }
		finally { try { reader.releaseLock(); } catch { /* Preserve the operation outcome. */ } }
	}
}
