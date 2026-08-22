# Implementation Plan: README-only history rewrite

## Phase 1 — Freeze scope and capture recovery data

- [x] Confirm the PRD decision: rewrite only `README.md` history.
- [x] Record remote URL, branch, old `origin/main` SHA, local `HEAD`, and current commit counts.
- [x] Confirm no tracked local changes exist; do not stage or alter `.agents/`, `.gitattributes`, `.trellis/`, or `AGENTS.md`.
- [x] Create an external bundle backup of the old remote `main` outside the repository working tree.
- [x] Create an isolated temporary clone from `origin/main`.

Validation gate:

```bash
git status --short
git rev-parse origin/main
git bundle create <external-backup>.bundle origin/main
```

Rollback point: delete the temporary clone; the working repository and remote remain unchanged.

## Phase 2 — Rewrite only README history in the temporary clone

- [x] Run `git filter-branch --index-filter 'git rm --cached --ignore-unmatch README.md' --prune-empty -- main` in the temporary clone.
- [x] Confirm old commits now have no `README.md` path.
- [x] Copy or generate the current README content, removing:
  - `Feature Matrix`
  - `Migration from pi-remote-compact`
- [x] Replace the acknowledgment with exact wording `LINUX DO community.`
- [x] Add the corrected README and commit it as one new final documentation commit.
- [x] Do not modify `README_zh.md` or any source file.

Validation gate:

```bash
git log --oneline -- README.md
git diff-tree --no-commit-id --name-only -r HEAD
```

Expected README history: exactly one new README commit.

## Phase 3 — Validate rewritten graph before push

- [x] Verify the final README content and absence of removed section headings.
- [x] Verify the parent of the README commit does not contain `README.md`.
- [x] Verify `src/types.ts` and another source path retain their logical history.
- [x] Verify the rewritten tree contains all expected tracked files except the intentionally recreated README path.
- [x] Verify no bootstrap/untracked files entered the temporary clone or commit.
- [x] Verify the old remote tip is the force-with-lease expected value.

Validation commands:

```bash
grep -n -E 'Feature Matrix|Migration from pi-remote-compact|Special thanks to the LINUX DO' README.md
# expected: no matches

git ls-tree -r HEAD^ -- README.md
# expected: no output

git log --oneline -- README.md
# expected: one commit

git log --oneline -- src/types.ts
# expected: source history remains represented
```

Rollback point: discard temporary clone if any check fails.

## Phase 4 — Replace remote main and synchronize local checkout

- [x] Push the temporary clone's rewritten `main` with `--force-with-lease=refs/heads/main:<old-sha>`.
- [x] Confirm remote `main` equals the verified rewritten tip.
- [x] Fetch the rewritten branch locally.
- [x] Move local `main` to the new remote tip without destructive reset and preserve untracked files.
- [x] Synchronize local tracked README with the pushed content.
- [x] Verify `origin` points to `https://github.com/awoaCrim/pi-openai-toolkit.git`.

Validation gate:

```bash
git ls-remote origin refs/heads/main
git log --oneline --decorate -5 origin/main
git log --oneline -- README.md
git status --short
```

## Phase 5 — Final audit and task finish

- [x] Re-run README content/history checks against local `main` and `origin/main`.
- [x] Confirm only the pre-existing untracked bootstrap files remain dirty.
- [x] Record the new remote tip and old tip in task notes or final report.
- [ ] Archive the Trellis task after the remote verification succeeds.
- [x] Do not publish npm or create unrelated commits.

## Risk notes

- Force-push changes the public commit graph; the old remote tip must be recorded before push.
- `git filter-branch` may create backup refs in the temporary clone; delete the temporary clone after success so those refs are not pushed.
- `--force-with-lease` must use the exact old remote SHA, not a stale local assumption.
- Existing untracked bootstrap files are intentionally excluded from all operations.
