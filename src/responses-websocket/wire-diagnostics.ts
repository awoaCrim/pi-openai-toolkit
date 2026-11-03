import { createHash } from "node:crypto";
import type { SendRecord } from "./stats";

type ObjectValue = Record<string, unknown>;
type Snapshot = { input: string[]; settings: Record<string, string> };
export type WireDiagnostic = {
	at: number;
	provider: string;
	model: string;
	midSystem: boolean;
	additionalTools: boolean;
	inputItems: number;
	topTools: number;
	additionalBatches: Array<{ index: number; count: number }>;
	prefix: "baseline" | "preserved" | "changed";
	firstChangedInput?: number;
	changedSettings: string[];
	sequence?: number;
	inputFingerprint?: string;
	settingsFingerprint?: string;
	requestedTier?: string;
	returnedTier?: string;
	transport?: SendRecord["transport"] | "sse";
	mode?: SendRecord["mode"];
	sendReason?: string;
	bytes?: number;
	connection?: number;
	finishedAt?: number;
	outcome?: "pending" | "completed" | "incomplete" | "failed" | "aborted";
	usage?: { input: number; cached?: number; output?: number };
	severeMiss?: boolean;
};
type State = { previous: Snapshot; recent: WireDiagnostic[] };
const KEY = Symbol.for("pi-openai-toolkit.responses-websocket.wire-diagnostics");
const global = globalThis as typeof globalThis & { [key: symbol]: Map<string, State> | undefined };
const sessions = global[KEY] ??= new Map<string, State>();
const CACHE_KEY = Symbol.for("pi-openai-toolkit.responses-websocket.cache-diagnostics");
type CacheHistory = { recent: WireDiagnostic[]; misses: WireDiagnostic[] };
type CacheStore = { sequence: number; connection: number; sockets: WeakMap<object, number>; sessions: Map<string, CacheHistory> };
const cacheGlobal = globalThis as typeof globalThis & { [CACHE_KEY]?: CacheStore };
const cache: CacheStore = cacheGlobal[CACHE_KEY] ??= {
	sequence: 0, connection: 0, sockets: new WeakMap<object, number>(), sessions: new Map<string, CacheHistory>(),
};
export const CACHE_DIAGNOSTIC_RECENT_LIMIT = 64;
export const CACHE_DIAGNOSTIC_MISS_LIMIT = 32;
export const CACHE_DIAGNOSTIC_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 100;
const isObject = (x: unknown): x is ObjectValue => x !== null && typeof x === "object" && !Array.isArray(x);
const count = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
function tier(value: unknown): string | undefined {
	return typeof value !== "string" ? undefined :
		["auto", "default", "priority", "flex", "scale", "fast"].includes(value) ? value : "other";
}
function canonical(x: unknown): unknown {
	if (Array.isArray(x)) return x.map(canonical);
	if (!isObject(x)) return x;
	return Object.fromEntries(Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => [k, canonical(x[k])]));
}
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(canonical(x))).digest("hex");

/** Hashes only: never retain prompt text, ids, cache keys, URLs or credentials. */
export function recordWireRequest(sessionId: string | undefined,
	model: { provider: string; id: string; compat?: unknown },
	body: ObjectValue): WireDiagnostic | undefined {
	if (!sessionId || !Array.isArray(body.input)) return undefined;
	expireDiagnostics();
	const settings = Object.fromEntries(Object.entries(body)
		.filter(([k, v]) => k !== "input" && k !== "previous_response_id" && v !== undefined)
		.map(([k, v]) => [k, hash(v)]));
	const snapshot = { input: body.input.map(hash), settings };
	const old = sessions.get(sessionId);
	// Model changes establish a new baseline, not a misleading prefix comparison.
	const previous = old?.recent.at(-1)?.provider === model.provider && old?.recent.at(-1)?.model === model.id ? old.previous : undefined;
	let first = 0;
	if (previous) while (first < previous.input.length && first < snapshot.input.length &&
		previous.input[first] === snapshot.input[first]) first++;
	const diagnostic: WireDiagnostic = {
		at: Date.now(), provider: model.provider, model: model.id,
		midSystem: isObject(model.compat) && model.compat.supportsMidConvoSystemMessages === true,
		additionalTools: isObject(model.compat) && model.compat.supportsAdditionalTools === true,
		inputItems: body.input.length,
		topTools: Array.isArray(body.tools) ? body.tools.length : 0,
		additionalBatches: body.input.flatMap((item, index) => isObject(item) && item.type === "additional_tools"
			? [{ index, count: Array.isArray(item.tools) ? item.tools.length : 0 }] : []),
		prefix: previous ? first === previous.input.length ? "preserved" : "changed" : "baseline",
		...(previous && first < previous.input.length ? { firstChangedInput: first } : {}),
		changedSettings: previous ? [...new Set([...Object.keys(settings), ...Object.keys(previous.settings)])]
			.filter(k => settings[k] !== previous.settings[k]).sort() : [],
		sequence: ++cache.sequence,
		inputFingerprint: hash(snapshot.input),
		settingsFingerprint: hash(settings),
		requestedTier: tier(body.service_tier),
		outcome: "pending",
	};
	const recent = [...(old?.recent ?? []), diagnostic].slice(-5);
	sessions.delete(sessionId);
	sessions.set(sessionId, { previous: snapshot, recent });
	if (sessions.size > 100) sessions.delete(sessions.keys().next().value!);
	remember(sessionId, diagnostic);
	return diagnostic;
}

