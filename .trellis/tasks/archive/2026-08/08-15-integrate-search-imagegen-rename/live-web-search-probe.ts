import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { transformWebSearchPayload } from "../../../src/web-search/payload.ts";

const modelsPath = path.join(os.homedir(), ".pi", "agent", "models.json");
const models = JSON.parse(fs.readFileSync(modelsPath, "utf8")) as Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function findProvider(value: unknown): { baseUrl: string; apiKey: string } | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.baseUrl === "string" &&
		value.baseUrl.replace(/\/+$/, "") === "https://newapi.uwoacrimson.com/v1" &&
		typeof value.apiKey === "string" &&
		value.apiKey.length > 0
	) {
		return { baseUrl: value.baseUrl.replace(/\/+$/, ""), apiKey: value.apiKey };
	}
	for (const nested of Object.values(value)) {
		const found = findProvider(nested);
		if (found) return found;
	}
	return undefined;
}

function countByKey(value: unknown, predicate: (record: Record<string, unknown>) => boolean): number {
	if (Array.isArray(value)) {
		return value.reduce((total, item) => total + countByKey(item, predicate), 0);
	}
	if (!isRecord(value)) return 0;
	return (predicate(value) ? 1 : 0) + Object.values(value).reduce<number>(
		(total, nested) => total + countByKey(nested, predicate),
		0,
	);
}

const provider = findProvider(models);
if (!provider) {
	throw new Error("Validated NewAPI provider credentials were not found in models.json");
}

const transformed = transformWebSearchPayload({
	api: "openai-responses",
	config: { enabled: true, apis: ["openai-responses"] },
	payload: {
		model: "gpt-5.5",
		input: "Find an official OpenAI page about the Responses API and answer with a cited one-sentence summary.",
		stream: false,
	},
});
if (!transformed.changed || !isRecord(transformed.payload)) {
	throw new Error(`Web Search payload was not injected: ${transformed.outcome}`);
}

const response = await fetch(`${provider.baseUrl}/responses`, {
	method: "POST",
	headers: {
		authorization: `Bearer ${provider.apiKey}`,
		"content-type": "application/json",
	},
	body: JSON.stringify(transformed.payload),
});

if (!response.ok) {
	console.log(JSON.stringify({ httpStatus: response.status, ok: false }));
	process.exitCode = 1;
} else {
	const body = (await response.json()) as unknown;
	const webSearchCalls = countByKey(body, (record) => record.type === "web_search_call");
	const urlCitations = countByKey(body, (record) => record.type === "url_citation");
	const completed = isRecord(body) && body.status === "completed";
	console.log(JSON.stringify({
		httpStatus: response.status,
		completed,
		webSearchCalls,
		urlCitations,
	}));
	if (!completed || webSearchCalls < 1 || urlCitations < 1) {
		process.exitCode = 1;
	}
}
