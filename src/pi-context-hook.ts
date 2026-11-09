import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ExtensionRunner, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionPayloadProjector } from "./compaction-request";

/** Context property added by the toolkit's host patch. */
export const PI_CONTEXT_PROJECTOR_FIELD = "projectContextForCompaction" as const;
const PI_CONTEXT_PROJECTION_REPORTER_FIELD = "__piOpenAiToolkitReportContextProjectionFailure" as const;
const PATCH_MARKER_FIELD = "__piOpenAiToolkitContextHookPatch" as const;
const PATCH_VERSION = 2;

type ProjectionState = {
	failure?: string;
};

const activeProjectionByRunner = new WeakMap<ExtensionRunner, ProjectionState>();

type PatchedExtensionContext = ExtensionContext & {
	[PI_CONTEXT_PROJECTOR_FIELD]?: PiContextHookProjector;
	projectProviderPayloadForCompaction?: CompactionPayloadProjector;
	[PI_CONTEXT_PROJECTION_REPORTER_FIELD]?: (reason: string) => void;
};

type MarkedCreateContext = typeof ExtensionRunner.prototype.createContext & {
	[PATCH_MARKER_FIELD]?: true | number;
};

/** The ordered context-hook chain, applied to a cloned compaction context. */
export type PiContextHookProjector = (
	messages: readonly AgentMessage[],
) => Promise<readonly AgentMessage[]>;

export type PiContextHookPatchResult =
	| { ok: true; installed: boolean; reason?: "already-installed" }
	| { ok: false; reason: "emit-context-unavailable" | "create-context-unavailable" };

/**
 * Add a narrow projection method to every ExtensionContext created by Pi.
 *
 * Pi 0.87's ordered `ExtensionRunner.emitContext()` runs both `context` and
 * `context_with_system` phases,
 * but the event-level ExtensionContext does not expose the runner. The patch
 * bridges only the method needed by Remote V2; it does not expose the runner
 * or alter Pi's scheduler.
 */
export function installPiContextHookPatch(): PiContextHookPatchResult {
	const prototype = ExtensionRunner.prototype;
	if (typeof prototype.emitContext !== "function") {
		return { ok: false, reason: "emit-context-unavailable" };
	}

	const original = prototype.createContext;
	if (typeof original !== "function") {
		return { ok: false, reason: "create-context-unavailable" };
	}

	const markedOriginal = original as MarkedCreateContext;
	if (markedOriginal[PATCH_MARKER_FIELD] === PATCH_VERSION) {
		return { ok: true, installed: false, reason: "already-installed" };
	}

	const patched = function patchedCreateContext(this: ExtensionRunner): ExtensionContext {
		const context = original.call(this) as PatchedExtensionContext;
		if (typeof this.emitBeforeProviderRequest === "function" && !("projectProviderPayloadForCompaction" in context)) {
			Object.defineProperty(context, "projectProviderPayloadForCompaction", {
				enumerable: false,
				value: async (payload: unknown) => {
					let failure: string | undefined;
					const unsubscribe = this.onError((event) => {
						if (event.event === "before_provider_request") failure = event.error;
					});
					try {
						const projected = await this.emitBeforeProviderRequest(payload);
						if (failure) throw new Error(`Compaction payload projection failed: ${failure}`);
						return projected;
					} finally {
						unsubscribe();
					}
				},
			});
		}
		if (!(PI_CONTEXT_PROJECTOR_FIELD in context)) {
			Object.defineProperty(context, PI_CONTEXT_PROJECTOR_FIELD, {
				configurable: false,
				enumerable: false,
				writable: false,
				value: async (messages: readonly AgentMessage[]) => {
					const state: ProjectionState = {};
					activeProjectionByRunner.set(this, state);
					try {
						const projected = await this.emitContext([...messages]);
						if (state.failure) {
							throw new Error(`context projection failed: ${state.failure}`);
						}
						return projected;
					} finally {
						if (activeProjectionByRunner.get(this) === state) {
							activeProjectionByRunner.delete(this);
						}
					}
				},
			});
		}
		if (!(PI_CONTEXT_PROJECTION_REPORTER_FIELD in context)) {
			Object.defineProperty(context, PI_CONTEXT_PROJECTION_REPORTER_FIELD, {
				configurable: false,
				enumerable: false,
				writable: false,
				value: (reason: string) => {
					const state = activeProjectionByRunner.get(this);
					if (state) state.failure = reason;
				},
			});
		}
		return context;
	};

	Object.defineProperty(patched, PATCH_MARKER_FIELD, {
		configurable: false,
		enumerable: false,
		writable: false,
		value: PATCH_VERSION,
	});
	prototype.createContext = patched;
	return { ok: true, installed: true };
}

/** Return the patched projection method, if this Pi process supports it. */
export function getPiContextHookProjector(
	ctx: ExtensionContext,
): PiContextHookProjector | undefined {
	const candidate = (ctx as PatchedExtensionContext)[PI_CONTEXT_PROJECTOR_FIELD];
	return typeof candidate === "function" ? candidate : undefined;
}

export function getCompactionPayloadProjector(ctx: ExtensionContext): CompactionPayloadProjector | undefined {
	const projector = (ctx as PatchedExtensionContext).projectProviderPayloadForCompaction;
	return typeof projector === "function" ? projector : undefined;
}

/** Preserve fail-closed context-hook errors across Pi's emitContext boundary. */
export function reportPiContextHookFailure(ctx: ExtensionContext, reason: string): void {
	(ctx as PatchedExtensionContext)[PI_CONTEXT_PROJECTION_REPORTER_FIELD]?.(reason);
}
