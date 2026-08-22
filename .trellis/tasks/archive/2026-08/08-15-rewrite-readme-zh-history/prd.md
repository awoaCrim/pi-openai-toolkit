# Rewrite Chinese README history and documentation

## Goal

同步英文 README 的修订到 `README_zh.md`：删除对应的冗余章节、更新 LINUX DO 致谢，并仅重写中文 README 的 Git 历史后安全 force push 远端 `main`。

## Confirmed facts

- Repository: `awoaCrim/pi-openai-toolkit`
- Branch: `main`
- Current local `HEAD`, `origin/main`, and remote `main` are all `25edf3b8b9038bfcf33a761403332e672ec5920d`.
- English `README.md` has already been rewritten and currently contains only the new README commit in its path history.
- `README_zh.md` currently still has the old documentation and one historical README commit:
  - `d4bf440 docs: rewrite README with dedicated English and Chinese docs`
- Existing unrelated untracked bootstrap files must remain untouched and uncommitted:
  - `.agents/`
  - `.gitattributes`
  - `.trellis/`
  - `AGENTS.md`

## Requirements

Apply the same changes as the English README:

1. Remove the complete `## 特性一览` section, including its feature table and the plugin loading-order note belonging to that section.
2. Remove the complete `## 从 `pi-remote-compact` 迁移` section and its migration bullets.
3. Replace the final acknowledgment with the same exact short wording used by the English README:

```text
- LINUX DO community.
```

4. Rewrite only the historical `README_zh.md` path. Preserve the current corrected Chinese README as a new final documentation commit.
5. Preserve the history and content of all other tracked files, including the already-corrected English `README.md`.
6. Force-push the rewritten `main` with `--force-with-lease` against the exact old remote SHA.

## Out of scope

- No source-code or package behavior changes.
- No changes to `README.md` beyond preserving its current corrected content.
- No changes to `NOTICE`, `README_zh.md` links outside the requested sections, or release metadata.
- No npm publish.
- No modification or commit of existing untracked bootstrap files.
- No full repository history reset.

## Acceptance criteria

- [x] `README_zh.md` no longer contains `特性一览` or `从 `pi-remote-compact` 迁移`.
- [x] The final Chinese README contains exactly `- LINUX DO community.` for the acknowledgment.
- [x] Historical commits before the new final documentation commit contain no `README_zh.md` path.
- [x] `git log -- README_zh.md` contains only the new final README_zh commit.
- [x] Existing corrected `README.md` content remains unchanged and its path history remains available.
- [x] Non-document source history and final trees remain unchanged by the path-only rewrite.
- [x] The remote `main` points to the verified rewritten tip.
- [x] Only the pre-existing untracked bootstrap files remain in the local working tree.
- [x] The external rollback bundle and old remote SHA are recorded before force push.
