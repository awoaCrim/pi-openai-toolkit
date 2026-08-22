# Remote compaction model override

## Goal

Allow a Pi session to keep its active conversation model unchanged while `remote_compaction_v2` is executed by one explicitly configured model. The primary target flow is Sol handling normal work, Luna producing opaque checkpoints, and Sol continuing from those checkpoints after automatic, manual, or overflow compaction.

## Background and Confirmed Facts

- Automatic compaction, manual `/compact`, and overflow recovery all pass through the same `session_before_compact` hook.
- The current implementation always builds `remote_compaction_v2` requests from `ctx.model`; `compaction.model` controls only Pi native-summary fallback.
- Current persisted native details and replay lookup treat `provider + api + model + baseUrl` as one exact identity, so a Luna-produced checkpoint is rejected when Sol is active.
- Credentialed probes against `https://newapi.uwoacrimson.com/v1` confirmed both directions needed by the feature:
  - Luna can compact Sol-authored history and Sol can recover an exact pre-compaction secret from Luna's checkpoint.
  - Luna can recursively compact its own checkpoint and Sol can recover the same secret.
  - Luna can take over an existing Sol-produced checkpoint, emit a new checkpoint, and Sol can recover the original secret.
- The verified model pair is `uwoacrimson/gpt-5.6-luna` as compactor and `uwoacrimson/gpt-5.6-sol` as active consumer. See `research/cross-model-remote-v2-probe.md`.

## Requirements

1. Add one optional `compaction.remoteCompactModel` configuration field with the value format `"provider/model-id"`; `null` or omission means no override.
2. When `remoteCompactModel` is unset, preserve the existing behavior: the active conversation model performs `remote_compaction_v2`.
3. When `remoteCompactModel` is set, use that registered model, its authentication, headers, API mode, and model-specific request metadata for every remote-v2 compact attempt initiated by manual, threshold, or overflow compaction.
4. Do not mutate or visibly switch Pi's active session model. After compaction, the model that was active before compaction must continue handling normal requests.
5. Keep the existing `compaction.model` field and native-summary fallback semantics unchanged.
6. Initially allow the override only when the active consumer and configured compactor use the same provider, supported Responses API identifier, and normalized base URL. Fail closed for cross-provider, cross-API, or cross-endpoint combinations because the credentialed evidence covers one shared gateway only.
7. Persist enough producer identity to diagnose which model generated a checkpoint while preserving the active consumer identity used by replay matching.
8. Allow the active consumer model to replay a checkpoint produced by the configured compactor. Repeated remote compaction must send the latest checkpoint and live tail to the configured compactor even when the previous checkpoint was produced by the active consumer before the override was enabled.
9. Request extras captured from the active live request (tools, reasoning, service tier, cache key, and text settings) must continue to be available to the synthetic compact request; native Web Search injection must remain excluded.
10. If the configured remote model specification is unusable, cannot authenticate, is not Responses-compatible, is not on the same provider/API/base URL, or its compact request fails, do not silently retry remote-v2 with the active model. Continue through the existing configured native-summary fallback and then Pi's default fallback, with existing warning/debug behavior.
11. Existing configurations, persisted same-model checkpoints, and sessions with no override must remain backward compatible.
12. Document the new field and the distinction between `remoteCompactModel` and the existing native fallback `model` in both READMEs.

## Out of Scope

- A model allowlist or separate producer/consumer mapping configuration.
- Cross-provider or cross-base-URL encrypted checkpoint portability.
- Changing Pi's visible model selection during compaction.
- Replacing, renaming, or changing the semantics of `compaction.model`.
- Adding prompt-cache breakpoint fields or unrelated provider optimizations.
- Publishing a release or changing package version as part of this task.

## Acceptance Criteria

- [x] With active model `uwoacrimson/gpt-5.6-sol` and `remoteCompactModel: "uwoacrimson/gpt-5.6-luna"`, both automatic and manual compact requests send `model: "gpt-5.6-luna"` with a `compaction_trigger` while the subsequent normal request remains `model: "gpt-5.6-sol"`.
- [x] The first Luna-produced checkpoint is replayed to Sol without an identity-mismatch rejection.
- [x] A second Luna compact reuses the latest opaque checkpoint plus the live tail, and Sol can consume the replacement checkpoint.
- [x] Enabling the override after an existing Sol-produced checkpoint allows Luna to take over the chain without discarding the previous opaque context.
- [x] Unset or null `remoteCompactModel` preserves current same-model remote-v2 behavior.
- [x] Invalid, missing, unauthenticated, unsupported, or endpoint-mismatched override models do not mutate the session model and enter the existing native fallback path without a hidden current-model remote retry.
- [x] Existing `compaction.model` fallback behavior and `thinkingLevel` remain unchanged.
- [x] Config parsing, identity validation, first compaction, replay, recursive compaction, handoff, manual/automatic shared routing, failure behavior, and backward compatibility are covered by automated tests.
- [x] `npm run typecheck`, `bun test`, the Pi smoke tests, and `git diff --check` pass.
- [x] A credentialed acceptance probe confirms Luna-to-Sol replay on the configured gateway without logging API keys or encrypted checkpoint contents.
