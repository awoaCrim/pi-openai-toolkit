import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ModelThinkingLevel, ProviderHeaders } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isExactModelAllowed } from "./model-scope";
import {
	CODEX_AFFINITY_SCOPE,
	type CodexAffinity,
} from "./responses-headers";
import { RESPONSES_COMPACT_CAPABLE_APIS } from "./types";

const OPENAI_RESPONSES_PATH = "responses";
const CODEX_RESPONSES_PATH = "codex/responses";
const AZURE_RESPONSES_PATH = "responses";
const OPENAI_COMPACT_PATH = "responses/compact";
const CODEX_COMPACT_PATH = "codex/responses/compact";
const AZURE_COMPACT_PATH = "responses/compact";
const AZURE_DEFAULT_API_VERSION = "v1";
const ALPHA_SEARCH_PATH = "alpha/search";
export const VIRTUAL_MODEL_API = "pi-virtual" as const;

export type ResponsesApi = (typeof RESPONSES_COMPACT_CAPABLE_APIS)[number];

type ResponsesCompactApi = ResponsesApi;
type RuntimeModel = Model<Api>;

export type ParsedModelSpec = {
	provider: string;
	modelId: string;
};

export type NativeCompactionFailureReason =
	| "disabled"
	| "missing-model"
	| "virtual-model-unresolved"
	| "invalid-model-spec"
	| "model-not-found"
	| "unsupported-api"
	| "missing-base-url"
	| "invalid-base-url"
	| "missing-session-id"
	| "missing-api-key"
	| "auth-resolution-failed"
	| "unsupported-payload"
	| "payload-model-mismatch"
	| "base-url-mismatch";

export type NativeCompactionSupportOptions = {
	enabled?: boolean;
	/** Which Responses APIs should use the compact endpoint; defaults to all capable APIs. */
	responsesApis?: readonly string[];
	/** Exact provider/model keys whose Responses traffic carries gateway Codex affinity metadata. */
	codexGatewayModels?: readonly string[];
};

export type ResponsesSupportOptions = NativeCompactionSupportOptions;

export type ResponsesCompatibleRequestPayload = {
	model: string;
	input: unknown[];
	instructions?: unknown;
	[key: string]: unknown;
};

export type ResponsesRuntime = {
	provider: string;
	api: ResponsesApi;
	/** Logical Pi model id. */
	model: string;
	/** Wire model/deployment id; usually the same as `model`. */
	requestModel?: string;
	baseUrl: string;
	apiKey: string;
	env?: Record<string, string>;
	headers?: ProviderHeaders;
	responsesPath: string;
	responsesUrl: string;
	/**
	 * Conversation identity for Codex prompt-cache affinity headers. Synthetic
	 * compaction/review requests must present the same id the live transcript
	 * requests used or the backend treats them as a new conversation.
	 */
	sessionId?: string;
	/** Opt-in gateway Codex routing metadata for synthetic Responses/compact requests. */
	codexAffinity?: CodexAffinity;
	currentModel: RuntimeModel;
};

export type NativeCompactionRuntime = ResponsesRuntime & {
	compactPath: string;
	compactUrl: string;
	payload?: ResponsesCompatibleRequestPayload;
};

export type NativeCompactionEnvironmentFailure = {
	ok: false;
	reason: NativeCompactionFailureReason;
	provider?: string;
	api?: string;
	model?: string;
	baseUrl?: string;
	modelSpec?: string;
	errorMessage?: string;
};

export type NativeCompactionEnvironmentSuccess = {
	ok: true;
	runtime: NativeCompactionRuntime;
};

export type NativeCompactionEnvironmentResolution =
	| NativeCompactionEnvironmentFailure
	| NativeCompactionEnvironmentSuccess;

export type ResponsesEnvironmentSuccess = {
	ok: true;
	runtime: ResponsesRuntime;
};

export type ResponsesEnvironmentResolution =
	| NativeCompactionEnvironmentFailure
	| ResponsesEnvironmentSuccess;

export type RemoteCompactionExecution = {
	/** Active session model. Its identity owns replay matching and is never mutated. */
	consumer: NativeCompactionRuntime;
	/** Model used only for the synthetic remote_compaction_v2 request. */
	compactor: NativeCompactionRuntime;
};

export type RemoteCompactionExecutionSuccess = {
	ok: true;
	execution: RemoteCompactionExecution;
};

