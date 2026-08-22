# Technical Design: README_zh-only history rewrite

## 1. Boundary and outcome

Operate on a temporary clone of the current remote `main`, not on the working repository. Remove only `README_zh.md` from historical trees, then add the corrected Chinese README in one new final commit.

The rewrite changes commit SHAs for the complete graph because parent trees change, but it must preserve the final tree and history of every non-`README_zh.md` path. In particular, the already-corrected English `README.md` must remain byte-for-byte unchanged.

## 2. Content transform

Starting from the current `README_zh.md`:

- Remove the complete `## 特性一览` section through the separator before `## 安装使用`.
- Remove the complete `## 从 `pi-remote-compact` 迁移` section through the separator before `## 测试与验证`.
- Replace:

```text
- 特别鸣谢 [LINUX DO](https://linux.do/) 社区的技术交流、灵感与支持。
```

with:

```text
- LINUX DO community.
```

No other Chinese content is intentionally changed.

## 3. History rewrite mechanism

`git filter-repo` is unavailable and no new dependency should be added. In an isolated clone, use built-in `git filter-branch` with an index filter:

```bash
git filter-branch --index-filter 'git rm --cached --ignore-unmatch README_zh.md' --prune-empty -- main
```

Remove the temporary clone's `refs/original` backup ref before validation, and inspect `main` rather than `--all` so stale remote-tracking refs cannot be mistaken for the rewritten branch. Copy the original current `README_zh.md` into the filtered clone, apply the three content changes, then commit only that file.

## 4. Safety and rollback

Before the rewrite:

- Confirm local `HEAD`, `origin/main`, and `git ls-remote` agree.
- Record the old remote SHA and repository URL.
- Create an external bundle backup of the old `origin/main`, outside the repository tree.
- Confirm no tracked local changes exist; preserve existing untracked bootstrap files.

Before push:

- Compare the old and rewritten final trees after excluding `README_zh.md`; they must match.
- Confirm all historical commits reachable from rewritten `main` before the final new commit lack `README_zh.md`.
- Confirm `README.md` blob content is identical to the old remote tip.
- Confirm the final path histories contain one new `README_zh.md` commit and the existing corrected `README.md` history remains present.
- Confirm the remote lease still equals the recorded old SHA.

Push only the rewritten `main` ref with:

```bash
git push origin main:main --force-with-lease=refs/heads/main:<old-sha>
```

If validation fails, delete the temporary clone and do not touch the remote. If a push succeeds but post-push verification fails, restore from the recorded old SHA only after explicit rollback confirmation.

## 5. Local synchronization

After a successful push, force-fetch the rewritten remote-tracking branch, move the local `main` ref to it with `git update-ref`, and update the worktree/index using `git read-tree -u -m HEAD`. This preserves untracked bootstrap files while making tracked files match the pushed branch.

Delete the temporary clone after synchronization. Retain the external bundle backup and metadata outside the repository for recovery.

## 6. Verification contracts

- Content: no `特性一览`, no `从 `pi-remote-compact` 迁移`, and exact `- LINUX DO community.` line.
- History: `git log main -- README_zh.md` has one commit; historical parent trees have no `README_zh.md`.
- English preservation: `git show <old-sha>:README.md` equals `git show <new-sha>:README.md`.
- Tree preservation: old and new recursive tree listings, excluding `README_zh.md`, are identical.
- Remote: `git ls-remote origin refs/heads/main` equals the verified new SHA.
- Scope: local status contains only the pre-existing untracked bootstrap files.
