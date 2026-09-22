# pi-openai-toolkit

Add Codex context windows, Responses compaction, hosted tools, and tool-call review to Pi.

[![npm version](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![License: MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](LICENSE)

[简体中文](README.zh.md)

## Features

| Feature | Use it to |
| --- | --- |
| Codex Remote Context | Start new windows with the adapted Codex protocol and retrieve earlier work through `history`. |
| Remote Compaction v2 | Continue Responses sessions with encrypted server checkpoints. |
| Web Search | Choose local `pi-web-access`, Responses `web_search`, or experimental CPA `web_run` per model. |
| Image generation | Generate or edit images with the hosted Responses image tool. |
| Tool-call review | Have a reviewer model approve selected calls through Toolkit's approval gate. |

The package uses Pi's existing models, authentication, and sessions. It does not add a provider or model.

## Install

Requires Pi 0.87.0+ and Node.js 22.19.0+.

```bash
pi install npm:pi-openai-toolkit
```

Add `--local` for a project-local installation. Toolkit configuration is global in either case:

`~/.pi/agent/extensions/pi-openai-toolkit/config.json`

Create the file and parent directory if needed. Merge the Toolkit examples below into an existing **schema v2** config; do not replace unrelated settings. For an unversioned legacy config, run `/toolkit-config migration-preview` first. See the [migration guide](docs/configuration.md#legacy-compatibility-and-migration).

By default, eligible models use Remote Compaction v2. Remote Context windows, image generation, and Auto Mode are off; search is unmanaged. Backend support is still required.

## Quick start: enable Remote Context

For search, images, or tool-call review only, skip to [Common tasks](#common-tasks).

### Use Pi's built-in Codex provider

Sign in to Pi's `openai-codex` provider, then add this Toolkit config:

```json
{
  "schemaVersion": 2,
  "defaults": {
    "context": { "mode": "remote-windows" }
  }
}
```

Start Pi with a model ID from your Codex catalog:

```bash
pi --model openai-codex/<model-id>
```

Look for `new_context`, `get_context_remaining`, `history`, and `notes`. Their presence confirms activation, not backend compatibility. Earlier windows stay accessible through `history` without being loaded into every request.

### Use a compatible gateway

The gateway must support `openai-responses` and the Codex Remote Context protocol. Ordinary chat support is not enough.

If your model is already registered in `~/.pi/agent/models.json`, skip the registration example.

<details>
<summary>Register a gateway model in Pi</summary>

Merge this into Pi's models file. Replace the provider name, URL, key variable, model ID, and limits with your setup; the numbers are examples.

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

Set the key in PowerShell:

```powershell
$env:MY_GATEWAY_KEY = "replace-with-your-gateway-key"
```

Or in a POSIX shell:

```bash
export MY_GATEWAY_KEY="replace-with-your-gateway-key"
```

Start Pi from the same terminal.

</details>

Add the exact registered `provider/model-id` to Toolkit's config:

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

Check for the same context tools listed above. If they are missing, use `/toolkit-config` and check the notification, model key, API, credentials, and URL.

## Common tasks

### Save work and switch windows with `/compact`

In an active Remote Context session, run `/compact` to save work to notes and enter a new window without a conversation summary. You can append instructions to the command.

To use a separate checkpoint model, set `context.remoteCompaction.model` under `defaults` or an exact model override. It must support Remote Context on the same backend/account; leaving it unset uses the current model. Toolkit restores your original model and thinking level before continuing. See [context settings and requirements](docs/configuration.md#context).

### Use server-side compaction

Set `context.mode` to `"remote-compaction"` (the default) for encrypted Responses checkpoints, or `"pi"` to leave context management to Pi. Advanced input and fallback options are in the [configuration reference](docs/configuration.md#context).

### Choose a Web Search route

Set a default route and override it for individual models:

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

| Route | Behavior |
| --- | --- |
| `unmanaged` | Leave search to Pi and other extensions. |
| `local` | Keep the existing local `pi-web-access` tools. |
| `hosted` | Use Responses `web_search` with source annotations. |
| `standalone-alpha` | Use experimental `web_run` on a CPA/Codex gateway that supports `/alpha/search`. |

Toolkit does not fall back between routes. See [search configuration](docs/configuration.md#web-search) for backend requirements.

### Generate an image

Requires a Responses session and may incur provider charges. Enable it with an image model your provider supports:

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

Ask Pi to generate an image or edit explicitly supplied local references using `openai_generate_image`. The default model must be in `allowedModels`; image settings are global. See [image configuration](docs/configuration.md#images).

### Review tool calls automatically

Enable Auto Mode for a model and choose its reviewer:

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

Turn it on with `/auto on` or `--auto`, and off with `/auto off`. By default it reviews `bash`, `write`, `edit`, and configured extra tools; `gate: "all"` reviews every call. A reviewer timeout never approves a call. See [Auto Mode settings](docs/configuration.md#auto-mode).

## Common configuration

Use `defaults` for shared settings and `models["provider/model-id"]` for exact model overrides. Toolkit reads only the global config file.

| Command | Purpose |
| --- | --- |
| `/toolkit-config` | Show effective settings and their origins. |
| `/toolkit-config validate` | Check for configuration errors. |
| `/toolkit-config migration-preview` | Preview a legacy-to-v2 migration without writing files. |

These commands require Pi's interactive UI. See the [full configuration reference](docs/configuration.md), [editor schema](config.schema.json), and [implementation details](docs/internals.md).

## Development

After installing dependencies in the repository root:

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

## License

MIT © awoaCrim and contributors. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
