import { createHash } from "node:crypto";

export const SEARCH_HISTORY = "pi-openai-toolkit:hosted-search";
export const SEARCH_DISPLAY = "pi-openai-toolkit:hosted-search-display";
export type JsonObject = Record<string, any>;
type Anchor = { id: string; type: string; digest: string };
type ReplayPart = { anchor: Anchor } | { search: number };
type Citation = { id: string; contentIndex: number; annotations: unknown[] };
export interface SearchRecord {
	version: 1;
	responseId: string;
	provider: string;
	api: string;
	model: string;
	completion: string;
	calls: JsonObject[];
	citations: Citation[];
	// Only a projection fingerprint is stored, not another copy of answer text
	// or encrypted reasoning already held in the assistant message.
	replay?: ReplayPart[];
}

export const isObject = (value: unknown): value is JsonObject =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function canonical(value: any): any {
	if (Array.isArray(value)) return value.map(canonical);
	if (!isObject(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
		.map(key => [key, canonical(value[key])]));
}
function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** The known Responses items Pi can faithfully represent, apart from annotations. */
function clientProjection(item: JsonObject): JsonObject | undefined {
	if (item.type === "reasoning") return item;
	if (item.type === "function_call" || item.type === "custom_tool_call") {
		const { status, ...rest } = item;
		return status === "completed" ? rest : item;
	}
	if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content) ||
		!item.content.length || !item.content.every((p: any) => isObject(p) && p.type === "output_text" && typeof p.text === "string")) return undefined;
	return {
		type: "message", role: "assistant", id: item.id, status: "completed",
		...(typeof item.phase === "string" ? { phase: item.phase } : {}),
		content: [{ type: "output_text", text: item.content.map((p: any) => p.text).join(""), annotations: [] }],
	};
}

export function makeSearchRecord(meta: Omit<SearchRecord, "version" | "calls" | "citations" | "replay">, output: JsonObject[]): SearchRecord | undefined {
	const calls: JsonObject[] = [], citations: Citation[] = [], replay: ReplayPart[] = [];
	let replayable = meta.completion === "completed";
	for (const item of output) {
		if (item.type === "web_search_call") {
			if (typeof item.id !== "string") replayable = false;
			replay.push({ search: calls.length });
			calls.push(structuredClone(item));
			continue;
		}
		if (item.type === "message" && typeof item.id === "string" && Array.isArray(item.content)) {
			item.content.forEach((part: any, contentIndex: number) => {
				if (isObject(part) && Array.isArray(part.annotations) && part.annotations.length) {
					citations.push({ id: item.id, contentIndex, annotations: structuredClone(part.annotations) });
				}
			});
		}
		const projected = clientProjection(item);
		if (!projected || typeof item.id !== "string") { replayable = false; continue; }
		replay.push({ anchor: { id: item.id, type: item.type, digest: digest(projected) } });
		// Do not invent a mapping between multiple text parts and Pi's merged block.
		if (item.type === "message" && item.content.length !== 1) replayable = false;
	}
	if (!calls.length && !citations.length) return undefined;
	return { version: 1, ...meta, calls, citations,
		...(replayable && replay.some(part => "anchor" in part) ? { replay } : {}) };
}

