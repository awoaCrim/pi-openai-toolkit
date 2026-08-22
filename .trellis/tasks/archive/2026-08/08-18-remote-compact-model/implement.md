# Implementation Plan: remote compaction model override

## Phase 1 — Context and contracts

- [x] Start the Trellis task only after the final planning summary is approved.
- [x] Load the applicable specs and the credentialed probe report.
- [x] Reconfirm existing user changes before editing and preserve unrelated worktree files.

## Phase 2 — Configuration and persisted types

- [x] Add `remoteCompactModel?: string` to `CompactionConfig` with an undefined default.
- [x] Add `remoteCompactModel` to canonical config parsing, including `null`, trimming, warnings, and config tests.
- [x] Extend native compaction details with optional producer/compaction-model identity while preserving backward compatibility with old entries.
- [x] Update structured cloning and runtime validation for the optional producer identity.

## Phase 3 — Consumer/compactor runtime resolution

- [x] Refactor remote-v2 environment resolution so the active consumer and synthetic compactor are explicit and `ctx.model` is never mutated.
- [x] Resolve an override through `modelRegistry.find()` and `getApiKeyAndHeaders()`.
- [x] Require exact provider, supported Responses API, and normalized base URL compatibility with the active consumer.
- [x] Build compact URLs, headers, model ID, and serialization from the compactor descriptor.
- [x] Keep request-context extras keyed to and captured from the active consumer request.

## Phase 4 — Remote compact and replay flow

- [x] Make first remote-v2 compaction use the configured compactor while persisting the active consumer as replay identity.
- [x] Allow the consumer to replay a checkpoint whose producer is the configured compactor.
- [x] Make repeated compaction send the latest opaque checkpoint plus live tail to the configured compactor.
- [x] Support handoff from an existing same-gateway consumer-produced checkpoint.
- [x] Preserve fail-open behavior for genuinely different consumer identities.
- [x] On override resolution or remote failure, enter the existing native fallback chain without retrying remote-v2 with the active consumer.

## Phase 5 — Tests and documentation

- [x] Add config/default/null/invalid parsing tests.
- [x] Add runtime model-resolution and provider/API/base-URL compatibility tests.
- [x] Add integration tests for Sol consumer/Luna compactor, replay, recursion, existing-chain handoff, request extras, and fallback behavior.
- [x] Assert automatic, manual, and overflow events use the same override path.
- [x] Update `README.md` and `README_zh.md` with `remoteCompactModel`, examples, fallback semantics, and the difference from `compaction.model`.
- [x] Update package file lists only if a new source module is introduced (not required; no packaged source module was added).

## Phase 6 — Verification

- [x] Run `npm run typecheck`.
- [x] Run `bun test`.
- [x] Run `bun test ./test/pi-smoke.test.ts` or the repository's working Pi smoke wrapper.
- [x] Run `git diff --check` and search for missing config/type references.
- [x] Repeat the sanitized credentialed cross-model and handoff probes without recording secrets or opaque contents.
- [x] Perform an independent check against the PRD, design, and relevant specs.

## Risk and rollback

- The primary risk is accepting an opaque checkpoint across an unverified deployment boundary; the implementation therefore restricts the override to the same provider/API/base URL.
- Consumer and producer identity must not be conflated, or Sol replay will fail and old checkpoint compatibility may regress.
- Request extras must remain sourced from the live Sol request even though Luna executes the synthetic request.
- Rollback is to remove `remoteCompactModel` support and its optional persisted producer field; existing old entries remain readable throughout.
- Operational rollback for users is simply setting `remoteCompactModel` to `null` or removing it.
