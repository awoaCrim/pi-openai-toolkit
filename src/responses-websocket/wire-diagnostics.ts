import { createHash } from "node:crypto";

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
};
type State = { previous: Snapshot; recent: WireDiagnostic[] };
const KEY = Symbol.for("pi-openai-toolkit.responses-websocket.wire-diagnostics");
const global = globalThis as typeof globalThis & { [key: symbol]: Map<string, State> | undefined };
const sessions = global[KEY] ??= new Map<string, State>();
const isObject = (x: unknown): x is ObjectValue => x !== null && typeof x === "object" && !Array.isArray(x);
function canonical(x: unknown): unknown {
	if (Array.isArray(x)) return x.map(canonical);
	if (!isObject(x)) return x;
	return Object.fromEntries(Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => [k, canonical(x[k])]));
}
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(canonical(x))).digest("hex");

/** Hashes only: never retain prompt text, ids, cache keys, URLs or credentials. */
export function recordWireRequest(sessionId: string | undefined,
	model: { provider: string; id: string; compat?: unknown },
	body: ObjectValue): void {
	if (!sessionId || !Array.isArray(body.input)) return;
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
	};
	const recent = [...(old?.recent ?? []), diagnostic].slice(-5);
	sessions.delete(sessionId);
	sessions.set(sessionId, { previous: snapshot, recent });
	if (sessions.size > 100) sessions.delete(sessions.keys().next().value!);
}

export function clearWireDiagnostics(sessionId: string): void { sessions.delete(sessionId); }

export function formatWireDiagnostics(sessionId: string): string {
	const recent = sessions.get(sessionId)?.recent;
	if (!recent?.length) return "暂无发送位置指纹。";
	return [
		"发送位置诊断（扩展改写后、WebSocket 增量裁剪前）：",
		...recent.map(d => `${new Date(d.at).toLocaleTimeString("zh-CN", { hour12: false })} | ${d.provider}/${d.model}` +
			` | 实际能力：中途系统提示=${d.midSystem ? "开" : "关"}、增量工具=${d.additionalTools ? "开" : "关"}` +
			` | 顶层工具=${d.topTools}，追加批次=${d.additionalBatches.map(b => `${b.index}:${b.count}`).join(",") || "无"}` +
			` | 旧请求前缀=${d.prefix === "baseline" ? "首次基线" : d.prefix === "preserved" ? "保留" : `变化，首个位置 ${d.firstChangedInput}`}` +
			` | 请求设置变化=${d.changedSettings.join(",") || "无"}`),
		"这里只比较本地实际请求，不代表上游计费缓存；哈希保存在内存，未保存原文。失败或取消的请求也会形成下一次比较基线。",
	].join("\n");
}
