# pi-openai-toolkit

Add Codex context windows, Responses compaction, hosted tools, and reviewed tool calls to Pi.

[![npm version](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![License: MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](LICENSE)

[简体中文](README.zh.md)

## Features

| Feature | Use it to |
| --- | --- |
| Codex Remote Context | Start a new context window and retrieve earlier windows with `history`. |
| Remote Compaction v2 | Continue an eligible Responses session with an encrypted server checkpoint. |
| Hosted Web Search | Give selected models OpenAI's hosted search tool. |
| Image generation | Generate images or edit explicitly supplied local reference images. |
| Tool-call review | Ask a reviewer model whether selected tool calls may run. |

The package uses Pi's existing model, authentication, and session configuration. It does not add a provider or model.

## Install

Requires Pi 0.85.1 or newer and Node.js 22.19.0 or newer.

Install the extension:

```bash
pi install npm:pi-openai-toolkit
```

Use `--local` to install it in the current project.

Installing the package alone does not enable every feature. With no extension config, compaction is enabled but Remote Context is off, the Web Search model list is empty, image generation is disabled, and Auto Mode has no allowed models or reviewer.

The extension config file is:

`~/.pi/agent/extensions/pi-openai-toolkit/config.json`

All JSON configuration examples below, except the `models.json` example, go in this file. If it does not exist, create the file and its parent directory. If it already exists, merge fields into the matching objects and keep the other settings.

## Quick start: enable Remote Context

This section is for users who want Codex-style context windows. If you only want Web Search, image generation, or tool-call review, skip to [Common tasks](#common-tasks).

### Use Pi's built-in Codex provider

You must already be signed in to Pi's built-in `openai-codex` provider.

Create or merge this extension config:

```json
{
  "compaction": {
    "contextManagement": "remote"
  }
}
```

Start Pi with a model from your existing Codex catalog:

```bash
pi --model openai-codex/<model-id>
```

Replace `<model-id>` with the model ID shown by your Pi setup. The session is activated when `new_context`, `get_context_remaining`, `history`, and `notes` appear as available tools.

### Use a compatible gateway

This route requires the `openai-responses` API and a gateway that preserves the Codex protocol fields used by Remote Context. A successful ordinary chat request does not prove Remote Context compatibility.

If `~/.pi/agent/models.json` already contains a gateway model that meets these conditions, skip model configuration and set the extension allowlist directly. Otherwise, add or merge the provider entry below. Replace `my-gateway`, the URL, the environment variable name, and the model values with values from your setup. The numeric values shown are examples, not project defaults; they must match the actual model and gateway.

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

Set the referenced key before starting Pi. In PowerShell:

```powershell
$env:MY_GATEWAY_KEY = "replace-with-your-gateway-key"
```

In a POSIX shell:

```bash
export MY_GATEWAY_KEY="replace-with-your-gateway-key"
```

Use the same terminal session to start Pi. Create or merge the extension config, and make the allowlist entry exactly match the provider and model ID:

```json
{
  "compaction": {
    "contextManagement": "remote",
    "gatewayContextModels": ["my-gateway/gpt-5.6-luna"]
  }
}
```

Start Pi with the same model specification:

```bash
pi --model my-gateway/gpt-5.6-luna
```

The enablement check is the same: the session should expose `new_context`, `get_context_remaining`, `history`, and `notes`. If they do not appear, read the toolkit notification and check the exact provider/model string, API, key, base URL, and allowlist entry.

Earlier windows remain available through `history`, but they are not all automatically added to the current context.

## Common tasks

### Continue a session with server-side compaction

Leave Remote Context off when you want the Responses compaction path instead. Remote Compaction v2 stores and replays an encrypted checkpoint for eligible Responses models. Set `compaction.remoteCompactModel` only when the compaction request should use a separate model.

### Enable hosted Web Search

List exact model specifications under `webSearch.models`:

```json
{
  "webSearch": {
    "models": ["my-gateway/gpt-5.6-luna"]
  }
}
```

For those models, the extension replaces Pi's local `web_search` tool with OpenAI's hosted Responses search tool.

### Generate an image

Image generation requires a Responses session and may incur provider charges. Enable it with:

```json
{
  "imageGeneration": {
    "enabled": true,
    "models": ["gpt-image-2.5", "grok-imagine-image-2.0"]
  }
}
```

`models` contains the bare model IDs used by the nested Responses `image_generation` tool. The first entry is the default; `openai_generate_image` also accepts an optional `model` argument for a one-call override, but it must match a configured entry exactly. If `models` is omitted, the default is `gpt-image-2.5`. Empty or invalid lists are ignored with a warning and fall back to that default; set `enabled` to `false` to disable the tool. The provider or gateway must support the configured image model.

The `openai_generate_image` tool supports text-to-image requests and edits using explicitly supplied local reference images.

### Review tool calls automatically

Allow a model and reviewer in `autoMode`:

```json
{
  "autoMode": {
    "models": ["my-gateway/gpt-5.6-luna"],
    "reviewerModel": "my-gateway/gpt-5.6-luna"
  }
}
```

Use `/auto on` in the session. The default `side-effect` gate reviews `bash`, `write`, `edit`, and configured extra tools. Set `gate` to `"all"` when every tool call needs review. A reviewer timeout does not approve a call.

## Common configuration

The config file is `~/.pi/agent/extensions/pi-openai-toolkit/config.json`. Unknown keys are ignored with a warning. Most model lists use exact `provider/model-id` strings, not globs; `imageGeneration.models` is an exception and contains bare nested image-generation model IDs.

| Key | Default | Use |
| --- | --- | --- |
| `compaction.enabled` | `true` | Master switch for compaction. |
| `compaction.contextManagement` | `"off"` | Enables Codex Remote Context when set to `"remote"`. |
| `compaction.gatewayContextModels` | `[]` | Gateway models allowed to use Remote Context. |
| `compaction.remoteCompactModel` | unset | Optional model used only for a v2 compaction request. |
| `compaction.contextReminderThresholdPercent` | `5` | Remaining budget percentage for the once-per-window reminder. `0` disables the reminder and exhausted-window fallback. |
| `webSearch.models` | `[]` | Models that receive hosted Web Search. |
| `imageGeneration.enabled` | `false` | Enables `openai_generate_image`. |
| `imageGeneration.models` | `["gpt-image-2.5"]` | Bare image-generation model IDs; the first entry is the default. |
| `autoMode.models` | `[]` | Models allowed to use Auto Mode. |
| `autoMode.reviewerModel` | unset | Model that reviews Auto Mode calls. |
| `autoMode.gate` | `"side-effect"` | Use `"all"` to review every tool call. |
| `autoMode.timeoutMs` | `30000` | Review timeout in milliseconds. |

## Development

From the repository root, after dependencies are installed:

```bash
npm run typecheck    # Type-check
bun test             # Run tests
npm run test:pi      # Run the Pi smoke test
npm pack --dry-run   # Inspect the package contents
```

## License

MIT © awoaCrim and contributors. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
