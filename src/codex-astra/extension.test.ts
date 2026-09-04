import { describe, expect, test } from "bun:test";
import {
	DEFAULT_CODEX_ASTRA_CONFIG,
	DEFAULT_COMPACTION_CONFIG,
	DEFAULT_IMAGE_GENERATION_CONFIG,
	DEFAULT_WEB_SEARCH_CONFIG,
	type CodexAstraConfig,
} from "../types";
import { registerCodexAstraExtension } from "./extension";

type Handler = (event: any, ctx: any) => unknown;

function codexModel(overrides: Record<string, unknown> = {}) {
	return {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		baseUrl: "https://chatgpt.com/backend-api",
		...overrides,
	};
}

function createHarness(options: { codexAstra?: Partial<CodexAstraConfig>; model?: unknown; sessionId?: string } = {}) {
	const codexAstra: CodexAstraConfig = {
		...DEFAULT_CODEX_ASTRA_CONFIG,
		models: [...DEFAULT_CODEX_ASTRA_CONFIG.models],
		...options.codexAstra,
	};
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as any;

	const ctx = {
		model: options.model === undefined ? codexModel() : options.model,
		sessionManager: {
			getSessionId: () => options.sessionId ?? "sess-1",
		},
	};

	registerCodexAstraExtension(pi, () => ({
		config: {
			compaction: DEFAULT_COMPACTION_CONFIG,
			webSearch: DEFAULT_WEB_SEARCH_CONFIG,
			imageGeneration: DEFAULT_IMAGE_GENERATION_CONFIG,
			// autoMode fields are irrelevant here but the type requires them.
			autoMode: {
				enabled: false,
				models: [],
				gate: "side-effect",
				extraTools: [],
				timeoutMs: 30_000,
				transcript: false,
				evidenceTools: false,
				maxEvidenceRounds: 0,
				classifier: { enabled: false, timeoutMs: 15_000, maxLag: 2 },
				circuitBreaker: { consecutiveDenials: 0, recentDenials: 0, windowSize: 50 },
			},
			codexAstra,
		},
		warnings: [],
	}));

	const fire = (event: string, e: any, c: any = ctx) =>
		(handlers.get(event) ?? []).reduce<unknown>((payload, handler) => handler(e, c) ?? payload, undefined);

	return { pi, ctx, handlers, fire };
}

function requestPayload(effort: string, input: unknown[] = [{ role: "user", content: "hi" }]) {
	return { model: "gpt-6-astra", input, reasoning: { effort }, store: false, stream: true };
}

