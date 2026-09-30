# pi-openai-toolkit

Add Codex context windows, Responses compaction, hosted tools, and tool-call review to Pi.

[![npm version](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![License: MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](LICENSE)

[简体中文](README.zh.md)

## Overview

Toolkit extends Pi with context management, hosted tools, image generation, and tool-call review. It keeps Pi's model, provider, authentication, and session setup intact. The global `config.json` below is the policy file for Toolkit features.

Requires Pi 0.87.0+ and Node.js 22.19.0+. v0.19.0 is adapted and verified for Pi 0.87.0 through 0.99.1 and later releases.

## Features

| Feature | What it does |
| --- | --- |
| Codex Remote Context | Switch to a new context window and retrieve earlier work through `history`. |
| Remote Compaction v2 | Continue Responses sessions with encrypted server checkpoints. |
| Web Search | Choose unmanaged, local, hosted, or standalone search per model. |
| Image generation | Generate or edit raster images through a separate Images API request. |
| Image input limits | Apply `inputLimits.images` resizing and per-message or per-request limits during compaction and replay. |
| Tool-call review | Ask a reviewer model to approve selected calls through Toolkit's approval gate. |

## Install

Toolkit requires Node.js 22.19.0+ and Pi 0.87.0 or later. Its configuration is global even when the extension is installed for one project:

`~/.pi/agent/extensions/pi-openai-toolkit/config.json`

Create the file and its parent directory when needed. New files use schema v2. For an existing unversioned file, run `/toolkit-config migration-preview` before editing it. See the [migration guide](docs/configuration.md#legacy-compatibility-and-migration).

## Quick start

Install Toolkit:

```bash
pi install npm:pi-openai-toolkit
```

Then add this policy to the Toolkit `config.json` to enable Codex Remote Context:

```json
{
  "schemaVersion": 2,
  "defaults": {
    "context": { "mode": "remote-windows" }
  }
}
```

Start Pi normally with the model and provider setup you already use. When Remote Context is ready, `new_context`, `get_context_remaining`, `history`, and `notes` appear in the session. `/compact` then saves the current work and starts a new window.

Remote Compaction v2 is the default context mode for eligible models. The configuration reference below covers other Toolkit features.

## Configuration reference

Toolkit reads only `~/.pi/agent/extensions/pi-openai-toolkit/config.json`. Use `defaults` for shared policy and `models["provider/model-id"]` for exact model overrides. Merge the fields you need into an existing v2 document instead of replacing unrelated settings.

The following example shows the complete v2 structure. Optional features are shown in their disabled state, so the file is a safe starting point. Change the relevant values when you enable a feature.

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

### Context management

`context.mode` selects the context strategy:

| Value | Behavior |
| --- | --- |
| `remote-compaction` | Use encrypted Responses checkpoints. This is the default for eligible models. |
| `remote-windows` | Use Codex context windows where the selected backend supports them. |
| `pi` | Leave context management to Pi. |

Set `context.remoteCompaction.model` when a separate checkpoint producer is needed. The producer must support the same context workflow as the active model. See [context settings and requirements](docs/configuration.md#context) for producer, fallback, and replay rules.

### Compatibility

`models["provider/model-id"].compatibility.transport` is `"standard"` by default. Set it to `"codex-gateway"` for an exact model that needs Toolkit's gateway protocol. Provider registration and endpoint setup remain in Pi; Toolkit reads the model and authentication that Pi has resolved. See the [provider-specific configuration notes](docs/configuration.md#provider-specific-responses-endpoints) when needed.

### Web Search

Set `webSearch.route` under `defaults` or an exact model:

| Route | Behavior |
| --- | --- |
| `unmanaged` | Leave search ownership to Pi and other extensions. |
| `local` | Keep the existing local `pi-web-access` tools. |
| `hosted` | Use Responses `web_search` with source annotations. |
| `standalone-alpha` | Use the experimental standalone search route. |

Toolkit keeps the selected route for the operation instead of switching to another one. See [search configuration](docs/configuration.md#web-search).

### Image generation and input limits

Image generation is global under `defaults.imageGeneration`:

- `enabled` turns the tool on or off.
- `defaultModel` selects the image model used when a request does not name one.
- `allowedModels` lists the image models the tool may use. The default must be in this list.

Image generation uses a separate Images API request, while the active conversation model continues to handle routing and authentication. PNG, JPEG, and WebP responses are validated and saved in their actual format. See [image configuration](docs/configuration.md#images).

Toolkit also honors the selected model's `inputLimits.images` metadata when rebuilding input for compaction or replay. It applies resize and count limits without mutating the persisted session or original provider payload.

### Tool-call review with Auto Mode

Place `autoMode` under `defaults` or an exact model. Set `available` to `true` to make the model eligible, then use `/auto on` or `--auto` to engage the gate. Use `/auto off` to turn it off.

The main settings are `reviewerModel`, `gate`, `extraTools`, and `timeoutMs`. The default side-effect gate reviews `bash`, `write`, `edit`, and configured extra tools. Set `gate` to `"all"` to review every tool. See [Auto Mode settings](docs/configuration.md#auto-mode).

### Diagnostics and migration

Use these commands to inspect and validate Toolkit configuration:

| Command | Purpose |
| --- | --- |
| `/toolkit-config` | Show effective settings and their sources. |
| `/toolkit-config validate` | Check configuration errors. |
| `/toolkit-config migration-preview` | Preview a legacy-to-v2 migration without writing files. |

Set global diagnostics under `diagnostics`. The [full configuration reference](docs/configuration.md) documents validation, migration, diagnostics, and all supported fields.

## Development

From the repository root, install dependencies and run the checks:

```bash
npm install
npm run typecheck
bun test
bun test ./test/pi-smoke.test.ts
npm pack --dry-run
```

## License

MIT © awoaCrim and contributors. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