export type RemoteCompactionExecutionResolution =
	| NativeCompactionEnvironmentFailure
	| RemoteCompactionExecutionSuccess;

type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: ProviderHeaders;
			baseUrl?: string;
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };

type VirtualModelRuntime = {
	resolveModel?: (
		model: RuntimeModel,
		messages: readonly Message[],
		options: {
			reason: "direct";
			thinkingLevel: ModelThinkingLevel;
			signal?: AbortSignal;
			state?: unknown;
		},
	) => Promise<{ model: RuntimeModel; thinkingLevel: ModelThinkingLevel; state?: unknown }>;
	getPhysicalModel?: (provider: string, modelId: string) => RuntimeModel | undefined;
};

type ModelRegistryRuntimeBridge = {
	runtime?: VirtualModelRuntime;
};

export type EffectiveModelResolution =
	| { ok: true; model: RuntimeModel; virtual: boolean }
	| { ok: false; reason: "missing-model" | "virtual-model-unresolved"; errorMessage?: string };

const physicalModelCache = new WeakMap<object, Map<string, RuntimeModel>>();
const physicalModelObserverApis = new WeakSet<object>();

function modelKey(model: RuntimeModel): string {
	return `${model.provider}/${model.id}`;
}

function getPhysicalModelCache(ctx: ExtensionContext): Map<string, RuntimeModel> {
	const registry = ctx.modelRegistry as object;
	let cache = physicalModelCache.get(registry);
	if (!cache) {
		cache = new Map<string, RuntimeModel>();
		physicalModelCache.set(registry, cache);
	}
	return cache;
}

function sessionModelKey(ctx: ExtensionContext, model: RuntimeModel): string | undefined {
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		return sessionId ? `${sessionId}\u0000${modelKey(model)}` : undefined;
	} catch {
		return undefined;
	}
}

function isAssistantModelMessage(message: AgentMessage): message is AgentMessage & {
	provider: string;
	api: string;
	model: string;
} {
	if (message.role !== "assistant") return false;
	const candidate = message as unknown as Record<string, unknown>;
	return typeof candidate.provider === "string" &&
		typeof candidate.api === "string" &&
		typeof candidate.model === "string";
}

/** Remember the physical model Pi actually used as a fallback for a virtual selection. */
export function rememberPhysicalModel(ctx: ExtensionContext, message: AgentMessage): void {
	const selected = ctx.model as RuntimeModel | undefined;
	if (!selected || selected.api !== VIRTUAL_MODEL_API || !isAssistantModelMessage(message)) return;
	const physical = ctx.modelRegistry.find(message.provider, message.model);
	const key = sessionModelKey(ctx, selected);
	if (physical && physical.api !== VIRTUAL_MODEL_API && key) {
		getPhysicalModelCache(ctx).set(key, physical);
	}
}

/**
 * Register the fallback cache observer used by feature extensions. Pi 0.99
 * exposes a resolver for fresh routes; the assistant message cache only helps
 * when a host cannot expose that resolver after a physical response exists.
 */
export function registerPhysicalModelObserver(pi: ExtensionAPI): void {
	if (physicalModelObserverApis.has(pi)) return;
	physicalModelObserverApis.add(pi);
	pi.on("message_end", (event, ctx) => {
		rememberPhysicalModel(ctx, event.message);
	});
}

