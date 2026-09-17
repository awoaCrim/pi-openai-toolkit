import { expect, test } from "bun:test";
import {
	COMPACTION_CHECKPOINT_PROVENANCE_UNAVAILABLE,
	hasVerifiedCompactionInputProvenance,
} from "./compaction-projection";
import {
	getRemoteV2InputProvenance,
	LEGACY_REMOTE_V2_INPUT_PROVENANCE,
	NATIVE_COMPACTION_INPUT_PROVENANCE,
	createNativeCompactionDetails,
} from "./types";

function details(inputProvenance?: typeof NATIVE_COMPACTION_INPUT_PROVENANCE | typeof LEGACY_REMOTE_V2_INPUT_PROVENANCE) {
	return createNativeCompactionDetails({
		provider: "openai",
		api: "openai-responses",
		model: "gpt-5-mini",
		baseUrl: "https://api.openai.com/v1",
		inputProvenance: inputProvenance ?? NATIVE_COMPACTION_INPUT_PROVENANCE,
		compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
	});
}

test("maps each configured Remote V2 source to its checkpoint marker", () => {
	expect(getRemoteV2InputProvenance("pi-context-hook")).toBe(NATIVE_COMPACTION_INPUT_PROVENANCE);
	expect(getRemoteV2InputProvenance("legacy")).toBe(LEGACY_REMOTE_V2_INPUT_PROVENANCE);
});

test("requires the checkpoint marker to match the configured source", () => {
	expect(hasVerifiedCompactionInputProvenance(details(), NATIVE_COMPACTION_INPUT_PROVENANCE)).toBe(true);
	expect(hasVerifiedCompactionInputProvenance(details(LEGACY_REMOTE_V2_INPUT_PROVENANCE), NATIVE_COMPACTION_INPUT_PROVENANCE)).toBe(false);
	expect(hasVerifiedCompactionInputProvenance(undefined, NATIVE_COMPACTION_INPUT_PROVENANCE)).toBe(false);
	expect(COMPACTION_CHECKPOINT_PROVENANCE_UNAVAILABLE).toBe("unverified-compaction-checkpoint");
});
