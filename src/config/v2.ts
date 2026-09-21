/**
 * Version 2 global Toolkit configuration: validation, known-field merge and per-leaf
 * provenance.
 *
 * This module is a pure decoder. It performs no file I/O, no path resolution, no auth or
 * provider lookup and no tool mutation, and it deliberately depends on no JSON Schema
 * library. The shipped `config.schema.json` mirrors the accepted document, and the runtime
 * checks in this file stay the authority.
 *
 * Document shape (`schemaVersion` must be exactly 2):
 *
 * ```jsonc
 * {
 *   "schemaVersion": 2,
 *   "$schema": "…metadata only…",
 *   "defaults": { "context": …, "webSearch": …, "imageGeneration": …, "autoMode": … },
 *   "models": { "provider/model-id": { "context": …, "webSearch": …, "autoMode": …, "compatibility": … } },
 *   "diagnostics": { … }
 * }
 * ```
 *
 * Rules:
 * - Precedence is built-ins -> `defaults` -> the exact override of the resolved model.
 * - Only known nested objects merge by field; arrays replace; `false` and `0` stay meaningful.
 * - `null` is accepted only for the optional producer/reviewer/classifier model references and
 *   clears an inherited reference. `null` anywhere else is a path-specific error and never
 *   deletes an object.
 * - Unknown properties are errors with masked names. Model-key diagnostic segments are bounded;
 *   raw values and unknown subtrees are never copied into diagnostics.
 * - `defaults.compatibility` is not a recognized scope: the standard transport is internal and
 *   the Codex gateway transport stays an exact-model opt-in.
 * - Image output settings (`defaults.imageGeneration`) and `diagnostics` are global only.
 * - Exact model keys and model references use the legacy `provider/model-id` grammar: no
 *   whitespace, globs or bracket patterns. Keys are trimmed like the legacy decoder, and two
 *   raw keys that normalize to the same key are rejected instead of resolved last-wins.
 *
 * Fail-closed contract for consumers: `policy` always carries the best known value for every
 * leaf, so an invalid present value keeps the inherited or built-in value instead of silently
 * falling through to another route. The blocking signal is `invalidFeatures`, which is scoped to
 * the resolved model: a leaf error in `defaults` marks the owning feature for every model, a
 * leaf error in the resolved model's override marks that feature for that model only, an error
 * in a different model is reported without invalidating the current selection, and a valid exact
 * override shadows an invalid `defaults` leaf. Malformed document sections and unknown
 * properties inside a feature scope are feature-level errors that no override can mask.
 * `origins` explains the effective value of every leaf, so an ignored invalid value never claims
 * provenance it does not own.
 *
 * Unversioned documents belong to the legacy adapter and must not be routed here: a missing or
 * non-2 `schemaVersion`, a mixed legacy/v2 root and a non-object root are fatal document errors
 * that resolve the shipped defaults and mark every feature invalid.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { MAX_IMAGE_MODEL_ID_CHARS } from "../image-generation/types";
import {
	BREAKER_LIMIT_MAX,
	BREAKER_LIMIT_MIN,
	BREAKER_WINDOW_MAX,
	BREAKER_WINDOW_MIN,
	CLASSIFIER_MAX_LAG_MAX,
	CLASSIFIER_MAX_LAG_MIN,
	EVIDENCE_ROUNDS_MAX,
	EVIDENCE_ROUNDS_MIN,
	RESPONSES_COMPACT_CAPABLE_APIS,
	REVIEWER_TIMEOUT_MAX_MS,
	REVIEWER_TIMEOUT_MIN_MS,
	THINKING_LEVELS,
} from "../types";
import {
	CONFIG_FEATURES,
	createPolicyDefaults,
	type ConfigFeature,
	type ConfigIssue,
	type ConfigOrigin,
	type EffectiveToolkitPolicy,
	type ResolvedToolkitPolicy,
	type SearchRoute,
} from "./policy";

/**
 * Stable, controlled diagnostic codes. Adding a code is a compatible change; consumers may
 * match on these strings but must not build messages from raw configuration values.
 */
export const V2_ISSUE = {
	rootInvalid: "document.root.invalid",
	schemaVersionMissing: "document.schemaVersion.missing",
	schemaVersionUnsupported: "document.schemaVersion.unsupported",
	formatMixed: "document.format.mixed",
	schemaInvalid: "document.$schema.invalid",
	defaultsInvalid: "document.defaults.invalid",
	modelsInvalid: "document.models.invalid",
	diagnosticsInvalid: "document.diagnostics.invalid",
	scopeInvalid: "scope.invalid",
	keyUnknown: "key.unknown",
	keyInvalid: "models.key.invalid",
	keyDuplicate: "models.key.duplicate",
	expectedBoolean: "value.expected.boolean",
	expectedString: "value.expected.string",
	expectedList: "value.expected.list",
	expectedInteger: "value.expected.integer",
	expectedEnum: "value.expected.enum",
	expectedModel: "value.expected.model",
	nullUnsupported: "value.null.unsupported",
	range: "value.range",
	length: "value.length",
	empty: "value.empty",
	apiUnsupported: "value.api.unsupported",
	imageDefaultNotAllowed: "imageGeneration.defaultModel.notAllowed",
} as const;

const CONTEXT_MODES = ["pi", "remote-compaction", "remote-windows"] as const;
const INPUT_SOURCES = ["legacy", "pi-context-hook"] as const;
const LEAVE_MANAGED_MODES = ["warn", "compact"] as const;
const SEARCH_ROUTES = ["unmanaged", "local", "hosted", "standalone-alpha"] as const;
const AUTO_GATES = ["side-effect", "all"] as const;
const TRANSPORTS = ["standard", "codex-gateway"] as const;
const DIAGNOSTIC_LEVELS = ["error", "warn", "info", "debug"] as const;

/** v1 root sections; their presence next to `schemaVersion: 2` is a mixed-format document. */
const LEGACY_ROOT_KEYS = ["compaction", "webSearch", "imageGeneration", "autoMode"] as const;

