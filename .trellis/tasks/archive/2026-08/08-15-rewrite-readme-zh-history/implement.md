# Implementation Plan: README_zh-only history rewrite

## Phase 1 — Capture state and recovery point

- [x] Record remote URL, current local `HEAD`, `origin/main`, and remote `main` SHA.
- [x] Confirm no tracked local changes; leave `.agents/`, `.gitattributes/`, `.trellis/`, and `AGENTS.md` untouched.
- [x] Create an external bundle backup of the current remote `main`.
- [x] Create an isolated temporary clone from the current remote `main`.

Rollback point: remove the temporary clone; no local tracked files or remote refs have changed.

## Phase 2 — Rewrite README_zh history and content

- [x] Run the README_zh-only index filter in the temporary clone:

```bash
git filter-branch --index-filter 'git rm --cached --ignore-unmatch README_zh.md' --prune-empty -- main
```

- [x] Remove temporary `refs/original` refs before validation.
- [x] Copy the original current `README_zh.md` into the filtered clone.
- [x] Remove `特性一览` and its table/loading-order note.
- [x] Remove `从 `pi-remote-compact` 迁移` and its migration bullets.
- [x] Replace the final acknowledgment with `- LINUX DO community.`.
- [x] Commit only the corrected `README_zh.md` with message `docs: refresh Chinese README after history rewrite`.

## Phase 3 — Pre-push verification

- [x] Verify content markers and exact acknowledgment.
- [x] Verify historical commits reachable from `main~1` contain no `README_zh.md`.
- [x] Verify `git log main -- README_zh.md` has exactly one commit.
- [x] Verify `README.md` content is byte-for-byte identical to the old remote tip.
- [x] Compare old/new final trees after excluding `README_zh.md`.
- [x] Verify source history count remains unchanged for `src/types.ts`.
- [x] Verify the remote still equals the recorded old SHA.

Rollback point: discard the temporary clone if any check fails.

## Phase 4 — Force push and local synchronization

- [x] Push temporary clone `main` with `--force-with-lease` using the recorded old SHA.
- [x] Verify remote `main` equals the new verified tip.
- [x] Force-fetch `origin/main` locally.
- [x] Move local `main` to `origin/main` with `git update-ref` and synchronize tracked files with `git read-tree -u -m HEAD`.
- [x] Verify local and remote tips match and untracked bootstrap files remain unchanged.
- [x] Delete the temporary clone; retain the external rollback bundle and metadata.

## Phase 5 — Quality checks and finish

- [x] Run `git diff --check` and README/history assertions.
- [x] Run `npm run typecheck` and `bun test`; no source code should change.
- [x] Re-run remote verification after local synchronization.
- [ ] Archive the Trellis task without creating a product commit for bootstrap files.

## Risk notes

- This is a second public history rewrite; all commit SHAs will change again.
- The old README_zh history is removed from the pushed `main` branch, while old objects remain only in the external local bundle/reflogs.
- `README.md` must be explicitly compared because its history is already rewritten and must not be accidentally altered.
- Use `--force-with-lease`, never an unconditional force push.