describe("codex astra extension wiring", () => {
	test("disabled by default: payload passes through untouched", () => {
		const { fire } = createHarness();
		const payload = requestPayload("medium");
		expect(fire("before_provider_request", { type: "before_provider_request", payload })).toBeUndefined();
	});

	test("an allowlisted model pins the effort and gains configuration_update items on change", () => {
		const { fire } = createHarness({ codexAstra: { enabled: true, models: ["openai-codex/gpt-6-astra"] } });

		// First request baselines.
		expect(
			fire("before_provider_request", {
				type: "before_provider_request",
				payload: requestPayload("low", [{ role: "user", content: "a" }]),
			}),
		).toBeUndefined();

		const changed = requestPayload("max", [
			{ role: "user", content: "a" },
			{ role: "user", content: "b" },
		]);
		const replaced = fire("before_provider_request", { type: "before_provider_request", payload: changed }) as any;

		expect(replaced).toBeDefined();
		expect(replaced.reasoning.effort).toBe("low");
		expect(replaced.input[1]).toEqual({ type: "configuration_update", reasoning: { effort: "max" } });
		// Unknown fields survive the rewrite untouched.
		expect(replaced.store).toBe(false);
		expect(replaced.stream).toBe(true);
	});

	test("model outside the allowlist is never rewritten", () => {
		const { fire } = createHarness({ codexAstra: { enabled: true, models: ["openai-codex/gpt-6-astra"] } });
		const payload = { ...requestPayload("high"), model: "gpt-5.6-sol" };
		expect(fire("before_provider_request", { type: "before_provider_request", payload })).toBeUndefined();
	});

	test("payload for another model id is skipped even on an allowlisted context model", () => {
		const { fire } = createHarness({ codexAstra: { enabled: true, models: ["openai-codex/gpt-6-astra"] } });
		// A synthetic payload naming a different model must not consume the
		// allowlisted session model's baseline.
		const foreign = { ...requestPayload("medium"), model: "gpt-5.1" };
		expect(fire("before_provider_request", { type: "before_provider_request", payload: foreign })).toBeUndefined();
	});

	test("non-codex models are never rewritten", () => {
		const { fire } = createHarness({
			model: codexModel({ provider: "openai", api: "openai-responses", id: "gpt-6-astra", baseUrl: "https://api.openai.com/v1" }),
			codexAstra: { enabled: true, models: ["openai/gpt-6-astra"] },
		});
		expect(
			fire("before_provider_request", { type: "before_provider_request", payload: requestPayload("high") }),
		).toBeUndefined();
	});

	test("compaction-shaped payloads never receive configuration_update items", () => {
		const { fire } = createHarness({ codexAstra: { enabled: true, models: ["openai-codex/gpt-6-astra"] } });

		fire("before_provider_request", {
			type: "before_provider_request",
			payload: requestPayload("low", [{ role: "user", content: "a" }]),
		});
		const compaction = requestPayload("max", [
			{ role: "user", content: "a" },
			{ type: "compaction_trigger" },
		]);
		expect(fire("before_provider_request", { type: "before_provider_request", payload: compaction })).toBeUndefined();
	});

	test("payloads without a wire effort shape (titles, embeddings) are skipped", () => {
		const { fire } = createHarness({ codexAstra: { enabled: true, models: ["openai-codex/gpt-6-astra"] } });
		expect(
			fire("before_provider_request", {
				type: "before_provider_request",
				payload: { model: "gpt-6-astra", input: "generate a title", reasoning: { effort: "low" } },
			}),
		).toBeUndefined();
		expect(
			fire("before_provider_request", {
				type: "before_provider_request",
				payload: { model: "gpt-6-astra", input: [], reasoning: { effort: "none" } },
			}),
		).toBeUndefined();
	});

	test("session_start drops baselines so a resumed session re-pins cleanly", () => {
		const { fire } = createHarness({ codexAstra: { enabled: true, models: ["openai-codex/gpt-6-astra"] } });

		fire("before_provider_request", {
			type: "before_provider_request",
			payload: requestPayload("low", [{ role: "user", content: "a" }]),
		});
		fire("session_start", { type: "session_start" }, undefined);

		// After the reset the next request baselines from its own effort,
		// with no stale splice.
		const first = requestPayload("max", [{ role: "user", content: "b" }]);
		expect(fire("before_provider_request", { type: "before_provider_request", payload: first })).toBeUndefined();
	});

	test("headers hook adds the version gate to codex requests only", () => {
		const { fire } = createHarness({ codexAstra: { enabled: true, models: ["openai-codex/gpt-6-astra"] } });

		const headers: Record<string, string | null> = { authorization: "Bearer x" };
		fire("before_provider_headers", { type: "before_provider_headers", headers });
		expect(headers.version).toBe("0.153.0");
		expect(headers.authorization).toBe("Bearer x");

		const otherCtx = { ...createHarness({ model: null }).ctx, model: codexModel({ provider: "uwoacrimson", api: "openai-completions" }) };
		const otherHeaders: Record<string, string | null> = {};
		// Re-fire through a handler set built for completions models.
		const h2 = createHarness({ model: otherCtx.model, codexAstra: { enabled: true, models: ["uwoacrimson/gpt-6-astra"] } });
		h2.fire("before_provider_headers", { type: "before_provider_headers", headers: otherHeaders });
		expect(otherHeaders.version).toBeUndefined();
	});

	test("a config or planner blowup cannot break the request path", () => {
		const { fire } = createHarness({ codexAstra: { enabled: true, models: ["openai-codex/gpt-6-astra"] } });
		// Payload shape that would throw mid-plan (non-object item after the guard's
		// filter, e.g. nested null) must return undefined instead of throwing.
		expect(
			fire("before_provider_request", {
				type: "before_provider_request",
				payload: { model: "gpt-6-astra", input: [null], reasoning: { effort: "high" } },
			}),
		).toBeUndefined();
	});
});
