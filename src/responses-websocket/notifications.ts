// Metadata only: never include payloads, credentials, or response IDs.
export type ContinuationOutcome = "delta" | "expected-full" | "prefix-mismatch";
type Listener = (outcome: ContinuationOutcome) => void;
const LISTENERS_KEY = Symbol.for("pi-openai-toolkit.responses-websocket.listeners");
const shared = globalThis as typeof globalThis & { [key: symbol]: Map<string, Set<Listener>> | undefined };
const listeners = shared[LISTENERS_KEY] ??= new Map<string, Set<Listener>>();

export function observeContinuation(sessionId: string, listener: Listener): () => void {
	const group = listeners.get(sessionId) ?? new Set<Listener>();
	group.add(listener);
	listeners.set(sessionId, group);
	return () => {
		if (group.delete(listener) && group.size === 0 && listeners.get(sessionId) === group) listeners.delete(sessionId);
	};
}

export function reportContinuation(sessionId: string, outcome: ContinuationOutcome): void {
	for (const listener of listeners.get(sessionId) ?? []) {
		// A UI failure must not turn a valid model request into a transport retry.
		try { listener(outcome); } catch { /* notification-only */ }
	}
}

export function createFallbackNotifier(notify: (message: string) => void): Listener {
	let warned = false;
	return (outcome) => {
		if (outcome !== "prefix-mismatch") {
			warned = false;
			return;
		}
		if (warned) return;
		warned = true;
		notify("增量未命中：历史前缀不匹配，本次全量上传。");
	};
}
