# pi-openai-toolkit

为 Pi 添加 Codex 上下文窗口、Responses 压缩、托管工具和工具调用审查。

[![npm 版本](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![许可证：MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](LICENSE)

[英文版](README.md)

## 功能

| 功能 | 用途 |
| --- | --- |
| Codex 远程上下文 | 通过适配的 Codex 协议切换窗口，用 `history` 找回较早的工作内容。 |
| 远程压缩 v2 | 使用加密的服务端检查点继续 Responses 会话。 |
| 联网搜索 | 按模型选择本地 `pi-web-access`、Responses `web_search` 或实验性的 CPA `web_run`。 |
| 图像生成 | 使用 Responses 托管生图工具生成或编辑图片。 |
| 工具调用审查 | 通过 Toolkit 审批门禁，让审查模型判断指定调用是否可以执行。 |

本包沿用 Pi 已有的模型、认证和会话，不新增提供商或模型。

## 安装

需要 Pi 0.87.0+ 和 Node.js 22.19.0+。

```bash
pi install npm:pi-openai-toolkit
```

加上 `--local` 可安装到当前项目。无论安装位置如何，Toolkit 都使用全局配置：

`~/.pi/agent/extensions/pi-openai-toolkit/config.json`

文件不存在时，创建文件及所需目录。将下方 Toolkit 示例合并到已有的**配置格式 v2** 文件，不要覆盖其他设置。无版本号的旧配置请先运行 `/toolkit-config migration-preview`，详见[迁移指南](docs/configuration.md#legacy-compatibility-and-migration)。

默认情况下，符合条件的模型启用远程压缩 v2；远程上下文窗口、生图和自动模式关闭，搜索不由 Toolkit 管理。使用相关功能仍需后端支持。

## 快速开始：启用远程上下文

如果只需要搜索、生图或工具调用审查，可跳到[常见用法](#常见用法)。

### 使用 Pi 内置的 Codex 提供商

先登录 Pi 的 `openai-codex` 提供商，再添加以下 Toolkit 配置：

```json
{
  "schemaVersion": 2,
  "defaults": {
    "context": { "mode": "remote-windows" }
  }
}
```

使用 Codex 模型目录中的实际模型 ID 启动 Pi：

```bash
pi --model openai-codex/<model-id>
```

检查是否出现 `new_context`、`get_context_remaining`、`history` 和 `notes`。工具出现表示已激活，不代表后端兼容性已经验证。较早窗口可通过 `history` 检索，不会加载到每次请求中。

### 使用兼容网关

网关必须支持 `openai-responses` 和 Codex 远程上下文协议，仅支持普通对话还不够。

如果模型已在 `~/.pi/agent/models.json` 注册，可跳过注册示例。

<details>
<summary>在 Pi 中注册网关模型</summary>

将以下内容合并到 Pi 的模型文件。按实际情况替换提供商名称、URL、密钥变量、模型 ID 和限制值；其中的数字仅为示例。

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://your-gateway.example/v1",
      "api": "openai-responses",
      "apiKey": "$MY_GATEWAY_KEY",
      "models": [{
        "id": "gpt-5.6-luna",
        "name": "GPT-5.6 Luna",
        "reasoning": true,
        "input": ["text"],
        "contextWindow": 272000,
        "maxTokens": 128000
      }]
    }
  }
}
```

PowerShell 中设置密钥：

```powershell
$env:MY_GATEWAY_KEY = "replace-with-your-gateway-key"
```

或使用 POSIX shell：

```bash
export MY_GATEWAY_KEY="replace-with-your-gateway-key"
```

在同一个终端中启动 Pi。

</details>

在 Toolkit 配置中填写已注册的精确 `提供商/模型 ID`：

```json
{
  "schemaVersion": 2,
  "models": {
    "my-gateway/gpt-5.6-luna": {
      "context": { "mode": "remote-windows" },
      "compatibility": { "transport": "codex-gateway" }
    }
  }
}
```

```bash
pi --model my-gateway/gpt-5.6-luna
```

检查是否出现上面列出的上下文工具。如果没有，使用 `/toolkit-config`，并检查通知、模型键、API、认证和 URL。

## 常见用法

### 用 `/compact` 保存工作并切换窗口

远程上下文已激活时，运行 `/compact` 可将工作状态保存到 notes，再进入新窗口，不生成会话摘要。命令后可以附加要求。

如需独立的检查点模型，在 `defaults` 或精确模型覆盖下设置 `context.remoteCompaction.model`。目标模型须在同一后端及账号下支持远程上下文；不设置则使用当前模型。Toolkit 会在继续工作前恢复原模型和思考等级。详见[上下文配置与要求](docs/configuration.md#context)。

### 使用服务端压缩

将 `context.mode` 设为 `"remote-compaction"`（默认值），使用加密的 Responses 检查点；设为 `"pi"` 则由 Pi 管理上下文。高级输入和回退选项见[配置参考](docs/configuration.md#context)。

### 选择联网搜索路由

设置默认路由，并按模型覆盖：

```json
{
  "schemaVersion": 2,
  "defaults": {
    "webSearch": { "route": "local" }
  },
  "models": {
    "my-gateway/gpt-5.6-luna": {
      "webSearch": { "route": "hosted" }
    }
  }
}
```

| 路由 | 行为 |
| --- | --- |
| `unmanaged` | 由 Pi 和其他扩展管理搜索。 |
| `local` | 保留现有本地 `pi-web-access` 工具。 |
| `hosted` | 使用带来源标注的 Responses `web_search`。 |
| `standalone-alpha` | 在支持 `/alpha/search` 的 CPA/Codex 网关上使用实验性的 `web_run`。 |

Toolkit 不会在路由之间自动回退。后端要求见[搜索配置](docs/configuration.md#web-search)。

### 生成图片

需要 Responses 会话，并可能产生服务商费用。选择服务商支持的生图模型后启用：

```json
{
  "schemaVersion": 2,
  "defaults": {
    "imageGeneration": {
      "enabled": true,
      "defaultModel": "gpt-image-2.5",
      "allowedModels": ["gpt-image-2.5"]
    }
  }
}
```

让 Pi 通过 `openai_generate_image` 生成图片，或编辑明确提供的本地参考图。默认模型必须在 `allowedModels` 中；生图设置全局生效。详见[生图配置](docs/configuration.md#images)。

### 启用工具调用自动审查

为模型开放自动模式，并选择审查模型：

```json
{
  "schemaVersion": 2,
  "models": {
    "my-gateway/gpt-5.6-luna": {
      "autoMode": {
        "available": true,
        "reviewerModel": "my-gateway/gpt-5.6-luna"
      }
    }
  }
}
```

使用 `/auto on` 或 `--auto` 开启，`/auto off` 关闭。默认审查 `bash`、`write`、`edit` 和额外配置的工具；`gate: "all"` 审查所有调用。审查超时不会自动放行。详见[自动模式配置](docs/configuration.md#auto-mode)。

## 常用配置

`defaults` 设置通用值，`models["provider/model-id"]` 按精确模型覆盖。Toolkit 只读取全局配置文件。

| 命令 | 用途 |
| --- | --- |
| `/toolkit-config` | 查看生效设置及其来源。 |
| `/toolkit-config validate` | 检查配置错误。 |
| `/toolkit-config migration-preview` | 预览旧格式到 v2 的迁移，不写入文件。 |

这些命令需要 Pi 交互界面。完整说明见[配置参考](docs/configuration.md)、[编辑器 schema](config.schema.json)和[实现细节](docs/internals.md)。

## 开发

在仓库根目录安装依赖后运行：

```bash
npm run typecheck
```

```bash
bun test
```

```bash
npm run test:pi
```

```bash
npm pack --dry-run
```

## 许可证

MIT © awoaCrim 与贡献者。见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
