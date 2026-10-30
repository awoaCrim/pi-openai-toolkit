export type SendRecord = {
	transport: "websocket" | "sse-fallback";
	mode: "full" | "delta";
	reason: string;
	bytes: number;
	items: number;
	at: number;
};
type Stats = { full: number; delta: number; sseFallback: number; recent: SendRecord[] };
const sessions = new Map<string, Stats>();

export function recordSend(sessionId: string | undefined, record: SendRecord): void {
	if (!sessionId) return;
	const stats = sessions.get(sessionId) ?? { full: 0, delta: 0, sseFallback: 0, recent: [] };
	stats[record.mode]++;
	if (record.transport === "sse-fallback") stats.sseFallback++;
	stats.recent.push({ ...record });
	if (stats.recent.length > 5) stats.recent.shift();
	sessions.delete(sessionId);
	sessions.set(sessionId, stats);
	if (sessions.size > 100) sessions.delete(sessions.keys().next().value!);
}

export function clearSendStats(sessionId: string): void { sessions.delete(sessionId); }

export function formatSendStats(sessionId: string): string {
	const stats = sessions.get(sessionId);
	if (!stats) return "No transport samples for this session. Send a request after /reload. Ordinary SSE and other adapters are not observed; no samples does not mean incremental upload is working.";
	return [
		`Transport sends since load: full ${stats.full}, delta ${stats.delta}, SSE fallbacks ${stats.sseFallback}.`,
		...stats.recent.map(r => `${new Date(r.at).toISOString()} | ${r.transport} | ${r.mode} | ${r.bytes} bytes | ${r.items} input items | ${r.reason}`),
		"Payload bytes before TLS/compression, not token usage. Sends include retries, not only successful responses. In-memory samples reset on reload/shutdown; recent 5 shown.",
	].join("\n");
}
