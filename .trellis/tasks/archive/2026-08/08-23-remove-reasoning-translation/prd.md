# 移除思考内容翻译扩展

## Goal

从 `pi-openai-toolkit` 中完整移除 reasoning-translation（思考内容翻译）扩展，使包恢复到仅包含 compaction 与 web-search 两个功能入口的状态。

## Background

- 0.5.0 引入了第三个子扩展 `extensions/reasoning-translation.ts`，在 TUI 中监听流式 thinking 内容并用独立模型分段翻译。
- 现决定不再提供该能力，需要删除其代码、测试、配置解析、类型、文档与 spec，并清理本机由该功能引入的配置。

## Requirements

### 功能与范围

- 删除翻译扩展入口及其 `src/reasoning-translation/` 全部源码与测试。
- 从 `package.json` 移除扩展入口、发布文件列表、关键词与描述中的翻译相关措辞。
- 从 `src/types.ts` 移除 `ReasoningTranslationConfig` 类型、`ToolkitConfig.reasoningTranslation` 字段及其默认值。
- 从 `src/config.ts` 移除 `reasoningTranslation` 顶层字段、字段白名单、默认值合并与 `applyReasoningTranslationConfig` 函数。
- 从 `src/config.test.ts` 移除翻译配置解析测试与相关导入。
- 从 `test/pi-smoke.test.ts` 移除 Reasoning Translation 入口的 smoke 检查。
- 从 `tsconfig.check.json` 移除所有 reasoning-translation 相关 include。
- 从 `README.md` 与 `README_zh.md` 移除翻译功能的介绍、独立加载命令、配置示例与字段说明。
- 从 `.trellis/spec/frontend/index.md` 移除翻译规范条目与相关检查项，删除 `.trellis/spec/frontend/reasoning-translation.md`。
- 清理本机由该功能引入的配置：`config.json` 的 `reasoningTranslation` 段，以及 `models.json` 中仅为翻译添加的 `mistral-code-latest` 模型。
- compaction 与 web-search 的功能、配置、测试与文档保持不变。

## Acceptance Criteria

- [ ] 包中不再存在 `extensions/reasoning-translation.ts` 或 `src/reasoning-translation/` 目录。
- [ ] `pi.extensions` 仅含 compaction 与 web-search；`files` 与 `tsconfig.check.json` 不再引用任何 reasoning-translation 文件。
- [ ] `ToolkitConfig` 不再包含 `reasoningTranslation`，配置解析不再识别该顶层字段。
- [ ] `npm run typecheck`、`bun test`、`bun test ./test/pi-smoke.test.ts`、`git diff --check` 全部通过。
- [ ] `grep -riE 'reasoning.?translation'` 在 `extensions/`、`src/`、`test/`、`README*.md`、`package.json`、`tsconfig.check.json` 中无匹配。
- [ ] README（中英）描述恢复为两个功能入口，无翻译章节。
- [ ] 本地 `config.json` 与 `models.json` 已清理翻译相关条目。

## Out of Scope

- 发布新 npm 版本、git push、`pi update` 更新本地安装（作为后续独立步骤，需用户确认）。
- 改动 compaction 或 web-search 的任何行为。

## Risks

- 若本地 `config.json` 残留 `reasoningTranslation` 段，移除后的配置解析会将其视为未知顶层字段并产生警告；因此必须同步清理本地配置。
