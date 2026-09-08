import { describe, expect, test } from "bun:test";
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

function createHarness(options: { model?: unknown; sessionId?: string } = {}) {
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

	registerCodexAstraExtension(pi);

	const fire = (event: string, e: any, c: any = ctx) =>
		(handlers.get(event) ?? []).reduce<unknown>((payload, handler) => handler(e, c) ?? payload, undefined);

	return { pi, ctx, handlers, fire };
}

function requestPayload(effort: string, input: unknown[] = [{ role: "user", content: "hi" }]) {
	return { model: "gpt-6-astra", input, reasoning: { effort }, store: false, stream: true };
}

describe("codex astra extension wiring", () => {
	test("astra models are activated silently by model id, other models pass through", () => {
		const { fire } = createHarness();
		// Baseline request on the astra model: no rewrite needed yet.
		expect(
			fire("before_provider_request", {
				type: "before_provider_request",
				payload: requestPayload("medium", [{ role: "user", content: "hi" }]),
			}),
		).toBeUndefined();
		// A non-astra context model is never touched even with astra-shaped payloads.
		const sol = createHarness({ model: codexModel({ id: "gpt-5.6-sol" }) });
		expect(
			sol.fire("before_provider_request", {
				type: "before_provider_request",
				payload: { ...requestPayload("high"), model: "gpt-5.6-sol" },
			}),
		).toBeUndefined();
		// A baseline exists now, so a changed effort on the astra model rewrites.
		const rewrote = fire("before_provider_request", {
			type: "before_provider_request",
			payload: requestPayload("max", [{ role: "user", content: "hi" }]),
		});
		expect(rewrote).toBeDefined();
	});

	test("an astra model pins the effort and gains configuration_update items on change", () => {
		const { fire } = createHarness();

		// First request baselines.
		expect(
			fire("before_provider_request", {
				type: "before_provider_request",
				payload: requestPayload("low", [{ role: "user", content: "a" }]),
			}),
		).toBeUndefined();

		const changed = {
			...requestPayload("max", [
				{ role: "user", content: "a" },
				{ role: "user", content: "b" },
			]),
			prompt_cache_options: { ttl: "30m" },
		};
		const before = structuredClone(changed);
		const replaced = fire("before_provider_request", { type: "before_provider_request", payload: changed }) as any;

		expect(replaced).toBeDefined();
		expect(replaced.reasoning.effort).toBe("low");
		expect(replaced.input[1]).toEqual({ type: "configuration_update", reasoning: { effort: "max" } });
		// Unknown fields survive the rewrite untouched.
		expect(replaced.store).toBe(false);
		expect(replaced.stream).toBe(true);
		expect(replaced.prompt_cache_options).toEqual({ ttl: "30m" });
		expect(changed).toEqual(before);
	});

	test("payload for another model id is skipped even on an astra context model", () => {
		const { fire } = createHarness();
		// A synthetic payload naming a different model must not consume the
		// astra session model's baseline.
		const foreign = { ...requestPayload("medium"), model: "gpt-5.1" };
		expect(fire("before_provider_request", { type: "before_provider_request", payload: foreign })).toBeUndefined();
	});

	test("openai-responses gateway astra models are rewritten too", () => {
		const { fire } = createHarness({
			model: codexModel({ provider: "uwoacrimson", api: "openai-responses", id: "gpt-6-astra", baseUrl: "https://newapi.example/v1" }),
		});
		expect(
			fire("before_provider_request", {
				type: "before_provider_request",
				payload: { ...requestPayload("low"), model: "gpt-6-astra" },
			}),
		).toBeUndefined(); // baselines; same as codex family
		const changed = fire("before_provider_request", {
			type: "before_provider_request",
			payload: {
				model: "gpt-6-astra",
				input: [
					{ role: "user", content: "a" },
					{ role: "user", content: "b" },
				],
				reasoning: { effort: "max" },
			},
		});
		expect(changed).toBeDefined();
	});

	test("non-Responses APIs are never rewritten", () => {
		const { fire } = createHarness({
			model: codexModel({ provider: "uwoacrimson", api: "openai-completions", id: "gpt-6-astra", baseUrl: "https://newapi.example/v1" }),
		});
		expect(
			fire("before_provider_request", { type: "before_provider_request", payload: requestPayload("high") }),
		).toBeUndefined();
	});

	test("compaction-shaped payloads never receive configuration_update items", () => {
		const { fire } = createHarness();

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
		const { fire } = createHarness();
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
		const { fire } = createHarness();

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
		const { fire } = createHarness();

		const headers: Record<string, string | null> = { authorization: "Bearer x" };
		fire("before_provider_headers", { type: "before_provider_headers", headers });
		expect(headers.version).toBe("0.153.0");
		expect(headers.authorization).toBe("Bearer x");

		const otherHeaders: Record<string, string | null> = {};
		// Re-fire through a handler set built for completions models.
		const h2 = createHarness({ model: codexModel({ provider: "uwoacrimson", api: "openai-completions" }) });
		h2.fire("before_provider_headers", { type: "before_provider_headers", headers: otherHeaders });
		expect(otherHeaders.version).toBeUndefined();
	});

	test("a planner blowup cannot break the request path", () => {
		const { fire } = createHarness();
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
