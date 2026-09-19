import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import { buildResponsesRequestHeaders } from "../responses-headers";
import { buildAlphaSearchUrl, type ResponsesRuntime } from "../runtime";

export const MAX_ALPHA_ACTIONS = 8;
export const MAX_ALPHA_COMMAND_CHARS = 4_096;
export const MAX_ALPHA_REF_ID_CHARS = 1_024;
export const MAX_ALPHA_DOMAIN_CHARS = 256;
export const MAX_ALPHA_DOMAINS = 16;
export const MAX_ALPHA_RECENCY_DAYS = 3_650;
export const MAX_ALPHA_LINE_NUMBER = 1_000_000;
export const MAX_ALPHA_LINK_ID = 10_000;
export const MAX_ALPHA_PAGE_NUMBER = 1_000_000;
export const MAX_ALPHA_WEATHER_DAYS = 31;
export const MAX_ALPHA_GAMES = 50;
export const MAX_ALPHA_REQUEST_BYTES = 64 * 1024;
export const MAX_ALPHA_RESPONSE_BYTES = 512 * 1024;
export const MAX_ALPHA_OUTPUT_BYTES = 64 * 1024;
export const MAX_ALPHA_RESULTS = 50;
export const MAX_ALPHA_RESULTS_BYTES = 256 * 1024;
export const MAX_ALPHA_ERROR_CHARS = 2_048;
export const ALPHA_SEARCH_TIMEOUT_MS = 35_000;
export const MAX_ALPHA_TIMEOUT_MS = 2 ** 32 - 1;
export const ALPHA_SEARCH_MAX_OUTPUT_TOKENS = 4_096;

const SEARCH_RESPONSE_LENGTHS = ["short", "medium", "long"] as const;
const FINANCE_ASSET_TYPES = ["equity", "fund", "crypto", "index"] as const;
const SPORTS_FUNCTIONS = ["schedule", "standings"] as const;
const SPORTS_LEAGUES = ["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"] as const;
const SPORTS_TOOL_NAMES = ["sports"] as const;

const SearchQueryParameters = Type.Object(
	{
		q: Type.String({ minLength: 1, maxLength: MAX_ALPHA_COMMAND_CHARS }),
		recency: Type.Optional(
			Type.Union([Type.Integer({ minimum: 0, maximum: MAX_ALPHA_RECENCY_DAYS }), Type.Null()]),
		),
		domains: Type.Optional(
			Type.Union([
				Type.Array(Type.String({ minLength: 1, maxLength: MAX_ALPHA_DOMAIN_CHARS }), {
					maxItems: MAX_ALPHA_DOMAINS,
				}),
				Type.Null(),
			]),
		),
	},
	{ additionalProperties: false },
);

const OpenParameters = Type.Object(
	{
		ref_id: Type.String({ minLength: 1, maxLength: MAX_ALPHA_REF_ID_CHARS }),
		lineno: Type.Optional(
			Type.Union([Type.Integer({ minimum: 1, maximum: MAX_ALPHA_LINE_NUMBER }), Type.Null()]),
		),
	},
	{ additionalProperties: false },
);

const ClickParameters = Type.Object(
	{
		ref_id: Type.String({ minLength: 1, maxLength: MAX_ALPHA_REF_ID_CHARS }),
		id: Type.Integer({ minimum: 1, maximum: MAX_ALPHA_LINK_ID }),
	},
	{ additionalProperties: false },
);

const FindParameters = Type.Object(
	{
		ref_id: Type.String({ minLength: 1, maxLength: MAX_ALPHA_REF_ID_CHARS }),
		pattern: Type.String({ minLength: 1, maxLength: MAX_ALPHA_COMMAND_CHARS }),
	},
	{ additionalProperties: false },
);

const ScreenshotParameters = Type.Object(
	{
		ref_id: Type.String({ minLength: 1, maxLength: MAX_ALPHA_REF_ID_CHARS }),
		pageno: Type.Integer({ minimum: 0, maximum: MAX_ALPHA_PAGE_NUMBER }),
	},
	{ additionalProperties: false },
);

const FinanceParameters = Type.Object(
	{
		ticker: Type.String({ minLength: 1, maxLength: MAX_ALPHA_COMMAND_CHARS }),
		type: StringEnum(FINANCE_ASSET_TYPES),
		market: Type.Optional(
			Type.Union([Type.String({ minLength: 1, maxLength: MAX_ALPHA_COMMAND_CHARS }), Type.Null()]),
		),
	},
	{ additionalProperties: false },
);

