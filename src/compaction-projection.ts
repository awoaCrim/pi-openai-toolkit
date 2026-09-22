import type {
	NativeCompactionDetails,
	NativeCompactionInputProvenance,
} from "./types";

/** The configured Pi context-hook projector is unavailable or failed. */
export const COMPACTION_PROJECTION_UNAVAILABLE = "no-supported-projection-seam" as const;
/** The current session context could not be read before projection. */
export const COMPACTION_SESSION_CONTEXT_UNAVAILABLE = "session-context-unavailable" as const;
/** A projected recursive context did not contain the current compaction summary. */
export const COMPACTION_PROJECTED_CONTEXT_UNAVAILABLE = "projected-compaction-context-unavailable" as const;
/** The latest opaque checkpoint was created with no or a different input marker. */
export const COMPACTION_CHECKPOINT_PROVENANCE_UNAVAILABLE = "unverified-compaction-checkpoint" as const;

/** Persisted edits changed input already sealed inside an opaque checkpoint. */
export const COMPACTION_CHECKPOINT_CONTEXT_EDITED = "checkpoint-context-edited" as const;

export type UnprojectedCompactionReason =
	| typeof COMPACTION_CHECKPOINT_CONTEXT_EDITED
	| typeof COMPACTION_PROJECTION_UNAVAILABLE
	| typeof COMPACTION_SESSION_CONTEXT_UNAVAILABLE
	| typeof COMPACTION_CHECKPOINT_PROVENANCE_UNAVAILABLE
	| typeof COMPACTION_PROJECTED_CONTEXT_UNAVAILABLE;

/**
 * A Remote V2 checkpoint is safe for the current replay chain only when its
 * marker matches the configured input source. Structural persistence validation
 * intentionally remains more permissive for old session files.
 */
export function hasVerifiedCompactionInputProvenance(
	details: Pick<NativeCompactionDetails, "inputProvenance"> | undefined,
	expected: NativeCompactionInputProvenance,
): boolean {
	return details?.inputProvenance === expected;
}
