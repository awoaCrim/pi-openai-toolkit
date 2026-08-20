import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "../config";
import type { LoadedToolkitConfig } from "../types";
import { ReasoningTranslationState } from "./state";

function refreshThinkingDisplay(ctx: ExtensionContext | undefined): void {
	if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) return;
	try {
		// Pi exposes no direct transcript invalidation API. Calling the public
		// setter rebuilds assistant components and reruns transformers, while the
		// no-argument form avoids leaving "Translating…" as the global hidden label.
		ctx.ui.setHiddenThinkingLabel();
	} catch {
		// A display refresh is additive; never break the main model stream.
	}
}

function restoreThinkingDisplay(ctx: ExtensionContext | undefined): void {
	if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) return;
	try {
		ctx.ui.setHiddenThinkingLabel();
	} catch {
		// Shutdown/reload must remain failure-open.
	}
}

export function registerReasoningTranslationExtension(
	pi: ExtensionAPI,
	loadConfig: typeof loadToolkitConfig = loadToolkitConfig,
): void {
	let latestContext: ExtensionContext | undefined;
	const state = new ReasoningTranslationState({
		onDisplayChanged: () => refreshThinkingDisplay(latestContext),
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant-thinking" || latestContext?.mode !== "tui") return markdown;
		return state.lookupDisplay(markdown) ?? markdown;
	});

	pi.on("session_start", (_event, ctx) => {
		latestContext = ctx;
		state.abortActive();
		const { config } = loadConfig() as LoadedToolkitConfig;
		state.hydrate(ctx, config.reasoningTranslation);
	});

	pi.on("session_tree", (_event, ctx) => {
		latestContext = ctx;
		state.abortActive();
		const { config } = loadConfig() as LoadedToolkitConfig;
		state.hydrate(ctx, config.reasoningTranslation);
	});

	pi.on("session_before_switch", () => {
		state.abortActive();
	});

	pi.on("session_before_fork", () => {
		state.abortActive();
	});

	pi.on("session_before_tree", () => {
		state.abortActive();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (latestContext === ctx) latestContext = undefined;
		state.abortActive();
		restoreThinkingDisplay(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		latestContext = ctx;
		state.abortActive();
		const { config } = loadConfig() as LoadedToolkitConfig;
		state.setDisplayEligibility(ctx, config.reasoningTranslation);
	});

	pi.on("message_start", (event, ctx) => {
		latestContext = ctx;
		const { config } = loadConfig() as LoadedToolkitConfig;
		state.beginMessage(event.message, ctx, config.reasoningTranslation);
	});

	pi.on("message_update", (event, ctx) => {
		latestContext = ctx;
		if (ctx.mode !== "tui") return;
		const update = event.assistantMessageEvent;
		if (update.type !== "thinking_delta" && update.type !== "thinking_end") return;
		state.handleMessageUpdate(event.message, update.type, update.contentIndex);
	});

	pi.on("message_end", (event, ctx) => {
		latestContext = ctx;
		if (ctx.mode !== "tui") return;
		state.finishMessage(event.message);
	});

}

export default function reasoningTranslationExtension(pi: ExtensionAPI): void {
	registerReasoningTranslationExtension(pi);
}
