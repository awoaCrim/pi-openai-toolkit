# pi-openai-toolkit

<p align="center">
  <strong>专为 <a href="https://github.com/badlogic/pi">Pi</a> 打造的 OpenAI 全功能增强工具包：远端无损压缩 v2、原生托管联网搜索与实时思考翻译</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README_zh.md">简体中文</a>
</p>

---

`pi-openai-toolkit` 是专为 **Pi (>= 0.84.x)** 打造的 OpenAI 全功能增强工具包，集成了三个可独立加载的扩展：

1. **远端无损压缩 (Remote Compaction v2)** (`extensions/compaction.ts`): 基于 `remote_compaction_v2` SSE 流式协议实现的服务端密文无损会话压缩，彻底告别会话变长后丢失细节的文本二次摘要。
2. **按模型启用的联网搜索** (`extensions/web-search.ts`): 通过 `webSearch.models` 精确匹配 `provider/model-id`，由 Toolkit 为符合条件的 `openai-responses` 与 `openai-codex-responses` 会话提供并拥有原生联网搜索。
3. **实时思考翻译** (`extensions/reasoning-translation.ts`): 仅在 TUI 展示层把流式 thinking/reasoning 分段翻译为目标语言。它使用独立配置的翻译模型，不修改 assistant 消息、会话原文或主模型上下文。

## 安装使用

### 全局安装已发布版本（推荐）

```bash
pi install npm:pi-openai-toolkit
```

该命令会把工具包加入 Pi 的全局配置。可以使用以下命令确认安装成功：

```bash
pi list
```

如果只想安装到当前项目，使用：

```bash
pi install npm:pi-openai-toolkit --local
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

# 仅加载实时思考翻译
pi --no-extensions -e /本地绝对路径/pi-openai-toolkit/extensions/reasoning-translation.ts
```

> ⚠️ **冲突提示**：请勿同时启用 `pi-remote-compact`、`@lll9p/pi-better-compaction` 或独立的 `pi-openai-web-search`。多重钩子会产生竞态或注入重复的 System Prompt。

---

## 配置文件说明

全局唯一配置路径：

```text
~/.pi/agent/extensions/pi-openai-toolkit/config.json
```

Windows 下对应：

```text
C:\Users\<user>\.pi\agent\extensions\pi-openai-toolkit\config.json
```

### 配置示例

```json
{
  "compaction": {
    "enabled": true,
    "allowCompactionContinuityBreak": false,
    "remoteCompactModel": "uwoacrimson/gpt-5.6-luna",
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
  },
  "reasoningTranslation": {
    "enabled": true,
    "models": [
      "uwoacrimson/gpt-5.6-luna"
    ],
    "model": "openai/gpt-4o-mini",
    "targetLanguage": "Simplified Chinese"
  }
}
```

### 配置参数详解

#### `compaction`（压缩配置）

- `enabled` (*boolean*, 默认 `true`): 是否启用远端无损压缩。
- `allowCompactionContinuityBreak` (*boolean*, 默认 `false`): 若最近一次历史压缩由其他方式（如文本摘要）生成，设为 `true` 允许直接从当前有效文本上下文重建密文压缩链。
- `remoteCompactModel` (*string | null*, 默认 `null`): 仅用于 synthetic `remote_compaction_v2` 请求的模型，格式为 `"provider/model-id"`。Pi 不会切换当前会话模型，压缩完成后仍由原模型继续正常请求。覆盖模型必须与当前模型使用相同的 Provider、Responses API 标识符和实际生效的 Base URL。为 `null` 时保持当前模型执行远端压缩的原有行为。
- `model` (*string | null*, 默认 `null`): 独立的原生文本摘要降级模型，格式为 `"provider/model-id"`（例如 `"openai/gpt-4o-mini"`）。当 Remote v2 不可用或失败时使用；为 `null` 时进入 Pi 默认的当前模型压缩路径。
- `thinkingLevel` (*string*, 默认 `"off"`): 降级模型调用 Pi 原生压缩时的思考级别（`"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`）。
- `responsesApis` (*string[]*): 允许尝试远端压缩的 API 标识符子集（从 `["openai-responses", "openai-codex-responses"]` 中选定）。
- `notifyOnLoad` (*boolean*, 默认 `false`): Pi 启动加载时是否弹出气泡提示。
- `debug` (*boolean*, 默认 `false`): 是否开启调试模式并记录诊断日志。
- `logProviderPayloads` / `logCompactResponses` (*boolean*, 默认 `false`): 是否在 Artifacts 中记录完整的 Provider 请求与 SSE 流事件体。
- `redactSensitiveData` (*boolean*, 默认 `true`): 对调试日志应用完整的敏感值脱敏。即使设为 `false`，Authorization 凭据、API Key/Token 和 `encrypted_content` 密文也始终会被替换为 `[REDACTED]`。
- `artifactRoot` (*string*): 诊断日志存储根目录，支持 `~/` 路径。

