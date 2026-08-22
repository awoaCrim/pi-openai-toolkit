# 设计：移除 reasoning-translation 扩展

## 边界

本次变更是对 0.5.0 新增功能的完整回滚，范围严格限定于 reasoning-translation 相关代码与文档，不触碰 compaction / web-search。

## 删除对象

- `extensions/reasoning-translation.ts`
- `src/reasoning-translation/`（11 个文件：6 实现 + 5 测试）
- `.trellis/spec/frontend/reasoning-translation.md`

## 配置与类型契约变化

- `src/types.ts`：删除 `ReasoningTranslationConfig` 类型、`ToolkitConfig.reasoningTranslation` 字段、`DEFAULT_REASONING_TRANSLATION_CONFIG` 常量及默认值中的对应项。
- `src/config.ts`：
  - 删除 `DEFAULT_REASONING_TRANSLATION_CONFIG` 与 `ReasoningTranslationConfig` 导入。
  - `TOP_LEVEL_FIELDS` 删除 `"reasoningTranslation"`。
  - 删除 `REASONING_TRANSLATION_FIELDS` 常量、`applyReasoningTranslationConfig` 函数、默认值合并块与 `raw.reasoningTranslation` 分支。
  - 共享 helper（`toModelAllowlist` / `toModelSpec` / `toBoolean` / `warnUnknownFields` / `isRecord`）仍被 compaction 与 webSearch 使用，保留不动。

## 包清单

- `package.json`：
  - `description` 去掉 "and TUI reasoning translation"。
  - `keywords` 删除 `"reasoning-translation"`。
  - `pi.extensions` 删除第三条入口。
  - `files` 删除 7 条（1 个入口 + 6 个 src）。
- `tsconfig.check.json`：`include` 删除 7 条。

## 测试

- 删除 `src/reasoning-translation/*.test.ts`（随目录一并删除）。
- `src/config.test.ts`：删除翻译配置测试用例与 `DEFAULT_REASONING_TRANSLATION_CONFIG` 导入。
- `test/pi-smoke.test.ts`：删除 Reasoning Translation 入口行。

## 文档与 spec

- `README.md` / `README_zh.md`：删除第 3 个功能点、独立加载命令、配置示例、`reasoningTranslation` 字段说明与功能章节，恢复标题/描述为两个功能。
- `.trellis/spec/frontend/index.md`：删除指南索引中的翻译行、checklist 第 2 条的翻译表述、Quality Check 中的 `src/reasoning-translation/*.test.ts` 引用。

## 本地配置清理（本机，不入库）

- `C:\Users\Administrator\.pi\agent\extensions\pi-openai-toolkit\config.json`：删除 `reasoningTranslation` 段。
- `C:\Users\Administrator\.pi\agent\models.json`：删除 `uwoacrimson.mistral-code-latest` 条目（仅为翻译添加）。

## 兼容性与回滚

- 无需数据迁移；回滚可依赖 git 历史（`git revert` 相应提交）或恢复 0.5.0 tarball。
- 本地已安装的 0.5.0 在未更新前仍保留翻译能力；发布 0.6.0 后由 `pi update` 卸载该入口（属后续步骤）。
