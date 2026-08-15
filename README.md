# pi-openai-toolkit

<p align="center">
  <strong>OpenAI-focused toolkit for <a href="https://github.com/badlogic/pi">Pi</a>: Native Remote Compaction v2 & Hosted Web Search</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README_zh.md">简体中文</a>
</p>

---

`pi-openai-toolkit` is an all-in-one OpenAI enhancement package for **Pi (>= 0.84.x)**. It bundles two high-performance extensions designed for OpenAI Responses endpoints:

1. **Remote Responses Compaction v2** (`extensions/compaction.ts`): Server-side opaque context compaction using the `remote_compaction_v2` SSE streaming protocol. Preserves context fidelity without lossy text re-summarization.
2. **Model-Scoped Web Search** (`extensions/web-search.ts`): Toolkit-owned hosted Web Search for an exact `provider/model-id` allowlist configured with `webSearch.models`, across the supported `openai-responses` and `openai-codex-responses` APIs.

## Installation

### Install via Pi Package Manager (recommended)

```bash
pi install npm:pi-openai-toolkit
```

### Git installation (alternative / development)

```bash
pi install git:github.com/awoaCrim/pi-openai-toolkit
```

### Local Development / Testing

Load the complete toolkit:

```bash
pi --no-extensions -e /absolute/path/to/pi-openai-toolkit
```

Or load a single extension independently:

```bash
# Compaction only
pi --no-extensions -e /absolute/path/to/pi-openai-toolkit/extensions/compaction.ts

# Web Search only
pi --no-extensions -e /absolute/path/to/pi-openai-toolkit/extensions/web-search.ts
```

> ⚠️ **Conflict Warning**: Do not run `pi-remote-compact`, `@lll9p/pi-better-compaction`, or standalone `pi-openai-web-search` alongside `pi-openai-toolkit`. Duplicate hooks cause race conditions and duplicated system prompts.

---

## Configuration

Configuration file location:

```text
~/.pi/agent/extensions/pi-openai-toolkit/config.json
```

### Example `config.json`

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

### Configuration Options

#### `compaction`

- `enabled` (*boolean*, default: `true`): Enable or disable Remote Compaction.
- `allowCompactionContinuityBreak` (*boolean*, default: `false`): When `true`, allows restarting a fresh native opaque compaction chain from Pi's current session text if the latest compaction was made by another strategy (e.g. text summary).
- `model` (*string | null*, default: `null`): Fallback model formatted as `provider/model-id` (e.g. `"openai/gpt-4o-mini"`) used if the remote compact gateway fails or when switching to non-Responses APIs. If `null`, uses the session's active model.
- `thinkingLevel` (*string*, default: `"off"`): Reasoning / thinking level passed to Pi native compaction fallback (`"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`).
- `responsesApis` (*string[]*): Narrow the supported remote compaction API identifiers (subset of `["openai-responses", "openai-codex-responses"]`).
- `notifyOnLoad` (*boolean*, default: `false`): Show a notification banner on Pi startup.
- `debug` (*boolean*, default: `false`): Output diagnostics and write execution artifacts to disk.
- `logProviderPayloads` / `logCompactResponses` (*boolean*, default: `false`): Write raw provider request payloads and compact SSE event bodies to artifacts.
- `redactSensitiveData` (*boolean*, default: `true`): Automatically redact Authorization headers, API keys, sensitive URL query tokens, and opaque `encrypted_content` ciphertext from debug artifacts.
- `artifactRoot` (*string*): Directory root for diagnostic artifacts. Relative paths resolve against the config directory.

#### `webSearch`

- `enabled` (*boolean*, default: `true`): Enable or disable native OpenAI Web Search injection.
- `models` (*string[]*): Exact `provider/model-id` allowlist. Toolkit Web Search is used only for listed models running on `openai-responses` or `openai-codex-responses`. An empty list disables toolkit Web Search for all models.

---

## Core Mechanics

### 1. Remote Compaction v2 Protocol

Instead of legacy JSON endpoints (`POST /responses/compact`), this toolkit implements the **`remote_compaction_v2`** protocol over standard streaming Responses:

```http
POST /responses
Content-Type: application/json

{
  "model": "...",
  "input": [
    ...currentResponsesInput,
    { "type": "compaction_trigger" }
  ],
  "stream": true,
  "store": false
}
```

- **Validation Criteria**: Must return a valid SSE stream with `response.completed` (status `completed`) containing exactly one output item of `type: "compaction"` with non-empty `encrypted_content`.
- **Zero Loss Replay**: The opaque encrypted item is stored in `CompactionEntry.details.compactedWindow`. On subsequent requests, it is transparently prepended after fresh preamble instructions alongside live turns, eliminating lossy text re-summaries.
- **Graceful Multi-Tier Fallback**:
  1. Compatible Responses endpoints &rarr; Remote v2 Opaque Compaction.
  2. Gateway failure or non-Responses model &rarr; Configured `compaction.model` fallback.
  3. Otherwise &rarr; Pi default native text compaction.

### 2. Model-Scoped Web Search

For allowlisted models using `openai-responses` or `openai-codex-responses`, the extension hooks into `before_provider_request` and `before_agent_start`:

- Injects `{ "type": "web_search" }` tool definition into the payload.
- Appends `web_search_call.action.sources` to the Responses `include` array.
- Appends concise search prompting to the system instructions.
- **Zero-Latency**: Uses Pi's existing connection, auth headers, and base URL without standalone HTTP overhead.
- **Toolkit Ownership**: For an eligible model, the outgoing payload removes the local function tool named `web_search` so native search is the only search path. Switching to an ineligible model restores that local tool's previous active state.

---

## Development & Testing

```bash
# Typecheck TypeScript definitions
npm run typecheck

# Run full test suite with Bun
bun test

# Run Pi integration smoke tests
npm run test:pi

# Dry-run package archive
npm pack --dry-run
```

---

## License & Acknowledgments

- Licensed under the **MIT License**. See [LICENSE](./LICENSE) for details.
- Native Web Search behavior was adapted from [`code-yeongyu/pi-openai-web-search`](https://github.com/code-yeongyu/pi-openai-web-search) (commit `39643380682f02f306b0de2673ff136c45ccc2a2`). See [NOTICE](./NOTICE).
- [LINUX DO](https://linux.do/) community.
