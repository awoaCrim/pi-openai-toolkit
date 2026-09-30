# pi-openai-toolkit

为 Pi 添加 Codex 上下文窗口、Responses 压缩、托管工具和工具调用审查。

[![npm 版本](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![许可证：MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](LICENSE)

[English](README.md)

## 概览

Toolkit 为 Pi 提供上下文管理、托管工具、生图和工具调用审查，同时沿用 Pi 现有的模型、提供商、认证和会话设置。下面的全局 `config.json` 是 Toolkit 功能的策略文件。

需要 Pi 0.87.0+ 和 Node.js 22.19.0+。v0.19.0 已适配并验证 Pi 0.87.0 到 0.99.1 及后续版本。

## 功能

| 功能 | 作用 |
| --- | --- |
| Codex 远程上下文 | 切换到新的上下文窗口，并通过 `history` 找回较早的工作内容。 |
| 远程压缩 v2 | 使用加密的服务端检查点继续 Responses 会话。 |
| 联网搜索 | 按模型选择不受 Toolkit 管理、本地、托管或 standalone 搜索。 |
| 图像生成 | 通过独立的 Images API 请求生成或编辑栅格图片。 |
| 图片输入限制 | 在压缩和 replay 时应用 `inputLimits.images` 的缩放及单消息、单请求限制。 |
| 工具调用审查 | 通过 Toolkit 审批门禁，让审查模型判断指定调用是否可以执行。 |

## 安装

Toolkit 需要 Node.js 22.19.0+ 和 Pi 0.87.0 或更高版本。即使扩展只安装到某个项目，配置仍使用全局路径：

`~/.pi/agent/extensions/pi-openai-toolkit/config.json`

需要时创建文件及其父目录。新文件使用配置格式 v2。对于没有 `schemaVersion` 的旧文件，编辑前先运行 `/toolkit-config migration-preview`。详见[迁移指南](docs/configuration.md#legacy-compatibility-and-migration)。

## 快速开始

安装 Toolkit：

```bash
pi install npm:pi-openai-toolkit
```

然后将下面的策略写入 Toolkit 的 `config.json`，启用 Codex 远程上下文：

```json
{
  "schemaVersion": 2,
  "defaults": {
    "context": { "mode": "remote-windows" }
  }
}
```

照常使用 Pi 启动和选择模型。远程上下文生效后，会出现 `new_context`、`get_context_remaining`、`history` 和 `notes`。运行 `/compact` 即可保存当前工作并进入新窗口。

对于符合条件的模型，远程压缩 v2 是默认上下文模式。其他 Toolkit 功能见下面的配置参考。

## 配置参考

Toolkit 只读取 `~/.pi/agent/extensions/pi-openai-toolkit/config.json`。用 `defaults` 设置通用策略，用 `models["provider/model-id"]` 精确覆盖单个模型。修改已有 v2 文件时，只合并需要的字段，不要覆盖无关设置。

下面是一份完整的 v2 配置结构。可选功能默认关闭，适合作为起点；启用功能时修改对应字段即可。

```json
{
  "schemaVersion": 2,
  "defaults": {
    "context": {
      "mode": "remote-compaction",
      "remoteCompaction": {
        "model": null,
        "inputSource": "legacy",
        "allowContinuityBreak": false,
        "apis": ["openai-responses", "openai-codex-responses"]
      },
      "nativeFallback": {
        "enabled": true,
        "model": null,
        "thinkingLevel": "off"
      },
      "remoteWindows": {
        "leaveManagedMode": "warn",
        "reminderThresholdPercent": 5
      }
    },
    "webSearch": {
      "route": "unmanaged"
    },
    "imageGeneration": {
      "enabled": false,
      "defaultModel": "image-model-id",
      "allowedModels": ["image-model-id"]
    },
    "autoMode": {
      "available": false,
      "reviewerModel": null,
      "gate": "side-effect",
      "extraTools": [],
      "timeoutMs": 30000,
      "transcript": true,
      "evidenceTools": true,
      "maxEvidenceRounds": 3,
      "classifier": {
        "enabled": false,
        "model": null,
        "timeoutMs": 15000,
        "maxLag": 2
      },
      "circuitBreaker": {
        "consecutiveDenials": 3,
        "recentDenials": 10,
        "windowSize": 50
      }
    }
  },
  "models": {
    "provider/model-id": {
      "webSearch": {
        "route": "hosted"
      },
      "compatibility": {
        "transport": "standard"
      }
    }
  },
  "diagnostics": {
    "level": "info",
    "notifyOnLoad": false,
    "captureRequests": false,
    "captureResponses": false,
    "redactSensitiveData": true,
    "artifactRoot": "~/.pi/agent/artifacts/pi-openai-toolkit/compaction"
  }
}
```

### 上下文管理

`context.mode` 用来选择上下文策略：

| 值 | 行为 |
| --- | --- |
| `remote-compaction` | 使用加密的 Responses 检查点。这是符合条件模型的默认值。 |
| `remote-windows` | 在所选后端支持时使用 Codex 上下文窗口。 |
| `pi` | 将上下文管理交给 Pi。 |

需要单独的检查点生产模型时，设置 `context.remoteCompaction.model`。该模型需要支持与当前模型相同的上下文流程。生产模型、回退和 replay 规则见[上下文配置与要求](docs/configuration.md#context)。

### 兼容性

`models["provider/model-id"].compatibility.transport` 默认值为 `"standard"`。确实需要 Toolkit 网关协议的精确模型，可以设置为 `"codex-gateway"`。提供商注册和 endpoint 配置仍由 Pi 管理，Toolkit 使用 Pi 已解析的模型和认证信息。必要时参见[提供商特定配置说明](docs/configuration.md#provider-specific-responses-endpoints)。

### 联网搜索

在 `defaults` 或精确模型下设置 `webSearch.route`：

| 路由 | 行为 |
| --- | --- |
| `unmanaged` | 将搜索交给 Pi 和其他扩展管理。 |
| `local` | 保留现有的本地 `pi-web-access` 工具。 |
| `hosted` | 使用带来源标注的 Responses `web_search`。 |
| `standalone-alpha` | 使用实验性的 standalone 搜索路由。 |

Toolkit 会保持当前操作选定的路由，不会自动切换到其他路由。详见[搜索配置](docs/configuration.md#web-search)。

### 图像生成与输入限制

图像生成设置位于全局 `defaults.imageGeneration` 下：

- `enabled` 控制工具是否启用。
- `defaultModel` 选择未指定模型时使用的生图模型。
- `allowedModels` 列出工具可以使用的生图模型，默认模型必须包含在其中。

图像生成通过独立的 Images API 请求执行，当前对话模型继续负责路由和认证。PNG、JPEG 和 WebP 响应会按实际格式校验和保存。详见[生图配置](docs/configuration.md#images)。

Toolkit 在为压缩或 replay 重建输入时，也会遵守所选模型的 `inputLimits.images` 元数据。它会执行缩放和数量限制，不会修改持久化会话或原始 provider payload。

### 使用 Auto Mode 审查工具调用

在 `defaults` 或精确模型下配置 `autoMode`。将 `available` 设为 `true` 后，使用 `/auto on` 或 `--auto` 开启门禁，使用 `/auto off` 关闭。

主要设置包括 `reviewerModel`、`gate`、`extraTools` 和 `timeoutMs`。默认的副作用门禁会审查 `bash`、`write`、`edit` 以及额外配置的工具。将 `gate` 设为 `"all"` 可审查所有工具。详见[自动模式配置](docs/configuration.md#auto-mode)。

### 诊断与迁移

使用以下命令检查和验证 Toolkit 配置：

| 命令 | 用途 |
| --- | --- |
| `/toolkit-config` | 查看生效设置及其来源。 |
| `/toolkit-config validate` | 检查配置错误。 |
| `/toolkit-config migration-preview` | 预览旧格式到 v2 的迁移，不写入文件。 |

在全局 `diagnostics` 下设置诊断选项。完整的[配置参考](docs/configuration.md)包含验证、迁移、诊断和全部支持字段。

## 开发

在仓库根目录安装依赖并运行检查：

```bash
npm install
npm run typecheck
bun test
bun test ./test/pi-smoke.test.ts
npm pack --dry-run
```

## 许可证

MIT © awoaCrim 与贡献者。见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
