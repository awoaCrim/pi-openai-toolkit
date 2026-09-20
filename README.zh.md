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
| 联网搜索路由 | 按精确模型路由选择本地 `pi-web-access`、Responses 托管 `web_search` 或 CPA standalone `web.run`。 |
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

只安装扩展不会自动启用所有功能。没有扩展配置时，压缩模块处于开启状态，但远程上下文关闭，联网搜索没有工具包选择的路由，图像生成关闭，自动模式也没有允许的模型和审查模型。

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

不配置 `compaction.remoteV2ContextSource` 时，Remote V2 保持原来的 `"legacy"` 输入链路：首次压缩使用 Pi 当前的 session context（最后才回退到事件提供的 preparation），递归压缩使用原始 branch tail。这会保留既有行为，但如果其他扩展改写消息，可能与 provider 实际看到的上下文不同。

将 `compaction.remoteV2ContextSource` 设为 `"pi-context-hook"` 可主动启用 Pi 0.85.1 runtime bridge，让 Remote V2 压缩使用与实时 provider 请求相同的有序 `context` hook 链。如果 Pi 无法提供这条公开 hook 路径，Remote V2 会取消压缩，而不会发送未投影的历史。只有检查点来源标记与当前设置一致时，才会继续回放。在两种模式之间切换后，必须重新创建 Remote V2 检查点；如果自定义状态必须保留在不透明检查点中，请关闭 Remote V2，或使用 Pi 原生压缩。

### 选择联网搜索路由

联网搜索有三条互斥路由。可以设置一个全局默认路由，也可以按精确的 `provider/model-id` 覆盖：

```json
{
  "webSearch": {
    "enabled": true,
    "defaultRoute": "hosted",
    "routes": {
      "uwoacrimson/gpt-6-astra": "standalone-alpha",
      "my-gateway/gpt-5.6-luna": "local"
    }
  }
}
```

路由选择是精确且确定的：`routes[provider/model-id]` 优先于 `defaultRoute`，`defaultRoute` 优先于旧版 `models` 列表。不支持通配符、模糊模型匹配、按模型名称猜能力、路由间 fallback 或重试。无效的路由值或模型键会告警后忽略，不会猜测路由；新旧字段重叠时会给出迁移告警。`enabled: false` 会释放工具包的工具所有权，并关闭工具包选择的全部三条路径。

- **`local`** 保留已经安装的 `pi-web-access` `web_search` 工具。如果它原本没有激活，工具包不会替你激活；同时不会添加托管 provider 工具或 `web.run`。
- **`hosted`** 移除名为 `web_search` 的本地 function，并注入原生 Responses `{ "type": "web_search" }` 工具和来源标注。旧版配置仍然有效：

  ```json
  {
    "webSearch": {
      "models": ["my-gateway/gpt-5.6-luna"]
    }
  }
  ```

  没有配置新路由字段时，只有精确命中该列表、且 API 属于现有 Responses 系列（`openai-responses` 或 `openai-codex-responses`）的模型会使用托管搜索。
- **`standalone-alpha`** 暴露一个 sequential 的 `web.run` 工具，并向 provider 相对的 `/alpha/search` 端点发送一次隔离的 `POST` 请求。例如基础地址是 `https://gateway.example/v1` 时，请求地址是 `https://gateway.example/v1/alpha/search`，不会变成 Responses 端点。支持的命令族包括 `search_query`、`image_query`、`open`、`click`、`find`、`screenshot`、`finance`、`weather`、`sports` 和 `time`；`response_length` 用于调整请求的结果长度。

standalone 路由属于实验性的 CPA/Codex 网关协议，不是稳定的公开 OpenAI Responses 端点。网关/provider 必须提供 `/alpha/search`、启用 `alpha-search` 能力，并支持 standalone web search（Codex provider 通常以 `supports_standalone_web_search = true` 表示）。请求会复用 Pi 当前模型、认证、provider headers、会话标识及 Codex/gateway affinity，不会切换当前模型。MVP 发送受边界限制的命令 envelope，而不是完整会话 transcript；`ref_id` 后续操作依赖 provider 的会话/引用处理；每次工具调用最多发送一次请求；配置无效、路由不可用、取消、超时、非 2xx、响应畸形或超限时都会 fail closed。

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

在会话中使用 `/auto on`，也可以用 `--auto` 启动 Pi。TUI 会显示自动模式已开启的提示；每次审查受控工具时，工作指示器会临时显示 `Auto mode: reviewing <tool>`，底部状态栏会保留当前审查范围。在支持兼容 tool renderer 的 Pi 版本中，自动模式下每个工具块底部都会显示一行状态：已审查的调用会显示 `allowed by reviewer · low risk · authorization medium` 或 `denied · <reason>`，不在当前审查范围内的调用会显示 `not reviewed · outside the configured gate`。如果当前 Pi 没有这个 renderer seam，扩展会告警一次并继续使用底部状态栏提示。默认的 `side-effect` 审查范围覆盖 `bash`、`write`、`edit` 和额外配置的工具。如果需要审查所有工具调用，将 `gate` 设置为 `"all"`。审查超时不会自动放行调用。

## 常用配置

配置文件为 `~/.pi/agent/extensions/pi-openai-toolkit/config.json`。未知键会告警后忽略。大多数模型列表必须使用精确的 `provider/model-id` 字符串，不支持通配符；`imageGeneration.models` 是例外，填写嵌套生图工具使用的裸模型 ID。

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `compaction.enabled` | `true` | 压缩功能总开关。 |
| `compaction.contextManagement` | `"off"` | 设置为 `"remote"` 后启用 Codex 远程上下文。 |
| `compaction.gatewayContextModels` | `[]` | 允许使用远程上下文的网关模型。 |
| `compaction.remoteCompactModel` | 未设置 | 仅用于 v2 压缩请求的可选模型。 |
| `compaction.remoteV2ContextSource` | `"legacy"` | 保留原来的原始 session/branch 输入路径。设置为 `"pi-context-hook"` 后才启用 Pi 的有序 context hook projection。检查点与模式绑定。 |
| `compaction.leaveManagedMode` | `"warn"` | 会话即将把整份持久 transcript（而不只是当前远程窗口）交给某个模型时的处理方式。`"warn"` 每个窗口与模型只提示一次；`"compact"` 在退役历史还超过该模型上下文窗口 80% 时额外先执行一次压缩——发生在切换模型时，或发生在仍排队着换窗裁剪的轮次结束时。print（`-p`）模式与没有排队裁剪的轮次只做提示，因为那种位置上的压缩无法跑完。 |
| `compaction.contextReminderThresholdPercent` | `5` | 每个窗口触发一次提醒的剩余预算百分比。设置为 `0` 会关闭提醒和窗口耗尽兜底。 |
| `webSearch.enabled` | `true` | 工具包联网搜索路由的总开关。设为 `false` 时不选择任何工具包路由。 |
| `webSearch.defaultRoute` | 未设置 | 默认路由：`local`、`hosted` 或 `standalone-alpha`。未设置时保留旧版行为。 |
| `webSearch.routes` | 未设置 | 精确的 `provider/model-id` 路由覆盖。精确条目优先于 `defaultRoute`。 |
| `webSearch.models` | `[]` | 旧版精确白名单；没有新路由字段时，列表中的 Responses 系列模型使用托管联网搜索。 |
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
