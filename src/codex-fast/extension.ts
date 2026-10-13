import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig, resolveToolkitConfig } from "../config";
import { resolveEffectiveModel } from "../runtime";
import { isCodexFastModel, rewriteCodexFastPayload } from "./payload";
import { CODEX_FAST_ENTRY_TYPE, readCodexFastState, type CodexFastState } from "./state";

export const CODEX_FAST_STATUS_KEY = "pi-openai-toolkit:codex-fast";

function sessionId(ctx: ExtensionContext): string | undefined {
	try {
		const id = ctx.sessionManager.getSessionId();
		return typeof id === "string" && id.trim() ? id : undefined;
	} catch {
		return undefined;
	}
}

export function registerCodexFastExtension(
	pi: ExtensionAPI,
	loadConfig: typeof loadToolkitConfig = loadToolkitConfig,
	resolveModel: typeof resolveEffectiveModel = resolveEffectiveModel,
): void {
	let currentSessionId: string | undefined;
	let enabled = false;
	let statusEpoch = 0;

	function restore(ctx: ExtensionContext): void {
		currentSessionId = sessionId(ctx);
		try {
			enabled = readCodexFastState(ctx.sessionManager.getBranch(), currentSessionId);
		} catch {
			enabled = false;
		}
	}
	function synchronize(ctx: ExtensionContext): void {
		if (sessionId(ctx) !== currentSessionId) restore(ctx);
	}
	function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(text, level);
	}
	async function eligibleModel(ctx: ExtensionContext, selected = ctx.model): Promise<ExtensionContext["model"]> {
		try {
			const effective = await resolveModel(ctx, selected);
			if (!effective.ok) return undefined;
			if (isCodexFastModel(effective.model)) return effective.model;
			// Only opaque aliases need the existing compatibility marker. Known
			// Codex/GPT routes work without loading or adding Toolkit settings.
			if (effective.model.api !== "openai-responses") return undefined;
			const resolved = resolveToolkitConfig(loadConfig(), selected);
			if (resolved.invalidFeatures.includes("compatibility")) return undefined;
			return isCodexFastModel(effective.model, resolved.gatewayModelKeys, selected) ? effective.model : undefined;
		} catch {
			return undefined;
		}
	}
	async function refreshStatus(ctx: ExtensionContext, model = ctx.model): Promise<void> {
		synchronize(ctx);
		const epoch = ++statusEpoch;
		const id = currentSessionId;
		const eligible = id && await eligibleModel(ctx, model);
		if (epoch !== statusEpoch || sessionId(ctx) !== id) return;
		if (ctx.hasUI) ctx.ui.setStatus(CODEX_FAST_STATUS_KEY, eligible ? "Fast " + (enabled ? "ON" : "OFF") : "Fast N/A");
	}

	pi.on("session_start", async (_event, ctx) => { restore(ctx); await refreshStatus(ctx); });
	pi.on("session_tree", async (_event, ctx) => { restore(ctx); await refreshStatus(ctx); });
	pi.on("model_select", async (event, ctx) => { await refreshStatus(ctx, event.model); });
	pi.on("session_shutdown", (_event, ctx) => {
		statusEpoch++;
		if (ctx.hasUI) ctx.ui.setStatus(CODEX_FAST_STATUS_KEY, undefined);
	});
	pi.registerCommand("fast", {
		description: "Toggle Codex Fast for this session (default OFF; may increase usage/cost).",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || (ctx.mode !== undefined && ctx.mode !== "tui")) {
				notify(ctx, "/fast requires an interactive terminal.", "warning");
				return;
			}
			if (args.trim()) { notify(ctx, "Usage: /fast (toggle ON/OFF)", "warning"); return; }
			synchronize(ctx);
			const id = currentSessionId;
			const selected = ctx.model;
			const model = await eligibleModel(ctx, selected);
			if (!id || sessionId(ctx) !== id || ctx.model !== selected) {
				notify(ctx, "Fast unchanged: session/model unavailable or changed.", "warning");
				return;
			}
			if (!model) { notify(ctx, "Fast unavailable on this model/route.", "warning"); return; }
			const next = !enabled;
			const data: CodexFastState = { version: 1, sessionId: id, enabled: next };
			try {
				pi.appendEntry(CODEX_FAST_ENTRY_TYPE, data);
			} catch {
				notify(ctx, "Fast unchanged: could not save the session preference.", "warning");
				return;
			}
			enabled = next;
			statusEpoch++;
			ctx.ui.setStatus(CODEX_FAST_STATUS_KEY, "Fast " + (next ? "ON" : "OFF"));
			notify(ctx, next
				? "Fast ON for this session's next Codex requests; may increase usage/cost. Backend acceptance is not verified."
				: "Fast OFF for this session's next Codex requests (Standard). No configuration file changed.");
		},
	});
	pi.on("before_provider_request", async (event, ctx) => {
		synchronize(ctx);
		const id = currentSessionId;
		const selection = enabled;
		const selected = ctx.model;
		if (!id) return undefined;
		const model = await eligibleModel(ctx, selected);
		if (!model || sessionId(ctx) !== id || ctx.model !== selected) return undefined;
		return rewriteCodexFastPayload(event.payload, model.id, selection);
	});
}

export default function codexFastExtension(pi: ExtensionAPI): void {
	registerCodexFastExtension(pi);
}
