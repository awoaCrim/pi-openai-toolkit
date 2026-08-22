# Technical Design: README-only history rewrite

## 1. Scope and outcome

Rewrite only the tracked `README.md` path in the `main` history of `awoaCrim/pi-openai-toolkit`.

The rewritten history will:

1. Preserve every non-README tracked file and its commit relationships as far as the path-only rewrite permits.
2. Remove `README.md` from all historical commits.
3. Add the corrected current `README.md` in one new final documentation commit.
4. Replace the remote `main` branch by force-push after local verification.

This is intentionally not a full repository history reset. Existing source commits remain represented in the rewritten graph, but all affected commit IDs change because their trees/parents are rewritten.

## 2. README content changes

In the current README:

- Remove the complete `## Feature Matrix` section, including its table and hook-order note directly belonging to that section.
- Remove the complete `## Migration from pi-remote-compact` section and its migration bullets.
- Replace the final acknowledgment sentence with the exact short wording:

```text
- LINUX DO community.
```

Do not change `README_zh.md`, source code, package behavior, or unrelated documentation.

## 3. Rewrite mechanism

`git filter-repo` is not installed in the environment. Do not install a new repository-rewrite dependency into the project.

Use an isolated temporary clone of the remote repository and the built-in `git filter-branch` index filter:

```bash
git filter-branch --index-filter 'git rm --cached --ignore-unmatch README.md' --prune-empty -- main
```

The operation must run only in the temporary clone, not in the user's working repository. The temporary clone starts from `origin/main`, so unrelated local bootstrap files cannot enter the rewrite.

After filtering, modify the now-absent README in the temporary clone and create one new commit. Configure commit identity explicitly from the current repository identity when needed; use the repository's existing author identity and current timestamp unless Git metadata requires otherwise.

## 4. Safety and rollback

Before rewriting:

- Record the exact remote old tip SHA.
- Record the current local `HEAD`, `origin/main`, remote URL, and default branch.
- Create an external bundle backup of the current remote branch outside the repository working tree, or retain the old tip SHA for emergency recovery.
- Confirm the working tree has no tracked modifications; leave untracked bootstrap files untouched.

Before force-push:

- Verify the temporary rewrite is a descendant-equivalent path-only rewrite, with README removed from all old commits and present only in the final new commit.
- Verify non-README files still have expected history counts/content.
- Verify README section removal and acknowledgment wording.
- Verify no task/bootstrap files are staged.

Rollback if verification fails:

- Discard the temporary clone without touching the working repository.
- If force-push already happened, restore `main` from the recorded old tip using the same authenticated remote and an explicit force-with-lease push, after confirming the user wants rollback.

Use `--force-with-lease` rather than unconditional `--force`, with the lease set to the recorded old remote SHA. This prevents overwriting an unrelated remote update.

## 5. Local repository synchronization

After successful remote replacement:

- Fetch the new `origin/main`.
- Update the local branch pointer to the new remote tip without touching untracked bootstrap files.
- Make the local working-tree README match the pushed README.
- Verify `git status --short` still shows only the pre-existing untracked bootstrap files.
- Update `origin` only if it is not already `https://github.com/awoaCrim/pi-openai-toolkit.git`.

## 6. Verification contracts

### README history

```bash
git log --format='%H %s' -- README.md
```

Expected result: only the new final README commit appears.

The parent of the final README commit must not contain `README.md`:

```bash
git ls-tree -r <new-readme-parent> -- README.md
```

Expected result: no output.

### Other history

Check a source path that existed before the rewrite, such as `src/types.ts`, and compare the number/order of logical commits before and after. Commit SHAs change, but the source path remains present and its history is not removed.

### Remote verification

After push:

```bash
git fetch origin main
git ls-remote origin refs/heads/main
git log --oneline --decorate -5 origin/main
git show origin/main:README.md
```

The remote tip must equal the verified local rewritten tip, and the remote README must contain neither removed section heading.