const ROOT_KEYS = new Set(["$schema", "schemaVersion", "defaults", "models", "diagnostics"]);
const DEFAULTS_KEYS = new Set(["context", "webSearch", "imageGeneration", "autoMode"]);
const MODEL_OVERRIDE_KEYS = new Set(["context", "webSearch", "autoMode", "compatibility"]);
const CONTEXT_KEYS = new Set(["mode", "remoteCompaction", "nativeFallback", "remoteWindows"]);
const REMOTE_COMPACTION_KEYS = new Set(["model", "inputSource", "allowContinuityBreak", "apis"]);
const NATIVE_FALLBACK_KEYS = new Set(["enabled", "model", "thinkingLevel"]);
const REMOTE_WINDOWS_KEYS = new Set(["leaveManagedMode", "reminderThresholdPercent"]);
const WEB_SEARCH_KEYS = new Set(["route"]);
const IMAGE_GENERATION_KEYS = new Set(["enabled", "defaultModel", "allowedModels"]);
const AUTO_MODE_KEYS = new Set([
	"available",
	"reviewerModel",
	"gate",
	"extraTools",
	"timeoutMs",
	"transcript",
	"evidenceTools",
	"maxEvidenceRounds",
	"classifier",
	"circuitBreaker",
]);
const CLASSIFIER_KEYS = new Set(["enabled", "model", "timeoutMs", "maxLag"]);
const BREAKER_KEYS = new Set(["consecutiveDenials", "recentDenials", "windowSize"]);
const COMPATIBILITY_KEYS = new Set(["transport"]);
const DIAGNOSTICS_KEYS = new Set([
	"level",
	"notifyOnLoad",
	"captureRequests",
	"captureResponses",
	"redactSensitiveData",
	"artifactRoot",
]);

/** Features a `models[exactKey]` entry is able to own. */
const MODEL_OVERRIDABLE_FEATURES: readonly ConfigFeature[] = [
	"context",
	"webSearch",
	"autoMode",
	"compatibility",
];

/**
 * Feature names usable as unknown-property attribution. `compaction` is the legacy name of the
 * context section, so a v2 document that still uses it fails the owning feature closed instead
 * of dropping the intent.
 */
const FEATURE_NAMES: ReadonlyMap<string, ConfigFeature> = new Map<string, ConfigFeature>([
	["context", "context"],
	["compaction", "context"],
	["webSearch", "webSearch"],
	["imageGeneration", "imageGeneration"],
	["autoMode", "autoMode"],
	["compatibility", "compatibility"],
	["diagnostics", "diagnostics"],
]);

/**
 * Every effective leaf of `EffectiveToolkitPolicy`. Resolution fills `origins` for exactly these
 * paths, so a read-only explanation can account for every value that reaches a consumer.
 */
const POLICY_LEAVES: readonly { leaf: string; feature: ConfigFeature }[] = [
	{ leaf: "context.mode", feature: "context" },
	{ leaf: "context.remoteCompaction.model", feature: "context" },
	{ leaf: "context.remoteCompaction.inputSource", feature: "context" },
	{ leaf: "context.remoteCompaction.allowContinuityBreak", feature: "context" },
	{ leaf: "context.remoteCompaction.apis", feature: "context" },
	{ leaf: "context.nativeFallback.enabled", feature: "context" },
	{ leaf: "context.nativeFallback.model", feature: "context" },
	{ leaf: "context.nativeFallback.thinkingLevel", feature: "context" },
	{ leaf: "context.remoteWindows.leaveManagedMode", feature: "context" },
	{ leaf: "context.remoteWindows.reminderThresholdPercent", feature: "context" },
	{ leaf: "webSearch.route", feature: "webSearch" },
	{ leaf: "imageGeneration.enabled", feature: "imageGeneration" },
	{ leaf: "imageGeneration.defaultModel", feature: "imageGeneration" },
	{ leaf: "imageGeneration.allowedModels", feature: "imageGeneration" },
	{ leaf: "autoMode.available", feature: "autoMode" },
	{ leaf: "autoMode.reviewerModel", feature: "autoMode" },
	{ leaf: "autoMode.gate", feature: "autoMode" },
	{ leaf: "autoMode.extraTools", feature: "autoMode" },
	{ leaf: "autoMode.timeoutMs", feature: "autoMode" },
	{ leaf: "autoMode.transcript", feature: "autoMode" },
	{ leaf: "autoMode.evidenceTools", feature: "autoMode" },
	{ leaf: "autoMode.maxEvidenceRounds", feature: "autoMode" },
	{ leaf: "autoMode.classifier.enabled", feature: "autoMode" },
	{ leaf: "autoMode.classifier.model", feature: "autoMode" },
	{ leaf: "autoMode.classifier.timeoutMs", feature: "autoMode" },
	{ leaf: "autoMode.classifier.maxLag", feature: "autoMode" },
	{ leaf: "autoMode.circuitBreaker.consecutiveDenials", feature: "autoMode" },
	{ leaf: "autoMode.circuitBreaker.recentDenials", feature: "autoMode" },
	{ leaf: "autoMode.circuitBreaker.windowSize", feature: "autoMode" },
	{ leaf: "compatibility.transport", feature: "compatibility" },
	{ leaf: "diagnostics.level", feature: "diagnostics" },
	{ leaf: "diagnostics.notifyOnLoad", feature: "diagnostics" },
	{ leaf: "diagnostics.captureRequests", feature: "diagnostics" },
	{ leaf: "diagnostics.captureResponses", feature: "diagnostics" },
	{ leaf: "diagnostics.redactSensitiveData", feature: "diagnostics" },
	{ leaf: "diagnostics.artifactRoot", feature: "diagnostics" },
];

/** Longest unrecognized key echoed into a diagnostic path. */
const MAX_DIAGNOSTIC_SEGMENT_CHARS = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
/** Characters that make a model key a pattern rather than an exact key. */
const MODEL_KEY_PATTERN_CHARACTERS = /[\s*?[\]{}]/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Exact `provider/model-id` grammar shared with the legacy decoder: one separator, non-empty
 * halves, no whitespace and no glob/bracket characters.
 */