async function resolveVirtualModel(ctx: ExtensionContext, model: RuntimeModel): Promise<EffectiveModelResolution> {
	const cache = getPhysicalModelCache(ctx);
	const key = sessionModelKey(ctx, model);
	const bridge = ctx.modelRegistry as unknown as ModelRegistryRuntimeBridge;
	const runtime = bridge.runtime;
	if (typeof runtime?.resolveModel !== "function") {
		const cached = key ? cache.get(key) : undefined;
		if (cached) return { ok: true, model: cached, virtual: true };
		return {
			ok: false,
			reason: "virtual-model-unresolved",
			errorMessage: "Pi does not expose virtual-model routing to extensions.",
		};
	}

	let messages: Message[];
	try {
		messages = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
	} catch (error) {
		return {
			ok: false,
			reason: "virtual-model-unresolved",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	}

	try {
		const route = await runtime.resolveModel(model, messages, {
			reason: "direct",
			thinkingLevel: (ctx.thinkingLevel ?? "off") as ModelThinkingLevel,
			signal: ctx.signal,
		});
		const physical = runtime.getPhysicalModel?.(route.model.provider, route.model.id)
			?? ctx.modelRegistry.find(route.model.provider, route.model.id)
			?? route.model;
		if (!physical || physical.api === VIRTUAL_MODEL_API) {
			return {
				ok: false,
				reason: "virtual-model-unresolved",
				errorMessage: "Pi virtual-model routing did not return a physical model.",
			};
		}
		if (key) cache.set(key, physical);
		return { ok: true, model: physical, virtual: true };
	} catch (error) {
		return {
			ok: false,
			reason: "virtual-model-unresolved",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function resolveEffectiveModel(
	ctx: ExtensionContext,
	model: ExtensionContext["model"] = ctx.model,
): Promise<EffectiveModelResolution> {
	if (!model) return { ok: false, reason: "missing-model" };
	const runtimeModel = model as RuntimeModel;
	if (runtimeModel.api !== VIRTUAL_MODEL_API) return { ok: true, model: runtimeModel, virtual: false };
	return resolveVirtualModel(ctx, runtimeModel);
}

function normalizeConfiguredApis(values: readonly string[] | undefined): Set<string> {
	if (values === undefined) {
		return new Set(RESPONSES_COMPACT_CAPABLE_APIS);
	}
	return new Set(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

function resolveCodexGatewayAffinity(
	model: RuntimeModel,
	gatewayModels: readonly string[] | undefined,
	logicalModel?: RuntimeModel,
): CodexAffinity | undefined {
	const allowlist = gatewayModels ?? [];
	const allowed = isExactModelAllowed(model, allowlist) ||
		(logicalModel?.api === VIRTUAL_MODEL_API && isExactModelAllowed(logicalModel, allowlist));
	if (model.api !== "openai-responses" || !allowed) {
		return undefined;
	}
	return {
		model: model.id,
		scope: CODEX_AFFINITY_SCOPE,
	};
}

/** Parse "provider/model-id" (model ids may themselves contain slashes). */
export function parseModelSpec(spec: string): ParsedModelSpec | undefined {
	const trimmed = spec.trim();
	const separatorIndex = trimmed.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
		return undefined;
	}

	const provider = trimmed.slice(0, separatorIndex).trim();
	const modelId = trimmed.slice(separatorIndex + 1).trim();
	if (!provider || !modelId) {
		return undefined;
	}

	return { provider, modelId };
}

export function normalizeBaseUrl(baseUrl: string | undefined | null): string | undefined {
	const normalized = baseUrl?.trim().replace(/\/+$/, "");
	return normalized ? normalized : undefined;
}

function buildOpenAIResponsesUrl(baseUrl: string): string {
	const normalized = normalizeBaseUrl(baseUrl) ?? baseUrl;
	return normalized.endsWith("/responses") ? normalized : `${normalized}/${OPENAI_RESPONSES_PATH}`;
}

function buildCodexResponsesUrl(baseUrl: string): string {
	const normalized = normalizeBaseUrl(baseUrl) ?? baseUrl;
	if (normalized.endsWith("/codex/responses")) {
		return normalized;
	}
	if (normalized.endsWith("/codex")) {
		return `${normalized}/responses`;
	}
	return `${normalized}/${CODEX_RESPONSES_PATH}`;
}

function buildOpenAICompactUrl(baseUrl: string): string {
	return `${buildOpenAIResponsesUrl(baseUrl)}/compact`;
}

function buildCodexCompactUrl(baseUrl: string): string {
	return `${buildCodexResponsesUrl(baseUrl)}/compact`;
}

function envValue(env: Record<string, string> | undefined, name: string): string | undefined {
	const value = env?.[name]?.trim();
	return value || undefined;
}

function buildAzureBaseUrl(baseUrl: string | undefined, env: Record<string, string> | undefined): string | undefined {
	const configured = envValue(env, "AZURE_OPENAI_BASE_URL") ?? normalizeBaseUrl(baseUrl);
	if (configured) return configured;
	const resource = envValue(env, "AZURE_OPENAI_RESOURCE_NAME");
	return resource ? `https://${resource}.openai.azure.com/openai/v1` : undefined;
}

function normalizeAzureBaseUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	const pathname = url.pathname.replace(/\/+$/, "");
	if (pathname === "" || pathname === "/" || pathname === "/openai") url.pathname = "/openai/v1";
	else if (pathname.endsWith("/responses")) url.pathname = pathname.slice(0, -"/responses".length);
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

function appendAzureApiVersion(urlValue: string, env: Record<string, string> | undefined): string {
	const url = new URL(urlValue);
	if (!url.searchParams.has("api-version")) {
		url.searchParams.set("api-version", envValue(env, "AZURE_OPENAI_API_VERSION") ?? AZURE_DEFAULT_API_VERSION);
	}
	return url.toString();
}

export function resolveAzureDeploymentName(modelId: string, env: Record<string, string> | undefined): string {
	const mapping = envValue(env, "AZURE_OPENAI_DEPLOYMENT_NAME_MAP");
	if (mapping) {
		for (const entry of mapping.split(",")) {
			const separator = entry.indexOf("=");
			if (separator <= 0) continue;
			if (entry.slice(0, separator).trim() === modelId) {
				const deployment = entry.slice(separator + 1).trim();
				if (deployment) return deployment;
			}
		}
	}
	return modelId;
}

export function buildResponsesUrl(
	baseUrl: string,
	api: ResponsesCompactApi,
	env?: Record<string, string>,
): string {
	if (api === "openai-codex-responses") return buildCodexResponsesUrl(baseUrl);
	if (api === "azure-openai-responses") {
		return appendAzureApiVersion(`${normalizeAzureBaseUrl(baseUrl)}/${AZURE_RESPONSES_PATH}`, env);
	}
	return buildOpenAIResponsesUrl(baseUrl);
}

export function buildResponsesPath(api: ResponsesCompactApi): string {
	return api === "openai-codex-responses" ? CODEX_RESPONSES_PATH : AZURE_RESPONSES_PATH;
}

export function buildCompactUrl(
	baseUrl: string,
	api: ResponsesCompactApi,
	env?: Record<string, string>,
): string {
	if (api === "openai-codex-responses") return buildCodexCompactUrl(baseUrl);
	if (api === "azure-openai-responses") {
		return appendAzureApiVersion(`${normalizeAzureBaseUrl(baseUrl)}/${AZURE_COMPACT_PATH}`, env);
	}
	return buildOpenAICompactUrl(baseUrl);
}

export function buildCompactPath(api: ResponsesCompactApi): string {
	return api === "openai-codex-responses" ? CODEX_COMPACT_PATH : AZURE_COMPACT_PATH;
}

/**
 * Build the provider-relative standalone-search endpoint. This deliberately
 * rejects a full Responses endpoint so an already-resolved URL cannot become
 * `/responses/alpha/search` or `/codex/responses/alpha/search` by accident.
 */
export function buildAlphaSearchUrl(baseUrl: string): string | undefined {
	const normalized = normalizeBaseUrl(baseUrl);
	if (!normalized) return undefined;

	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		return undefined;
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		return undefined;
	}

	const pathname = parsed.pathname.replace(/\/+$/, "");
	if (
		pathname.endsWith("/responses/alpha/search") ||
		pathname.endsWith("/codex/responses/alpha/search") ||
		pathname.endsWith("/responses/compact/alpha/search") ||
		pathname.endsWith("/codex/responses/compact/alpha/search")
	) {
		return undefined;
	}
	if (pathname.endsWith("/alpha/search")) {
		parsed.pathname = pathname;
		return parsed.toString();
	}
	if (
		pathname.endsWith("/responses") ||
		pathname.endsWith("/codex/responses") ||
		pathname.endsWith("/responses/compact") ||
		pathname.endsWith("/codex/responses/compact")
	) {
		return undefined;
	}

	parsed.pathname = `${pathname}/${ALPHA_SEARCH_PATH}`.replace(/^\/\//, "/");
	return parsed.toString();
}

async function resolveRequestAuth(ctx: ExtensionContext, model: RuntimeModel): Promise<ResolvedRequestAuth> {
	const modelRegistry = ctx.modelRegistry as {
		getApiKeyAndHeaders?: (currentModel: RuntimeModel) => Promise<ResolvedRequestAuth>;
	};

	if (typeof modelRegistry.getApiKeyAndHeaders !== "function") {
		return { ok: true };
	}

	return modelRegistry.getApiKeyAndHeaders(model);
}

export function isSupportedApi(api: string): api is ResponsesCompactApi {
	return (RESPONSES_COMPACT_CAPABLE_APIS as readonly string[]).includes(api);
}

export function isResponsesCompatiblePayload(payload: unknown): payload is ResponsesCompatibleRequestPayload {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return false;
	}

	const candidate = payload as Record<string, unknown>;
	return typeof candidate.model === "string" && Array.isArray(candidate.input);
}

export function getRuntimeModelDescriptor(model: RuntimeModel | undefined): {
	provider?: string;
	api?: string;
	model?: string;
	baseUrl?: string;
} {
	if (!model) {
		return {};
	}

	return {
		provider: model.provider,
		api: model.api,
		model: model.id,
		baseUrl: normalizeBaseUrl(model.baseUrl),
	};
}

/** Best-effort conversation id; header emission then simply skips the affinity headers. */
export function resolveRuntimeSessionId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

async function resolveNativeCompactionEnvironmentForModel(
	ctx: ExtensionContext,
	currentModel: RuntimeModel | undefined,
	options: NativeCompactionSupportOptions,
	payload?: unknown,
): Promise<NativeCompactionEnvironmentResolution> {
	if (options.enabled === false) {
		return {
			ok: false,
			reason: "disabled",
		};
	}

	const originalDescriptor = getRuntimeModelDescriptor(currentModel);
	if (!currentModel || !originalDescriptor.provider || !originalDescriptor.api || !originalDescriptor.model) {
		return {
			ok: false,
			reason: "missing-model",
			...originalDescriptor,
		};
	}

	const effective = await resolveEffectiveModel(ctx, currentModel);
	if (!effective.ok) {
		return {
			ok: false,
			reason: effective.reason,
			errorMessage: effective.errorMessage,
			...originalDescriptor,
		};
	}
	const effectiveModel = effective.model;
	const descriptor = getRuntimeModelDescriptor(effectiveModel);
	if (!descriptor.provider || !descriptor.api || !descriptor.model) {
		return {
			ok: false,
			reason: "missing-model",
			...descriptor,
		};
	}

	// The compact endpoint is selected purely by API family: any provider speaking
	// a validated Responses API gets a native compact attempt and fails open (to
	// the fallback model or pi's default) when the endpoint is missing.
	const configuredApis = normalizeConfiguredApis(options.responsesApis);
	if (!configuredApis.has(descriptor.api) || !isSupportedApi(descriptor.api)) {
		return {
			ok: false,
			reason: "unsupported-api",
			...descriptor,
		};
	}

	let requestPayload: ResponsesCompatibleRequestPayload | undefined;
	if (payload !== undefined) {
		if (!isResponsesCompatiblePayload(payload)) {
			return {
				ok: false,
				reason: "unsupported-payload",
				...descriptor,
			};
		}
		requestPayload = payload;
	}

	let auth: ResolvedRequestAuth;
	try {
		auth = await resolveRequestAuth(ctx, effectiveModel);
	} catch (error) {
		return {
			ok: false,
			reason: "auth-resolution-failed",
			errorMessage: error instanceof Error ? error.message : String(error),
			...descriptor,
		};
	}

	if (!auth.ok) {
		return {
			ok: false,
			reason: "auth-resolution-failed",
			errorMessage: auth.error,
			...descriptor,
		};
	}

	const rawBaseUrl = normalizeBaseUrl(auth.baseUrl) ?? descriptor.baseUrl;
	let baseUrl = rawBaseUrl;
	if (descriptor.api === "azure-openai-responses") {
		baseUrl = buildAzureBaseUrl(rawBaseUrl, auth.env);
	}
	if (!baseUrl) {
		return {
			ok: false,
			reason: "missing-base-url",
			...descriptor,
		};
	}
	if (descriptor.api === "azure-openai-responses") {
		try {
			baseUrl = normalizeAzureBaseUrl(baseUrl);
		} catch (error) {
			return {
				ok: false,
				reason: "invalid-base-url",
				errorMessage: error instanceof Error ? error.message : String(error),
				...descriptor,
				baseUrl,
			};
		}
	}

	const requestModel = descriptor.api === "azure-openai-responses"
		? resolveAzureDeploymentName(descriptor.model, auth.env)
		: descriptor.model;
	if (requestPayload && requestPayload.model !== descriptor.model && requestPayload.model !== requestModel) {
		return {
			ok: false,
			reason: "payload-model-mismatch",
			...descriptor,
			baseUrl,
		};
	}

	const codexAffinity = resolveCodexGatewayAffinity(effectiveModel, options.codexGatewayModels, currentModel);
	const sessionId = resolveRuntimeSessionId(ctx);
	if (codexAffinity && !sessionId) {
		return {
			ok: false,
			reason: "missing-session-id",
			...descriptor,
			baseUrl,
		};
	}

	if (!auth.apiKey) {
		return {
			ok: false,
			reason: "missing-api-key",
			...descriptor,
			baseUrl,
		};
	}

	return {
		ok: true,
		runtime: {
			provider: descriptor.provider,
			api: descriptor.api,
			model: descriptor.model,
			requestModel,
			baseUrl,
			apiKey: auth.apiKey,
			env: auth.env,
			headers: auth.headers,
			responsesPath: buildResponsesPath(descriptor.api),
			responsesUrl: buildResponsesUrl(baseUrl, descriptor.api, auth.env),
			compactPath: buildCompactPath(descriptor.api),
			compactUrl: buildCompactUrl(baseUrl, descriptor.api, auth.env),
			sessionId,
			codexAffinity,
			payload: requestPayload,
			currentModel: effectiveModel,
		},
	};
}

export async function resolveResponsesEnvironment(
	ctx: ExtensionContext,
	options: ResponsesSupportOptions = {},
): Promise<ResponsesEnvironmentResolution> {
	const resolution = await resolveNativeCompactionEnvironmentForModel(ctx, ctx.model, options);
	if (!resolution.ok) return resolution;

	const runtime = resolution.runtime;
	return {
		ok: true,
		runtime: {
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			requestModel: runtime.requestModel,
			baseUrl: runtime.baseUrl,
			apiKey: runtime.apiKey,
			env: runtime.env,
			headers: runtime.headers,
			responsesPath: runtime.responsesPath,
			responsesUrl: runtime.responsesUrl,
			sessionId: runtime.sessionId,
			codexAffinity: runtime.codexAffinity,
			currentModel: runtime.currentModel,
		},
	};
}

export async function resolveNativeCompactionEnvironment(
	ctx: ExtensionContext,
	options: NativeCompactionSupportOptions = {},
	payload?: unknown,
): Promise<NativeCompactionEnvironmentResolution> {
	return resolveNativeCompactionEnvironmentForModel(ctx, ctx.model, options, payload);
}

export async function resolveRemoteCompactionExecution(
	ctx: ExtensionContext,
	options: NativeCompactionSupportOptions = {},
	remoteModelSpec?: string,
): Promise<RemoteCompactionExecutionResolution> {
	const consumerResolution = await resolveNativeCompactionEnvironment(ctx, options);
	if (!consumerResolution.ok) {
		return consumerResolution;
	}

	const spec = remoteModelSpec?.trim();
	if (!spec) {
		return {
			ok: true,
			execution: {
				consumer: consumerResolution.runtime,
				compactor: consumerResolution.runtime,
			},
		};
	}

	const parsed = parseModelSpec(spec);
	if (!parsed) {
		return {
			ok: false,
			reason: "invalid-model-spec",
			modelSpec: spec,
		};
	}

	const compactorModel = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!compactorModel) {
		return {
			ok: false,
			reason: "model-not-found",
			provider: parsed.provider,
			model: parsed.modelId,
			modelSpec: spec,
		};
	}

	const compactorResolution = await resolveNativeCompactionEnvironmentForModel(
		ctx,
		compactorModel,
		options,
	);
	if (!compactorResolution.ok) {
		return {
			...compactorResolution,
			modelSpec: spec,
		};
	}

	const consumer = consumerResolution.runtime;
	const compactor = compactorResolution.runtime;
	if (compactor.baseUrl !== consumer.baseUrl) {
		return {
			ok: false,
			reason: "base-url-mismatch",
			provider: compactor.provider,
			api: compactor.api,
			model: compactor.model,
			baseUrl: compactor.baseUrl,
			modelSpec: spec,
		};
	}

	return {
		ok: true,
		execution: {
			consumer,
			compactor,
		},
	};
}

export async function getNativeCompactionRuntime(
	ctx: ExtensionContext,
	options: NativeCompactionSupportOptions = {},
	payload?: unknown,
): Promise<NativeCompactionRuntime | undefined> {
	const resolution = await resolveNativeCompactionEnvironment(ctx, options, payload);
	return resolution.ok ? resolution.runtime : undefined;
}
