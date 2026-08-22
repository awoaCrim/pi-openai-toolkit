# Technical Design: restore README links and rewrite README history

## 1. Scope and outcome

Run the rewrite in a temporary clone of the current remote `main`. Remove both `README.md` and `README_zh.md` from historical trees, then add the corrected versions together in one final documentation commit.

This keeps the README history policy consistent: the public branch will not retain the previous plain-text acknowledgment commits, while all non-README files retain their final content and logical history.

## 2. Content transform

Only replace the final acknowledgment line in each current README:

```diff
-- LINUX DO community.
+- [LINUX DO](https://linux.do/) community.
```

Do not restore the removed feature matrix or migration sections, and do not otherwise alter either README.

## 3. History rewrite

`git filter-repo` is unavailable. Use built-in `git filter-branch` in the isolated clone:

```bash
git filter-branch --index-filter 'git rm --cached --ignore-unmatch README.md README_zh.md' --prune-empty -- main
```

Delete temporary `refs/original` refs before validation. Copy the current local README files into the filtered clone, apply only the link changes, stage both files, and commit them together.

Inspect `main` explicitly rather than `--all`, because the clone may retain stale `origin/main` or filter backup refs that are not part of the pushed branch.

## 4. Safety and rollback

Before rewriting:

- Confirm local, tracking, and remote `main` all equal the recorded old SHA.
- Create an external bundle backup outside the repository.
- Confirm no tracked working-tree changes exist.
- Use a temporary clone so current files and untracked bootstrap content are isolated.

Before push:

- Verify exact Markdown lines in both files.
- Verify removed sections remain absent.
- Verify no historical commit reachable from rewritten `main~1` contains either README path.
- Verify each README path history has one final documentation commit.
- Compare old/new recursive trees after excluding both README paths.
- Compare all non-README source history counts and representative blobs.
- Verify the remote lease still equals the recorded old SHA.

Push only with:

```bash
git push origin main:main --force-with-lease=refs/heads/main:<old-sha>
```

If any pre-push check fails, delete the temporary clone and do not touch the remote. Retain the external bundle and metadata as rollback material.

## 5. Local synchronization

After push, force-fetch `origin/main`, move the local `main` ref with `git update-ref`, and synchronize tracked files with `git read-tree -u -m HEAD`. This preserves untracked bootstrap files. Delete the temporary clone after successful synchronization.

## 6. Verification contracts

- Content contract: both files contain `- [LINUX DO](https://linux.do/) community.`.
- Section contract: neither file contains the previously removed feature matrix or migration section.
- History contract: historical commits contain neither README path; each current README path has one new commit.
- Preservation contract: non-README final tree matches the old remote tree; `src/types.ts` history count is unchanged.
- Remote contract: local `HEAD`, `origin/main`, and remote `refs/heads/main` equal the verified new SHA.
- Scope contract: local status still lists only the pre-existing untracked bootstrap files.
