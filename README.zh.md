# pi-openai-toolkit

为 Pi 添加 Codex 上下文窗口、Responses 压缩、托管工具和工具调用审查。

[![npm 版本](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![许可证：MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](LICENSE)

[英文版](README.md)

## 功能

| 功能 | 用途 |
| --- | --- |
| Codex 远程上下文 | 切换到新上下文窗口，并通过 `history` 按需检索较早窗口。 |
| 远程压缩 v2 | 使用服务端返回的加密检查点继续符合条件的 Responses 会话。 |
| 托管联网搜索 | 为指定模型启用 OpenAI 托管的搜索工具。 |
| 图像生成 | 生成图片，或根据明确传入的本地参考图片进行编辑。 |
| 工具调用审查 | 在指定范围的工具调用执行前，由审查模型判断是否允许执行。 |

本包沿用 Pi 已有的模型、认证和会话配置，不新增提供商或模型。

## 安装

需要 Pi 0.85.1 或更高版本，以及 Node.js 22.19.0 或更高版本。

安装扩展：

```bash
pi install npm:pi-openai-toolkit
```

在当前项目中安装时，在命令后加上 `--local`。

只安装扩展不会自动启用所有功能。没有扩展配置时，压缩模块处于开启状态，但远程上下文关闭，联网搜索没有目标模型，图像生成关闭，自动模式也没有允许的模型和审查模型。

扩展配置文件位于：

`~/.pi/agent/extensions/pi-openai-toolkit/config.json`

下文除 `models.json` 示例外，其他 JSON 配置示例都写入此文件。文件不存在时，创建文件及所需目录；已有配置时，将字段合并到对应对象中，保留其他设置。

## 快速开始：启用远程上下文

本节适用于想使用 Codex 风格上下文窗口的用户。如果只需要联网搜索、图像生成或工具调用审查，请直接跳到[常见用法](#常见用法)。

### 使用 Pi 内置的 Codex 提供商

你需要先登录 Pi 内置的 `openai-codex` 提供商。

创建或合并扩展配置：

```json
{
  "compaction": {
    "contextManagement": "remote"
  }
}
```

使用已有 Codex 模型目录中的模型启动 Pi：

```bash
pi --model openai-codex/<model-id>
```

将 `<model-id>` 换成 Pi 配置中实际显示的模型 ID。会话中出现 `new_context`、`get_context_remaining`、`history` 和 `notes` 工具，说明扩展已经完成启用检查。

### 使用兼容网关

本路线要求使用 `openai-responses` 接口，并且网关保留远程上下文所需的 Codex 协议字段。普通对话请求成功，不代表已经验证远程上下文兼容性。

如果 `~/.pi/agent/models.json` 中已有符合上述条件的网关模型，可以跳过模型配置，直接设置扩展白名单。否则，先添加或合并下面的提供商配置。请把 `my-gateway`、地址、环境变量名称和模型字段替换成实际值。示例中的数字只是示意值，不是项目默认值，必须改成符合实际模型与网关能力的上下文窗口和最大输出 token 数。

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

在启动 Pi 之前设置配置中引用的密钥。PowerShell 使用：

```powershell
$env:MY_GATEWAY_KEY = "replace-with-your-gateway-key"
```

POSIX shell 使用：

```bash
export MY_GATEWAY_KEY="replace-with-your-gateway-key"
```

使用同一个终端启动 Pi。创建或合并扩展配置，并确保白名单条目与提供商名称和模型 ID 完全一致：

```json
{
  "compaction": {
    "contextManagement": "remote",
    "gatewayContextModels": ["my-gateway/gpt-5.6-luna"]
  }
}
```

使用相同的模型标识启动 Pi：

```bash
pi --model my-gateway/gpt-5.6-luna
```

启用检查方式相同：会话中应该出现 `new_context`、`get_context_remaining`、`history` 和 `notes`。如果没有出现，先查看工具包通知，再检查提供商和模型字符串、接口、密钥、基础 URL 和白名单条目。

较早窗口的历史仍可通过 `history` 检索和读取，但不会全部自动加入当前上下文。

## 常见用法

### 使用服务端压缩继续会话

如果希望使用 Responses 压缩路径，就保持远程上下文关闭。远程压缩 v2 会为符合条件的 Responses 模型保存并回放加密检查点。只有在压缩请求需要使用其他模型时，才设置 `compaction.remoteCompactModel`。

### 启用托管联网搜索

在 `webSearch.models` 中填写精确的模型标识：

```json
{
  "webSearch": {
    "models": ["my-gateway/gpt-5.6-luna"]
  }
}
```

对于这些模型，扩展会用 OpenAI 托管的 Responses 搜索工具替代 Pi 本地的 `web_search` 工具。

### 生成图片

图像生成需要 Responses 会话，并且可能产生服务商费用。启用方式如下：

```json
{
  "imageGeneration": {
    "enabled": true,
    "models": ["gpt-image-2.5", "grok-imagine-image-2.0"]
  }
}
```

`models` 填写嵌套 Responses `image_generation` 工具使用的裸模型 ID。列表第一项是默认模型；`openai_generate_image` 也支持通过可选的 `model` 参数在单次调用中切换，但该值必须与配置列表中的某一项完全一致。省略 `models` 时默认使用 `gpt-image-2.5`。列表为空或格式无效时会告警并回退到默认模型；如果要关闭工具，将 `enabled` 设置为 `false`。服务商或网关必须实际支持配置的生图模型。

`openai_generate_image` 支持文生图，也支持使用明确传入的本地参考图片进行编辑。

### 启用工具调用自动审查

在 `autoMode` 中设置允许使用的模型和审查模型：

```json
{
  "autoMode": {
    "models": ["my-gateway/gpt-5.6-luna"],
    "reviewerModel": "my-gateway/gpt-5.6-luna"
  }
}
```

在会话中使用 `/auto on`。默认的 `side-effect` 审查范围覆盖 `bash`、`write`、`edit` 和额外配置的工具。如果需要审查所有工具调用，将 `gate` 设置为 `"all"`。审查超时不会自动放行调用。

## 常用配置

配置文件为 `~/.pi/agent/extensions/pi-openai-toolkit/config.json`。未知键会告警后忽略。大多数模型列表必须使用精确的 `provider/model-id` 字符串，不支持通配符；`imageGeneration.models` 是例外，填写嵌套生图工具使用的裸模型 ID。

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `compaction.enabled` | `true` | 压缩功能总开关。 |
| `compaction.contextManagement` | `"off"` | 设置为 `"remote"` 后启用 Codex 远程上下文。 |
| `compaction.gatewayContextModels` | `[]` | 允许使用远程上下文的网关模型。 |
| `compaction.remoteCompactModel` | 未设置 | 仅用于 v2 压缩请求的可选模型。 |
| `compaction.contextReminderThresholdPercent` | `5` | 每个窗口触发一次提醒的剩余预算百分比。设置为 `0` 会关闭提醒和窗口耗尽兜底。 |
| `webSearch.models` | `[]` | 使用托管联网搜索的模型。 |
| `imageGeneration.enabled` | `false` | 启用 `openai_generate_image`。 |
| `imageGeneration.models` | `["gpt-image-2.5"]` | 裸生图模型 ID；列表第一项是默认模型。 |
| `autoMode.models` | `[]` | 允许使用自动模式的模型。 |
| `autoMode.reviewerModel` | 未设置 | 审查自动模式调用的模型。 |
| `autoMode.gate` | `"side-effect"` | 设置为 `"all"` 后审查所有工具调用。 |
| `autoMode.timeoutMs` | `30000` | 审查超时时间，单位为毫秒。 |

## 开发

在仓库根目录安装依赖后运行：

```bash
npm run typecheck    # 类型检查
bun test             # 运行测试
npm run test:pi      # 运行 Pi 冒烟测试
npm pack --dry-run   # 检查发布包内容
```

## 许可证

MIT © awoaCrim 与贡献者。见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