function isExactModelKey(value: string): boolean {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator >= value.length - 1) return false;
	return !MODEL_KEY_PATTERN_CHARACTERS.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Bound an unrecognized key before it reaches a diagnostic path; the text is never a value. */
function boundedSegment(value: string): string {
	const cleaned = value.replace(CONTROL_CHARACTERS, "");
	return cleaned.length > MAX_DIAGNOSTIC_SEGMENT_CHARS
		? `${cleaned.slice(0, MAX_DIAGNOSTIC_SEGMENT_CHARS)}…`
		: cleaned;
}

function joinPath(prefix: string, segment: string): string {
	return prefix ? `${prefix}.${segment}` : segment;
}

/** Input JSON path of a model scope, e.g. `models["openai/gpt-5.2"]`. */
function modelScopePath(key: string): string {
	return `models[${JSON.stringify(key)}]`;
}

// ---------------------------------------------------------------------------------------------
// Document scopes
// ---------------------------------------------------------------------------------------------

type ScopeKind = "document" | "defaults" | "model";

type Scope = {
	/** JSON path of the scope object inside the user document; `""` is the document root. */
	input: string;
	kind: ScopeKind;
	/** Normalized exact key when `kind` is `"model"`. */
	modelKey?: string;
};

const DOCUMENT_SCOPE: Scope = { input: "", kind: "document" };

function subScope(scope: Scope, key: string): Scope {
	return { ...scope, input: joinPath(scope.input, key) };
}

type FieldDescriptor = {
	/** Key inside the owning JSON object. */
	key: string;
	/** Effective policy leaf path, matching an entry in `POLICY_LEAVES`. */
	leaf: string;
	feature: ConfigFeature;
};

type LeafState = {
	feature: ConfigFeature;
	/** A present `defaults` value for this leaf failed validation. */
	invalidAtDefaults: boolean;
	/** A present override of the resolved model for this leaf failed validation. */
	invalidAtModel: boolean;
	/** A valid override of the resolved model supplied this leaf. */
	modelApplied: boolean;
};

type ResolutionState = {
	policy: EffectiveToolkitPolicy;
	origins: Record<string, ConfigOrigin>;
	issues: ConfigIssue[];
	leaves: Map<string, LeafState>;
	/** Feature-level errors a valid exact override cannot mask. */
	hardInvalid: Set<ConfigFeature>;
	/** Fatal document error: nothing is trusted and every feature is invalid. */
	untrusted: boolean;
	selectedKey: string | undefined;
	gatewayCandidates: Set<string>;
};

function createState(modelKey: string | undefined): ResolutionState {
	const origins: Record<string, ConfigOrigin> = {};
	for (const { leaf } of POLICY_LEAVES) origins[leaf] = { kind: "builtin" };
	const trimmed = typeof modelKey === "string" ? modelKey.trim() : "";
	return {
		policy: createPolicyDefaults(),
		origins,
		issues: [],
		leaves: new Map(),
		hardInvalid: new Set(),
		gatewayCandidates: new Set(),
		untrusted: false,
		selectedKey: trimmed.length > 0 ? trimmed : undefined,
	};
}

/** `defaults` and `diagnostics` always reach the resolved policy; a model scope only matches itself. */
function scopeApplies(state: ResolutionState, scope: Scope): boolean {
	if (scope.kind === "model") return scope.modelKey === state.selectedKey;
	return true;
}

function leafState(state: ResolutionState, leaf: string, feature: ConfigFeature): LeafState {
	let entry = state.leaves.get(leaf);
	if (!entry) {
		entry = { feature, invalidAtDefaults: false, invalidAtModel: false, modelApplied: false };
		state.leaves.set(leaf, entry);
	}
	return entry;
}

function withModel(scope: Scope, issue: ConfigIssue): ConfigIssue {
	return scope.modelKey === undefined ? issue : { ...issue, modelKey: scope.modelKey };
}

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------

function fatalDocumentError(state: ResolutionState, code: string, path: string): void {
	state.issues.push({ severity: "error", code, path, feature: "document" });
	state.untrusted = true;
}

/** A value that is present but not usable for the leaf it was written to. */
function reportLeafError(
	state: ResolutionState,
	scope: Scope,
	field: FieldDescriptor,
	code: string,
	inputPath: string,
): void {
	state.issues.push(
		withModel(scope, { severity: "error", code, path: inputPath, feature: field.feature }),
	);
	if (!scopeApplies(state, scope)) return;
	const leaf = leafState(state, field.leaf, field.feature);
	if (scope.kind === "model") leaf.invalidAtModel = true;
	else leaf.invalidAtDefaults = true;
}

/** A malformed object scope: the feature it owns cannot be trusted, override or not. */
function reportScopeError(
	state: ResolutionState,
	scope: Scope,
	feature: ConfigFeature | "document",
	code: string,
	inputPath: string,
): void {
	state.issues.push(
		withModel(scope, { severity: "error", code, path: inputPath, feature }),
	);
	if (scopeApplies(state, scope)) {
		if (feature === "document") markModelOverrideInvalid(state, scope);
		else state.hardInvalid.add(feature);
	}
}

function markModelOverrideInvalid(state: ResolutionState, scope: Scope): void {
	if (!scopeApplies(state, scope)) return;
	for (const feature of MODEL_OVERRIDABLE_FEATURES) state.hardInvalid.add(feature);
}

/**
 * Unknown properties are errors in their owning scope. A key named after a feature (or its
 * legacy alias) fails that feature closed; otherwise the containing feature scope fails closed;
 * an unmapped key blocks its containing model scope (or the document for a root/default key).
 */
