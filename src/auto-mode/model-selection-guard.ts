import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHANNEL = "pi-openai-toolkit:managed-compact-approval-v1";
type SelectionRequest = {
	sessionId: string;
	operationId: string;
	target: { provider: string; id: string };
	eligible: boolean;
	answer: (allowed: boolean, release: () => void) => void;
};

/** A session-local lease preserves an engaged gate; it never makes a tool eligible. */
export function protectAutoModeSelection(pi: ExtensionAPI, request: Omit<SelectionRequest, "answer">): {
	allowed: boolean;
	release: () => void;
} {
	let allowed = true;
	const releases: Array<() => void> = [];
	pi.events?.emit(CHANNEL, {
		...request,
		answer(ok: boolean, release: () => void) { allowed &&= ok; releases.push(release); },
	} satisfies SelectionRequest);
	return { allowed, release: () => { for (const release of releases) release(); } };
}

export function listenForProtectedSelection(
	pi: ExtensionAPI,
	check: (target: SelectionRequest["target"], sessionId: string) => "inactive" | "allow" | "deny",
	setProtected: (operationId: string | undefined) => void,
): () => void {
	let owner: string | undefined;
	const unsubscribe = pi.events?.on(CHANNEL, (data) => {
		if (!data || typeof data !== "object") return;
		const request = data as Partial<SelectionRequest>;
		if (typeof request.sessionId !== "string" || typeof request.operationId !== "string"
			|| typeof request.eligible !== "boolean" || typeof request.answer !== "function"
			|| !request.target || typeof request.target.provider !== "string" || typeof request.target.id !== "string") return;
		let decision: ReturnType<typeof check>;
		try { decision = check(request.target, request.sessionId); }
		catch { request.answer(false, () => {}); return; }
		if (decision === "inactive") return;
		if (decision === "deny" || !request.eligible || owner) { request.answer(false, () => {}); return; }
		owner = request.operationId;
		setProtected(owner);
		request.answer(true, () => {
			if (owner !== request.operationId) return;
			owner = undefined;
			setProtected(undefined);
		});
	});
	return () => { unsubscribe?.(); owner = undefined; setProtected(undefined); };
}
