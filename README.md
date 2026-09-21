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
| Web Search routes | Choose local `pi-web-access`, hosted Responses `web_search`, or CPA standalone `web_run` per exact model route. |
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

Installing the package alone does not enable every feature. With no extension config, compaction is enabled but Remote Context is off, Web Search has no toolkit-selected route, image generation is disabled, and Auto Mode has no allowed models or reviewer.

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

When `compaction.remoteV2ContextSource` is omitted, Remote V2 keeps the original `"legacy"` input chain: first compaction uses Pi's current session context (or the supplied preparation as a last resort), and recursive compaction uses the raw branch tail. This preserves existing behavior, but can diverge from provider-visible context when other extensions rewrite messages.

Set `compaction.remoteV2ContextSource` to `"pi-context-hook"` to opt into the Pi 0.85.1 runtime bridge. The toolkit then uses the same ordered `context` hook chain as the live provider request. If Pi cannot expose that public hook path, Remote V2 cancels instead of sending an unprojected history. Checkpoint replay is accepted only when its source marker matches the current setting. Switching between the two modes requires a new Remote V2 checkpoint; disable Remote V2 or use Pi's native compaction when custom-only state must survive inside the opaque checkpoint.

### Choose a Web Search route

Web Search has three mutually exclusive routes. Configure one global default and, when needed, exact `provider/model-id` overrides:

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

Route selection is exact and deterministic: `routes[provider/model-id]` wins over `defaultRoute`; `defaultRoute` wins over the legacy `models` list. There is no wildcard, fuzzy model matching, capability guessing, fallback, or retry between routes. Invalid route values/keys are ignored with warnings rather than guessed, and overlapping new/legacy fields produce migration warnings. `enabled: false` releases toolkit ownership and disables all three toolkit-selected paths.

- **`local`** keeps the already-installed `pi-web-access` `web_search` tool. The toolkit does not activate it when it was not active, and it does not add a hosted provider tool or `web_run`.
- **`hosted`** removes the local function named `web_search` and injects the native Responses `{ "type": "web_search" }` tool plus source annotations. The legacy configuration remains valid:

  ```json
  {
    "webSearch": {
      "models": ["my-gateway/gpt-5.6-luna"]
    }
  }
  ```

  With no new route fields, only models in this exact list and the existing Responses-family APIs (`openai-responses` or `openai-codex-responses`) use hosted search.
- **`standalone-alpha`** exposes one sequential `web_run` tool and sends one isolated `POST` request to the provider-relative `/alpha/search` endpoint. A base URL such as `https://gateway.example/v1` therefore receives `https://gateway.example/v1/alpha/search`, not a Responses endpoint. Supported command families are `search_query`, `image_query`, `open`, `click`, `find`, `screenshot`, `finance`, `weather`, `sports`, and `time`; `response_length` controls the requested result size.

The standalone route is an experimental CPA/Codex gateway protocol, not a stable public OpenAI Responses endpoint. The gateway/provider must expose `/alpha/search`, enable its `alpha-search` capability, and support standalone web search (Codex providers commonly expose this as `supports_standalone_web_search = true`). The request reuses Pi's current model, authentication, provider headers, session identity, and Codex/gateway affinity; it does not change the active model. The MVP sends the bounded command envelope rather than the full conversation transcript, relies on provider session/reference handling for `ref_id` follow-ups, makes at most one request per tool call, and fails closed on invalid configuration, unavailable routes, cancellation, timeout, non-2xx, malformed, or oversized responses.

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

Use `/auto on` in the session, or start Pi with `--auto`. The TUI shows an activation notice and temporarily changes the working indicator to `Auto mode: reviewing <tool>` while a gated call is being reviewed; the footer keeps the active gate visible. On Pi versions that expose the compatible tool renderer, each tool block in Auto Mode also gets a bottom line: reviewed calls show states such as `allowed by reviewer · low risk · authorization medium` or `denied · <reason>`, while calls outside the configured gate show `not reviewed · outside the configured gate`. If that renderer seam is unavailable, the extension warns once and keeps the footer-only status. The default `side-effect` gate reviews `bash`, `write`, `edit`, and configured extra tools. Set `gate` to `"all"` when every tool call needs review. A reviewer timeout does not approve a call.

## Common configuration

The config file is `~/.pi/agent/extensions/pi-openai-toolkit/config.json`. Unknown keys are ignored with a warning. Most model lists use exact `provider/model-id` strings, not globs; `imageGeneration.models` is an exception and contains bare nested image-generation model IDs.

| Key | Default | Use |
| --- | --- | --- |
| `compaction.enabled` | `true` | Master switch for compaction. |
| `compaction.contextManagement` | `"off"` | Enables Codex Remote Context when set to `"remote"`. |
| `compaction.gatewayContextModels` | `[]` | Gateway models allowed to use Remote Context. |
| `compaction.remoteCompactModel` | unset | Optional model used only for a v2 compaction request. |
| `compaction.remoteV2ContextSource` | `"legacy"` | Preserve the original raw session/branch input path. Set `"pi-context-hook"` to opt into Pi's ordered context-hook projection. Checkpoints are mode-specific. |
| `compaction.leaveManagedMode` | `"warn"` | What to do when a session is about to hand a model the whole durable transcript instead of its remote window. `"warn"` notices once per window and model; `"compact"` additionally runs a compaction when the retired history also passes 80% of that model's context window - on a model switch, or at the end of a turn that still has a queued rollover trim. Print (`-p`) runs and turns without a queued trim stay at the warning, because a compaction started there cannot finish. |
| `compaction.contextReminderThresholdPercent` | `5` | Remaining budget percentage for the once-per-window reminder. `0` disables the reminder and exhausted-window fallback. |
| `webSearch.enabled` | `true` | Total switch for the toolkit's Web Search route selection. `false` selects no toolkit route. |
| `webSearch.defaultRoute` | unset | Default route: `local`, `hosted`, or `standalone-alpha`. Unset preserves legacy behavior. |
| `webSearch.routes` | unset | Exact `provider/model-id` to route overrides. Exact entries take precedence over `defaultRoute`. |
| `webSearch.models` | `[]` | Legacy exact allowlist; without the new route fields, listed Responses-family models receive hosted Web Search. |
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
