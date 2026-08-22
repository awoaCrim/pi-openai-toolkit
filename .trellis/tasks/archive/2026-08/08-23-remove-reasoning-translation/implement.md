# 执行清单（git revert 方案）

## 撤销仓库内改动

1. `git revert --no-commit 20e45bb 43567f7`（倒序撤销 docs 与 feat 两个提交，覆盖代码/测试/配置/类型/文档/包清单）

## 手动处理 untracked spec（git revert 不覆盖）

2. 删除 `.trellis/spec/frontend/reasoning-translation.md`
3. 修改 `.trellis/spec/frontend/index.md`：删除翻译指南索引行、checklist 第 2 条翻译表述、Quality Check 中的 `src/reasoning-translation/*.test.ts` 引用

## 本地配置（仓库外，git revert 不覆盖）

4. 清理 `C:\Users\Administrator\.pi\agent\extensions\pi-openai-toolkit\config.json` 的 `reasoningTranslation`
5. 清理 `C:\Users\Administrator\.pi\agent\models.json` 的 `mistral-code-latest`

## 验证

6. `npm run typecheck`
7. `bun test`
8. `bun test ./test/pi-smoke.test.ts`
9. `git diff --check`
10. `grep -riE 'reasoning.?translation' extensions/ src/ test/ README.md README_zh.md package.json tsconfig.check.json` 应为空
11. `git status` 确认 revert 仅涉及预期文件，且 version 仍为 0.5.0

## Review gate

- 确认 compaction / web-search 测试全绿且未受影响
- 确认 revert 干净无冲突，工作区仅剩预期改动

## 回滚点

- `git revert --no-commit` 的结果可用 `git reset` 取消；revert 本身是安全操作
- 本地 `config.json` / `models.json` 清理内容已在会话记录中，可手动恢复