function reportUnknownKeys(
	container: Record<string, unknown>,
	known: ReadonlySet<string>,
	scope: Scope,
	state: ResolutionState,
	owningFeature: ConfigFeature | undefined,
): void {
	for (const key of Object.keys(container)) {
		if (known.has(key)) continue;
		const feature = owningFeature ?? FEATURE_NAMES.get(key) ?? "document";
		state.issues.push(
			withModel(scope, {
				severity: "error",
				code: V2_ISSUE.keyUnknown,
				path: joinPath(scope.input, "[unknown-field]"),
				feature,
			}),
		);
		if (scopeApplies(state, scope)) {
			if (feature !== "document") state.hardInvalid.add(feature);
			else if (scope.kind === "model") markModelOverrideInvalid(state, scope);
			else state.untrusted = true;
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Value readers
// ---------------------------------------------------------------------------------------------

type ReadResult<T> = { ok: true; value: T } | { ok: false; code: string };

function typeCode(value: unknown, expected: string): string {
	return value === null ? V2_ISSUE.nullUnsupported : expected;
}

function readBoolean(value: unknown): ReadResult<boolean> {
	return typeof value === "boolean"
		? { ok: true, value }
		: { ok: false, code: typeCode(value, V2_ISSUE.expectedBoolean) };
}

function readEnum<T extends string>(allowed: readonly T[], value: unknown): ReadResult<T> {
	if (typeof value !== "string") {
		return { ok: false, code: typeCode(value, V2_ISSUE.expectedString) };
	}
	const normalized = value.trim();
	for (const entry of allowed) {
		if (entry === normalized) return { ok: true, value: entry };
	}
	return { ok: false, code: V2_ISSUE.expectedEnum };
}

function readInteger(value: unknown, min: number, max: number): ReadResult<number> {
	if (typeof value !== "number") {
		return { ok: false, code: typeCode(value, V2_ISSUE.expectedInteger) };
	}
	if (!Number.isInteger(value) || value < min || value > max) {
		return { ok: false, code: V2_ISSUE.range };
	}
	return { ok: true, value };
}

function readThinkingLevel(value: unknown): ReadResult<ThinkingLevel> {
	return readEnum(THINKING_LEVELS, value);
}

/** A non-empty, trimmed string such as `artifactRoot`. */
function readNonEmptyString(value: unknown, maxChars?: number): ReadResult<string> {
	if (typeof value !== "string") {
		return { ok: false, code: typeCode(value, V2_ISSUE.expectedString) };
	}
	const normalized = value.trim();
	if (normalized.length === 0) return { ok: false, code: V2_ISSUE.empty };
	if (maxChars !== undefined && normalized.length > maxChars) {
		return { ok: false, code: V2_ISSUE.length };
	}
	return { ok: true, value: normalized };
}

/** Exact `provider/model-id` reference; `null` clears an inherited reference. */
function readModelRef(value: unknown): ReadResult<string | null> {
	if (value === null) return { ok: true, value: null };
	if (typeof value !== "string") {
		return { ok: false, code: V2_ISSUE.expectedModel };
	}
	const normalized = value.trim();
	if (normalized.length === 0) return { ok: false, code: V2_ISSUE.empty };
	if (!isExactModelKey(normalized)) return { ok: false, code: V2_ISSUE.expectedModel };
	return { ok: true, value: normalized };
}

/** Order-preserving string list with the legacy trim/dedupe/drop-blank normalization. */
function readStringList(
	value: unknown,
	options?: { maxEntryChars?: number; requireNonEmpty?: boolean },
): ReadResult<string[]> {
	if (!Array.isArray(value)) {
		return { ok: false, code: typeCode(value, V2_ISSUE.expectedList) };
	}
	const entries: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			return { ok: false, code: V2_ISSUE.expectedString };
		}
		const normalized = item.trim();
		if (normalized.length === 0) continue;
		if (options?.maxEntryChars !== undefined && normalized.length > options.maxEntryChars) {
			return { ok: false, code: V2_ISSUE.length };
		}
		if (!entries.includes(normalized)) entries.push(normalized);
	}
	if (options?.requireNonEmpty && entries.length === 0) {
		return { ok: false, code: V2_ISSUE.empty };
	}
	return { ok: true, value: entries };
}

function readImageModelList(value: unknown): ReadResult<string[]> {
	return readStringList(value, {
		maxEntryChars: MAX_IMAGE_MODEL_ID_CHARS,
		requireNonEmpty: true,
	});
}

// ---------------------------------------------------------------------------------------------
// Field application
// ---------------------------------------------------------------------------------------------

/**
 * Apply one known leaf when it is present: validate, and on success write the effective value,
 * record its origin and mark the leaf supplied for the resolved model. An invalid present value
 * is reported and leaves the previously resolved value and origin untouched.
 */
function applyField<T>(
	container: Record<string, unknown>,
	field: FieldDescriptor,
	scope: Scope,
	state: ResolutionState,
	read: (value: unknown) => ReadResult<T>,
	assign: (value: T) => void,
): void {
	if (!Object.hasOwn(container, field.key)) return;
	const inputPath = joinPath(scope.input, field.key);
	const result = read(container[field.key]);
	if (!result.ok) {
		reportLeafError(state, scope, field, result.code, inputPath);
		return;
	}
	if (!scopeApplies(state, scope)) return;
	assign(result.value);
	state.origins[field.leaf] = {
		kind: scope.kind === "defaults" ? "defaults" : "model",
		path: inputPath,
	};
	if (scope.kind === "model") leafState(state, field.leaf, field.feature).modelApplied = true;
}

/** Open a nested known object; a present non-object is a scope error for the owning feature. */
function openGroup(
	container: Record<string, unknown>,
	key: string,
	scope: Scope,
	state: ResolutionState,
	feature: ConfigFeature,
): { raw: Record<string, unknown>; scope: Scope } | undefined {
	if (!Object.hasOwn(container, key)) return undefined;
	const value = container[key];
	if (!isRecord(value)) {
		reportScopeError(state, scope, feature, V2_ISSUE.scopeInvalid, joinPath(scope.input, key));
		return undefined;
	}
	return { raw: value, scope: subScope(scope, key) };
}

// ---------------------------------------------------------------------------------------------
// Feature scopes
// ---------------------------------------------------------------------------------------------

function applyContextSettings(
	raw: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	reportUnknownKeys(raw, CONTEXT_KEYS, scope, state, "context");

	applyField(
		raw,
		{ key: "mode", leaf: "context.mode", feature: "context" },
		scope,
		state,
		(value) => readEnum(CONTEXT_MODES, value),
		(value) => {
			state.policy.context.mode = value;
		},
	);

	const remoteCompaction = openGroup(raw, "remoteCompaction", scope, state, "context");
	if (remoteCompaction) applyRemoteCompactionSettings(remoteCompaction.raw, remoteCompaction.scope, state);

	const nativeFallback = openGroup(raw, "nativeFallback", scope, state, "context");
	if (nativeFallback) applyNativeFallbackSettings(nativeFallback.raw, nativeFallback.scope, state);

	const remoteWindows = openGroup(raw, "remoteWindows", scope, state, "context");
	if (remoteWindows) applyRemoteWindowsSettings(remoteWindows.raw, remoteWindows.scope, state);
}

function applyRemoteCompactionSettings(
	raw: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	reportUnknownKeys(raw, REMOTE_COMPACTION_KEYS, scope, state, "context");

	applyField(
		raw,
		{ key: "model", leaf: "context.remoteCompaction.model", feature: "context" },
		scope,
		state,
		readModelRef,
		(value) => {
			state.policy.context.remoteCompaction.model = value;
		},
	);
	applyField(
		raw,
		{ key: "inputSource", leaf: "context.remoteCompaction.inputSource", feature: "context" },
		scope,
		state,
		(value) => readEnum(INPUT_SOURCES, value),
		(value) => {
			state.policy.context.remoteCompaction.inputSource = value;
		},
	);
	applyField(
		raw,
		{
			key: "allowContinuityBreak",
			leaf: "context.remoteCompaction.allowContinuityBreak",
			feature: "context",
		},
		scope,
		state,
		readBoolean,
		(value) => {
			state.policy.context.remoteCompaction.allowContinuityBreak = value;
		},
	);
	applyApisField(raw, scope, state);
}

/**
 * `apis` may only narrow the Responses APIs the toolkit can build a compact URL for, like the
 * legacy decoder. Unsupported entries invalidate this leaf; a malformed selected policy
 * cannot silently fall back to the inherited API list.
 */
function applyApisField(raw: Record<string, unknown>, scope: Scope, state: ResolutionState): void {
	if (!Object.hasOwn(raw, "apis")) return;
	const field: FieldDescriptor = {
		key: "apis",
		leaf: "context.remoteCompaction.apis",
		feature: "context",
	};
	const inputPath = joinPath(scope.input, "apis");
	const value = raw.apis;
	if (!Array.isArray(value)) {
		reportLeafError(state, scope, field, typeCode(value, V2_ISSUE.expectedList), inputPath);
		return;
	}

	const accepted: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const entry = value[index];
		if (typeof entry !== "string") {
			reportLeafError(state, scope, field, V2_ISSUE.expectedString, inputPath);
			return;
		}
		const normalized = entry.trim();
		if (normalized.length === 0) continue;
		const capable = RESPONSES_COMPACT_CAPABLE_APIS as readonly string[];
		if (!capable.includes(normalized)) {
			reportLeafError(state, scope, field, V2_ISSUE.apiUnsupported, `${inputPath}[${index}]`);
			return;
		}
		if (!accepted.includes(normalized)) accepted.push(normalized);
	}

	if (!scopeApplies(state, scope)) return;
	state.policy.context.remoteCompaction.apis = accepted;
	state.origins[field.leaf] = {
		kind: scope.kind === "defaults" ? "defaults" : "model",
		path: inputPath,
	};
	if (scope.kind === "model") leafState(state, field.leaf, field.feature).modelApplied = true;
}

