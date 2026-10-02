# pi-openai-toolkit

为 Pi 添加远程上下文窗口、Responses 压缩、联网搜索、图像生成和工具调用审查。沿用 Pi 的模型、端点、认证和会话配置，不另行注册提供商或模型。

[![npm 版本](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](LICENSE)

[English](README.md)

## 安装与快速开始

需要 Node.js **22.19.0+**、Pi **0.87.0+**。当前开发依赖锁定 Pi **1.0.0**；后端功能是否可用，还取决于所选模型、接口和账号权限。

```bash
pi install npm:pi-openai-toolkit
```

在 Pi 中配置好模型和凭据后，照常启动。没有 Toolkit 配置文件时，符合条件的模型默认使用远程压缩；搜索由 Pi 和其他扩展管理，生图和 Auto Mode 默认关闭。

Toolkit 只读取一个全局配置文件，即使扩展安装在项目内也一样：

```text
~/.pi/agent/extensions/pi-openai-toolkit/config.json
```

新建配置时，按需创建父目录，使用 v2 格式：

```json
{
  "schemaVersion": 2,
  "defaults": {
    "context": { "mode": "remote-compaction" }
  }
}
```

在 Pi 中检查配置：

- `/toolkit-config`：查看当前生效值及其来源
- `/toolkit-config validate`：检查配置错误
- `/toolkit-config migration-preview`：预览旧格式迁移，不写入文件

配置按“内置默认值 → `defaults` → `models["provider/model-id"]`”覆盖。模型键精确匹配、区分大小写，不支持通配符或项目级配置。以下示例按需合并到现有文件，不要覆盖其他设置；没有 `schemaVersion` 的旧配置先看[迁移说明](docs/configuration.md#legacy-compatibility-and-migration)。

## 上下文管理

通过 `defaults.context.mode` 或单个模型的 `context.mode` 选择：

- `remote-compaction`：默认模式，使用服务端返回的加密检查点继续会话
- `remote-windows`：使用 Codex 远程上下文窗口，通过 `history` 检索较早内容、`notes` 保存交接信息
- `pi`：交给 Pi 管理上下文

**远程压缩**支持的 API 类型是 `openai-responses`、`openai-codex-responses` 和 `azure-openai-responses`，但后端仍须支持对应的检查点协议。可用 `context.remoteCompaction.model` 指定独立的压缩模型；远程压缩要求它与当前模型使用相同的有效 base URL。原生摘要回退有独立配置，并非所有失败都会回退；空检查点、来源不匹配或被修改的已封存历史会阻止存储或重放。详见[上下文配置](docs/configuration.md#context)和[检查点规则](docs/internals.md#remote-compaction-v2-wire-contract)。

**远程窗口**需要原生 `openai-codex` 提供商的 `openai-codex-responses` API，或支持相应协议的 `openai-responses` 网关。网关必须在精确模型下设置 `compatibility.transport: "codex-gateway"`；这一设置不会让普通兼容端点自动获得该能力。

将上例的 `mode` 改为 `remote-windows` 后，符合条件的会话会提供 `new_context`、`get_context_remaining`、`history` 和 `notes`。手动 `/compact [instructions]` 会发起检查点交接：先成功写入 notes，再切换窗口。不具备窗口能力的模型仍走压缩流程；窗口激活失败不会静默改用摘要。

远程窗口依赖 alpha 接口，上游可能随时调整。切换模型前也要留意旧窗口历史仍未清理的情况，详见[窗口生命周期](docs/internals.md#rollover-lifecycle)。

## 搜索、生图与工具审查

### 联网搜索

在 `defaults.webSearch.route` 或精确模型的 `webSearch.route` 中选择：

- `unmanaged`：默认值，不接管搜索；这不等于禁止联网
- `local`：保留已有本地搜索工具（如 `pi-web-access`），不会安装或启用原本未启用的工具
- `hosted`：使用 Responses `web_search` 并返回来源标注，停用冲突的本地搜索工具
- `standalone-alpha`：实验性 `web_run`，通过独立的 `/alpha/search` 请求执行搜索、打开页面等操作

`hosted` 支持上述三类 Responses API，仍需后端和账号支持搜索。`standalone-alpha` 仅支持已验证的 OpenAI/Codex 路由，网关还须提供对应端点及能力。选定路由不可用、缺少认证或发生工具冲突时，不会自动换到另一条路由。完整操作列表见[搜索配置](docs/configuration.md#web-search)。

### 图像生成

生图配置只放在全局 `defaults.imageGeneration`。将示例中的 `image-model-id` 替换为后端实际支持的图片模型 ID：

```json
{
  "schemaVersion": 2,
  "defaults": {
    "imageGeneration": {
      "enabled": true,
      "defaultModel": "image-model-id",
      "allowedModels": ["image-model-id"]
    }
  }
}
```

启用后，符合条件的会话提供 `openai_generate_image`，支持生成、参考图编辑和批量生成。当前会话模型负责路由和认证，图片模型通过独立 Images API 调用，不会替换对话模型。默认图片模型为 `grok-imagine-image-2.0`，不代表你的后端一定支持它；`defaultModel` 必须包含在 `allowedModels` 中。

目前要求 `openai-responses` 或 `openai-codex-responses` 路由，以及可用的 Images API。返回结果须为 base64 编码的 PNG、JPEG 或 WebP。`batchSize` 为 1–10，每张图是一次独立请求，可能单独计费；部分失败会保留已保存的图片。编辑会向提供商发送参考图，请确认这些图片可以上传。详见[生图配置](docs/configuration.md#images)。

### Responses WebSocket 传输

Toolkit 的 WebSocket adapter 默认关闭。对使用 Pi `openai-responses` API 的 GPT 模型，可通过全局配置开启：

```json
{
  "schemaVersion": 2,
  "defaults": {
    "responsesWebSocket": { "enabled": true }
  }
}
```

它沿用当前模型的 provider、base URL、凭据、headers 和 model ID，不注册新的 provider。Pi 的 `transport: "auto"` 会先尝试 WebSocket，并在开始流式输出前回退到 SSE；会话 ID 稳定时还会复用连接，并在历史匹配时只发送新的 continuation 输入。使用 `transport: "websocket-cached"` 可强制要求缓存连接路径，使用 `transport: "sse"` 则保持原有 HTTP/SSE 路径。修改 Toolkit 配置后请重启或 reload Pi。详见[WebSocket 配置](docs/configuration.md#responses-websocket-transport)。

### Auto Mode

Auto Mode 在工具执行前进行模型审查。先允许使用并指定 Pi 中已注册、可认证的审查模型，再手动开启：

```json
{
  "schemaVersion": 2,
  "defaults": {
    "autoMode": {
      "available": true,
      "reviewerModel": "provider/reviewer-model-id"
    }
  }
}
```

将 `provider/reviewer-model-id` 替换为实际模型。用 `/auto on` 或启动参数 `--auto` 开启，`/auto off` 关闭；只设置 `available: true` 不会自动开启。

默认 `gate: "side-effect"` 审查 `bash`、`write`、`edit` 和 `extraTools` 中的工具，`gate: "all"` 审查所有工具。支持只读取证、拒绝次数熔断和可选的后台分类器预评分；开启分类器后，部分调用可依据预评分放行。

审查超时或不可用不算批准：交互模式会请求用户确认，无界面模式会阻止调用。它不是沙箱，也不保证每次判断正确；选择不符合条件的模型会关闭 Auto Mode。完整配置见[Auto Mode](docs/configuration.md#auto-mode)。

## 兼容性与排查

- 提供商、端点和凭据仍由 Pi 管理，不写进 Toolkit 配置。Azure 的部署映射、`api-version` 和认证说明见[提供商配置](docs/configuration.md#provider-specific-responses-endpoints)
- `pi-virtual` 使用 Pi 解析出的实际提供商和模型检查能力，不按虚拟模型名称推断支持情况
- 压缩和重放时遵守 Pi 模型元数据中的 `inputLimits.images` 缩放与数量限制，不修改持久化会话或原始请求对象
- 无效配置会阻止依赖它的操作。先运行 `/toolkit-config validate`，再检查模型、认证和后端能力；配置校验通过不等于端点可用
- 请求与压缩响应记录默认关闭。排查时才开启 `diagnostics.captureRequests` / `captureResponses`，分享日志前检查是否包含对话内容

完整字段和默认值见[配置参考](docs/configuration.md)与 [JSON Schema](config.schema.json)。协议、检查点和调试细节见[内部实现](docs/internals.md)。

## 开发

在仓库根目录运行：

```bash
npm ci
npm run typecheck
npm test
npm run test:pi
npm pack --dry-run
```

测试使用 Bun，已列入开发依赖。修改 README 的 JSON 示例时，同步更新中英文版本，文档测试会检查两者一致。

MIT © awoaCrim 与贡献者。许可证见 [LICENSE](LICENSE)，第三方来源与致谢见 [NOTICE](NOTICE)。
