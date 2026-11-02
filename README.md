# pi-openai-toolkit

Responses compaction, web search, and image generation for Pi. Uses Pi's existing models, endpoints, authentication, and sessions without registering another provider or model.

[![npm version](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](LICENSE)

[简体中文](README.zh.md)

## Install and start

Requires Node.js **22.19.0+** and Pi **0.87.0+**. Current development dependencies pin Pi **1.0.0**; backend features also depend on the selected model, API, and account access.

```bash
pi install npm:pi-openai-toolkit
```

Configure your model and credentials in Pi, then start Pi normally. Without a Toolkit config file, eligible models use remote compaction by default. Search remains managed by Pi and other extensions; image generation is off.

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
- `pi`: leave context management to Pi

**Remote compaction** accepts `openai-responses`, `openai-codex-responses`, and `azure-openai-responses`. It tries V2 first. On the official OpenAI API-key route, a qualifying protocol failure can trigger one standalone `/v1/responses/compact` request; its complete encrypted replacement window is preserved for replay. OpenAI OAuth, native Codex, Azure, and gateways keep their existing V2 route. OpenAI subscription-sharing OAuth and native Codex login are separate grants, not interchangeable credentials. Backend/model access is still required.

Set `context.remoteCompaction.model` to use a separate producer on the same effective base URL without changing the active model. When its full `provider/model-id` matches the current model, Toolkit directly reuses the current runtime, authentication snapshot, and session; it does not select the model again or switch to native summarization merely because the models match. For ordinary remote compaction, exhausted remote attempts warn before continuing with a native text summary. `nativeFallback.enabled: false` disables only Toolkit's configured-model tier, not Pi's default summary. Aborts, incompatible provenance, and edits to sealed history still cancel rather than bypassing checkpoint safety. See [context settings](docs/configuration.md#context) and [checkpoint rules](docs/internals.md#remote-compaction-v2-wire-contract).

**Remote Windows has been removed**, including its four tools and model-selection recovery. Old window sessions are not continuable: Toolkit refuses branches containing their markers instead of resending retired history. Start a new session; existing files are not rewritten or deleted. Dormant window settings are ignored with a warning, but a selected `remote-windows` mode must be changed explicitly. See [retirement guidance](docs/configuration.md#removed-remote-windows). Shared Codex gateway transport remains available to compaction and images.

## Codex Fast

Fast is OFF by default. Run `/fast` in Pi's terminal or a UI-backed RPC client such as pi-web to turn it ON, then run it again to turn it OFF. Notifications confirm changes. Eligible routes show `Fast ON` or `Fast OFF`; other routes hide the indicator while retaining the session preference. Display placement is controlled by the client. Print/JSON and headless commands cannot toggle Fast. No Fast configuration is needed.

Supports native Codex and recognizable GPT/Codex models on compatible Responses gateways. The selection is saved only in the current session: reload/resume retain it; new or forked sessions start OFF. ON requests Fast, while OFF requests Standard, overriding an existing service-tier preference on eligible conversation requests without changing reasoning effort or configuration files.

Fast may increase usage/cost. The indicator shows the requested mode, not confirmed backend acceleration; a gateway may reject, ignore, or downgrade it. Opaque gateway model aliases need an existing Codex gateway identity. See the [Fast contract](docs/internals.md#codex-fast-session-control) for scope and lifecycle details.

## Search, images, and transport

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

It reuses the selected model's provider, base URL, credentials, headers, and model ID without registering another provider. Pi's `transport: "auto"` tries WebSocket first and falls back to SSE before streaming starts; with a stable session it also reuses the socket and sends only the new continuation input when the transcript matches. Use `transport: "websocket-cached"` to require that cached path, or `transport: "sse"` to keep the original HTTP/SSE path. Restart or reload Pi after changing the Toolkit setting. See [WebSocket configuration](docs/configuration.md#responses-websocket-transport).

Size safety takes precedence over WebSocket transport preferences: an actual UTF-8 `response.create` frame at or above 15 MiB uses the original full HTTP/SSE request directly. The threshold is a safety margin, not an advertised backend limit. A large transcript with a small valid continuation delta still uses WebSocket. This does not trigger compaction or remove images/reasoning; HTTP responses do not establish WebSocket continuation state. `/ws-status` counts size-routed HTTP separately from transport-error SSE recovery. Without a usable cached continuation, oversized requests do not open a WebSocket first.

## Compatibility and troubleshooting

Auto Mode, `/auto`, and `--auto` have been removed. Toolkit no longer reviews tool calls through this feature. Existing `autoMode` configuration is ignored with a warning and can be deleted; other valid settings keep working. See [removal guidance](docs/configuration.md#removed-auto-mode).

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