function applyNativeFallbackSettings(
	raw: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	reportUnknownKeys(raw, NATIVE_FALLBACK_KEYS, scope, state, "context");

	applyField(
		raw,
		{ key: "enabled", leaf: "context.nativeFallback.enabled", feature: "context" },
		scope,
		state,
		readBoolean,
		(value) => {
			state.policy.context.nativeFallback.enabled = value;
		},
	);
	applyField(
		raw,
		{ key: "model", leaf: "context.nativeFallback.model", feature: "context" },
		scope,
		state,
		readModelRef,
		(value) => {
			state.policy.context.nativeFallback.model = value;
		},
	);
	applyField(
		raw,
		{ key: "thinkingLevel", leaf: "context.nativeFallback.thinkingLevel", feature: "context" },
		scope,
		state,
		readThinkingLevel,
		(value) => {
			state.policy.context.nativeFallback.thinkingLevel = value;
		},
	);
}

function applyRemoteWindowsSettings(
	raw: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	reportUnknownKeys(raw, REMOTE_WINDOWS_KEYS, scope, state, "context");

	applyField(
		raw,
		{ key: "leaveManagedMode", leaf: "context.remoteWindows.leaveManagedMode", feature: "context" },
		scope,
		state,
		(value) => readEnum(LEAVE_MANAGED_MODES, value),
		(value) => {
			state.policy.context.remoteWindows.leaveManagedMode = value;
		},
	);
	applyField(
		raw,
		{
			key: "reminderThresholdPercent",
			leaf: "context.remoteWindows.reminderThresholdPercent",
			feature: "context",
		},
		scope,
		state,
		(value) => readInteger(value, 0, 100),
		(value) => {
			state.policy.context.remoteWindows.reminderThresholdPercent = value;
		},
	);
}

function applyWebSearchSettings(
	raw: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	reportUnknownKeys(raw, WEB_SEARCH_KEYS, scope, state, "webSearch");

	applyField(
		raw,
		{ key: "route", leaf: "webSearch.route", feature: "webSearch" },
		scope,
		state,
		(value) => readEnum(SEARCH_ROUTES, value),
		(value) => {
			state.policy.webSearch.route = value satisfies SearchRoute;
		},
	);
}

/**
 * Image output settings are global only. The effective default must be a member of the effective
 * non-empty allowed list; a mismatch or an empty list fails the paid feature closed instead of
 * selecting a different model.
 */