const WeatherParameters = Type.Object(
	{
		location: Type.String({ minLength: 1, maxLength: MAX_ALPHA_COMMAND_CHARS }),
		start: Type.Optional(
			Type.Union([Type.String({ minLength: 1, maxLength: MAX_ALPHA_COMMAND_CHARS }), Type.Null()]),
		),
		duration: Type.Optional(
			Type.Union([Type.Integer({ minimum: 1, maximum: MAX_ALPHA_WEATHER_DAYS }), Type.Null()]),
		),
	},
	{ additionalProperties: false },
);

const SportsParameters = Type.Object(
	{
		tool: Type.Optional(Type.Union([StringEnum(SPORTS_TOOL_NAMES), Type.Null()])),
		fn: StringEnum(SPORTS_FUNCTIONS),
		league: StringEnum(SPORTS_LEAGUES),
		team: Type.Optional(
			Type.Union([Type.String({ minLength: 1, maxLength: MAX_ALPHA_COMMAND_CHARS }), Type.Null()]),
		),
		opponent: Type.Optional(
			Type.Union([Type.String({ minLength: 1, maxLength: MAX_ALPHA_COMMAND_CHARS }), Type.Null()]),
		),
		date_from: Type.Optional(
			Type.Union([Type.String({ minLength: 1, maxLength: MAX_ALPHA_COMMAND_CHARS }), Type.Null()]),
		),
		date_to: Type.Optional(
			Type.Union([Type.String({ minLength: 1, maxLength: MAX_ALPHA_COMMAND_CHARS }), Type.Null()]),
		),
		num_games: Type.Optional(
			Type.Union([Type.Integer({ minimum: 1, maximum: MAX_ALPHA_GAMES }), Type.Null()]),
		),
		locale: Type.Optional(
			Type.Union([Type.String({ minLength: 1, maxLength: MAX_ALPHA_COMMAND_CHARS }), Type.Null()]),
		),
	},
	{ additionalProperties: false },
);

const TimeParameters = Type.Object(
	{
		utc_offset: Type.String({ minLength: 1, maxLength: 32 }),
	},
	{ additionalProperties: false },
);

export const STANDALONE_WEB_RUN_PARAMETERS = Type.Object(
	{
		search_query: Type.Optional(Type.Union([Type.Array(SearchQueryParameters, { minItems: 1, maxItems: MAX_ALPHA_ACTIONS }), Type.Null()])),
		image_query: Type.Optional(Type.Union([Type.Array(SearchQueryParameters, { minItems: 1, maxItems: MAX_ALPHA_ACTIONS }), Type.Null()])),
		open: Type.Optional(Type.Union([Type.Array(OpenParameters, { minItems: 1, maxItems: MAX_ALPHA_ACTIONS }), Type.Null()])),
		click: Type.Optional(Type.Union([Type.Array(ClickParameters, { minItems: 1, maxItems: MAX_ALPHA_ACTIONS }), Type.Null()])),
		find: Type.Optional(Type.Union([Type.Array(FindParameters, { minItems: 1, maxItems: MAX_ALPHA_ACTIONS }), Type.Null()])),
		screenshot: Type.Optional(Type.Union([Type.Array(ScreenshotParameters, { minItems: 1, maxItems: MAX_ALPHA_ACTIONS }), Type.Null()])),
		finance: Type.Optional(Type.Union([Type.Array(FinanceParameters, { minItems: 1, maxItems: MAX_ALPHA_ACTIONS }), Type.Null()])),
		weather: Type.Optional(Type.Union([Type.Array(WeatherParameters, { minItems: 1, maxItems: MAX_ALPHA_ACTIONS }), Type.Null()])),
		sports: Type.Optional(Type.Union([Type.Array(SportsParameters, { minItems: 1, maxItems: MAX_ALPHA_ACTIONS }), Type.Null()])),
		time: Type.Optional(Type.Union([Type.Array(TimeParameters, { minItems: 1, maxItems: MAX_ALPHA_ACTIONS }), Type.Null()])),
		response_length: Type.Optional(Type.Union([StringEnum(SEARCH_RESPONSE_LENGTHS), Type.Null()])),
	},
	{ additionalProperties: false },
);

