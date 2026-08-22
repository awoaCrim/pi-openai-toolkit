# Implementation Plan: restore LINUX DO links

## Phase 1 — Capture state and recovery

- [x] Record remote URL, local `HEAD`, `origin/main`, and remote `main` SHA.
- [x] Confirm no tracked changes and preserve `.agents/`, `.gitattributes/`, `.trellis/`, and `AGENTS.md`.
- [x] Create an external bundle backup of the old remote `main`.
- [x] Create an isolated temporary clone from the current remote `main`.

Rollback point: remove the temporary clone; no project files or remote refs have changed.

## Phase 2 — Rewrite both README histories

- [x] Run the combined README path filter:

```bash
git filter-branch --index-filter 'git rm --cached --ignore-unmatch README.md README_zh.md' --prune-empty -- main
```

- [x] Remove temporary `refs/original` refs.
- [x] Copy the current README files into the filtered clone.
- [x] Replace only the two plain-text acknowledgment lines with linked Markdown.
- [x] Confirm removed sections remain absent.
- [x] Commit both corrected files together as `docs: restore LINUX DO links in READMEs`.

## Phase 3 — Pre-push verification

- [x] Check both exact Markdown lines and removed-section absence.
- [x] Check no historical commit reachable from `main~1` contains `README.md` or `README_zh.md`.
- [x] Check each README path history contains exactly one new commit.
- [x] Compare final non-README tree with the old remote tip.
- [x] Confirm `README.md` and `README_zh.md` differ from their old versions only at the acknowledgment line.
- [x] Confirm `src/types.ts` history count and representative source blobs are preserved.
- [x] Confirm the remote still equals the recorded old SHA.

Rollback point: discard the temporary clone if any check fails.

## Phase 4 — Force push and synchronize local state

- [x] Push rewritten `main` with `--force-with-lease` using the recorded old SHA.
- [x] Verify remote `main` equals the new verified tip.
- [x] Force-fetch `origin/main`.
- [x] Move local `main` to the remote tip with `git update-ref` and `git read-tree -u -m HEAD`.
- [x] Verify local and remote refs match and untracked bootstrap files remain unchanged.
- [x] Delete the temporary clone; retain the external bundle and metadata.

## Phase 5 — Quality checks and finish

- [x] Run README/history assertions and `git diff --check`.
- [x] Run `npm run typecheck` and `bun test`.
- [ ] Archive this task without committing unrelated bootstrap files.

## Risks

- This is another public history rewrite; all commit SHAs will change.
- Filtering both README paths removes the previous README-only commits from the pushed branch.
- `--force-with-lease` must use the exact current old SHA.
