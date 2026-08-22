# Implementation plan: release model-scoped Web Search

## Phase 1 — Documentation

- [x] Update `README.md` with the npm Pi installation command, retain Git installation, and align the overview with exact model allowlisting and both supported APIs.
- [x] Apply the equivalent changes to `README_zh.md`.
- [x] Check for stale Web Search claims that say API-only activation or local-tool precedence over Toolkit Web Search.

## Phase 2 — Pre-release validation

- [x] Run `npm run typecheck`.
- [x] Run `bun test`.
- [x] Run `bun test ./test/pi-smoke.test.ts`.
- [x] Run `npm pack --dry-run` and verify the intended files are included and Trellis/bootstrap files are absent.
- [x] Run `git diff --check` and review the complete tracked diff.

## Phase 3 — Commit and publish

- [x] Stage only tracked product changes; leave `.agents/`, `.trellis/`, `AGENTS.md`, and `.gitattributes` unstaged.
- [x] Create one release commit on `main`.
- [x] Push `main` to `origin`.
- [x] Publish `pi-openai-toolkit@0.3.0` with the configured public npm registry.
- [x] Verify `npm view pi-openai-toolkit version`, registry tarball contents, and the remote branch commit.

## Phase 4 — Completion

- [x] Update this checklist and the PRD acceptance criteria.
- [ ] Archive the Trellis task with `task.py archive --no-commit`; the product release commit is created explicitly in Phase 3.

## Rollback points

- Before commit: edit/revert only the intended tracked changes if validation fails.
- After Git push but before npm publish: keep the pushed commit and retry publication if the failure is transient.
- After npm publish: do not overwrite `0.3.0`; use a new version only with explicit approval if a corrective release is required.
