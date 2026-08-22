# `pi-openai-web-search` integration research

## Scope and source snapshot

- Upstream: <https://github.com/code-yeongyu/pi-openai-web-search>
- Inspected commit: `39643380682f02f306b0de2673ff136c45ccc2a2` (`main`)
- Package version: `0.1.0`
- This repository is small: one runtime source file and one test file.
- The package was not present on npm when checked (`npm view pi-openai-web-search` returned 404), so the README's npm command is prospective; Git/manual installation is the currently evidenced path.
- Upstream contains **web search only**. It has no image-generation capability, image tool, image command, or image-model configuration.

Primary upstream files:

- [`src/index.ts`](https://github.com/code-yeongyu/pi-openai-web-search/blob/39643380682f02f306b0de2673ff136c45ccc2a2/src/index.ts) — complete runtime implementation.
- [`test/index.test.ts`](https://github.com/code-yeongyu/pi-openai-web-search/blob/39643380682f02f306b0de2673ff136c45ccc2a2/test/index.test.ts) — complete test suite.
- [`package.json`](https://github.com/code-yeongyu/pi-openai-web-search/blob/39643380682f02f306b0de2673ff136c45ccc2a2/package.json) — Pi entry point, peers, scripts, publish contents.
- [`README.md`](https://github.com/code-yeongyu/pi-openai-web-search/blob/39643380682f02f306b0de2673ff136c45ccc2a2/README.md) — documented behavior and installation.
- [`LICENSE`](https://github.com/code-yeongyu/pi-openai-web-search/blob/39643380682f02f306b0de2673ff136c45ccc2a2/LICENSE) and [`NOTICE`](https://github.com/code-yeongyu/pi-openai-web-search/blob/39643380682f02f306b0de2673ff136c45ccc2a2/NOTICE) — licensing and origin attribution.

## User-facing capability

The extension enables OpenAI-hosted native web search on eligible Responses requests. It does **not** register or execute a local Pi tool.

For API identifiers `openai-responses` and `azure-openai-responses`, it:

1. Injects `{ type: "web_search" }` into the provider payload when neither native `web_search` nor `web_search_preview` is present.
2. Preserves an existing native `web_search` or `web_search_preview` definition without duplicating it.
3. Removes a function-tool variant whose `name` is `web_search`, then ensures the native variant is present. This deliberately resolves the provider-level name collision in favor of the hosted OpenAI tool.
4. Adds `"web_search_call.action.sources"` to the top-level Responses `include` array so source metadata is requested, without duplicating that string.
5. Adds a short `## Web Search` system-prompt section telling the model to use native search for current/online information and prefer it over guessing when freshness matters.
6. Is default-on and can be disabled with `PI_OPENAI_WEB_SEARCH=0|false|no|off` (case-insensitive, whitespace-trimmed). `1|true|yes|on` enables it; unknown values also default to enabled.

Non-Responses payloads and non-object payloads are returned unchanged. When disabled, the original payload object is returned unchanged.

There is no interactive command, no slash command, no settings UI, and no actual status/widget content. The lifecycle UI code only clears the keys `pi-openai-web-search`; the test named “shows native web search widget” verifies those clearing calls rather than rendering a widget.

Sources: upstream `src/index.ts`, especially `OPENAI_RESPONSES_APIS`, `parseEnableEnv`, `sanitizeTools`, `includeWebSearchSources`, `addOpenAiWebSearchToPayload`, `OPENAI_WEB_SEARCH_SECTION`, and the default extension function.

## Important interfaces and Pi hooks

All important interfaces are in upstream `src/index.ts`:

```ts
export function addOpenAiWebSearchToPayload(
  api: Api | undefined,
  payload: unknown,
): unknown
```

Pure provider-payload transformer. This is the main reusable unit.

```ts
export function isOpenaiWebSearchEnabled(): boolean
```

Reads `PI_OPENAI_WEB_SEARCH` using default-on parsing.

```ts
export const OPENAI_WEB_SEARCH_SECTION: string
```

Prompt fragment appended for eligible sessions.

```ts
export default function openaiWebSearchExtension(pi: ExtensionAPI): void
```

Registers these hooks:

| Pi hook | Upstream behavior |
|---|---|
| `before_provider_request` | Returns `addOpenAiWebSearchToPayload(ctx.model?.api, event.payload)`; this is a raw replacement payload, not `{ payload: ... }`. |
| `before_agent_start` | For enabled `openai-responses`/`azure-openai-responses`, returns `{ systemPrompt: event.systemPrompt + section }`. |
| `session_start` | Clears its status/widget keys. |
| `model_select` | Clears its status/widget keys. |
| `session_shutdown` | Clears its status/widget keys. |

It does **not** call `pi.registerTool`, register commands, add message renderers, make HTTP requests itself, or handle provider authentication.

Pi's documented chaining rule is important for integration: `before_provider_request` handlers run in extension load order; any non-`undefined` return becomes the payload seen by later handlers and sent to the provider. `before_agent_start` system prompts are similarly chained. The installed Pi peer documentation used during verification is `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, sections `before_provider_request` and `before_agent_start`.

## Package structure and dependencies

Upstream package layout:

```text
pi-openai-web-search/
├── src/index.ts
├── test/index.test.ts
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── biome.json
├── README.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── AGENTS.md
├── LICENSE
└── NOTICE
```

`package.json` declares the Pi entry point directly as TypeScript:

```json
"pi": { "extensions": ["./src/index.ts"] }
```

There are no production `dependencies`. Runtime imports are type-only peers:

- `@mariozechner/pi-ai: "*"`
- `@mariozechner/pi-coding-agent: "*"`

Development dependencies at the inspected commit:

- `@biomejs/biome` 2.5.5
- `@types/node` `^25.6.0`
- `@typescript/native-preview` `^7.0.0-dev.20260501.1`
- TypeScript 7.0.2
- Vitest `^4.1.5`

Node requirement: `>=20.0.0`; ESM package; strict TypeScript; Node16 module resolution. The published-file allowlist is `src`, README, changelog, license, and NOTICE. A dry-run package contained only six files and no bundled dependencies.

### Dependency compatibility with this repository

This compaction extension uses the forked package namespace:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

See local `package.json` and `src/extension-runtime.ts`. Therefore upstream is **not a safe drop-in source copy**: its type imports must be adapted, and adding its `@mariozechner/*` peers would create parallel Pi type/runtime dependency families. Prefer internal integration using the current `@earendil-works/*` types and existing extension entry point.

## Configuration and authentication model

Configuration is intentionally minimal:

- Only `PI_OPENAI_WEB_SEARCH` is read.
- Default is enabled.
- There is no JSON config, per-provider setting, per-model setting, location/domain filter, search-context-size option, source toggle, or command-line option.
- Existing native tool objects are preserved, so another payload author can supply richer native search options before this transformer runs.

Authentication is entirely delegated to Pi's selected provider/model. The extension does not read API keys, OAuth credentials, Azure deployment variables, base URLs, or headers, and it makes no direct request. Native search is simply added to the already-authenticated provider payload.

## Supported providers and models

Support is based **only** on `ctx.model.api`, not provider name or model ID:

- Included: `openai-responses`
- Included: `azure-openai-responses`
- Excluded: `openai-codex-responses`
- Excluded: `openai-completions`, `anthropic-messages`, and every other API discriminator

Consequences:

- Any custom gateway/provider presented to Pi as `openai-responses` is opted in, whether or not that gateway/model actually implements native web search or the requested `include` value.
- There is no tested/declared model-ID allowlist. Capability ultimately depends on the selected deployment.
- Existing `web_search_preview` is accepted for compatibility, while new injection uses the GA `{ type: "web_search" }` discriminator.
- The upstream source comment says that discriminator was checked against `openai/openai-node` Responses types on 2026-05-07, but the repository has no Azure/custom-gateway compatibility probe.

This differs from the compaction extension's local `RESPONSES_COMPACT_CAPABLE_APIS` in `src/types.ts`, which includes `openai-responses` and `openai-codex-responses` but not Azure.

## Tests and verification

Upstream `test/index.test.ts` covers:

- No-op behavior for completions and Anthropic APIs.
- Injection for OpenAI and Azure Responses.
- Preservation/no duplication of `web_search_preview`.
- Removal/replacement of function-tool `web_search` on Responses only.
- Addition and deduplication of `web_search_call.action.sources` while preserving existing string include values.
- Disabled behavior and the default-on environment parser, including case/whitespace and unknown values.
- Suppression of prompt injection when disabled.
- Lifecycle UI clearing calls.

Local verification against the inspected checkout:

- `npm test`: **30/30 cases passed**, one test file.
- `npm run typecheck`: passed after `npm ci`.
- No end-to-end provider request is tested.

Not covered upstream:

- Real OpenAI/Azure/custom-gateway calls or source rendering.
- `before_provider_request` ordering with another payload-rewriting extension.
- A payload already containing both native and function variants.
- Duplicate prompt sections when the extension is loaded twice.
- Behavior on `openai-codex-responses`.
- Unsupported `include` values on older/custom gateways.
- Tool-call/session replay across compaction.
- Auth failures, because auth is outside this extension.
- A real UI widget (none is rendered).

## License and attribution

Upstream is MIT licensed. `LICENSE` contains:

> Copyright (c) 2026 Yeongyu Kim

MIT requires the upstream copyright and permission notice to be included in all copies or substantial portions. This repository's own MIT license is not a substitute for preserving that upstream notice if source is copied.

Upstream `NOTICE` additionally states that the package targets Mario Zechner's Pi extension API and ports the `senpi-mono` builtin `openai-web-search` extension into a standalone package. The README identifies the original path as:

```text
packages/coding-agent/src/core/extensions/builtin/openai-web-search/index.ts
```

in `code-yeongyu/senpi-mono`.

Recommendation:

- If copying/adapting substantial implementation or tests, preserve Yeongyu Kim's MIT notice and add an attribution entry in this repository's NOTICE/README describing the port and upstream commit.
- Ship the upstream NOTICE text or an equivalent attribution when redistributing copied code, even though the MIT text itself is the binding license condition.
- If reimplementing only the behavior with newly written code, attribution is still prudent because the integration is explicitly based on this upstream design.

## Reuse versus reimplementation

### Reuse/adapt conceptually

The following upstream logic is small, deterministic, and worth retaining as focused pure helpers:

1. API-family guard.
2. Default-on environment parsing, if backward compatibility with `PI_OPENAI_WEB_SEARCH` is desired.
3. Native search detection for both `web_search` and `web_search_preview`.
4. Idempotent source-include addition.
5. A payload transformer with tests for no-op/reference preservation outside the target APIs.
6. The compact prompt guidance, preferably with explicit deduplication.
7. The test-case matrix for enable/disable parsing and payload transformation.

### Reimplement/integrate rather than copy wholesale

1. **Extension registration and imports:** integrate into local `src/extension-runtime.ts` or a local focused module using `@earendil-works/*`; do not add a second standalone Pi extension runtime or `@mariozechner/*` peers.
2. **Hook ordering:** orchestrate compaction and native-search payload mutation explicitly rather than relying on separately installed extension load order.
3. **Provider capability policy:** share a local capability table/config rather than copying the hardcoded OpenAI/Azure set, because compaction supports a different pair.
4. **Tool collision policy:** decide explicitly whether a local function `web_search` should be removed. Late removal can leave Pi's system prompt/tool snippets advertising a local tool that is no longer in the provider payload.
5. **Configuration:** integrate with the existing JSON config and optionally retain the old environment variable as a compatibility override. Unknown environment values should ideally warn rather than silently enable.
6. **UI and renamed identifiers:** omit the no-op UI hooks or use the new package/feature identifiers. Do not retain `pi-openai-web-search` status/widget keys after a rename unless intentionally cleaning up legacy state.
7. **Types:** use a shared Responses payload type instead of the broad `Record<string, unknown>`/`unknown` boundary throughout the integrated module.
8. **Compaction-request policy:** native search should be enabled for live model calls, not automatically inherited by the synthetic `remote_compaction_v2` request.

## Concrete integration risks and conflicts with remote compaction

### 1. `before_provider_request` ordering changes compaction behavior — high

The local compaction handler (`src/extension-runtime.ts`, `handleBeforeProviderRequest`) first caches selected live-request fields via `rememberRequestContext`, then may replace `input` with opaque-compaction replay. `src/request-context-cache.ts` caches `tools`, `parallel_tool_calls`, `reasoning`, `service_tier`, `prompt_cache_key`, and `text` for the next synthetic compaction request.

If web-search injection runs **before** compaction, `{ type: "web_search" }` is cached in `tools` and later sent on the synthetic `compaction_trigger` request. This can expose compaction to unnecessary hosted-tool availability, cost, provider-side tool activity, or gateway rejection. The top-level `include` source request is not cached, creating inconsistent tool/include state for that synthetic call.

Recommended order for live requests:

1. Let the compaction handler inspect/cache the original Pi payload and perform opaque replay.
2. Apply native web-search injection to the final rewritten live payload.

The compaction rewrite spreads `...args.payload` and replaces only `input` (local `src/payload-rewrite.ts`), so a search tool and `include` added after rewrite are retained in the final request. A single orchestrated handler is safer than two independently load-ordered packages.

### 2. API capability sets disagree — high

Upstream search enables `openai-responses` + `azure-openai-responses`; local compaction enables `openai-responses` + `openai-codex-responses`.

- Azure would get native search but no remote-v2 compaction.
- Codex Responses would get remote-v2 compaction but no native search.

Do not mechanically union these sets. Model/gateway support should be tested and configured per feature. Initial integration should restrict search to validated `openai-responses`; add Azure or Codex only after live compatibility tests.

### 3. Local function-tool collision and prompt mismatch — high

Upstream strips any non-native tool named `web_search` at provider-payload time. If Pi has already built tool snippets/system instructions for a local function tool of that name, the prompt may still describe the local tool while only the hosted native tool remains in the payload. Conversely, preserving both can create an ambiguous name collision.

Resolve this earlier in tool selection or make the collision policy explicit. Add an integration test with a registered local `web_search` function, the generated system prompt, and the final provider payload.

### 4. Compaction replay parity with hosted-tool output — high/unknown

Local opaque replay validates the current Pi payload against a locally reserialized session history in `src/payload-rewrite.ts`; failure returns `expected-pi-replay-mismatch`. Native Responses search can introduce provider-specific `web_search_call` items and requested source metadata. The local serializer/rewrite code has no explicit `web_search_call` handling.

A real multi-turn test is required:

1. Run native search and receive cited sources.
2. Continue for another turn.
3. Trigger remote-v2 compaction.
4. Send a post-compaction turn using the opaque checkpoint.
5. Confirm parity succeeds and search-related items/sources are neither lost nor duplicated.

Until this passes, consider native search + opaque replay experimental.

### 5. Prompt guidance may leak into compaction instructions — medium

Upstream appends search guidance in `before_agent_start`. Local compaction builds remote-compaction instructions from `ctx.getSystemPrompt()` in `src/extension-runtime.ts`. Depending on Pi's turn-lifetime semantics, compaction may inherit “use web_search when freshness matters,” which is irrelevant and potentially counterproductive for a compaction request. Keep feature guidance scoped to live model requests or explicitly remove it when building compaction instructions.

### 6. Gateway compatibility is assumed from API name — medium/high

Any custom provider labeled `openai-responses` receives `{ type: "web_search" }` and `include: ["web_search_call.action.sources"]`. Gateways may support Responses but not hosted search, GA tool names, or that include path, causing the entire request to fail. Add a config allowlist/denylist or capability flag; fail-open retry without native search may be warranted.

### 7. Payload sanitizer is mildly destructive — medium

Upstream `sanitizeTools` drops non-object entries and removes function `web_search`. `includeWebSearchSources` drops non-string include entries and overwrites non-array `include` values. This is reasonable boundary normalization but broader than “append one tool.” An integrated transformer should preserve all valid unknown fields and only alter the exact collision/source cases required.

### 8. Duplicate installation/prompt mutation — medium

Loading both the standalone upstream extension and an integrated renamed extension would register duplicate hooks. Tool/source injection is mostly idempotent, but `OPENAI_WEB_SEARCH_SECTION` has no deduplication and can be appended twice. UI-clearing hooks can also interfere through shared legacy keys. Document mutual exclusivity and dedupe prompt sections defensively.

### 9. Renaming/backward compatibility — medium

The environment variable and UI keys embed `PI_OPENAI_WEB_SEARCH` / `pi-openai-web-search`. A renamed combined package should decide whether to:

- keep the environment variable as a supported legacy alias;
- introduce a new config field as the canonical control;
- warn on conflicting legacy/new controls;
- avoid claiming an upstream package identity after integration.

### 10. No image-generation basis — explicit scope warning

Nothing in this upstream repository supports image generation. Search integration can reuse the payload-policy pattern, but image generation needs separate research/design for tool shape, model support, binary/URL result handling, persistence, rendering, auth, and compaction semantics. Do not infer imagegen interfaces from this package.

## Recommended initial feature subset

For the first integrated release:

1. Enable only on validated `openai-responses` models/providers.
2. Inject native `{ type: "web_search" }` idempotently.
3. Preserve existing native `web_search`/`web_search_preview` definitions.
4. Request `web_search_call.action.sources` idempotently.
5. Append deduplicated, feature-flagged prompt guidance.
6. Do not render a status/widget and do not add commands.
7. Do not inject/copy web-search tools into synthetic remote-compaction requests.
8. Keep the feature disabled or fail-open per provider when the gateway rejects native search.
9. Add integration tests for hook order, local-tool collision, native-search multi-turn serialization, remote compaction, and opaque follow-up replay.
10. Preserve upstream MIT attribution if implementation/tests are copied or substantially adapted.

This captures the useful upstream behavior while avoiding its package-namespace mismatch, unvalidated Azure/custom-gateway assumptions, no-op UI lifecycle, and the most serious compaction interaction.