export type StandaloneWebRunParameters = Static<typeof STANDALONE_WEB_RUN_PARAMETERS>;
export type AlphaSearchResponseLength = (typeof SEARCH_RESPONSE_LENGTHS)[number];
export type FinanceAssetType = (typeof FINANCE_ASSET_TYPES)[number];
export type SportsFunction = (typeof SPORTS_FUNCTIONS)[number];
export type SportsLeague = (typeof SPORTS_LEAGUES)[number];

export type AlphaSearchQuery = {
	q: string;
	recency?: number;
	domains?: string[];
};

export type AlphaOpenOperation = {
	ref_id: string;
	lineno?: number;
};

export type AlphaClickOperation = {
	ref_id: string;
	id: number;
};

export type AlphaFindOperation = {
	ref_id: string;
	pattern: string;
};

export type AlphaScreenshotOperation = {
	ref_id: string;
	pageno: number;
};

export type AlphaFinanceOperation = {
	ticker: string;
	type: FinanceAssetType;
	market?: string;
};

export type AlphaWeatherOperation = {
	location: string;
	start?: string;
	duration?: number;
};

export type AlphaSportsOperation = {
	tool?: "sports";
	fn: SportsFunction;
	league: SportsLeague;
	team?: string;
	opponent?: string;
	date_from?: string;
	date_to?: string;
	num_games?: number;
	locale?: string;
};

export type AlphaTimeOperation = {
	utc_offset: string;
};

export type StandaloneWebRunCommands = {
	search_query?: AlphaSearchQuery[];
	image_query?: AlphaSearchQuery[];
	open?: AlphaOpenOperation[];
	click?: AlphaClickOperation[];
	find?: AlphaFindOperation[];
	screenshot?: AlphaScreenshotOperation[];
	finance?: AlphaFinanceOperation[];
	weather?: AlphaWeatherOperation[];
	sports?: AlphaSportsOperation[];
	time?: AlphaTimeOperation[];
	response_length?: AlphaSearchResponseLength;
};

export type AlphaSearchRequest = {
	id: string;
	model: string;
	commands: StandaloneWebRunCommands;
	max_output_tokens: number;
};

export type AlphaSearchDetails = {
	status: number;
	responseId?: string;
	encryptedOutput?: string;
	results?: unknown[];
};

export type AlphaSearchClientFailureReason =
	| "aborted"
	| "timeout"
	| "invalid-parameters"
	| "invalid-url"
	| "request-too-large"
	| "authentication"
	| "rate-limit"
	| "request-rejected"
	| "backend-unavailable"
	| "network"
	| "oversized-response"
	| "malformed-response";

export type AlphaSearchClientResult =
	| { ok: true; status: number; output: string; details: AlphaSearchDetails }
	| {
			ok: false;
			reason: AlphaSearchClientFailureReason;
			status?: number;
			errorMessage: string;
	  };

export type AlphaSearchFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class StandaloneWebRunError extends Error {
	readonly code = "invalid-parameters" as const;

	constructor(message: string) {
		super(message);
		this.name = "StandaloneWebRunError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function invalid(field: string, message: string): never {
	throw new StandaloneWebRunError(`${field}: ${boundedText(message, MAX_ALPHA_ERROR_CHARS)}.`);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) invalid(field, `unexpected field "${boundedText(key, 128)}"`);
	}
}

function requiredString(value: unknown, field: string, maxChars: number): string {
	if (typeof value !== "string") invalid(field, "expected a string");
	const trimmed = value.trim();
	if (!trimmed) invalid(field, "must not be blank");
	if (trimmed.length > maxChars) invalid(field, `must be at most ${maxChars} characters`);
	return trimmed;
}

function optionalString(value: unknown, field: string, maxChars: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") invalid(field, "expected a string or null");
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.length > maxChars) invalid(field, `must be at most ${maxChars} characters`);
	return trimmed;
}

function requiredInteger(value: unknown, field: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value)) {
		invalid(field, "expected an integer");
	}
	if (value < min || value > max) invalid(field, `must be between ${min} and ${max}`);
	return value;
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
	if (value === undefined || value === null) return undefined;
	return requiredInteger(value, field, min, max);
}

function optionalEnum<T extends string>(value: unknown, field: string, values: readonly T[]): T | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !values.includes(value as T)) {
		invalid(field, `expected one of ${values.join(", ")}`);
	}
	return value as T;
}

