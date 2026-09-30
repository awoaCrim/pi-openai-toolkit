# pi-openai-toolkit

Remote context windows, Responses compaction, web search, image generation, and tool-call review for Pi. Uses Pi's existing models, endpoints, authentication, and sessions without registering another provider or model.

[![npm version](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](LICENSE)

[简体中文](README.zh.md)

## Install and start

Requires Node.js **22.19.0+** and Pi **0.87.0+**. Current development dependencies pin Pi **0.99.1**; backend features also depend on the selected model, API, and account access.

```bash
pi install npm:pi-openai-toolkit
```

Configure your model and credentials in Pi, then start Pi normally. Without a Toolkit config file, eligible models use remote compaction by default. Search remains managed by Pi and other extensions; image generation and Auto Mode are off.

Toolkit reads one global configuration file, even for a project-local installation:

```text
~/.pi/agent/extensions/pi-openai-toolkit/config.json
```

Create the parent directory if needed. New configurations use schema v2:

```json
{
  "schemaVersion": 2,
  "defaults": {
    "context": { "mode": "remote-compaction" }
  }
}
```

Check the configuration from Pi:

- `/toolkit-config`: show effective values and their sources
- `/toolkit-config validate`: check configuration errors
- `/toolkit-config migration-preview`: preview a legacy migration without writing files

Settings resolve in this order: built-in defaults → `defaults` → `models["provider/model-id"]`. Model keys are exact and case-sensitive; wildcards and project-level policy are not supported. Merge the examples below into your existing file without replacing unrelated settings. For an unversioned configuration, read the [migration guide](docs/configuration.md#legacy-compatibility-and-migration) first.

## Context management

Set `defaults.context.mode` or an individual model's `context.mode`:

- `remote-compaction`: the default; continue with encrypted checkpoints returned by the server
- `remote-windows`: use Codex remote context windows, retrieve earlier work with `history`, and save handoff notes with `notes`
- `pi`: leave context management to Pi

**Remote compaction** accepts the `openai-responses`, `openai-codex-responses`, and `azure-openai-responses` API types. The backend must still support the checkpoint protocol. Set `context.remoteCompaction.model` to use a separate compaction model; remote compaction requires the same effective base URL as the active model. Native summary fallback has separate settings and does not apply to every failure: empty checkpoints, incompatible provenance, or edits to sealed history block storage or replay. See [context settings](docs/configuration.md#context) and [checkpoint rules](docs/internals.md#remote-compaction-v2-wire-contract).

**Remote windows** require the native `openai-codex` provider with `openai-codex-responses`, or an `openai-responses` gateway implementing the protocol. Gateways require `compatibility.transport: "codex-gateway"` on the exact model entry. This setting does not add the capability to an ordinary compatible endpoint.

Change `mode` in the example above to `remote-windows`. Eligible sessions expose `new_context`, `get_context_remaining`, `history`, and `notes`. Manual `/compact [instructions]` starts a checkpoint handoff: write notes successfully, then switch windows. Models without window capability retain the compaction flow; a failed window activation does not silently switch to a summary.

Remote windows use alpha endpoints that may change upstream. When switching models, also watch for retired-window history that has not yet been trimmed. See the [window lifecycle](docs/internals.md#rollover-lifecycle).

## Search, images, and tool review

### Web search

Set `defaults.webSearch.route` or an exact model's `webSearch.route`:

- `unmanaged`: the default; leave search ownership alone. This does not disable network access
- `local`: retain existing local search tools, such as `pi-web-access`; do not install or activate previously inactive tools
- `hosted`: use Responses `web_search` with source annotations and suppress conflicting local search tools
- `standalone-alpha`: experimental `web_run`, using a separate `/alpha/search` request for searches, page opening, and related operations

`hosted` accepts the three Responses API types listed above, subject to backend support and account access. `standalone-alpha` is restricted to verified OpenAI/Codex routes; a gateway must expose the endpoint and capability. An unavailable route, missing authentication, or a tool conflict never causes an automatic switch to another route. See [search configuration](docs/configuration.md#web-search) for supported operations.

### Image generation

Image settings belong only under global `defaults.imageGeneration`. Replace `image-model-id` with an image model your backend supports:

```json
{
  "schemaVersion": 2,
  "defaults": {
    "imageGeneration": {
      "enabled": true,
      "defaultModel": "image-model-id",
      "allowedModels": ["image-model-id"]
    }
  }
}
```

Eligible sessions expose `openai_generate_image` for generation, reference-image editing, and batches. The conversation model supplies routing and authentication; the image model is called through a separate Images API without replacing the conversation model. The built-in image default is `grok-imagine-image-2.0`, which your backend may not support. `defaultModel` must be included in `allowedModels`.

Requires an `openai-responses` or `openai-codex-responses` route and a working Images API. Responses must contain base64-encoded PNG, JPEG, or WebP output. `batchSize` accepts 1–10; each image is a separate request and may incur a separate charge. Partial failure preserves images already saved. Editing sends reference images to the provider, so make sure those images can be uploaded. See [image configuration](docs/configuration.md#images).

### Responses WebSocket transport

The Toolkit WebSocket adapter is disabled by default. Enable it globally for GPT models that use Pi's `openai-responses` API:

```json
{
  "schemaVersion": 2,
  "defaults": {
    "responsesWebSocket": { "enabled": true }
  }
}
```

It reuses the selected model's provider, base URL, credentials, headers, and model ID without registering another provider. Pi's `transport: "auto"` tries WebSocket first and falls back to SSE before streaming starts; `transport: "sse"` keeps the original HTTP/SSE path. Restart or reload Pi after changing the Toolkit setting. See [WebSocket configuration](docs/configuration.md#responses-websocket-transport).

### Auto Mode

Auto Mode uses model-based review before tool execution. Permit it and select a reviewer registered and authenticated in Pi, then engage it explicitly:

```json
{
  "schemaVersion": 2,
  "defaults": {
    "autoMode": {
      "available": true,
      "reviewerModel": "provider/reviewer-model-id"
    }
  }
}
```

Replace `provider/reviewer-model-id` with a real model reference. Use `/auto on` or the `--auto` startup flag to engage, and `/auto off` to disengage. Setting `available: true` alone does not engage the gate.

The default `gate: "side-effect"` reviews `bash`, `write`, `edit`, and `extraTools`. Use `gate: "all"` to cover every tool. Read-only evidence gathering, denial circuit breakers, and optional background classifier pre-scoring are supported. With the classifier enabled, some calls can pass based on a pre-score.

A timeout or unavailable review is never approval: interactive sessions ask for confirmation, while headless sessions block the call. This is not a sandbox or a guarantee of correct decisions. Selecting an ineligible model disengages Auto Mode. See [Auto Mode settings](docs/configuration.md#auto-mode).

## Compatibility and troubleshooting

- Keep providers, endpoints, and credentials in Pi, not Toolkit configuration. See [provider setup](docs/configuration.md#provider-specific-responses-endpoints) for Azure deployment mapping, `api-version`, and authentication
- `pi-virtual` capability checks use the physical provider/model resolved by Pi, without inferring support from the virtual model's name
- Compaction and replay honor `inputLimits.images` resizing and count limits from Pi model metadata without changing the persisted session or original request object
- Invalid settings block dependent operations. Run `/toolkit-config validate`, then check the model, authentication, and backend capabilities. Valid configuration is not a successful endpoint test
- Request and compact-response capture are off by default. Enable `diagnostics.captureRequests` / `captureResponses` only for troubleshooting, and check logs for conversation content before sharing

See the [configuration reference](docs/configuration.md) and [JSON Schema](config.schema.json) for all fields and defaults. Protocol, checkpoint, and debugging details are in [internals](docs/internals.md).

## Development

From the repository root:

```bash
npm ci
npm run typecheck
npm test
npm run test:pi
npm pack --dry-run
```

Tests use Bun, included in the development dependencies. Keep JSON examples identical in both READMEs; the documentation tests check this.

MIT © awoaCrim and contributors. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for third-party attribution.