function applyImageGenerationSettings(
	raw: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	reportUnknownKeys(raw, IMAGE_GENERATION_KEYS, scope, state, "imageGeneration");

	applyField(
		raw,
		{ key: "enabled", leaf: "imageGeneration.enabled", feature: "imageGeneration" },
		scope,
		state,
		readBoolean,
		(value) => {
			state.policy.imageGeneration.enabled = value;
		},
	);
	applyField(
		raw,
		{ key: "defaultModel", leaf: "imageGeneration.defaultModel", feature: "imageGeneration" },
		scope,
		state,
		(value) => readNonEmptyString(value, MAX_IMAGE_MODEL_ID_CHARS),
		(value) => {
			state.policy.imageGeneration.defaultModel = value;
		},
	);
	applyField(
		raw,
		{ key: "allowedModels", leaf: "imageGeneration.allowedModels", feature: "imageGeneration" },
		scope,
		state,
		readImageModelList,
		(value) => {
			state.policy.imageGeneration.allowedModels = value;
		},
	);

	const defaultLeaf = state.leaves.get("imageGeneration.defaultModel");
	const allowedLeaf = state.leaves.get("imageGeneration.allowedModels");
	const unreliable = (leaf: LeafState | undefined): boolean =>
		!!leaf && (leaf.invalidAtDefaults || leaf.invalidAtModel);
	if (unreliable(defaultLeaf) || unreliable(allowedLeaf)) return;

	const image = state.policy.imageGeneration;
	if (image.allowedModels.includes(image.defaultModel)) return;
	reportScopeError(
		state,
		scope,
		"imageGeneration",
		V2_ISSUE.imageDefaultNotAllowed,
		joinPath(scope.input, "defaultModel"),
	);
}

function applyAutoModeSettings(
	raw: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	reportUnknownKeys(raw, AUTO_MODE_KEYS, scope, state, "autoMode");

	applyField(
		raw,
		{ key: "available", leaf: "autoMode.available", feature: "autoMode" },
		scope,
		state,
		readBoolean,
		(value) => {
			state.policy.autoMode.available = value;
		},
	);
	applyField(
		raw,
		{ key: "reviewerModel", leaf: "autoMode.reviewerModel", feature: "autoMode" },
		scope,
		state,
		readModelRef,
		(value) => {
			state.policy.autoMode.reviewerModel = value;
		},
	);
	applyField(
		raw,
		{ key: "gate", leaf: "autoMode.gate", feature: "autoMode" },
		scope,
		state,
		(value) => readEnum(AUTO_GATES, value),
		(value) => {
			state.policy.autoMode.gate = value;
		},
	);
	applyField(
		raw,
		{ key: "extraTools", leaf: "autoMode.extraTools", feature: "autoMode" },
		scope,
		state,
		readStringList,
		(value) => {
			state.policy.autoMode.extraTools = value;
		},
	);
	applyField(
		raw,
		{ key: "timeoutMs", leaf: "autoMode.timeoutMs", feature: "autoMode" },
		scope,
		state,
		(value) => readInteger(value, REVIEWER_TIMEOUT_MIN_MS, REVIEWER_TIMEOUT_MAX_MS),
		(value) => {
			state.policy.autoMode.timeoutMs = value;
		},
	);
	applyField(
		raw,
		{ key: "transcript", leaf: "autoMode.transcript", feature: "autoMode" },
		scope,
		state,
		readBoolean,
		(value) => {
			state.policy.autoMode.transcript = value;
		},
	);
	applyField(
		raw,
		{ key: "evidenceTools", leaf: "autoMode.evidenceTools", feature: "autoMode" },
		scope,
		state,
		readBoolean,
		(value) => {
			state.policy.autoMode.evidenceTools = value;
		},
	);
	applyField(
		raw,
		{ key: "maxEvidenceRounds", leaf: "autoMode.maxEvidenceRounds", feature: "autoMode" },
		scope,
		state,
		(value) => readInteger(value, EVIDENCE_ROUNDS_MIN, EVIDENCE_ROUNDS_MAX),
		(value) => {
			state.policy.autoMode.maxEvidenceRounds = value;
		},
	);

	const classifier = openGroup(raw, "classifier", scope, state, "autoMode");
	if (classifier) applyClassifierSettings(classifier.raw, classifier.scope, state);

	const circuitBreaker = openGroup(raw, "circuitBreaker", scope, state, "autoMode");
	if (circuitBreaker) applyCircuitBreakerSettings(circuitBreaker.raw, circuitBreaker.scope, state);
}

function applyClassifierSettings(
	raw: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	reportUnknownKeys(raw, CLASSIFIER_KEYS, scope, state, "autoMode");

	applyField(
		raw,
		{ key: "enabled", leaf: "autoMode.classifier.enabled", feature: "autoMode" },
		scope,
		state,
		readBoolean,
		(value) => {
			state.policy.autoMode.classifier.enabled = value;
		},
	);
	applyField(
		raw,
		{ key: "model", leaf: "autoMode.classifier.model", feature: "autoMode" },
		scope,
		state,
		readModelRef,
		(value) => {
			state.policy.autoMode.classifier.model = value;
		},
	);
	applyField(
		raw,
		{ key: "timeoutMs", leaf: "autoMode.classifier.timeoutMs", feature: "autoMode" },
		scope,
		state,
		(value) => readInteger(value, REVIEWER_TIMEOUT_MIN_MS, REVIEWER_TIMEOUT_MAX_MS),
		(value) => {
			state.policy.autoMode.classifier.timeoutMs = value;
		},
	);
	applyField(
		raw,
		{ key: "maxLag", leaf: "autoMode.classifier.maxLag", feature: "autoMode" },
		scope,
		state,
		(value) => readInteger(value, CLASSIFIER_MAX_LAG_MIN, CLASSIFIER_MAX_LAG_MAX),
		(value) => {
			state.policy.autoMode.classifier.maxLag = value;
		},
	);
}