#### `webSearch`（联网搜索配置）

- `enabled` (*boolean*, 默认 `true`): 是否启用原生 OpenAI 联网搜索注入。
- `models` (*string[]*): 精确的 `provider/model-id` 模型白名单。只有列表中的模型在 `openai-responses` 或 `openai-codex-responses` 端点上运行时，才会使用 Toolkit Web Search。空列表表示所有模型都不启用 Toolkit Web Search。

#### `reasoningTranslation`（实时思考翻译配置）

- `enabled` (*boolean*, 默认 `true`): 是否启用展示层思考翻译。
- `models` (*string[]*): 主模型的精确 `provider/model-id` 白名单。空列表表示不翻译任何模型。
- `model` (*string | null*, 默认 `null`): 独立的翻译模型，格式为 `provider/model-id`。它不会被设置为 Pi 当前模型，翻译请求也不会启用 thinking/reasoning。
- `targetLanguage` (*string*, 默认 `"Simplified Chinese"`): 传给翻译模型的目标语言名称，可以改为其他自然语言。

实时思考翻译只在 Pi 交互式 **TUI** 模式运行，并且要求 Pi 没有全局隐藏 thinking 区域。扩展监听流式 `thinking_delta`，优先在句号、问号、分号或换行处分段；没有自然边界时约每 400 个 UTF-16 字符切分，空闲约 800 ms 或收到 `thinking_end` 时刷新尾部。翻译请求严格按 FIFO 单并发执行，不会因为响应速度不同而乱序。

替换只发生在 TUI 的 Markdown 展示层。session 中的原始 assistant thinking、后续 Provider payload、LLM 上下文和压缩输入都保持不变；扩展不会注册 Function Tool，也不会向主模型发送 custom message。已完成的展示映射会作为不可见的 custom entry 保存，恢复 session 或切换会话树后可以继续替换对应原文。RPC、JSON 与 print 模式不会调用翻译模型，也不会改变 Pi 原始输出。

翻译会增加额外延迟和模型费用。翻译模型未配置、认证失败、模型不存在、超时、限流、空输出或某个分段失败时，主模型响应仍会继续；失败分段精确回退为原文，后续分段继续处理。中止、切换模型/会话、扩展重载或退出时会取消当前队列并忽略迟到结果。

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
- **远端压缩模型覆盖**：`compaction.remoteCompactModel` 可以让同一网关上的另一个 Responses 模型负责生成 checkpoint，而当前活动模型仍是 checkpoint 的消费者。synthetic 压缩请求会使用覆盖模型在注册表中的模型元数据、认证、请求头和实际 Base URL；旧 checkpoint、递归压缩 checkpoint 都仍由当前活动模型重放。
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

### 3. 实时思考翻译

该扩展与压缩、联网搜索彼此独立：只注册生命周期监听器和一个同步 Markdown transformer，不注册 Function Tool，也不改写主模型的 Provider request。翻译直接调用配置模型所属 Provider 的 `streamSimple()`，因此不会切换当前模型，也不会递归触发 Toolkit 的其他请求钩子。每个分段完成后通过 Pi 公共的 `setHiddenThinkingLabel()` 触发展示刷新，继续使用 Pi 原有 thinking 容器的颜色、斜体和折叠行为。

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
