# pi-openai-toolkit

为 Pi 添加 Codex 上下文窗口、Responses 压缩、托管工具和工具调用审查。

[![npm 版本](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![许可证：MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](LICENSE)

[英文版](README.md)

## 功能

| 功能 | 用途 |
| --- | --- |
| Codex 远程上下文 | 使用适配的 Codex 窗口协议切换上下文窗口，并通过 `history` 检索较早窗口。 |
| 远程压缩 v2 | 使用服务端返回的加密检查点继续符合条件的 Responses 会话。 |
| 联网搜索路由 | 按精确模型选择本地 `pi-web-access`、Responses 托管 `web_search` 或实验性的 CPA 独立 `web_run`。 |
| 图像生成 | 调用 Responses 托管生图工具生成图片，或编辑明确传入的本地参考图片。 |
| 工具调用审查 | 使用 Toolkit 的审批门禁，由审查模型判断指定工具调用是否可以执行。 |

本包沿用 Pi 已有的模型、认证和会话配置，不新增提供商或模型。

## 安装

需要 Pi 0.85.1 或更高版本，以及 Node.js 22.19.0 或更高版本。

```bash
pi install npm:pi-openai-toolkit
```

在当前项目中安装扩展时加上 `--local`。Toolkit 策略仍然只使用全局配置，不支持项目配置或环境变量策略覆盖。

没有配置文件时，符合条件的模型启用远程压缩 v2，远程上下文窗口关闭，搜索不由 Toolkit 管理，图像生成关闭，自动模式不可用。这些默认值不表示后端能力已经验证。

Toolkit 唯一的配置文件是：

`~/.pi/agent/extensions/pi-openai-toolkit/config.json`

下文除 Pi 模型注册示例外，其他 JSON 示例均使用**配置格式 v2**。文件不存在时，创建文件及所需目录；已有 v2 配置时，将示例合并到对应对象并保留其他设置。无版本号的旧格式仍受支持，请勿直接加入 v2 字段，也不要用示例覆盖原文件。先运行 `/toolkit-config migration-preview`；[配置参考](docs/configuration.md)说明了审查和已安装版本检查要求。读取配置和预览迁移都不会改写源文件。

## 快速开始：启用远程上下文

本节适用于想使用 Codex 风格上下文窗口的用户。如果只需要搜索、生图或工具调用审查，请跳到[常见用法](#常见用法)。

### 使用 Pi 内置的 Codex 提供商

你需要先登录 Pi 内置的 `openai-codex` 提供商。创建或合并以下 v2 Toolkit 配置：

```json
{
  "schemaVersion": 2,
  "defaults": {
    "context": { "mode": "remote-windows" }
  }
}
```

使用已有 Codex 模型目录中的模型启动 Pi：

```bash
pi --model openai-codex/<model-id>
```

将 `<model-id>` 换成 Pi 配置中实际显示的模型 ID。会话中出现 `new_context`、`get_context_remaining`、`history` 和 `notes`，说明已经激活；这不代表已完成后端往返验证。

### 使用兼容网关

本路线要求使用 `openai-responses`，并且网关保留远程上下文所需的 Codex 协议字段。普通对话请求成功，不代表远程上下文兼容性已经验证。

如果 `~/.pi/agent/models.json` 中已有兼容模型，可以跳过注册，直接设置下方 Toolkit 精确模型覆盖。否则，添加或合并下面的 Pi 提供商配置。请替换提供商名称、地址、环境变量和模型字段。示例数字不是项目默认值。

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

启动 Pi 前设置配置中引用的密钥。PowerShell 使用：

```powershell
$env:MY_GATEWAY_KEY = "replace-with-your-gateway-key"
```

POSIX shell 使用：

```bash
export MY_GATEWAY_KEY="replace-with-your-gateway-key"
```

使用同一个终端启动 Pi。在 Toolkit 配置中，确保键与已注册的提供商名称和模型 ID 完全一致：

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

检查是否出现 `new_context`、`get_context_remaining`、`history` 和 `notes`。如果没有，查看通知与 `/toolkit-config`，再检查精确模型键、Pi API、认证和基础 URL。传输设置只是显式选择协议适配，不会注册模型，也不能证明后端支持。

较早窗口仍可通过 `history` 检索，但不会全部自动加入当前上下文。

## 常见用法

### 使用服务端压缩继续会话

使用 `context.mode: "remote-compaction"` 选择 Responses 压缩路径（默认值），或设为 `"pi"` 交回 Toolkit 的上下文管理权。只有需要独立模型生成检查点时才设置 `context.remoteCompaction.model`。这些字段放在 `defaults` 或精确的 `models` 覆盖下。

`context.remoteCompaction.inputSource` 默认为 `"legacy"`：首次压缩使用 Pi 当前会话上下文，最后才回退到事件提供的数据；递归压缩使用原始分支尾部。这保留了既有行为，但当其他扩展改写消息时，可能与提供商实际看到的上下文不同。

主动选择 `"pi-context-hook"` 后，使用 Pi 有序上下文钩子投影。如果桥接不可用，压缩会取消，不会发送未投影的历史。检查点与来源绑定，切换来源后必须创建新检查点。详见[协议说明](docs/internals.md#remote-compaction-v2-wire-contract)。

### 选择联网搜索路由

设置全局默认值和精确模型覆盖：

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

- `unmanaged` 释放 Toolkit 的管理权，不会关闭第三方搜索或所有网络访问。
- `local` 保留本地 `pi-web-access` 工具原先的激活状态，并从提供商请求中移除冲突的托管或独立搜索工具。原先未激活的本地工具不会被自动激活。
- `hosted` 用原生 Responses 搜索工具和来源标注替换本地 `web_search` 函数。
- `standalone-alpha` 显式启用实验性的 CPA/Codex 网关搜索。它暴露顺序执行的 `web_run`，每次调用向提供商相对路径 `/alpha/search` 发送一次隔离请求，使用当前 Pi 模型及认证。网关必须实际支持该端点和能力，Toolkit 不会探测或替你开启。

精确覆盖优先于默认值。不支持模式匹配、猜测能力或路由间回退。选中策略无效时，会阻止受影响操作，不会改选其他路由。旧版托管模型列表仍可读取，但其宽松失败处理与 v2 显式 `hosted` 不完全相同；迁移预览会标出差异。

### 生成图片

图像生成需要 Responses 会话，并且可能产生服务商费用。全局启用方式如下：

```json
{
  "schemaVersion": 2,
  "defaults": {
    "imageGeneration": {
      "enabled": true,
      "defaultModel": "gpt-image-2.5",
      "allowedModels": ["gpt-image-2.5", "grok-imagine-image-2.0"]
    }
  }
}
```

这里填写嵌套 Responses `image_generation` 工具使用的裸输出模型 ID。列表顺序不决定默认模型。`defaultModel` 必须属于非空的 `allowedModels` 列表，单次调用的可选 `model` 也必须在列表中。无效策略或不允许的选择会在认证、参考图上传及付费请求前被拒绝。提供商必须支持所选模型。

`openai_generate_image` 支持文生图和使用明确传入的本地参考图进行编辑。生图策略不能按当前会话模型覆盖。

### 启用工具调用自动审查

为精确模型开放自动模式，并选择审查模型：

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

`available` 表示允许开启，使用 `/auto on` 或 `--auto` 才会实际开启；`/auto off` 明确关闭。默认 `side-effect` 范围覆盖 `bash`、`write`、`edit` 和额外配置的工具；`gate: "all"` 审查所有工具调用。审查超时不会自动放行。运行中配置变为无效时，已开启的门禁继续阻止调用，直到修正配置或明确关闭。

TUI 会显示开启提示、审查活动和底部状态。兼容的 Pi 工具渲染器还会显示每次调用的允许、拒绝、阻止或未审查状态。如果渲染接口不可用，Toolkit 告警一次并保留底部显示。审查器、分类器和熔断器的高级配置见[配置参考](docs/configuration.md)。

## 常用配置

全局文件按内置值、`defaults`、精确 `models["provider/model-id"]` 的顺序解析。缺失字段继承，数组整体替换，`false` 和 `0` 保持含义。支持的可选模型引用可以用 `null` 清除继承。默认值不是总开关：精确覆盖可以开启默认关闭的功能。

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `defaults.context.mode` | `"remote-compaction"` | `"pi"`、`"remote-compaction"` 或 `"remote-windows"`。 |
| `models[exact].compatibility.transport` | `"standard"` | 用 `"codex-gateway"` 显式选择网关协议。 |
| `defaults.context.remoteCompaction.model` | `null` | 可选的检查点生成模型。 |
| `defaults.context.remoteCompaction.inputSource` | `"legacy"` | 与检查点来源绑定的输入策略。 |
| `defaults.context.remoteWindows.reminderThresholdPercent` | `5` | `0` 关闭提醒和窗口耗尽兜底。 |
| `defaults.webSearch.route` | `"unmanaged"` | Toolkit 搜索管理策略。 |
| `defaults.imageGeneration.enabled` | `false` | 全局生图开关。 |
| `defaults.imageGeneration.defaultModel` | `"gpt-image-2.5"` | 明确指定默认输出模型。 |
| `defaults.imageGeneration.allowedModels` | `["gpt-image-2.5"]` | 允许的输出模型，仅支持全局设置。 |
| `defaults.autoMode.available` | `false` | 是否允许开启工具审查。 |
| `defaults.autoMode.gate` | `"side-effect"` | 指定副作用工具，或 `"all"`。 |
| `defaults.autoMode.timeoutMs` | `30000` | 审查超时，单位为毫秒。 |
| `diagnostics.level` | `"info"` | `"debug"` 开启调试产物。 |
| `diagnostics.captureRequests` / `captureResponses` | `false` | 分别开启请求或压缩响应捕获。 |

使用 `/toolkit-config` 查看有效值及来源，`/toolkit-config validate` 查看文档问题，`/toolkit-config migration-preview` 预览只读的旧格式迁移候选。这些命令需要 UI，不查询网络或认证，不激活工具，也不写文件。选中配置不表示后端支持已验证。

未知 v2 策略键和畸形值会产生可见的分范围错误，不依赖调试模式。每个公开回调或工具执行及其等待的辅助操作使用同一份不可变快照，后续操作重新读取文件；独立 Pi 事件之间不保证原子事务。完整选项见[配置参考](docs/configuration.md)和[编辑器 schema](config.schema.json)。

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