function applyCircuitBreakerSettings(
	raw: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	reportUnknownKeys(raw, BREAKER_KEYS, scope, state, "autoMode");

	applyField(
		raw,
		{
			key: "consecutiveDenials",
			leaf: "autoMode.circuitBreaker.consecutiveDenials",
			feature: "autoMode",
		},
		scope,
		state,
		(value) => readInteger(value, BREAKER_LIMIT_MIN, BREAKER_LIMIT_MAX),
		(value) => {
			state.policy.autoMode.circuitBreaker.consecutiveDenials = value;
		},
	);
	applyField(
		raw,
		{ key: "recentDenials", leaf: "autoMode.circuitBreaker.recentDenials", feature: "autoMode" },
		scope,
		state,
		(value) => readInteger(value, BREAKER_LIMIT_MIN, BREAKER_LIMIT_MAX),
		(value) => {
			state.policy.autoMode.circuitBreaker.recentDenials = value;
		},
	);
	applyField(
		raw,
		{ key: "windowSize", leaf: "autoMode.circuitBreaker.windowSize", feature: "autoMode" },
		scope,
		state,
		(value) => readInteger(value, BREAKER_WINDOW_MIN, BREAKER_WINDOW_MAX),
		(value) => {
			state.policy.autoMode.circuitBreaker.windowSize = value;
		},
	);
}

/** Protocol compatibility is an exact-model opt-in; there is no broad defaults wildcard. */
function applyCompatibilitySettings(
	raw: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	reportUnknownKeys(raw, COMPATIBILITY_KEYS, scope, state, "compatibility");
	if (scope.modelKey && Object.hasOwn(raw, "transport") && typeof raw.transport === "string" && raw.transport.trim() === "codex-gateway") {
		state.gatewayCandidates.add(scope.modelKey);
	}

	applyField(
		raw,
		{ key: "transport", leaf: "compatibility.transport", feature: "compatibility" },
		scope,
		state,
		(value) => readEnum(TRANSPORTS, value),
		(value) => {
			state.policy.compatibility.transport = value;
		},
	);
}

function applyDiagnosticsSettings(
	raw: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	reportUnknownKeys(raw, DIAGNOSTICS_KEYS, scope, state, "diagnostics");

	applyField(
		raw,
		{ key: "level", leaf: "diagnostics.level", feature: "diagnostics" },
		scope,
		state,
		(value) => readEnum(DIAGNOSTIC_LEVELS, value),
		(value) => {
			state.policy.diagnostics.level = value;
		},
	);
	applyField(
		raw,
		{ key: "notifyOnLoad", leaf: "diagnostics.notifyOnLoad", feature: "diagnostics" },
		scope,
		state,
		readBoolean,
		(value) => {
			state.policy.diagnostics.notifyOnLoad = value;
		},
	);
	applyField(
		raw,
		{ key: "captureRequests", leaf: "diagnostics.captureRequests", feature: "diagnostics" },
		scope,
		state,
		readBoolean,
		(value) => {
			state.policy.diagnostics.captureRequests = value;
		},
	);
	applyField(
		raw,
		{ key: "captureResponses", leaf: "diagnostics.captureResponses", feature: "diagnostics" },
		scope,
		state,
		readBoolean,
		(value) => {
			state.policy.diagnostics.captureResponses = value;
		},
	);
	applyField(
		raw,
		{
			key: "redactSensitiveData",
			leaf: "diagnostics.redactSensitiveData",
			feature: "diagnostics",
		},
		scope,
		state,
		readBoolean,
		(value) => {
			state.policy.diagnostics.redactSensitiveData = value;
		},
	);
	applyField(
		raw,
		{ key: "artifactRoot", leaf: "diagnostics.artifactRoot", feature: "diagnostics" },
		scope,
		state,
		readNonEmptyString,
		(value) => {
			// Path expansion stays in the loader; the resolver records the configured value.
			state.policy.diagnostics.artifactRoot = value;
		},
	);
}

/** Reusable scope appliers so `defaults.<feature>` and `models[key].<feature>` share one contract. */
function applyContextScope(container: Record<string, unknown>, scope: Scope, state: ResolutionState): void {
	const group = openGroup(container, "context", scope, state, "context");
	if (group) applyContextSettings(group.raw, group.scope, state);
}

function applyWebSearchScope(
	container: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	const group = openGroup(container, "webSearch", scope, state, "webSearch");
	if (group) applyWebSearchSettings(group.raw, group.scope, state);
}

function applyImageGenerationScope(
	container: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	const group = openGroup(container, "imageGeneration", scope, state, "imageGeneration");
	if (group) applyImageGenerationSettings(group.raw, group.scope, state);
}

function applyAutoModeScope(
	container: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	const group = openGroup(container, "autoMode", scope, state, "autoMode");
	if (group) applyAutoModeSettings(group.raw, group.scope, state);
}

function applyCompatibilityScope(
	container: Record<string, unknown>,
	scope: Scope,
	state: ResolutionState,
): void {
	const group = openGroup(container, "compatibility", scope, state, "compatibility");
	if (group) applyCompatibilitySettings(group.raw, group.scope, state);
}

// ---------------------------------------------------------------------------------------------
// Document sections
// ---------------------------------------------------------------------------------------------

function applyDefaults(doc: Record<string, unknown>, state: ResolutionState): void {
	if (!Object.hasOwn(doc, "defaults")) return;
	const raw = doc.defaults;
	if (!isRecord(raw)) {
		state.issues.push({
			severity: "error",
			code: V2_ISSUE.defaultsInvalid,
			path: "defaults",
			feature: "document",
		});
		state.untrusted = true;
		return;
	}

	const scope: Scope = { input: "defaults", kind: "defaults" };
	reportUnknownKeys(raw, DEFAULTS_KEYS, scope, state, undefined);
	applyContextScope(raw, scope, state);
	applyWebSearchScope(raw, scope, state);
	applyImageGenerationScope(raw, scope, state);
	applyAutoModeScope(raw, scope, state);
}

