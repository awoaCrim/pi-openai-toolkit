import { beforeEach, describe, expect, test } from "bun:test";
import {
	clearRequestContextCache,
	getCompactionRequestExtras,
	rememberRequestContext,
	type RequestContextIdentity,
} from "./request-context-cache";

const identity: RequestContextIdentity = {
	provider: "openai",
	api: "openai-responses",
	model: "gpt-5-mini",
	baseUrl: "https://api.example.com/v1",
	sessionId: "session-1",
};

beforeEach(() => {
	clearRequestContextCache();
});

describe("request context cache", () => {
	test("captures only compact-relevant fields from a live payload", () => {
		rememberRequestContext(
			{
				model: "gpt-5-mini",
				input: [{ role: "user", content: [] }],
				instructions: "system prompt",
				stream: true,
				store: false,
				include: ["reasoning.encrypted_content"],
				tool_choice: "auto",
				tools: [{ type: "function", name: "read" }],
				parallel_tool_calls: true,
				reasoning: { effort: "high", summary: "auto" },
				service_tier: "flex",
				prompt_cache_key: "session-1",
				text: { verbosity: "low" },
			},
			identity,
		);

		const extras = getCompactionRequestExtras(identity);
		expect(extras).toEqual({
			tools: [{ type: "function", name: "read" }],
			parallel_tool_calls: true,
			reasoning: { effort: "high", summary: "auto" },
			service_tier: "flex",
			prompt_cache_key: "session-1",
			text: { verbosity: "low" },
		});
		// stream/store/include/tool_choice must never leak into the compact request.
		expect(extras && "stream" in extras).toBe(false);
		expect(extras && "tool_choice" in extras).toBe(false);
	});

	test("misses when the runtime identity differs", () => {
		rememberRequestContext({ model: identity.model, input: [], reasoning: { effort: "low" } }, identity);

		expect(getCompactionRequestExtras({ ...identity, provider: "proxy" })).toBeUndefined();
		expect(getCompactionRequestExtras({ ...identity, api: "openai-codex-responses" })).toBeUndefined();
		expect(getCompactionRequestExtras({ ...identity, model: "gpt-5.1" })).toBeUndefined();
		expect(getCompactionRequestExtras({ ...identity, baseUrl: "https://other.example.com/v1" })).toBeUndefined();
		expect(getCompactionRequestExtras({ ...identity, sessionId: "session-2" })).toBeUndefined();
	});

	test("requires matching absence of a session id", () => {
		const noSession = { ...identity, sessionId: undefined };
		rememberRequestContext({ model: identity.model, input: [], parallel_tool_calls: false }, noSession);

		expect(getCompactionRequestExtras(noSession)).toEqual({ parallel_tool_calls: false });
		expect(getCompactionRequestExtras(identity)).toBeUndefined();
	});

	test("drops payloads whose model disagrees with the identity", () => {
		rememberRequestContext({ model: "gpt-5.1", input: [], reasoning: { effort: "low" } }, identity);

		expect(getCompactionRequestExtras(identity)).toBeUndefined();
	});

	test("returns isolated clones so later mutation cannot corrupt the cache", () => {
		rememberRequestContext({ model: identity.model, input: [], tools: [{ name: "read" }] }, identity);

		const first = getCompactionRequestExtras(identity);
		(first!.tools![0] as Record<string, unknown>).name = "mutated";

		expect(getCompactionRequestExtras(identity)).toEqual({ tools: [{ name: "read" }] });
	});

	test("empty extras are still valid (payload had none of the fields)", () => {
		rememberRequestContext({ model: identity.model, input: [] }, identity);

		expect(getCompactionRequestExtras(identity)).toEqual({});
	});

	test("clearRequestContextCache empties the cache", () => {
		rememberRequestContext({ model: identity.model, input: [], parallel_tool_calls: true }, identity);
		clearRequestContextCache();

		expect(getCompactionRequestExtras(identity)).toBeUndefined();
	});
});