function requiredEnum<T extends string>(value: unknown, field: string, values: readonly T[]): T {
	const result = optionalEnum(value, field, values);
	if (result === undefined) invalid(field, "is required");
	return result;
}

function normalizeDomains(value: unknown, field: string): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) invalid(field, "expected an array or null");
	if (value.length === 0) return undefined;
	if (value.length > MAX_ALPHA_DOMAINS) invalid(field, `must contain at most ${MAX_ALPHA_DOMAINS} entries`);
	const domains: string[] = [];
	for (const [index, item] of value.entries()) {
		const domain = requiredString(item, `${field}[${index}]`, MAX_ALPHA_DOMAIN_CHARS);
		if (!domains.includes(domain)) domains.push(domain);
	}
	return domains;
}

function normalizeSearchQuery(value: unknown, field: string): AlphaSearchQuery {
	if (!isRecord(value)) invalid(field, "expected an object");
	assertAllowedKeys(value, ["q", "recency", "domains"], field);
	const q = requiredString(value.q, `${field}.q`, MAX_ALPHA_COMMAND_CHARS);
	const recency = optionalInteger(value.recency, `${field}.recency`, 0, MAX_ALPHA_RECENCY_DAYS);
	const domains = normalizeDomains(value.domains, `${field}.domains`);
	return {
		q,
		...(recency !== undefined ? { recency } : {}),
		...(domains ? { domains } : {}),
	};
}

function normalizeOperationArray<T>(
	value: unknown,
	field: string,
	normalizeItem: (item: unknown, itemField: string) => T,
): T[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) invalid(field, "expected an array or null");
	if (value.length === 0) invalid(field, "must contain at least one operation");
	if (value.length > MAX_ALPHA_ACTIONS) invalid(field, `must contain at most ${MAX_ALPHA_ACTIONS} operations`);
	return value.map((item, index) => normalizeItem(item, `${field}[${index}]`));
}

function normalizeOpen(value: unknown, field: string): AlphaOpenOperation {
	if (!isRecord(value)) invalid(field, "expected an object");
	assertAllowedKeys(value, ["ref_id", "lineno"], field);
	const ref_id = requiredString(value.ref_id, `${field}.ref_id`, MAX_ALPHA_REF_ID_CHARS);
	const lineno = optionalInteger(value.lineno, `${field}.lineno`, 1, MAX_ALPHA_LINE_NUMBER);
	return { ref_id, ...(lineno !== undefined ? { lineno } : {}) };
}

function normalizeClick(value: unknown, field: string): AlphaClickOperation {
	if (!isRecord(value)) invalid(field, "expected an object");
	assertAllowedKeys(value, ["ref_id", "id"], field);
	return {
		ref_id: requiredString(value.ref_id, `${field}.ref_id`, MAX_ALPHA_REF_ID_CHARS),
		id: requiredInteger(value.id, `${field}.id`, 1, MAX_ALPHA_LINK_ID),
	};
}

function normalizeFind(value: unknown, field: string): AlphaFindOperation {
	if (!isRecord(value)) invalid(field, "expected an object");
	assertAllowedKeys(value, ["ref_id", "pattern"], field);
	return {
		ref_id: requiredString(value.ref_id, `${field}.ref_id`, MAX_ALPHA_REF_ID_CHARS),
		pattern: requiredString(value.pattern, `${field}.pattern`, MAX_ALPHA_COMMAND_CHARS),
	};
}

function normalizeScreenshot(value: unknown, field: string): AlphaScreenshotOperation {
	if (!isRecord(value)) invalid(field, "expected an object");
	assertAllowedKeys(value, ["ref_id", "pageno"], field);
	return {
		ref_id: requiredString(value.ref_id, `${field}.ref_id`, MAX_ALPHA_REF_ID_CHARS),
		pageno: requiredInteger(value.pageno, `${field}.pageno`, 0, MAX_ALPHA_PAGE_NUMBER),
	};
}

function normalizeFinance(value: unknown, field: string): AlphaFinanceOperation {
	if (!isRecord(value)) invalid(field, "expected an object");
	assertAllowedKeys(value, ["ticker", "type", "market"], field);
	const market = optionalString(value.market, `${field}.market`, MAX_ALPHA_COMMAND_CHARS);
	return {
		ticker: requiredString(value.ticker, `${field}.ticker`, MAX_ALPHA_COMMAND_CHARS),
		type: requiredEnum(value.type, `${field}.type`, FINANCE_ASSET_TYPES),
		...(market !== undefined ? { market } : {}),
	};
}