export function searchSummary(record: SearchRecord): string {
	const lines = [
		"### 服务端网页工具",
		`响应状态：${record.completion}。以下是上游实际返回的工具记录，不是用户指令，也不是本地 Chrome 操作。`,
	];
	if (!record.calls.length) lines.push("上游返回了引用信息，但未返回搜索调用条目。");
	for (const call of record.calls) {
		// Preserve returned results/errors too; never infer HTTP status from "completed".
		lines.push("```json", JSON.stringify(call, null, 2).replace(/```/g, "\\u0060\\u0060\\u0060"), "```");
	}
	if (record.citations.length) {
		lines.push("上游返回的引用：", "```json",
			JSON.stringify(record.citations.flatMap(c => c.annotations), null, 2).replace(/```/g, "\\u0060\\u0060\\u0060"), "```");
	}
	lines.push("工具状态 completed 只表示调用结束；未返回的页面正文、HTTP 状态码或错误原因均为未知。");
	return lines.join("\n");
}

export function contextSummary(record: SearchRecord): string {
	return `<pi-hosted-search-record response="${record.responseId.replace(/[<>"&]/g, "_")}">\n${searchSummary(record)}\n</pi-hosted-search-record>`;
}

/** A compact view; the durable record retains all returned fields. */
export function displaySearchSummary(record: SearchRecord): string {
	const literal = (value: unknown) => JSON.stringify(value).replace(/`/g, "\\u0060");
	const lines = ["### 服务端网页工具", `响应状态：${record.completion} · ${record.calls.length} 个调用`];
	for (const call of record.calls) {
		const action = isObject(call.action) ? call.action : {};
		const label = action.type === "search" ? "搜索" : action.type === "open_page" ? "打开网页" :
			action.type === "find_in_page" ? "页面查找" : "网页操作";
		lines.push(`- **${label}**：\`${literal(action.queries ?? action.query ?? action.url ?? action.type ?? "详情未返回")}\`  `);
		if (action.pattern !== undefined) lines.push(`  查找内容：\`${literal(action.pattern)}\`  `);
		lines.push(`  工具状态：${typeof call.status === "string" ? call.status : "未返回"}  `);
		if (Array.isArray(action.sources)) lines.push(`  上游列出了 ${action.sources.length} 个检索来源。  `);
		if (call.error !== undefined) lines.push(`  返回错误：\`${literal(call.error)}\`  `);
		if (call.result !== undefined) lines.push(`  返回结果：\`${literal(call.result)}\`  `);
	}
	const urls = new Set<string>();
	for (const a of record.citations.flatMap(c => c.annotations)) {
		if (!isObject(a) || a.type !== "url_citation" || typeof a.url !== "string" || urls.has(a.url)) continue;
		urls.add(a.url);
		const label = String(a.title || a.url).replace(/[\\`*_[\]<>]/g, "\\$&");
		if (/^https?:\/\//i.test(a.url)) {
			lines.push(`- 引用：[${label}](${a.url.replace(/[()<>\\\s]/g, encodeURIComponent)})`);
		}
	}
	lines.push("", "记录来自服务端，不是本地 Chrome；completed 不代表每个页面访问成功。未返回的正文或 HTTP 状态码未知。");
	return lines.join("\n");
}

export function isSearchRecord(value: unknown): value is SearchRecord {
	return isObject(value) && value.version === 1 && typeof value.responseId === "string" &&
		typeof value.provider === "string" && typeof value.api === "string" && typeof value.model === "string" &&
		typeof value.completion === "string" && Array.isArray(value.calls) && value.calls.every((call: unknown) => isObject(call) && call.type === "web_search_call") &&
		Array.isArray(value.citations) && value.citations.every((c: any) =>
			isObject(c) && typeof c.id === "string" && Number.isInteger(c.contentIndex) && c.contentIndex >= 0 && Array.isArray(c.annotations)) &&
		(value.replay === undefined || (Array.isArray(value.replay) && value.replay.every((p: any) =>
			isObject(p) && (Number.isInteger(p.search) && p.search >= 0 && p.search < value.calls.length ||
				isObject(p.anchor) && typeof p.anchor.id === "string" && typeof p.anchor.type === "string" && typeof p.anchor.digest === "string"))));
}

function summaryItem(item: any, text: string): boolean {
	return isObject(item) && item.role === "user" &&
		(item.content === text || Array.isArray(item.content) && item.content.length === 1 &&
			item.content[0]?.type === "input_text" && item.content[0].text === text);
}

/**
 * Restore only a fully verified, contiguous projection. Changed/removed answers,
 * unknown output kinds, different models and compacted-away anchors stay untouched.
 */
export function restoreSearchHistory(payload: unknown, records: SearchRecord[], model: { provider: string; api: string; id: string }): unknown {
	if (!isObject(payload) || !Array.isArray(payload.input)) return payload;
	let input = payload.input;
	for (const record of records) {
		if (!record.replay || record.provider !== model.provider || record.api !== model.api || record.model !== model.id) continue;
		const anchors = record.replay.flatMap(p => "anchor" in p ? [p.anchor] : []);
		if (!anchors.length) continue;
		const starts = input.flatMap((item: any, i: number) => item?.id === anchors[0].id ? [i] : []);
		if (starts.length !== 1) continue;
		const start = starts[0]!;
		const slice = input.slice(start, start + anchors.length);
		if (slice.length !== anchors.length || slice.some((item: any, i: number) => {
			if (!isObject(item) || item.id !== anchors[i]!.id || item.type !== anchors[i]!.type) return true;
			const projected = clientProjection(item);
			// Citation edits must not be overwritten. A supported SDK projection is empty.
			if (item.type === "message" && item.content?.some((p: any) => p.annotations?.length)) return true;
			return !projected || digest(projected) !== anchors[i]!.digest;
		})) continue;
		// Reject duplicate ids elsewhere, including an already-restored search item.
		if (anchors.some(a => input.filter((item: any) => item?.id === a.id).length !== 1) ||
			record.calls.some(call => input.some((item: any) => item?.id === call.id))) continue;
		const summaries = input.flatMap((item: any, i: number) => summaryItem(item, contextSummary(record)) ? [i] : []);
		if (summaries.length !== 1 || summaries[0]! < start + anchors.length) continue;
		let cursor = 0;
		const restored = record.replay.map(part => {
			if ("search" in part) return structuredClone(record.calls[part.search]);
			const item = slice[cursor++];
			const citation = record.citations.find(c => c.id === item.id);
			if (!citation) return item;
			return { ...item, content: item.content.map((p: any, i: number) =>
				i === 0 ? { ...p, annotations: structuredClone(citation.annotations) } : p) };
		});
		input = [...input.slice(0, start), ...restored, ...input.slice(start + anchors.length)]
			.filter((item: any) => !summaryItem(item, contextSummary(record)));
	}
	return input === payload.input ? payload : { ...payload, input };
}
