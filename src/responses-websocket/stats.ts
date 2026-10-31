export type SendRecord = {
	transport: "websocket" | "sse-fallback" | "http-size";
	mode: "full" | "delta";
	reason: string;
	changedFields?: string[];
	bytes: number;
	items: number;
	at: number;
};
type Stats = { full: number; delta: number; sseFallback: number; httpSize?: number; recent: SendRecord[] };
const STATS_KEY = Symbol.for("pi-openai-toolkit.responses-websocket.stats");
const shared = globalThis as typeof globalThis & { [key: symbol]: Map<string, Stats> | undefined };
const sessions = shared[STATS_KEY] ??= new Map<string, Stats>();

export function recordSend(sessionId: string | undefined, record: SendRecord): void {
	if (!sessionId) return;
	const stats = sessions.get(sessionId) ?? { full: 0, delta: 0, sseFallback: 0, recent: [] };
	stats[record.mode]++;
	if (record.transport === "sse-fallback") stats.sseFallback++;
	if (record.transport === "http-size") stats.httpSize = (stats.httpSize ?? 0) + 1;
	stats.recent.push({ ...record });
	if (stats.recent.length > 5) stats.recent.shift();
	sessions.delete(sessionId);
	sessions.set(sessionId, stats);
	if (sessions.size > 100) sessions.delete(sessions.keys().next().value!);
}

export function clearSendStats(sessionId: string): void { sessions.delete(sessionId); }

const REASONS: Record<string, string> = {
	"no cached baseline (new/reconnected socket)": "无缓存基线（新建或重连）",
	"request settings changed": "请求设置发生变化",
	"history shortened": "历史上下文缩短",
	"history prefix mismatch": "历史前缀不匹配",
	"matched continuation": "续传匹配成功",
	"uncached socket (no session/cache disabled/busy)": "未缓存连接（无会话、缓存关闭或连接忙）",
	"WebSocket transport recovery": "WebSocket 故障，回退 SSE",
	"request exceeds WebSocket size threshold": "实际帧达到 15 MiB 安全阈值，直接使用 HTTP/SSE",
};

export function formatSendStats(sessionId: string): string {
	const stats = sessions.get(sessionId);
	if (!stats) return "当前会话暂无传输数据。请在 /reload 后执行一轮任务。普通 SSE 和其他适配器不在采集范围内；无数据不代表增量正常。";
	return [
		`当前会话：全量 ${stats.full} 次，增量 ${stats.delta} 次，SSE 回退 ${stats.sseFallback} 次。大请求 HTTP ${stats.httpSize ?? 0} 次。`,
		...stats.recent.map(r => `${new Date(r.at).toLocaleTimeString("zh-CN", { hour12: false })} | ${r.transport === "websocket" ? "WebSocket" : r.transport === "http-size" ? "大请求 HTTP" : "SSE 回退"} | ${r.mode === "full" ? "全量" : "增量"} | ${r.bytes} 字节 | ${r.items} 条输入 | ${REASONS[r.reason] ?? r.reason}${r.changedFields?.length ? `（${r.changedFields.join(", ")}）` : ""}`),
		"字节数为 TLS／压缩前的请求数据量，不是 token 数；发送次数包含重试，不代表全部成功。只显示最近 5 次；同进程的扩展实例共享统计，该会话资源全部释放或服务重启后清空。",
	].join("\n");
}
