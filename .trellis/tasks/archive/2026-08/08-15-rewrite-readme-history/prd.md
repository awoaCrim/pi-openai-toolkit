# Rewrite README history and update documentation

## Goal

Remove the historical `README.md` commit trail from the remote `pi-openai-toolkit` repository while retaining a corrected current README, and force-push the rewritten history after verification.

## Confirmed current state

- Repository: `awoaCrim/pi-openai-toolkit`
- Branch: `main`
- Current HEAD and `origin/main`: `3900af1 docs: rewrite README with dedicated English and Chinese docs`
- `README.md` has history in at least these commits:
  - `461a52b Rework compaction...`
  - `c1a81dd Add Responses remote compaction v2 support`
  - `91c0056 feat: rename package and add native web search`
  - `3900af1 docs: rewrite README with dedicated English and Chinese docs`
- Working tree changes unrelated to this task are untracked bootstrap files:
  - `.agents/`
  - `.gitattributes`
  - `.trellis/`
  - `AGENTS.md`
- The current README contains sections named `Feature Matrix` and `Migration from pi-remote-compact`, and the final acknowledgment currently says `Special thanks to the LINUX DO community for ideas, feedback, and support.`

## Requested README changes

- Remove the `Feature Matrix` section from the current `README.md`.
- Remove the `Migration from pi-remote-compact` section from the current `README.md`.
- Change the final acknowledgment to use the exact wording `LINUX DO community` as requested by the user.

## Confirmed history rewrite decision

The user approved the recommended path-only rewrite:

- Rewrite only the `README.md` path history.
- Preserve the corrected current README as a new file state after the rewrite.
- Preserve commit history for all other tracked files.
- Accept that the complete commit graph and all affected commit SHAs will change.
- Force-push the rewritten `main` branch to `origin` using `--force-with-lease` against the recorded old remote SHA.

## Out of scope

- Deleting `README_zh.md` history or changing its contents unless separately requested.
- Changing source code, package behavior, releases, or npm publication.
- Modifying or committing existing untracked bootstrap files.
- Deleting the GitHub repository.

## Acceptance criteria

- [x] The selected history rewrite scope is explicitly confirmed.
- [x] Current `README.md` no longer contains `Feature Matrix` or `Migration from pi-remote-compact`.
- [x] The acknowledgment contains the requested `LINUX DO community` wording.
- [x] The rewritten remote `main` branch contains the corrected README.
- [x] No historical commit in the selected scope retains `README.md` history.
- [x] Other tracked source-file history remains available using the path-only rewrite.
- [x] Unrelated untracked bootstrap files are untouched and excluded.
- [x] Force-push and post-push commit/tree checks pass.
