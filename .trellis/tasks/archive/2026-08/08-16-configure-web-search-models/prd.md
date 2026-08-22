# Configure Web Search by model

## Goal

Make toolkit Web Search an explicit model allowlist: only selected models using the `openai-responses` endpoint receive toolkit's native Web Search, while other models retain their existing tools and do not receive toolkit Web Search injection.

## Confirmed decisions

- Add a `webSearch.models` configuration field accepting multiple model entries.
- Match models by exact `provider/model-id` keys, for example `uwoacrimson/gpt-5.6-luna`.
- Toolkit Web Search is hardcoded to the `openai-responses` and `openai-codex-responses` endpoints; the configurable `webSearch.apis` field is removed.
- `webSearch.enabled` remains the global safety switch.
- An empty `webSearch.models` list is a strict allowlist: toolkit Web Search is disabled for every model.
- For an allowlisted `openai-responses` model, the toolkit owns native Web Search and disables the active local function tool named `web_search` for that model.
- For non-allowlisted models, toolkit Web Search is not injected and the local `web_search` tool retains its prior active state.
- Model switching must synchronize the tool state for the new model.

## Current implementation facts

- `src/web-search/payload.ts` currently gates only on `config.enabled` and `config.apis` / API support.
- `src/web-search/prompt.ts` has the same API-only gate.
- `src/web-search/extension.ts` currently uses `ctx.model?.api`, `pi.getActiveTools()`, and `pi.getAllTools()` but does not react to `model_select`.
- `src/types.ts` and `src/config.ts` currently define/parse `webSearch.apis`.

## Requirements

1. Replace `WebSearchConfig.apis` with `models: string[]`.
2. Normalize configured model entries by trimming, removing empty values, and deduplicating; reject non-string entries with a warning consistent with existing config parsing.
3. Add one shared eligibility predicate requiring:
   - `config.enabled === true`;
   - model API is exactly `openai-responses` or `openai-codex-responses`;
   - exact `${model.provider}/${model.id}` match in `config.models`.
4. Use that predicate for both:
   - native payload tool/include injection;
   - Web Search system prompt guidance.
5. On session start and every `model_select` event:
   - when eligible, remove active `web_search` from `pi.getActiveTools()` before the next request;
   - when ineligible, restore the tool's active state as it was before toolkit ownership took effect;
   - avoid incorrectly warning about a local conflict when toolkit intentionally owns the eligible model's Web Search.
6. Preserve immutable payload behavior and existing source/include deduplication.
7. Keep non-allowlisted model requests unchanged, including local function tools.
8. Update README/config examples, tests, and package typecheck expectations.

## Out of scope

- Matching by wildcard, regex, model display name, or provider-independent model ID.
- Enabling toolkit Web Search for endpoints other than `openai-responses` and `openai-codex-responses`.
- Disabling arbitrary tools other than the exact local function tool name `web_search`.
- Changing compaction model/API selection.
- Changing remote package installation or publishing behavior.

## Acceptance criteria

- [x] `webSearch.models` supports multiple exact `provider/model-id` entries.
- [x] `webSearch.apis` is no longer accepted as an active configuration field.
- [x] An allowlisted `openai-responses` model receives native `web_search`, source include metadata, and prompt guidance.
- [x] An allowlisted model using another API receives no toolkit Web Search.
- [x] An allowlisted `openai-codex-responses` model receives native Web Search, subject to the same model allowlist and tool ownership rules.
- [x] An unlisted `openai-responses` model receives no toolkit Web Search.
- [x] An eligible model does not receive an active local `web_search` function tool.
- [x] Switching from eligible to ineligible restores the prior local tool active state, and switching back disables it again.
- [x] Empty `models` disables toolkit Web Search for all models.
- [x] Existing payload immutability, collision, and prompt tests continue to pass or are updated for the new contract.
- [x] README and config examples document the model allowlist and fixed endpoint.
- [x] Typecheck and full Bun tests pass.
