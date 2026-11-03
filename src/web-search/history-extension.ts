import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	SEARCH_HISTORY, SEARCH_DISPLAY, isObject, isSearchRecord, makeSearchRecord,
	contextSummary, restoreSearchHistory, displaySearchSummary, type JsonObject, type SearchRecord,
} from "./history";

function branchRecords(ctx: ExtensionContext): SearchRecord[] {
	return ctx.sessionManager.getBranch().flatMap(entry =>
		entry.type === "custom" && entry.customType === SEARCH_HISTORY && isSearchRecord(entry.data) ? [entry.data] : []);
}
function recordForMessage(records: SearchRecord[], message: any): SearchRecord | undefined {
	return records.find(r => r.responseId === message.responseId && r.provider === message.provider &&
		r.api === message.api && r.model === message.model);
}

export const HOSTED_SEARCH_CAPTURE_MIN_PI = "0.99.0";

export function registerHostedSearchHistory(pi: ExtensionAPI): void {
	let warned = false;
	let inTurn = false;
	let expectsHostedSearch = false;
	let sawProviderEvent = false;
	let active = false;
	let capture: { responseId: string; provider: string; api: string; model: string;
		items: Map<number, JsonObject>; output?: JsonObject[]; completion: string; notified: boolean } | undefined;
	let pending: SearchRecord | undefined;
	const clear = () => {
		inTurn = false; active = false; expectsHostedSearch = false; sawProviderEvent = false;
		capture = undefined; pending = undefined;
	};
	pi.on("session_start", () => { clear(); warned = false; });
	pi.on("session_shutdown", clear);
	pi.on("turn_start", () => { inTurn = true; active = false; capture = undefined; });
	pi.on("provider_stream_event", (event, ctx) => {
		if (!active || !["openai-responses", "openai-codex-responses"].includes(event.api) || !isObject(event.data)) return;
		sawProviderEvent = true;
		const data = event.data;
		if (data.type === "response.created" && typeof data.response?.id === "string") {
			capture = { responseId: data.response.id, provider: event.provider, api: event.api, model: event.model,
				items: new Map(), completion: "unfinished", notified: false };
		}
		if (!capture || capture.provider !== event.provider || capture.api !== event.api || capture.model !== event.model) return;
		if (["response.output_item.added", "response.output_item.done"].includes(data.type) &&
			Number.isInteger(data.output_index) && isObject(data.item)) {
			capture.items.set(data.output_index, structuredClone(data.item));
			if (data.item.type === "web_search_call" && !capture.notified) {
				capture.notified = true;
				if (ctx.hasUI) {
					ctx.ui.setStatus("toolkit-hosted-search", "服务端网页工具执行中");
					ctx.ui.notify("正在使用服务端网页工具（非本地 Chrome）", "info");
				}
			}
		}
		if (["response.completed", "response.done", "response.incomplete", "response.failed"].includes(data.type)) {
			capture.completion = typeof data.response?.status === "string" ? data.response.status : "unfinished";
			if (Array.isArray(data.response?.output)) capture.output = structuredClone(data.response.output);
		}
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant" || !active) return;
		active = false;
		const finished = capture;
		capture = undefined;
		if (expectsHostedSearch && !sawProviderEvent && !warned) {
			warned = true;
			const message = `Hosted search history capture requires Pi >=${HOSTED_SEARCH_CAPTURE_MIN_PI} ` +
				`and raw provider stream events, which were unavailable for this request. ` +
				`Search still runs, but new evidence is not persisted for reload/replay.`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else console.warn(`[pi-openai-toolkit] ${message}`);
		}
		if (finished && finished.responseId === event.message.responseId && finished.provider === event.message.provider &&
			finished.api === event.message.api && finished.model === event.message.model) {
			const { provider, api, model, responseId } = finished;
			const completed = ["stop", "toolUse"].includes(event.message.stopReason) && finished.completion === "completed";
			const streamedItems = [...finished.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
			const record = makeSearchRecord({ provider, api, model, responseId,
				completion: completed ? "completed" : event.message.stopReason },
			finished.output?.length ? finished.output : streamedItems);
			if (record && !branchRecords(ctx).some(r => r.responseId === record.responseId && r.provider === record.provider)) {
				// Stored before the assistant entry, so a fork at that answer retains the evidence.
				pi.appendEntry(SEARCH_HISTORY, record);
				pending = record;
			}
		}
		// A UI failure must not prevent persistence of the evidence above.
		if (ctx.hasUI) ctx.ui.setStatus("toolkit-hosted-search", undefined);
	});
	pi.on("turn_end", () => {
		inTurn = false;
		if (!pending) return;
		const record = pending;
		pending = undefined;
		return { entries: [{
			type: "custom_message" as const, customType: SEARCH_DISPLAY,
			content: displaySearchSummary(record), display: false,
			details: { responseId: record.responseId, provider: record.provider },
		}] };
	});
	pi.on("context", (event, ctx) => {
		const records = branchRecords(ctx);
		const seen = new Set<string>();
		const messages: typeof event.messages = [];
		const visible = new Set(event.messages.flatMap(m => m.role === "assistant" && m.responseId ? [m.responseId] : []));
		for (const message of event.messages) {
			if (message.role === "custom" && message.customType === SEARCH_DISPLAY) {
				const ref = message.details as { responseId?: string; provider?: string } | undefined;
				if (ref?.responseId && visible.has(ref.responseId)) continue;
				const record = records.find(r => r.responseId === ref?.responseId && r.provider === ref?.provider);
				if (record && !seen.has(record.responseId)) {
					messages.push({ ...message, content: contextSummary(record) });
					seen.add(record.responseId);
				} else if (!record) messages.push(message);
				continue;
			}
			messages.push(message);
			if (message.role !== "assistant") continue;
			const record = recordForMessage(records, message);
			if (!record || seen.has(record.responseId)) continue;
			seen.add(record.responseId);
			messages.push({ role: "custom", customType: SEARCH_DISPLAY, content: contextSummary(record),
				details: { responseId: record.responseId, provider: record.provider }, display: false, timestamp: message.timestamp });
		}
		return { messages };
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!ctx.model || !["openai-responses", "openai-codex-responses"].includes(ctx.model.api)) return;
		// The raw response.created can precede normalized assistant message_start.
		// Arm capture at the request boundary, scoped to an active agent turn.
		if (inTurn) {
			active = true; capture = undefined; sawProviderEvent = false;
			expectsHostedSearch = isObject(event.payload) && Array.isArray(event.payload.tools) &&
				event.payload.tools.some((tool: unknown) =>
					isObject(tool) && ["web_search", "web_search_preview"].includes(tool.type));
		}
		const payload = restoreSearchHistory(event.payload, branchRecords(ctx), ctx.model);
		return payload === event.payload ? undefined : payload;
	});
}
