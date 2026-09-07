import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextWindowIdentity } from "./types";
import { CODEX_ENCRYPTED_OUTPUT_CONTEXT_MARKER } from "./history-notes";
import { rewriteContextNamespaceCalls } from "./namespace-tools";

export type ContextWindowRequestMetadata = {
	session_id: string;
	thread_id: string;
	agent_name: "/root";
	window_id: string;
	window_number: number;
	context_window_id: string;
	request_kind: "turn";
	history_ingest_requested: true;
};

export function buildContextWindowRequestMetadata(
	ctx: Pick<ExtensionContext, "sessionManager">,
	identity: ContextWindowIdentity,
): ContextWindowRequestMetadata {
	const sessionId = ctx.sessionManager.getSessionId();
	return {
		session_id: sessionId,
		thread_id: sessionId,
		agent_name: "/root",
		window_id: `${sessionId}:${identity.windowNumber}`,
		window_number: identity.windowNumber,
		context_window_id: identity.currentWindowId,
		request_kind: "turn",
		history_ingest_requested: true,
	};
}

export function rewriteWindowPayload(
	payload: unknown,
	ctx: Pick<ExtensionContext, "sessionManager">,
	identity: ContextWindowIdentity | undefined,
): unknown {
	if (!identity || !isResponsesPayload(payload)) return payload;
	const clientMetadata = payload.client_metadata;
	if (clientMetadata !== undefined && !isRecord(clientMetadata)) return payload;
	const existingTurnMetadata = parseTurnMetadata(clientMetadata?.["x-codex-turn-metadata"]);
	if (clientMetadata?.["x-codex-turn-metadata"] !== undefined && !existingTurnMetadata) return payload;
	const metadata = buildContextWindowRequestMetadata(ctx, identity);
	const turnMetadata = { ...existingTurnMetadata, ...metadata };
	const rewritten: Record<string, unknown> = {
		...payload,
		client_metadata: {
			...(clientMetadata ?? {}),
			"x-codex-window-id": metadata.window_id,
			"x-codex-turn-metadata": JSON.stringify(turnMetadata),
		},
	};
	return rewriteEncryptedToolOutputs(rewriteContextNamespaceCalls(rewritten));
}

export function rewriteEncryptedToolOutputs(payload: unknown): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.input)) return payload;
	let changed = false;
	const input = payload.input.map((item) => {
		if (!isRecord(item) || item.type !== "function_call_output") return item;
		const output = item.output;
		if (typeof output === "string") {
			const encrypted = decodeEncryptedOutputContext(output);
			if (encrypted === undefined) return item;
			changed = true;
			return { ...item, output: [{ type: "encrypted_content", encrypted_content: encrypted }] };
		}
		if (!Array.isArray(output)) return item;
		let outputChanged = false;
		const rewrittenOutput = output.map((part) => {
			if (!isRecord(part) || part.type !== "input_text" || typeof part.text !== "string") return part;
			const encrypted = decodeEncryptedOutputContext(part.text);
			if (encrypted === undefined) return part;
			outputChanged = true;
			return { type: "encrypted_content", encrypted_content: encrypted };
		});
		if (!outputChanged) return item;
		changed = true;
		return { ...item, output: rewrittenOutput };
	});
	return changed ? { ...payload, input } : payload;
}

function decodeEncryptedOutputContext(value: string): string | undefined {
	if (!value.startsWith(CODEX_ENCRYPTED_OUTPUT_CONTEXT_MARKER)) return undefined;
	try {
		const decoded: unknown = JSON.parse(value.slice(CODEX_ENCRYPTED_OUTPUT_CONTEXT_MARKER.length));
		if (typeof decoded !== "string" || decoded.length === 0) throw new Error("invalid encrypted output marker");
		return decoded;
	} catch {
		throw new Error("Malformed encrypted history/notes output marker");
	}
}

function parseTurnMetadata(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined) return {};
	if (typeof value !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isResponsesPayload(value: unknown): value is Record<string, unknown> & { model: string; input: unknown[] } {
	return isRecord(value) && typeof value.model === "string" && Array.isArray(value.input);
}

export function rewriteWindowHeaders(
	headers: ProviderHeaders,
	ctx: Pick<ExtensionContext, "sessionManager">,
	identity: ContextWindowIdentity | undefined,
): void {
	if (!identity) return;
	const metadata = buildContextWindowRequestMetadata(ctx, identity);
	headers["x-codex-window-id"] = metadata.window_id;
	headers["x-codex-turn-metadata"] = JSON.stringify(metadata);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
