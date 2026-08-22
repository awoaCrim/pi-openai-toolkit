# Implementation Plan: pi-openai-toolkit

## Execution status

- Phases A-G are complete.
- Typecheck, 74-test Bun suite, three-target Pi smoke suite, package dry-run, diff checks, and the credentialed NewAPI Web Search acceptance probe passed.
- Work commit `91c0056` was pushed, GitHub was renamed to `awoaCrim/pi-openai-toolkit`, and local `origin` was verified against the new repository.
- npm publication remained out of scope.

## Execution constraint

Implement and verify in the main session without background sub-agents, per the user's explicit request after the earlier research workers caused local performance problems. Use small direct inspection/edit/test batches.

## Phase A — Lock baseline and package seams

- [ ] Re-run the existing typecheck, full test suite, Pi smoke test, and package dry-run before editing.
- [ ] Record the current package file list and public branding references.
- [ ] Add thin extension adapters:
  - `extensions/compaction.ts`
  - `extensions/web-search.ts`
- [ ] Point `package.json#pi.extensions` to both adapters in compaction-then-Web-Search order.
- [ ] Update TypeScript/package file allowlists for all new runtime files.
- [ ] Keep a rollback point before config/schema changes.

Validation gate:

```bash
./node_modules/.bin/tsc -p tsconfig.check.json
bun test ./test/pi-smoke.test.ts
npm pack --dry-run --json
```

## Phase B — Replace flat config with nested toolkit config

- [ ] Define toolkit, compaction, and Web Search config types and defaults.
- [ ] Move canonical config path to `~/.pi/agent/extensions/pi-openai-toolkit/config.json`.
- [ ] Parse nested `compaction` and `webSearch` objects with field-level warnings.
- [ ] Rename compaction config fields to the reviewed nested names.
- [ ] Restrict `webSearch.apis` to `openai-responses`.
- [ ] Default Web Search to enabled.
- [ ] Move default compaction artifacts to `~/.pi/agent/artifacts/pi-openai-toolkit/compaction`.
- [ ] Update compaction call sites to consume only `config.compaction` or an extracted compaction config.
- [ ] Do not implement legacy-path reads or automatic migration.
- [ ] Rewrite config tests for defaults, overrides, malformed nested sections, path resolution, and absence of legacy fallback.

Validation gate:

```bash
bun test ./src/config.test.ts
./node_modules/.bin/tsc -p tsconfig.check.json
```

Rollback point: config parser/types and all call-site changes must revert together.

## Phase C — Implement focused Web Search modules

- [ ] Add Web Search types/constants for the known API, native tool types, source include value, prompt marker, and transformation outcomes.
- [ ] Implement a pure immutable payload transformer.
- [ ] Preserve existing native `web_search`/`web_search_preview` tools without duplication.
- [ ] Preserve a conflicting local function `web_search` and return a collision outcome.
- [ ] Add source include metadata idempotently while preserving existing values.
- [ ] Implement prompt guidance with marker-based deduplication.
- [ ] Implement the Web Search extension adapter:
  - startup `pi.getAllTools()` conflict warning once;
  - active-tool-aware `before_agent_start` prompt behavior;
  - final-payload `before_provider_request` injection;
  - no local tool or command registration.
- [ ] Add unit tests for every transformer/prompt/config outcome.
- [ ] Add extension registration tests for warning and hook return shapes.

Validation gate:

```bash
bun test ./src/web-search
./node_modules/.bin/tsc -p tsconfig.check.json
```

## Phase D — Verify compaction/Web Search ordering

- [ ] Add an integration harness that chains extension handlers in package load order.
- [ ] Verify request-context caching sees the pre-search live tools.
- [ ] Verify opaque replay rewriting occurs before native Web Search injection.
- [ ] Verify the final live payload contains native Web Search and source include metadata.
- [ ] Verify synthetic remote-compaction requests never inherit native Web Search.
- [ ] Verify local function-tool conflict keeps payload/prompt behavior consistent.
- [ ] Re-run all existing compaction validation tests.

Validation gate:

```bash
bun test ./src/validation.test.ts ./src/web-search ./test
./node_modules/.bin/tsc -p tsconfig.check.json
```

Rollback point: extension order, caching behavior, and integration tests form one atomic change.

## Phase E — Rename runtime/package/documentation surfaces

- [ ] Rename package metadata to `pi-openai-toolkit` and update repository URLs.
- [ ] Introduce toolkit/feature runtime IDs and replace branding-specific old IDs.
- [ ] Keep compaction protocol strategy constants unchanged.
- [ ] Update README for:
  - package purpose and feature matrix;
  - new install commands;
  - nested configuration;
  - compaction usage;
  - Web Search behavior and supported API;
  - local `web_search` conflict warning;
  - NewAPI validation notes and optional `action.sources`;
  - transparent failure/manual disable behavior;
  - manual migration from old package/config paths;
  - old/new package mutual exclusion.
- [ ] Add and package `NOTICE` with upstream Web Search attribution/license notice.
- [ ] Update smoke tests to load compaction and Web Search entries separately and as a package.
- [ ] Search for every remaining legacy brand/path and classify intentional protocol/history references versus missed branding.

Validation gate:

```bash
./node_modules/.bin/tsc -p tsconfig.check.json
bun test
npm pack --dry-run --json
```

## Phase F — Live acceptance and final review

- [ ] Run the package-level Pi smoke test with the installed official Pi 0.84.2-compatible local dependency.
- [ ] Run an opt-in NewAPI Web Search probe with configured credentials without logging credentials or response text.
- [ ] Assert HTTP success, completed Web Search calls, and URL citation annotations; do not require `action.sources`.
- [ ] Run `git diff --check`.
- [ ] Review all changed files against PRD/design acceptance criteria.
- [ ] Review package dry-run contents for accidental test/research/config leakage.
- [ ] Review whether project specs need updates for multi-entry extension ordering and provider-native tool injection.

Final validation commands:

```bash
git diff --check
./node_modules/.bin/tsc -p tsconfig.check.json
bun test
npm pack --dry-run --json
```

## Phase G — Commit and external repository rename

- [x] Present a focused commit plan excluding unrelated untracked Trellis/bootstrap files.
- [x] Commit the verified source/package/docs changes only after user confirmation.
- [x] Push the work commit to the current GitHub repository.
- [x] Rename GitHub repository `awoaCrim/pi-remote-compact` to `awoaCrim/pi-openai-toolkit` using authenticated GitHub tooling.
- [x] Change local `origin` to `https://github.com/awoaCrim/pi-openai-toolkit.git`.
- [x] Verify fetch/push remote URLs and the default branch after rename.
- [x] Do not publish npm.

External rollback:

1. Rename the GitHub repository back to `pi-remote-compact`.
2. Restore the old `origin` URL.
3. Revert the work commit if source rollback is also required.