export function clearWireDiagnostics(sessionId: string): void { sessions.delete(sessionId); }

function expireDiagnostics(): void {
	const cutoff = Date.now() - CACHE_DIAGNOSTIC_TTL_MS;
	for (const [id, value] of sessions) {
		value.recent = value.recent.filter(d => d.at >= cutoff);
		if (!value.recent.length) sessions.delete(id);
	}
	for (const [id, value] of cache.sessions) {
		value.recent = value.recent.filter(d => d.at >= cutoff);
		value.misses = value.misses.filter(d => (d.finishedAt ?? d.at) >= cutoff);
		if (!value.recent.length && !value.misses.length) {
			cache.sessions.delete(id);
			sessions.delete(id);
		}
	}
}

function history(sessionId: string): CacheHistory {
	expireDiagnostics();
	return cache.sessions.get(sessionId) ?? { recent: [], misses: [] };
}

function remember(sessionId: string, diagnostic: WireDiagnostic): void {
	const state = history(sessionId);
	if (diagnostic.at >= Date.now() - CACHE_DIAGNOSTIC_TTL_MS &&
		!state.recent.includes(diagnostic)) state.recent.push(diagnostic);
	state.recent.sort((a, b) => a.at - b.at || (a.sequence ?? 0) - (b.sequence ?? 0));
	state.recent = state.recent.slice(-CACHE_DIAGNOSTIC_RECENT_LIMIT);
	if (diagnostic.severeMiss && !state.misses.includes(diagnostic)) state.misses.push(diagnostic);
	state.misses.sort((a, b) => (a.finishedAt ?? a.at) - (b.finishedAt ?? b.at));
	state.misses = state.misses.slice(-CACHE_DIAGNOSTIC_MISS_LIMIT);
	if (!state.recent.length && !state.misses.length) return;
	cache.sessions.delete(sessionId);
	cache.sessions.set(sessionId, state);
	if (cache.sessions.size > MAX_SESSIONS) {
		const oldest = cache.sessions.keys().next().value!;
		cache.sessions.delete(oldest);
		sessions.delete(oldest);
	}
}

/** Updates the same receipt returned at finalized-payload time, never a "latest request" lookup. */
export function recordWireSend(diagnostic: WireDiagnostic | undefined,
	record: Omit<SendRecord, "transport"> & { transport: WireDiagnostic["transport"] }, socket?: object): void {
	if (!diagnostic) return;
	Object.assign(diagnostic, {
		transport: record.transport, mode: record.mode, bytes: record.bytes, sendReason: record.reason,
		outcome: "pending", finishedAt: undefined,
	});
	if (socket) {
		let id = cache.sockets.get(socket);
		if (id === undefined) { id = ++cache.connection; cache.sockets.set(socket, id); }
		diagnostic.connection = id;
	}
}

export function recordWireFailure(diagnostic: WireDiagnostic | undefined, aborted: boolean): void {
	if (!diagnostic || diagnostic.finishedAt !== undefined) return;
	diagnostic.outcome = aborted ? "aborted" : "failed";
	diagnostic.finishedAt = Date.now();
}

