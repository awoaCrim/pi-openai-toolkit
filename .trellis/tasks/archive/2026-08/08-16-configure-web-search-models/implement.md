# Implementation Plan: model-scoped native Web Search

## Phase 1 — Context and contracts

- [x] Start the Trellis task after final plan approval.
- [x] Read applicable specs and inspect existing Web Search/config tests.
- [x] Confirm current config path and preserve compaction behavior.

## Phase 2 — Configuration and shared model matching

- [x] Replace `WebSearchConfig.apis` with `models: string[]`.
- [x] Update defaults to `enabled: true, models: []` for strict allowlist behavior.
- [x] Parse and normalize `webSearch.models`; warn on invalid entries and unknown `apis`.
- [x] Add a shared exact `provider/model-id` + (`openai-responses` or `openai-codex-responses`) eligibility helper.
- [x] Remove API-list documentation and references from Web Search types/config tests.

## Phase 3 — Payload, prompt, and tool ownership

- [x] Pass model identity into payload and prompt transforms.
- [x] Make eligible models remove local `function:web_search` from outgoing tools and inject exactly one native tool/source include.
- [x] Keep ineligible requests byte/structure unchanged.
- [x] Add model synchronization in the Web Search extension for `session_start`, `before_agent_start`, and `model_select`.
- [x] Track and restore the local tool's pre-ownership active state.
- [x] Remove or update the old generic local-conflict warning so eligible toolkit-owned models do not report a false conflict.

## Phase 4 — Tests and documentation

- [x] Update/add config parser tests.
- [x] Update payload and prompt tests for model/API eligibility and local-tool precedence.
- [x] Add extension tests for active-tool removal, model switching, restoration, and no false warning.
- [x] Update integration tests for compaction/Web Search ordering.
- [x] Update `README.md` and `README_zh.md` examples with `webSearch.models` and the fixed endpoint rule.

## Phase 5 — Verification

- [x] Run `npm run typecheck`.
- [x] Run `bun test`.
- [x] Run the Pi smoke path (`bun test ./test/pi-smoke.test.ts`); the equivalent `npm run test:pi` wrapper timed out in this environment.
- [x] Check `git diff --check` and ensure no config/API references were missed.
- [x] Review that non-Responses/non-Codex requests never receive toolkit Web Search and that compaction API support is unchanged.

## Risk and rollback

- The strict empty default intentionally disables toolkit Web Search until models are configured; document this clearly.
- Tool active-state restoration must not enable a tool that was initially inactive.
- If model switching or payload defense becomes inconsistent, revert the Web Search changes without touching compaction.