function applyModels(doc: Record<string, unknown>, state: ResolutionState): void {
	if (!Object.hasOwn(doc, "models")) return;
	const raw = doc.models;
	if (!isRecord(raw)) {
		state.issues.push({
			severity: "error",
			code: V2_ISSUE.modelsInvalid,
			path: "models",
			feature: "document",
		});
		markModelOverrideInvalid(state, { input: "models", kind: "document" });
		return;
	}

	// Trim-normalize keys and reject collisions instead of resolving them last-wins.
	// Keep the raw key for JSON paths: normalization selects the scope, but provenance and
	// diagnostics must still point at the property the caller actually supplied.
	const normalized = new Map<string, string[]>();
	for (const rawKey of Object.keys(raw)) {
		const key = rawKey.trim();
		const existing = normalized.get(key);
		if (existing) existing.push(rawKey);
		else normalized.set(key, [rawKey]);
	}

	for (const [key, rawKeys] of normalized) {
		const firstRawKey = rawKeys[0] as string;
		const scope: Scope = { input: modelScopePath(firstRawKey), kind: "model", modelKey: key };
		if (!isExactModelKey(key)) {
			state.issues.push({
				severity: "error",
				code: V2_ISSUE.keyInvalid,
				path: modelScopePath(boundedSegment(firstRawKey)),
				feature: "document",
			});
			if (key === state.selectedKey) markModelOverrideInvalid(state, scope);
			continue;
		}
		if (rawKeys.length > 1) {
			state.issues.push(
				withModel(scope, {
					severity: "error",
					code: V2_ISSUE.keyDuplicate,
					path: modelScopePath(boundedSegment(firstRawKey)),
					feature: "document",
				}),
			);
			if (key === state.selectedKey) markModelOverrideInvalid(state, scope);
			continue;
		}

		const entry = Object.hasOwn(raw, firstRawKey) ? raw[firstRawKey] : undefined;
		if (!isRecord(entry)) {
			reportScopeError(state, scope, "document", V2_ISSUE.scopeInvalid, modelScopePath(boundedSegment(firstRawKey)));
			markModelOverrideInvalid(state, scope);
			continue;
		}

		reportUnknownKeys(entry, MODEL_OVERRIDE_KEYS, scope, state, undefined);
		applyContextScope(entry, scope, state);
		applyWebSearchScope(entry, scope, state);
		applyAutoModeScope(entry, scope, state);
		applyCompatibilityScope(entry, scope, state);
	}
}

function applyDiagnostics(doc: Record<string, unknown>, state: ResolutionState): void {
	if (!Object.hasOwn(doc, "diagnostics")) return;
	const raw = doc.diagnostics;
	if (!isRecord(raw)) {
		reportScopeError(
			state,
			{ input: "diagnostics", kind: "document" },
			"diagnostics",
			V2_ISSUE.diagnosticsInvalid,
			"diagnostics",
		);
		return;
	}
	// Diagnostics are global, so they resolve into the inherited policy like `defaults`.
	applyDiagnosticsSettings(raw, { input: "diagnostics", kind: "defaults" }, state);
}

type V2Resolution = ResolvedToolkitPolicy & { gatewayModelKeys: string[] };

function finish(state: ResolutionState): V2Resolution {
	const invalidFeatures = CONFIG_FEATURES.filter((feature) => {
		if (state.untrusted || state.hardInvalid.has(feature)) return true;
		for (const leaf of state.leaves.values()) {
			if (leaf.feature !== feature) continue;
			if (leaf.invalidAtModel) return true;
			if (leaf.invalidAtDefaults && !leaf.modelApplied) return true;
		}
		return false;
	});
	// All model scopes were validated in the same pass. An unrelated context/search error
	// does not change a valid transport; document/compatibility errors do.
	const blockedGateways = new Set<string>();
	let blockAllGateways = state.untrusted;
	for (const issue of state.issues) {
		if (issue.severity !== "error" || (issue.feature !== "document" && issue.feature !== "compatibility")) continue;
		if (issue.modelKey !== undefined) blockedGateways.add(issue.modelKey);
		else if (issue.code !== V2_ISSUE.keyInvalid) blockAllGateways = true;
	}
	return {
		policy: state.policy,
		origins: state.origins,
		issues: state.issues,
		invalidFeatures: [...invalidFeatures],
		gatewayModelKeys: blockAllGateways ? [] : [...state.gatewayCandidates].filter((key) => !blockedGateways.has(key)),
	};
}

/**
 * Validate and resolve a version 2 document for `modelKey`.
 *
 * Pure: no file I/O, path expansion, auth lookup, provider call or tool mutation. Callers must
 * route unversioned documents through the legacy adapter instead. Consumers must treat any
 * feature listed in `invalidFeatures` as fail-closed and must never reconstruct the merge
 * themselves.
 */
export function resolveV2Config(raw: unknown, modelKey: string | undefined): V2Resolution {
	const state = createState(modelKey);

	if (!isRecord(raw)) {
		fatalDocumentError(state, V2_ISSUE.rootInvalid, "document");
		return finish(state);
	}
	if (!Object.hasOwn(raw, "schemaVersion")) {
		fatalDocumentError(state, V2_ISSUE.schemaVersionMissing, "schemaVersion");
		return finish(state);
	}
	if (raw.schemaVersion !== 2) {
		fatalDocumentError(state, V2_ISSUE.schemaVersionUnsupported, "schemaVersion");
		return finish(state);
	}
	if (LEGACY_ROOT_KEYS.some((key) => Object.hasOwn(raw, key))) {
		fatalDocumentError(state, V2_ISSUE.formatMixed, "document");
		return finish(state);
	}

	if (Object.hasOwn(raw, "$schema") && typeof raw.$schema !== "string") {
		fatalDocumentError(state, V2_ISSUE.schemaInvalid, "$schema");
	}
	reportUnknownKeys(raw, ROOT_KEYS, DOCUMENT_SCOPE, state, undefined);

	applyDefaults(raw, state);
	applyModels(raw, state);
	applyDiagnostics(raw, state);

	return finish(state);
}
