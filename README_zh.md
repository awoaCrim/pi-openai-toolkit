# pi-openai-toolkit

<p align="center">
  <strong>专为 <a href="https://github.com/badlogic/pi">Pi</a> 打造的 OpenAI 全功能增强工具包：远端无损压缩 v2 & 原生托管联网搜索</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README_zh.md">简体中文</a>
</p>

---

`pi-openai-toolkit` 是专为 **Pi (>= 0.84.x)** 打造的 OpenAI 全功能增强工具包，集成了两项针对 OpenAI Responses 协议的核心扩展：

1. **远端无损压缩 (Remote Compaction v2)** (`extensions/compaction.ts`): 基于 `remote_compaction_v2` SSE 流式协议实现的服务端密文无损会话压缩，彻底告别会话变长后丢失细节的文本二次摘要。
2. **按模型启用的联网搜索** (`extensions/web-search.ts`): 通过 `webSearch.models` 精确匹配 `provider/model-id`，由 Toolkit 为符合条件的 `openai-responses` 与 `openai-codex-responses` 会话提供并拥有原生联网搜索。

## 安装使用

### 通过 Pi 安装 (推荐)

```bash
pi install npm:pi-openai-toolkit
```

### Git 安装（替代 / 开发路径）

```bash
pi install git:github.com/awoaCrim/pi-openai-toolkit
```

### 本地开发与调试加载

加载完整工具包：

```bash
pi --no-extensions -e /本地绝对路径/pi-openai-toolkit
```

或单独加载某一子扩展：

```bash
# 仅加载远端压缩
pi --no-extensions -e /本地绝对路径/pi-openai-toolkit/extensions/compaction.ts

# 仅加载原生联网搜索
pi --no-extensions -e /本地绝对路径/pi-openai-toolkit/extensions/web-search.ts
```

> ⚠️ **冲突提示**：请勿同时启用 `pi-remote-compact`、`@lll9p/pi-better-compaction` 或独立的 `pi-openai-web-search`。多重钩子会产生竞态或注入重复的 System Prompt。

---

## 配置文件说明

全局唯一配置路径：

```text
~/.pi/agent/extensions/pi-openai-toolkit/config.json
```

### 配置示例

```json
{
  "compaction": {
    "enabled": true,
    "allowCompactionContinuityBreak": false,
    "model": null,
    "thinkingLevel": "off",
    "responsesApis": [
      "openai-responses",
      "openai-codex-responses"
    ],
    "notifyOnLoad": false,
    "debug": false,
    "logProviderPayloads": false,
    "logCompactResponses": false,
    "redactSensitiveData": true,
    "artifactRoot": "~/.pi/agent/artifacts/pi-openai-toolkit/compaction"
  },
  "webSearch": {
    "enabled": true,
    "models": [
      "uwoacrimson/gpt-5.6-luna"
    ]
  }
}
```

### 配置参数详解

#### `compaction`（压缩配置）

- `enabled` (*boolean*, 默认 `true`): 是否启用远端无损压缩。
- `allowCompactionContinuityBreak` (*boolean*, 默认 `false`): 若最近一次历史压缩由其他方式（如文本摘要）生成，设为 `true` 允许直接从当前有效文本上下文重建密文压缩链。
- `model` (*string | null*, 默认 `null`): 降级模型，格式为 `"provider/model-id"`（例如 `"openai/gpt-4o-mini"`）。当网关不支持远端压缩或切换到非 Responses 协议模型时使用。为 `null` 时使用当前会话模型。
- `thinkingLevel` (*string*, 默认 `"off"`): 降级模型调用 Pi 原生压缩时的思考级别（`"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`）。
- `responsesApis` (*string[]*): 允许尝试远端压缩的 API 标识符子集（从 `["openai-responses", "openai-codex-responses"]` 中选定）。
- `notifyOnLoad` (*boolean*, 默认 `false`): Pi 启动加载时是否弹出气泡提示。
- `debug` (*boolean*, 默认 `false`): 是否开启调试模式并记录诊断日志。
- `logProviderPayloads` / `logCompactResponses` (*boolean*, 默认 `false`): 是否在 Artifacts 中记录完整的 Provider 请求与 SSE 流事件体。
- `redactSensitiveData` (*boolean*, 默认 `true`): 自动对日志中的 Authorization 请求头、API Key、URL 敏感参数及 `encrypted_content` 密文进行脱敏处理（替换为 `[REDACTED]`）。
- `artifactRoot` (*string*): 诊断日志存储根目录，支持 `~/` 路径。

#### `webSearch`（联网搜索配置）

- `enabled` (*boolean*, 默认 `true`): 是否启用原生 OpenAI 联网搜索注入。
- `models` (*string[]*): 精确的 `provider/model-id` 模型白名单。只有列表中的模型在 `openai-responses` 或 `openai-codex-responses` 端点上运行时，才会使用 Toolkit Web Search。空列表表示所有模型都不启用 Toolkit Web Search。

---

## 核心工作原理解析

### 1. Remote Compaction v2（远端密文压缩）

摒弃了老旧且不稳定的 `POST /responses/compact` JSON 端点，采用最新 **`remote_compaction_v2`** 标准流式协议：

```http
POST /responses
Content-Type: application/json

{
  "model": "...",
  "input": [
    ...当前会话输入上下文,
    { "type": "compaction_trigger" }
  ],
  "stream": true,
  "store": false
}
```

- **校验标准**：接收 SSE 流并验证 `response.completed` 事件（状态为 `completed`），且返回且仅返回一个包含非空 `encrypted_content` 密文的 `type: "compaction"` 数据块。
- **无损重放机制**：密文数据完整存入 `CompactionEntry.details.compactedWindow`。在后续对话中，插件会自动将密文插入在最新的系统指令之后与最新几轮消息之前，实现完全服务端无损上下文还原。
- **三级优雅降级**：
  1. 支持的 Responses 端点 &rarr; 触发 Remote v2 密文无损压缩；
  2. 网关不支持或报错 &rarr; 降级调用用户指定的 `compaction.model`；
  3. 未配置降级模型 &rarr; 回退至 Pi 默认的当前模型摘要压缩。

### 2. 按模型启用的联网搜索

对于白名单中的 `openai-responses` 或 `openai-codex-responses` 模型，扩展直接拦截请求载荷：

- 自动向 `tools` 注入 `{ "type": "web_search" }`；
- 自动向 `include` 数组追加 `web_search_call.action.sources`；
- 注入规范、去重的搜索引导 System Prompt；
- **零额外网络延迟**：复用 Pi 当前活跃的 Provider 配置、认证凭据与 Base URL；
- **Toolkit 接管搜索**：对于符合条件的模型，发给 Provider 的载荷会移除名为 `web_search` 的本地 Function Tool，只保留原生搜索；切换到不符合条件的模型后，会恢复该本地工具原先的 active 状态。

---

## 测试与验证

```bash
# 类型检查
npm run typecheck

# 单元与集成测试 (Bun)
bun test

# Pi 冒烟测试
npm run test:pi
```

---

## 开源协议与致谢

- 本项目基于 **MIT 许可证** 开源，详情见 [LICENSE](./LICENSE)。
- 原生联网搜索特性逻辑参考并演进自 [`code-yeongyu/pi-openai-web-search`](https://github.com/code-yeongyu/pi-openai-web-search)（Commit `39643380682f02f306b0de2673ff136c45ccc2a2`）。详细版权声明与 MIT 许可授权请参阅 [NOTICE](./NOTICE)。
- [LINUX DO](https://linux.do/) community.
