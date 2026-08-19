import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RESPONSES_COMPACT_CAPABLE_APIS } from "./types";

const OPENAI_RESPONSES_PATH = "responses";
const CODEX_RESPONSES_PATH = "codex/responses";
const OPENAI_COMPACT_PATH = "responses/compact";
const CODEX_COMPACT_PATH = "codex/responses/compact";

type ResponsesCompactApi = (typeof RESPONSES_COMPACT_CAPABLE_APIS)[number];

type RuntimeModel = Model<Api>;

export type ParsedModelSpec = {
	provider: string;
	modelId: string;
};

export type NativeCompactionFailureReason =
	| "disabled"
	| "missing-model"
	| "invalid-model-spec"
	| "model-not-found"
	| "unsupported-api"
	| "missing-base-url"
	| "missing-api-key"
	| "auth-resolution-failed"
	| "unsupported-payload"
	| "payload-model-mismatch"
	| "base-url-mismatch";

export type NativeCompactionSupportOptions = {
	enabled?: boolean;
	/** Which Responses APIs should use the compact endpoint; defaults to all capable APIs. */
	responsesApis?: readonly string[];
};

export type ResponsesCompatibleRequestPayload = {
	model: string;
	input: unknown[];
	instructions?: unknown;
	[key: string]: unknown;
};

export type NativeCompactionRuntime = {
	provider: string;
	api: ResponsesCompactApi;
	model: string;
	baseUrl: string;
	apiKey: string;
	headers?: ProviderHeaders;
	responsesPath: string;
	responsesUrl: string;
	compactPath: string;
	compactUrl: string;
	payload?: ResponsesCompatibleRequestPayload;
	currentModel: RuntimeModel;
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
	  }
	| { ok: false; error: string };

function normalizeConfiguredApis(values: readonly string[] | undefined): Set<string> {
	if (values === undefined) {
		return new Set(RESPONSES_COMPACT_CAPABLE_APIS);
	}
	return new Set(values.map((value) => value.trim()).filter((value) => value.length > 0));
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

export function buildResponsesUrl(baseUrl: string, api: ResponsesCompactApi): string {
	return api === "openai-codex-responses" ? buildCodexResponsesUrl(baseUrl) : buildOpenAIResponsesUrl(baseUrl);
}

export function buildResponsesPath(api: ResponsesCompactApi): string {
	return api === "openai-codex-responses" ? CODEX_RESPONSES_PATH : OPENAI_RESPONSES_PATH;
}

export function buildCompactUrl(baseUrl: string, api: ResponsesCompactApi): string {
	return api === "openai-codex-responses" ? buildCodexCompactUrl(baseUrl) : buildOpenAICompactUrl(baseUrl);
}

export function buildCompactPath(api: ResponsesCompactApi): string {
	return api === "openai-codex-responses" ? CODEX_COMPACT_PATH : OPENAI_COMPACT_PATH;
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

	const descriptor = getRuntimeModelDescriptor(currentModel);
	if (!currentModel || !descriptor.provider || !descriptor.api || !descriptor.model) {
		return {
			ok: false,
			reason: "missing-model",
			...descriptor,
		};
	}

	// The compact endpoint is selected purely by API family: any provider speaking
	// openai-responses/openai-codex-responses gets a native compact attempt and fails
	// open (to the fallback model or pi's default) when the endpoint is missing.
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

		if (payload.model !== descriptor.model) {
			return {
				ok: false,
				reason: "payload-model-mismatch",
				...descriptor,
			};
		}

		requestPayload = payload;
	}

	let auth: ResolvedRequestAuth;
	try {
		auth = await resolveRequestAuth(ctx, currentModel);
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

	const baseUrl = normalizeBaseUrl(auth.baseUrl) ?? descriptor.baseUrl;
	if (!baseUrl) {
		return {
			ok: false,
			reason: "missing-base-url",
			...descriptor,
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
			baseUrl,
			apiKey: auth.apiKey,
			headers: auth.headers,
			responsesPath: buildResponsesPath(descriptor.api),
			responsesUrl: buildResponsesUrl(baseUrl, descriptor.api),
			compactPath: buildCompactPath(descriptor.api),
			compactUrl: buildCompactUrl(baseUrl, descriptor.api),
			payload: requestPayload,
			currentModel,
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