function normalizeWeather(value: unknown, field: string): AlphaWeatherOperation {
	if (!isRecord(value)) invalid(field, "expected an object");
	assertAllowedKeys(value, ["location", "start", "duration"], field);
	const start = optionalString(value.start, `${field}.start`, MAX_ALPHA_COMMAND_CHARS);
	const duration = optionalInteger(value.duration, `${field}.duration`, 1, MAX_ALPHA_WEATHER_DAYS);
	return {
		location: requiredString(value.location, `${field}.location`, MAX_ALPHA_COMMAND_CHARS),
		...(start !== undefined ? { start } : {}),
		...(duration !== undefined ? { duration } : {}),
	};
}

function normalizeSports(value: unknown, field: string): AlphaSportsOperation {
	if (!isRecord(value)) invalid(field, "expected an object");
	assertAllowedKeys(value, ["tool", "fn", "league", "team", "opponent", "date_from", "date_to", "num_games", "locale"], field);
	const tool = optionalEnum(value.tool, `${field}.tool`, SPORTS_TOOL_NAMES);
	const team = optionalString(value.team, `${field}.team`, MAX_ALPHA_COMMAND_CHARS);
	const opponent = optionalString(value.opponent, `${field}.opponent`, MAX_ALPHA_COMMAND_CHARS);
	const date_from = optionalString(value.date_from, `${field}.date_from`, MAX_ALPHA_COMMAND_CHARS);
	const date_to = optionalString(value.date_to, `${field}.date_to`, MAX_ALPHA_COMMAND_CHARS);
	const num_games = optionalInteger(value.num_games, `${field}.num_games`, 1, MAX_ALPHA_GAMES);
	const locale = optionalString(value.locale, `${field}.locale`, MAX_ALPHA_COMMAND_CHARS);
	return {
		...(tool !== undefined ? { tool } : {}),
		fn: requiredEnum(value.fn, `${field}.fn`, SPORTS_FUNCTIONS),
		league: requiredEnum(value.league, `${field}.league`, SPORTS_LEAGUES),
		...(team !== undefined ? { team } : {}),
		...(opponent !== undefined ? { opponent } : {}),
		...(date_from !== undefined ? { date_from } : {}),
		...(date_to !== undefined ? { date_to } : {}),
		...(num_games !== undefined ? { num_games } : {}),
		...(locale !== undefined ? { locale } : {}),
	};
}

function normalizeTime(value: unknown, field: string): AlphaTimeOperation {
	if (!isRecord(value)) invalid(field, "expected an object");
	assertAllowedKeys(value, ["utc_offset"], field);
	return { utc_offset: requiredString(value.utc_offset, `${field}.utc_offset`, 32) };
}

