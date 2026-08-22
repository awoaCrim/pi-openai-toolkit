# Technical Design: model-scoped native Web Search

## 1. Configuration contract

Change the Web Search config from API allowlisting to model allowlisting:

```json
{
  "webSearch": {
    "enabled": true,
    "models": [
      "uwoacrimson/gpt-5.6-luna",
      "uwoacrimson/gpt-5.6-sol"
    ]
  }
}
```

`models` is normalized as a trimmed, deduplicated array of exact `provider/model-id` strings. An empty array means no model is eligible. `webSearch.apis` is removed from the schema and documentation. The only supported native Web Search APIs are the code-level constants `openai-responses` and `openai-codex-responses`.

## 2. Shared eligibility predicate

Create one helper in `src/web-search/types.ts` that derives a canonical model key and checks:

```text
config.enabled
AND model.api is one of "openai-responses" or "openai-codex-responses"
AND `${model.provider}/${model.id}` is in config.models
```

`payload.ts`, `prompt.ts`, and `extension.ts` must all use this predicate rather than implementing separate API/model checks.

## 3. Payload and prompt behavior

For an eligible model:

- Remove any local function tool whose exact shape is `type: "function"` and `name: "web_search"` from the outgoing provider payload.
- Preserve all unrelated tools.
- Ensure exactly one native `{ "type": "web_search" }` tool.
- Ensure exactly one `web_search_call.action.sources` include value.
- Append the toolkit prompt even if a local `web_search` registration exists, because toolkit owns the eligible model's search path.

For an ineligible model, return the original payload and system prompt unchanged. This preserves other extensions' search tools for those models.

All transforms remain immutable and idempotent.

## 4. Active function-tool ownership

Use Pi's runtime tool API:

- `pi.getActiveTools()` to inspect the current active tool names;
- `pi.setActiveTools(names)` to remove or restore the exact local `web_search` function;
- `model_select` to react to model changes;
- `session_start` and `before_agent_start` to synchronize initial/current state.

Maintain session-local ownership state:

```text
previousLocalWebSearchActive: boolean | undefined
currentlyOwnedByToolkit: boolean
```

When entering an eligible model:

1. Capture whether `web_search` was active before toolkit ownership.
2. Remove `web_search` from the active set.
3. Mark toolkit ownership active.

When leaving an eligible model:

1. Restore `web_search` only if it was active before toolkit ownership.
2. Clear ownership state.

Calling synchronization before each agent turn also repairs a reactivated local tool while the eligible model remains selected. Payload filtering is a second defense if another extension adds the local function after active-tool synchronization.

The old generic startup conflict warning is no longer appropriate: eligible models intentionally give toolkit precedence, and ineligible models do not receive toolkit injection.

## 5. Compatibility and migration

- Compaction configuration is unchanged.
- The native Web Search protocol remains `{ "type": "web_search" }`.
- `openai-codex-responses` is eligible for toolkit Web Search when its exact model key is allowlisted.
- Existing configs containing `webSearch.apis` should produce an unknown-field warning and use the strict empty model list until `models` is configured. This makes the model allowlist explicit rather than silently enabling all models.
- README examples must show the new `models` field and fixed endpoint behavior.

## 6. Testing design

Add/update tests for:

- exact provider/model matching;
- empty list and wrong API rejection;
- payload removal of local `web_search` plus native injection for eligible models;
- unchanged payload for unlisted or non-Responses models;
- prompt behavior for eligible and ineligible models;
- active tool removal/restoration on session start and model switches;
- no false conflict warning for toolkit-owned models;
- config parsing, deduplication, and removal of `apis`.
