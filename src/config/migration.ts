import { resolveToolkitConfig } from "../config";
import type { LoadedToolkitConfig } from "../types";
import type { ConfigOrigin } from "./policy";
import { resolveV2Config } from "./v2";

export type MigrationPreview = {
	status: "ready" | "needs-review" | "already-v2" | "unavailable";
	candidate?: Record<string, unknown>;
	/** Controlled explanations, never arbitrary raw input values. */
	reasons: string[];
	/** Unknown names are masked; paths never expose unknown values. */
	unmappedPaths: string[];
	/** Candidate leaf -> origin in the unchanged legacy source (or built-in). */
	origins?: Record<string, ConfigOrigin>;
};

function modelRef(key: string): { provider: string; id: string; api: string } {
	const slash = key.indexOf("/");
	return { provider: key.slice(0, slash), id: key.slice(slash + 1), api: "openai-responses" };
}

/** Read-only analysis: never edits a source file or claims a lossy candidate is equivalent. */
export function previewToolkitMigration(loaded: LoadedToolkitConfig): MigrationPreview {
	if (loaded.document?.format === "v2") return { status: "already-v2", reasons: ["The document already uses schemaVersion 2."], unmappedPaths: [] };
	if (loaded.document?.format === "invalid" || loaded.document?.format === "missing") {
		return { status: "unavailable", reasons: ["A readable legacy document is required; no candidate was produced."], unmappedPaths: [] };
	}
	const baseline = resolveToolkitConfig(loaded);
	const legacy = baseline.config;
	const { compatibility: _compatibility, diagnostics, ...defaults } = structuredClone(baseline.policy);
	const models: Record<string, unknown> = Object.create(null);
	const origins: Record<string, ConfigOrigin> = Object.create(null);
	const unmappedPaths = new Set(baseline.issues.map((issue) => issue.path));
	for (const [leaf, origin] of Object.entries(baseline.origins)) {
		if (leaf.startsWith("compatibility.")) continue;
		origins[leaf.startsWith("diagnostics.") ? leaf : `defaults.${leaf}`] = origin;
	}
	const keys = new Set([
		...legacy.webSearch.models,
		...Object.keys(legacy.webSearch.routes ?? {}),
		...legacy.autoMode.models,
		...legacy.compaction.gatewayContextModels,
	]);
	for (const key of keys) {
		const resolved = resolveToolkitConfig(loaded, modelRef(key));
		const override: Record<string, unknown> = {};
		if (resolved.policy.webSearch.route !== defaults.webSearch.route) override.webSearch = resolved.policy.webSearch;
		if (resolved.policy.autoMode.available !== defaults.autoMode.available) override.autoMode = { available: resolved.policy.autoMode.available };
		if (resolved.policy.compatibility.transport !== "standard") override.compatibility = resolved.policy.compatibility;
		if (Object.keys(override).length > 0) {
			models[key] = override;
			for (const [feature, fields] of Object.entries(override)) {
				for (const field of Object.keys(fields as Record<string, unknown>)) {
					const leaf = `${feature}.${field}`;
					origins[`models[${JSON.stringify(key)}].${leaf}`] = resolved.origins[leaf];
				}
			}
		}
	}
	const candidate = { schemaVersion: 2, defaults, models, diagnostics };
	const reasons: string[] = [];
	if (loaded.warnings.length || baseline.issues.length) {
		reasons.push("Legacy warnings, unknown fields or normalized invalid values require review. Their original contents remain in the untouched source file.");
	}
	if (legacy.webSearch.enabled && legacy.webSearch.defaultRoute === undefined &&
		legacy.webSearch.models.some((key) => !Object.prototype.hasOwnProperty.call(legacy.webSearch.routes ?? {}, key))) {
		reasons.push("Legacy hosted allowlists ignore unsupported APIs and malformed payloads; explicit v2 hosted routes fail closed. This candidate is not behavior-equivalent on those paths.");
	}
	if (!legacy.webSearch.enabled && (legacy.webSearch.models.length || Object.keys(legacy.webSearch.routes ?? {}).length || legacy.webSearch.defaultRoute)) {
		reasons.push("Disabled legacy search contains dormant routes or a model list; simplified v2 policy does not retain that enable-later intent.");
		if (legacy.webSearch.models.length) unmappedPaths.add("webSearch.models");
		if (Object.keys(legacy.webSearch.routes ?? {}).length) unmappedPaths.add("webSearch.routes");
		if (legacy.webSearch.defaultRoute) unmappedPaths.add("webSearch.defaultRoute");
	}
	if (legacy.webSearch.models.length && (legacy.webSearch.defaultRoute !== undefined ||
		legacy.webSearch.models.some((key) => Object.hasOwn(legacy.webSearch.routes ?? {}, key)))) {
		unmappedPaths.add("webSearch.models");
	}
	if (!legacy.autoMode.enabled && legacy.autoMode.models.length) {
		reasons.push("Disabled legacy auto mode contains a dormant eligibility list; keep the original file for review.");
		unmappedPaths.add("autoMode.models");
	}
	if (!legacy.compaction.enabled && legacy.compaction.contextManagement === "remote") {
		reasons.push("Disabled legacy context management retains a dormant remote mode; the candidate selects Pi ownership.");
		unmappedPaths.add("compaction.contextManagement");
	}
	// Gateway affinity was previously context-mode gated for compaction, and not used by image.
	if (legacy.compaction.gatewayContextModels.length) {
		reasons.push("Gateway compatibility is now shared across features; review synthetic compaction/image affinity before using this candidate.");
	}
	const candidateChecks = [resolveV2Config(candidate, undefined), ...[...keys].map((key) => resolveV2Config(candidate, key))];
	if (candidateChecks.some((resolved) => resolved.issues.length)) reasons.push("The candidate has v2 validation issues; it cannot be applied as-is.");
	return {
		status: reasons.length ? "needs-review" : "ready",
		candidate,
		origins,
		unmappedPaths: [...unmappedPaths],
		reasons: reasons.length ? reasons : ["Recognized active policies map without a known semantic difference. Preview only; no source file was changed."],
	};
}