export function normalizeStandaloneWebRunCommands(value: unknown): StandaloneWebRunCommands {
	if (!isRecord(value)) invalid("web.run", "expected an object");
	assertAllowedKeys(value, [
		"search_query",
		"image_query",
		"open",
		"click",
		"find",
		"screenshot",
		"finance",
		"weather",
		"sports",
		"time",
		"response_length",
	], "web.run");

	const search_query = normalizeOperationArray(value.search_query, "search_query", normalizeSearchQuery);
	const image_query = normalizeOperationArray(value.image_query, "image_query", normalizeSearchQuery);
	const open = normalizeOperationArray(value.open, "open", normalizeOpen);
	const click = normalizeOperationArray(value.click, "click", normalizeClick);
	const find = normalizeOperationArray(value.find, "find", normalizeFind);
	const screenshot = normalizeOperationArray(value.screenshot, "screenshot", normalizeScreenshot);
	const finance = normalizeOperationArray(value.finance, "finance", normalizeFinance);
	const weather = normalizeOperationArray(value.weather, "weather", normalizeWeather);
	const sports = normalizeOperationArray(value.sports, "sports", normalizeSports);
	const time = normalizeOperationArray(value.time, "time", normalizeTime);
	const response_length = optionalEnum(value.response_length, "response_length", SEARCH_RESPONSE_LENGTHS);

	if (!search_query && !image_query && !open && !click && !find && !screenshot && !finance && !weather && !sports && !time) {
		invalid("web.run", "at least one search command is required");
	}
	return {
		...(search_query ? { search_query } : {}),
		...(image_query ? { image_query } : {}),
		...(open ? { open } : {}),
		...(click ? { click } : {}),
		...(find ? { find } : {}),
		...(screenshot ? { screenshot } : {}),
		...(finance ? { finance } : {}),
		...(weather ? { weather } : {}),
		...(sports ? { sports } : {}),
		...(time ? { time } : {}),
		...(response_length !== undefined ? { response_length } : {}),
	};
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function freshRequestId(): string {
	return globalThis.crypto.randomUUID();
}

export function buildAlphaSearchRequest(args: {
	model: string;
	commands: unknown;
	id?: string;
	maxOutputTokens?: number;
}): { request: AlphaSearchRequest; body: string } {
	const model = requiredString(args.model, "model", MAX_ALPHA_COMMAND_CHARS);
	const commands = normalizeStandaloneWebRunCommands(args.commands);
	const id = requiredString(args.id ?? freshRequestId(), "id", MAX_ALPHA_REF_ID_CHARS);
	const maxOutputTokens = args.maxOutputTokens ?? ALPHA_SEARCH_MAX_OUTPUT_TOKENS;
	if (
		typeof maxOutputTokens !== "number" ||
		!Number.isInteger(maxOutputTokens) ||
		!Number.isFinite(maxOutputTokens) ||
		maxOutputTokens < 1 ||
		maxOutputTokens > ALPHA_SEARCH_MAX_OUTPUT_TOKENS
	) {
		invalid("max_output_tokens", `must be an integer between 1 and ${ALPHA_SEARCH_MAX_OUTPUT_TOKENS}`);
	}
	const request: AlphaSearchRequest = {
		id,
		model,
		commands,
		max_output_tokens: maxOutputTokens,
	};
	const body = JSON.stringify(request);
	if (utf8ByteLength(body) > MAX_ALPHA_REQUEST_BYTES) {
		throw new StandaloneWebRunError("web.run request exceeds the 64 KiB limit.");
	}
	return { request, body };
}

export function sanitizeAlphaDiagnostic(value: unknown, fallback: string): string {
	const raw = typeof value === "string" ? value : value instanceof Error ? value.message : String(value ?? "");
	const sanitized = raw
		.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
		.replace(/((?:["'])(?:api[-_ ]?key|access[_-]?token|access[_-]?key|client[_-]?secret|token|secret|password|cookie|authorization)(?:["'])\s*:\s*["'])[^"']*(["'])/gi, "$1[REDACTED]$2")
		.replace(/((?:api[-_ ]?key|access[_-]?token|access[_-]?key|client[_-]?secret|token|secret|password|cookie|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
		.replace(/([?&](?:api[-_ ]?key|access[_-]?token|access[_-]?key|client[_-]?secret|token|secret|password|cookie|authorization)=)[^&\s]+/gi, "$1[REDACTED]")
		.trim();
	return boundedText(sanitized || fallback, MAX_ALPHA_ERROR_CHARS);
}

function providerErrorText(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = isRecord(value.error) ? value.error : value;
	const parts = [candidate.code, candidate.type, candidate.message].filter(
		(item): item is string => typeof item === "string" && item.trim().length > 0,
	);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function mapHttpFailure(status: number, payload: unknown): AlphaSearchClientFailureReason {
	if (status === 401 || status === 403) return "authentication";
	const providerText = providerErrorText(payload)?.toLowerCase() ?? "";
	if (
		status === 429 ||
		/(?:rate|usage|billing)[-_ ]?limit|quota|insufficient[-_ ]?(?:quota|credit)/.test(providerText)
	) {
		return "rate-limit";
	}
	if (status >= 500) return "backend-unavailable";
	return "request-rejected";
}

function defaultHttpMessage(status: number, reason: AlphaSearchClientFailureReason): string {
	switch (reason) {
		case "authentication":
			return "Standalone Web Search authentication failed for the current model provider.";
		case "rate-limit":
			return "Standalone Web Search was rate-limited or the provider search quota was exhausted.";
		case "backend-unavailable":
			return "Standalone Web Search is temporarily unavailable at the configured gateway or upstream provider.";
		default:
			return `Standalone Web Search request was rejected (HTTP ${status}).`;
	}
}

async function readBoundedBody(
	response: Response,
	maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		const parsed = Number(contentLength);
		if (Number.isFinite(parsed) && parsed > maxBytes) return { ok: false };
	}
	if (!response.body) return { ok: true, bytes: new Uint8Array() };

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			if (!next.value) continue;
			total += next.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return { ok: false };
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, bytes };
}

function parseJson(bytes: Uint8Array): unknown {
	return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function parseAlphaSearchResponse(value: unknown, status: number):
	| { ok: true; output: string; details: AlphaSearchDetails }
	| { ok: false; reason: "malformed-response" | "oversized-response"; errorMessage: string } {
	if (!isRecord(value)) {
		return { ok: false, reason: "malformed-response", errorMessage: "Standalone Web Search returned a non-object response." };
	}
	if (typeof value.output !== "string" || !value.output.trim()) {
		return { ok: false, reason: "malformed-response", errorMessage: "Standalone Web Search response did not contain usable output text." };
	}
	if (utf8ByteLength(value.output) > MAX_ALPHA_OUTPUT_BYTES) {
		return { ok: false, reason: "oversized-response", errorMessage: "Standalone Web Search output exceeded the configured size limit." };
	}

	let encryptedOutput: string | undefined;
	if (value.encrypted_output !== undefined) {
		if (typeof value.encrypted_output !== "string") {
			return { ok: false, reason: "malformed-response", errorMessage: "Standalone Web Search encrypted output was malformed." };
		}
		if (utf8ByteLength(value.encrypted_output) > MAX_ALPHA_OUTPUT_BYTES) {
			return { ok: false, reason: "oversized-response", errorMessage: "Standalone Web Search encrypted output exceeded the configured size limit." };
		}
		encryptedOutput = value.encrypted_output;
	}

	let results: unknown[] | undefined;
	if (value.results !== undefined) {
		if (!Array.isArray(value.results)) {
			return { ok: false, reason: "malformed-response", errorMessage: "Standalone Web Search results were malformed." };
		}
		if (value.results.length > MAX_ALPHA_RESULTS) {
			return { ok: false, reason: "oversized-response", errorMessage: "Standalone Web Search returned too many result entries." };
		}
		let serializedResults: string;
		try {
			const serialized = JSON.stringify(value.results);
			if (typeof serialized !== "string") {
				return { ok: false, reason: "malformed-response", errorMessage: "Standalone Web Search results could not be serialized." };
			}
			serializedResults = serialized;
			results = structuredClone(value.results);
		} catch {
			return { ok: false, reason: "malformed-response", errorMessage: "Standalone Web Search results could not be serialized." };
		}
		if (utf8ByteLength(serializedResults) > MAX_ALPHA_RESULTS_BYTES) {
			return { ok: false, reason: "oversized-response", errorMessage: "Standalone Web Search results exceeded the configured size limit." };
		}
	}

	const responseId = typeof value.id === "string" && value.id.trim()
		? boundedText(value.id.trim(), MAX_ALPHA_REF_ID_CHARS)
		: undefined;
	return {
		ok: true,
		output: value.output,
		details: {
			status,
			...(responseId ? { responseId } : {}),
			...(encryptedOutput !== undefined ? { encryptedOutput } : {}),
			...(results !== undefined ? { results } : {}),
		},
	};
}

export async function requestAlphaSearch(args: {
	runtime: ResponsesRuntime;
	commands: StandaloneWebRunCommands;
	signal?: AbortSignal;
	fetchFn?: AlphaSearchFetch;
	timeoutMs?: number;
	requestId?: string;
}): Promise<AlphaSearchClientResult> {
	if (args.signal?.aborted) {
		return { ok: false, reason: "aborted", errorMessage: "Standalone Web Search was cancelled." };
	}
	const url = buildAlphaSearchUrl(args.runtime.baseUrl);
	if (!url) {
		return { ok: false, reason: "invalid-url", errorMessage: "Standalone Web Search has an invalid provider base URL." };
	}

	let request: { request: AlphaSearchRequest; body: string };
	try {
		request = buildAlphaSearchRequest({
			model: args.runtime.model,
			commands: args.commands,
			id: args.requestId,
		});
	} catch (error) {
		const errorMessage = sanitizeAlphaDiagnostic(error, "Standalone Web Search request was invalid.");
		return {
			ok: false,
			reason: errorMessage.includes("exceeds the 64 KiB limit") ? "request-too-large" : "invalid-parameters",
			errorMessage,
		};
	}

	const fetchFn = args.fetchFn ?? globalThis.fetch;
	const timeoutMs = args.timeoutMs ?? ALPHA_SEARCH_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_ALPHA_TIMEOUT_MS) {
		return {
			ok: false,
			reason: "invalid-parameters",
			errorMessage: "Standalone Web Search timeout must be a non-negative bounded integer.",
		};
	}
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	// Bun implements AbortSignal.any() with weak references to its inputs; keep
	// the timeout signal live for the duration of this request so a short test
	// or a real fast timeout cannot be lost before it fires.
	timeoutSignal.addEventListener("abort", () => undefined, { once: true });
	const signal = args.signal ? AbortSignal.any([args.signal, timeoutSignal]) : timeoutSignal;
	if (signal.aborted) {
		return timeoutSignal.aborted && !args.signal?.aborted
			? { ok: false, reason: "timeout", errorMessage: "Standalone Web Search timed out. The request was not retried automatically." }
			: { ok: false, reason: "aborted", errorMessage: "Standalone Web Search was cancelled." };
	}
	let response: Response;
	try {
		response = await fetchFn(url, {
			method: "POST",
			redirect: "error",
			headers: buildResponsesRequestHeaders(args.runtime, {
				accept: "application/json",
				sessionId: args.runtime.sessionId,
			}),
			body: request.body,
			signal,
		});
	} catch (error) {
		if (args.signal?.aborted) {
			return { ok: false, reason: "aborted", errorMessage: "Standalone Web Search was cancelled." };
		}
		if (timeoutSignal.aborted) {
			return {
				ok: false,
				reason: "timeout",
				errorMessage: "Standalone Web Search timed out. The request was not retried automatically.",
			};
		}
		return {
			ok: false,
			reason: "network",
			errorMessage: sanitizeAlphaDiagnostic(
				error,
				"Standalone Web Search network request failed. The request was not retried automatically.",
			),
		};
	}

	let bounded: Awaited<ReturnType<typeof readBoundedBody>>;
	try {
		bounded = await readBoundedBody(response, MAX_ALPHA_RESPONSE_BYTES);
	} catch (error) {
		if (args.signal?.aborted) {
			return { ok: false, reason: "aborted", status: response.status, errorMessage: "Standalone Web Search was cancelled." };
		}
		if (timeoutSignal.aborted) {
			return {
				ok: false,
				reason: "timeout",
				status: response.status,
				errorMessage: "Standalone Web Search timed out while reading the response. The request was not retried automatically.",
			};
		}
		return {
			ok: false,
			reason: "network",
			status: response.status,
			errorMessage: sanitizeAlphaDiagnostic(
				error,
				"Standalone Web Search response could not be read. The request was not retried automatically.",
			),
		};
	}
	if (args.signal?.aborted) {
		return { ok: false, reason: "aborted", status: response.status, errorMessage: "Standalone Web Search was cancelled." };
	}
	if (timeoutSignal.aborted) {
		return {
			ok: false,
			reason: "timeout",
			status: response.status,
			errorMessage: "Standalone Web Search timed out while reading the response. The request was not retried automatically.",
		};
	}
	if (!bounded.ok) {
		return {
			ok: false,
			reason: "oversized-response",
			status: response.status,
			errorMessage: "Standalone Web Search response exceeded the configured size limit.",
		};
	}

	let payload: unknown;
	try {
		payload = parseJson(bounded.bytes);
	} catch {
		const reason = response.ok ? "malformed-response" : mapHttpFailure(response.status, undefined);
		return {
			ok: false,
			reason,
			status: response.status,
			errorMessage: response.ok
				? "Standalone Web Search returned invalid JSON."
				: defaultHttpMessage(response.status, reason),
		};
	}

	if (!response.ok) {
		const reason = mapHttpFailure(response.status, payload);
		return {
			ok: false,
			reason,
			status: response.status,
			errorMessage: sanitizeAlphaDiagnostic(
				providerErrorText(payload),
				defaultHttpMessage(response.status, reason),
			),
		};
	}

	const parsed = parseAlphaSearchResponse(payload, response.status);
	if (!parsed.ok) return { ...parsed, status: response.status };
	return { ok: true, status: response.status, output: parsed.output, details: parsed.details };
}

export const _alphaClientTest = {
	readBoundedBody,
	parseAlphaSearchResponse,
	sanitizeAlphaDiagnostic,
	utf8ByteLength,
};