export function recordWireResponse(sessionId: string | undefined, diagnostic: WireDiagnostic | undefined, event: unknown): void {
	if (!sessionId || !diagnostic || diagnostic.finishedAt !== undefined || !isObject(event)) return;
	const outcome = event.type === "response.completed" || event.type === "response.done" ? "completed" :
		event.type === "response.incomplete" ? "incomplete" :
		event.type === "response.failed" || event.type === "error" ? "failed" : undefined;
	if (!outcome) return;
	diagnostic.outcome = outcome;
	diagnostic.finishedAt = Date.now();
	const response = isObject(event.response) ? event.response : undefined;
	diagnostic.returnedTier = tier(response?.service_tier);
	const usage = isObject(response?.usage) ? response.usage : undefined;
	if (usage && count(usage.input_tokens)) {
		const details = isObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
		diagnostic.usage = {
			input: usage.input_tokens,
			...(count(details?.cached_tokens) && details.cached_tokens <= usage.input_tokens ? { cached: details.cached_tokens } : {}),
			...(count(usage.output_tokens) ? { output: usage.output_tokens } : {}),
		};
		diagnostic.severeMiss = diagnostic.usage.input >= 50_000 && diagnostic.usage.cached !== undefined &&
			diagnostic.usage.cached / diagnostic.usage.input < 0.1;
	}
	remember(sessionId, diagnostic);
}

/** Bounded, sanitized snapshots; no provider response IDs or raw stream events. */
export function getCacheDiagnostics(sessionId: string): CacheHistory {
	return JSON.parse(JSON.stringify(history(sessionId))) as CacheHistory;
}

export function clearCacheDiagnostics(sessionId: string): void {
	cache.sessions.delete(sessionId);
	sessions.delete(sessionId);
}

function cacheLine(d: WireDiagnostic): string {
	const usage = d.usage, rate = usage?.cached === undefined || !usage.input ? "未知" : `${(100 * usage.cached / usage.input).toFixed(2)}%`;
	return `#${d.sequence} ${new Date(d.at).toLocaleTimeString("zh-CN", { hour12: false })}` +
		` | ${d.provider}/${d.model} | ${d.transport ?? "未发送"}/${d.mode ?? "未知"}，WS连接=${d.connection ?? "无"}` +
		` | 档位：请求=${d.requestedTier ?? "未提供"}、返回=${d.returnedTier ?? "未返回"}` +
		` | 输入=${usage?.input ?? "未知"}，缓存=${usage?.cached ?? "未知"}，命中=${rate}` +
		` | ${d.outcome ?? "未知"}${d.severeMiss ? "，严重 miss" : ""}` +
		` | 前缀=${d.prefix}${d.firstChangedInput !== undefined ? `@${d.firstChangedInput}` : ""}` +
		`，设置变化=${d.changedSettings.join(",") || "无"}`;
}

export function formatWireDiagnostics(sessionId: string, json = false): string {
	const captured = getCacheDiagnostics(sessionId);
	if (json) return JSON.stringify(captured, null, 2);
	const recent = sessions.get(sessionId)?.recent;
	if (!recent?.length && !captured.recent.length && !captured.misses.length) return "暂无发送位置指纹。";
	return [
		"发送位置诊断（扩展改写后、WebSocket 增量裁剪前）：",
		...(recent ?? []).map(d => `#${d.sequence ?? "—"} ${new Date(d.at).toLocaleTimeString("zh-CN", { hour12: false })} | ${d.provider}/${d.model}` +
			` | 实际能力：中途系统提示=${d.midSystem ? "开" : "关"}、增量工具=${d.additionalTools ? "开" : "关"}` +
			` | 顶层工具=${d.topTools}，追加批次=${d.additionalBatches.map(b => `${b.index}:${b.count}`).join(",") || "无"}` +
			` | 旧请求前缀=${d.prefix === "baseline" ? "首次基线" : d.prefix === "preserved" ? "保留" : `变化，首个位置 ${d.firstChangedInput}`}` +
			` | 请求设置变化=${d.changedSettings.join(",") || "无"}`),
		"最近请求与上游 usage（按同一请求关联）：",
		...captured.recent.slice(-5).map(cacheLine),
		`严重 miss 留存：${captured.misses.length} 条（输入至少 50000 且命中低于 10%）：`,
		...captured.misses.slice(-5).map(cacheLine),
		"本地前缀保留不保证上游命中；请求档位不等于实际返回档位，缺少 usage 不代表未计费。",
		"仅内存哈希与脱敏元数据：每会话最近 64 请求、单独保留 32 次严重 miss，最长 24 小时、最多 100 会话；服务重启清空。会话重载可保留缓存诊断，失败或取消也会形成指纹比较基线。",
	].join("\n");
}
