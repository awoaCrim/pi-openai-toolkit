import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig, resolveToolkitConfig } from "../config";
import { notifyConfigIssues } from "../config/notifications";
import { ASTRA_MODEL_ID } from "../types";
import { CODEX_CLIENT_VERSION } from "../responses-headers";
import {
	getEffortControlState,
	planStableEffort,
	type EffortControlState,
	type PlannableInputItem,
} from "./effort-planner";

type AstraPayload = {
	model: string;
	input: PlannableInputItem[];
	reasoning: { effort: string; [key: string]: unknown };
	[key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Recognize the live Codex Responses request body: model + wire input array
 * + a request-level string effort. Anything else (titles, embeddings, or a
 * shape we do not understand) is left untouched.
 */
function parseAstraPayload(payload: unknown): AstraPayload | undefined {
	if (!isRecord(payload)) return undefined;
	if (typeof payload.model !== "string") return undefined;
	if (!Array.isArray(payload.input)) return undefined;
	const reasoning = payload.reasoning;
	if (!isRecord(reasoning) || typeof reasoning.effort !== "string") return undefined;
	if (reasoning.effort.length === 0 || reasoning.effort === "none") return undefined;
	if (!payload.input.every((item) => isRecord(item))) return undefined;
	return payload as unknown as AstraPayload;
}

function isCompactionShaped(payload: AstraPayload): boolean {
	// A `compaction_trigger` history belongs to a compact endpoint request,
	// which rejects `configuration_update` items. Our compaction clients use
	// direct fetch and never reach this hook; this guard covers any future
	// provider-routed compaction.
	const last = payload.input[payload.input.length - 1];
	return !!last && isRecord(last) && last.type === "compaction_trigger";
}

function getSessionId(ctx: { sessionManager: { getSessionId(): string } }): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

export function registerCodexAstraExtension(
	pi: ExtensionAPI,
	loadConfig: typeof loadToolkitConfig = loadToolkitConfig,
): void {
	const states = new Map<string, EffortControlState>();

	// Switching or forking a session rebuilds the runtime and re-fires
	// session_start; clearing there covers every replacement path.
	pi.on("session_start", () => {
		states.clear();
	});

	pi.on("model_select", () => {
		states.clear();
	});

	pi.on("before_provider_request", (event, ctx) => {
		try {
			// Pi already encodes the selected thinking level in the payload.
			// Only opt-in Astra Responses requests may pin it to a cache baseline.
			const model = ctx.model;
			const resolved = resolveToolkitConfig(loadConfig(), model);
			notifyConfigIssues(ctx, resolved);
			const enabled = !resolved.invalidFeatures.includes("reasoning") && resolved.policy.reasoning.effortOverride;
			if (!enabled || !model || model.api !== "openai-responses" || model.id !== ASTRA_MODEL_ID) {
				states.clear();
				return undefined;
			}

			const payload = parseAstraPayload(event.payload);
			// The payload must belong to the model the eligibility check just
			// passed; a mismatch means this request is not ours to plan.
			if (!payload || payload.model !== model.id) return undefined;
			if (isCompactionShaped(payload)) return undefined;

			const sessionId = getSessionId(ctx);
			const state = getEffortControlState(
				states,
				`${model.provider}\u0000${model.api}\u0000${model.baseUrl ?? ""}\u0000${model.id}\u0000${sessionId ?? "no-session"}`,
			);

			// Idempotence: never plan on top of items a previous pass injected.
			const history = payload.input.filter((item) => item.type !== "configuration_update");
			const { input, result } = planStableEffort(state, history, payload.reasoning.effort);
			if (result.effort === payload.reasoning.effort && result.spliced === 0) return undefined;

			return {
				...payload,
				input,
				reasoning: { ...payload.reasoning, effort: result.effort },
			};
		} catch {
			// A planner failure must never break the provider request path.
			states.clear();
			return undefined;
		}
	});

	pi.on("before_provider_headers", (event, ctx) => {
		try {
			const model = ctx.model;
			if (!model || model.api !== "openai-codex-responses") return;
			// Live requests need the same backend version gate as our synthetic
			// ones: an old or missing `version` never reaches gated SKUs.
			if (!event.headers.version) {
				event.headers.version = CODEX_CLIENT_VERSION;
			}
		} catch {
			// Header injection is best-effort.
		}
	});
}

export default function codexAstraExtension(pi: ExtensionAPI): void {
	registerCodexAstraExtension(pi);
}
