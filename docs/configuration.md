# Toolkit configuration

Toolkit reads only `~/.pi/agent/extensions/pi-openai-toolkit/config.json`. There are no project overrides, environment policy overlays, profiles, `extends`, or wildcard rules. Pi still owns extension loading, provider endpoints, model registration, and credentials. A project-local extension installation does not create project-local Toolkit policy.

This reference describes schema v2. Unversioned legacy configuration remains supported. Configuration schema v2 and Remote Compaction v2 are separate version numbers.

---

### Start with a small document

Create the file and parent directory if absent. This example states the shipped feature defaults; it is not a conversion of an existing legacy file:

```json
{
  "schemaVersion": 2,
  "defaults": {
    "context": { "mode": "remote-compaction" },
    "webSearch": { "route": "unmanaged" },
    "imageGeneration": {
      "enabled": false,
      "defaultModel": "grok-imagine-image-2.0",
      "allowedModels": ["grok-imagine-image-2.0"]
    },
    "responsesWebSocket": { "enabled": false }
  },
  "models": {},
  "diagnostics": {
    "level": "info",
    "notifyOnLoad": false,
    "captureRequests": false,
    "captureResponses": false,
    "redactSensitiveData": true
  }
}
```

`$schema` is optional editor metadata pointing to the shipped [config.schema.json](../config.schema.json). It does not change runtime schema selection. The editor schema describes canonical spelling; runtime also trims surrounding whitespace in supported strings and deduplicates lists. Runtime validation checks normalized key collisions and image-default membership that the editor schema cannot express.

---

### Resolution and errors

Precedence is built-ins, then `defaults`, then `models["provider/model-id"]`. Keys are exact and case-sensitive. Leading/trailing whitespace is trimmed; conflicting normalized keys are rejected. Model IDs may contain further slashes. No pattern matching or endpoint/capability guessing occurs.

Known nested objects merge by field. Missing fields inherit, arrays replace instead of append, and `false`/`0` retain their meanings. Only optional model references accept `null`: context producer and native-fallback model. Other active settings reject `null`. Defaults do not prohibit exact overrides; an exact model can select a different context mode or search route.

A missing file uses independent built-in defaults. Invalid JSON, an unreadable file, missing/unsupported `schemaVersion` on a v2-shaped document, or mixed legacy/v2 fields are reported distinctly. Unknown v2 policy keys are errors in their owning scope. Invalid selected settings block dependent operations; they never silently pick a more permissive route. Errors in other models remain visible without replacing a valid current model's policy. A valid exact leaf may shadow an invalid default leaf, but cannot hide a malformed containing object or unknown field in that feature scope.

Each public callback, tool execution, compaction, or config command uses an immutable snapshot across its awaited helpers. The next operation reads again. This does not make separate Pi headers, payload, and tool events one atomic transaction. Windows and results stay out of the config file.

---

### Context

Place `context` under `defaults` or an exact `models` entry.

| Relative field | Default | Contract |
| --- | --- | --- |
| `mode` | `"remote-compaction"` | `"pi"` relinquishes Toolkit context management; `"remote-compaction"` uses the eligible Responses checkpoint path; `"remote-windows"` selects Codex windows where supported. |
| `remoteCompaction.model` | `null` | Exact producer reference; `null` uses the active model. In `remote-compaction`, it selects the synthetic checkpoint producer on the same effective base URL. In active `remote-windows`, manual `/compact` temporarily selects it for notes checkpoint duty on the same backend/account. |
| `remoteCompaction.inputSource` | `"legacy"` | `"legacy"` preserves session/raw-branch input; `"pi-context-hook"` opts into Pi's ordered context projection. Checkpoint provenance must match. |
| `remoteCompaction.allowContinuityBreak` | `false` | Allow restarting from Pi context after a foreign compaction entry. It does not make malformed opaque checkpoints replayable. |
| `remoteCompaction.apis` | `["openai-responses", "openai-codex-responses", "azure-openai-responses"]` | May narrow this set; `[]` permits no remote-compaction API. Azure uses Pi's resolved `AZURE_OPENAI_*` environment values for the `/openai/v1` Responses path, deployment mapping, and `api-version`; unsupported entries are errors. |
| `nativeFallback.enabled` | `true` | Enable the existing native-method fallback tier. |
| `nativeFallback.model` | `null` | Summary-model reference on the remote-ineligible path. Character-count estimates do not bypass it; resolution, auth or summary failure cancels compaction without retrying the active model. After a remote attempt fails, the existing producer-first selection is retained. Disabled/unset/same-model selections keep Pi's default path. |
| `nativeFallback.thinkingLevel` | `"off"` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; actual model support still applies. |
| `remoteWindows.leaveManagedMode` | `"warn"` | Legacy compatibility field. Both values preserve the same behavior: non-window models receive only the current local window, and no bulk close-out compaction is started for retired Remote Context history. |
| `remoteWindows.reminderThresholdPercent` | `5` | Integer 0-100. `0` disables both the once-per-window reminder and exhausted-window fallback. |

Ordinary remote compaction tries V2 first. One automatic standalone `/v1/responses/compact` attempt is available only for the official HTTPS OpenAI endpoint, an `openai-responses` physical producer, public Pi auth metadata explicitly indicating configured non-OAuth auth, and an outgoing Bearer header matching Pi's resolved key. Missing/unknown auth metadata, an unrelated Authorization override, Codex affinity, OAuth, Azure, and third-party gateways do not opt in. A protocol-compatible rejection or invalid successful V2 checkpoint can qualify; auth/subscription, quota/rate-limit, network, abort, and unrelated server failures do not. No protocol selector, credential switch, or capability cache is added; a selected standalone attempt may add latency/cost.

Standalone success preserves the full canonical output window, including retained items, rather than treating retained assistant text as a summary. When actual remote attempts are exhausted, Toolkit warns that no encrypted checkpoint was produced and starts the existing native text-summary chain: the configured remote producer after a remote attempt, or `nativeFallback.model` when remote compaction is unavailable. `nativeFallback.enabled: false` disables only the configured-model tier; disabled/unset/same-model selections still permit Pi's default summary. Explicit summary-model failures and checkpoint-integrity failures cancel. OpenAI subscription-sharing OAuth can reject compaction; separately authenticating native Codex is a different route, not a way to reuse that grant. See the [wire contract](internals.md#remote-compaction-v2-wire-contract).

Native Codex eligibility derives from the actual Pi provider/API. Gateways additionally need the exact transport opt-in below. `remote-windows` keeps the Remote Window state persisted when a model without window capability is selected: that model receives only the current local window, while retired/managed Remote Context history is excluded from live requests and compaction producers. A no-summary boundary preserves the marker for later reuse. A configured window model whose activation fails does not silently receive a summary fallback. Normal `new_context` keeps its persisted-notes, duplicate and cooldown gates. Synthetic Remote V2 producer/consumer identity and checkpoint provenance are unchanged. See [Toolkit internals](internals.md).

In active `remote-windows`, `/compact [instructions]` starts checkpoint duty rather than producing a summary. The selected model must authenticate to the same native backend/account or gateway credential/affinity domain, fit the projected window plus its output reserve, and retain the required permitted context tools. Invalid or unsuitable explicit targets are refused without switching to a fallback model. The entire handoff uses the initiating context-policy snapshot; no config or global Pi defaults are rewritten.

Only a new persisted successful notes write/append after the handoff and the latest delivered user message authorizes its rollover. After the exact target marker is durable, Toolkit restores the original model/thinking before new-window inference and asks it to read the receipt first. Failure or cancellation restores an owned selection; a later user selection takes priority. Failed restoration blocks further handoff requests until selection/auth is repaired. Reload can recover selection, but does not automatically restart inference.

The SDK native compact call reports its intentional cancellation; the visible handoff is a separate agent operation. Pi's pre-hook “nothing to compact” and “already compacted” outcomes remain. Automatic threshold/overflow compaction and internal pending-trim maintenance do not initiate checkpoint duty. `nativeFallback.model` keeps its existing summary-model meaning.

---

### Compatibility transport

Only `models["provider/model-id"].compatibility.transport` is configurable: `"standard"` is the internal baseline and `"codex-gateway"` is an exact opt-in. There is no global `defaults.compatibility` and no built-in gateway model list.

This selects an existing Toolkit protocol profile, independently of context mode. It does not change Pi's provider, API, endpoint, or model. The same decoded document supplies compatibility for search, image generation, and a separately named compaction producer. A successful config resolution is not a backend capability test. When Pi selects a `pi-virtual` model, Toolkit uses Pi's runtime resolver (when available) to obtain the physical provider/model for capability, authentication, and endpoint checks; if that route cannot be verified, the feature fails closed instead of treating the virtual entry as an OpenAI model.

---

### Responses WebSocket transport

The Responses WebSocket extension is disabled by default. Enable it globally with `defaults.responsesWebSocket.enabled: true`; it is intentionally not a model-scoped override. Restart or reload Pi after changing this setting. An invalid or legacy configuration keeps the feature disabled.

The extension is an API-adapter override, not a provider registration. It applies to GPT model IDs whose Pi API is `openai-responses`, regardless of provider name. The active model's `baseUrl`, `apiKey`, configured headers, session id, and payload remain the source of truth.

The extension honors Pi's global `transport` setting:

| Pi `transport` | Behavior |
| --- | --- |
| `auto` | Try `wss://.../responses?model=...` first; fall back to the original SSE adapter only before a stream starts. With a stable session id, reuse the WebSocket and send a continuation delta when possible. |
| `websocket` | Require the WebSocket path; do not fall back to SSE. This mode opens a request-scoped connection. |
| `websocket-cached` | Require the WebSocket path and keep a session-scoped connection for later turns. |
| `sse` | Bypass the extension and use the original HTTP/SSE adapter. |

The endpoint is derived from the model's base URL by appending `/responses` when needed and switching `https:`/`http:` to `wss:`/`ws:`. The first frame is a standard `response.create` object and incoming frames are passed through Pi's existing Responses event normalizer. For `auto` and `websocket-cached`, Toolkit caches an open socket by session/model/endpoint/auth identity for up to five minutes idle or 55 minutes of age. When the current transcript has the cached request and response as a prefix, the next frame uses `previous_response_id` and only the new input items; if it cannot prove that relationship, it sends the full payload instead. A missing session id or `cacheRetention: "none"` disables reuse. The upstream must support the standard Responses WebSocket contract, including continuation semantics for `previous_response_id`; this does not rewrite a server that only exposes Codex's `/codex/responses` path or Codex-only authentication.

This feature does not write Pi settings, model files, auth files, or global extensions. To keep the Toolkit adapter disabled, set `defaults.responsesWebSocket.enabled` to `false` or omit it. Once enabled, Pi's global `transport: "sse"` still bypasses the WebSocket path for a request.

---

### Provider-specific Responses endpoints

Toolkit consumes provider registration, endpoint, model, credential, and provider-scoped environment values from Pi. Keep those details in Pi's model and authentication stores; Toolkit configuration selects the feature policy and exact model overrides. Pi's complete `auth.env` object is preserved through Toolkit authentication and request setup, including compaction, replay, fallback, and hosted-tool boundaries.

#### Azure OpenAI Responses

Pi's `azure-openai-responses` API uses Azure's Responses endpoint. Toolkit uses Pi's resolved provider authentication and environment values for the base URL, deployment mapping, and `api-version`. Azure Responses requests use the `api-key` header and do not forward an inherited bearer `Authorization` header.

Set the API key and either a resource name or a full base URL before starting Pi. `AZURE_OPENAI_API_VERSION` defaults to `v1`, and `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` maps the model ID selected in Pi to an Azure deployment name.

PowerShell:

```powershell
$env:AZURE_OPENAI_API_KEY = "replace-with-your-azure-key"
$env:AZURE_OPENAI_RESOURCE_NAME = "replace-with-your-resource"
$env:AZURE_OPENAI_API_VERSION = "2025-01-01"
$env:AZURE_OPENAI_DEPLOYMENT_NAME_MAP = "model-id=replace-with-deployment"
```

POSIX shell:

```bash
export AZURE_OPENAI_API_KEY="replace-with-your-azure-key"
export AZURE_OPENAI_RESOURCE_NAME="replace-with-your-resource"
export AZURE_OPENAI_API_VERSION="2025-01-01"
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP="model-id=replace-with-deployment"
```

Use `AZURE_OPENAI_BASE_URL` instead of `AZURE_OPENAI_RESOURCE_NAME` when the full resource URL is already known, for example `https://your-resource.openai.azure.com`. Toolkit normalizes the resource root to `/openai/v1` and appends `api-version` to both the Responses and compact URLs.

Provider-scoped values can also be stored in Pi's `~/.pi/agent/auth.json`:

```json
{
  "azure-openai-responses": {
    "type": "api_key",
    "key": "$AZURE_OPENAI_API_KEY",
    "env": {
      "AZURE_OPENAI_RESOURCE_NAME": "replace-with-your-resource",
      "AZURE_OPENAI_API_VERSION": "2025-01-01",
      "AZURE_OPENAI_DEPLOYMENT_NAME_MAP": "model-id=replace-with-deployment"
    }
  }
}
```

Pi resolves the credential and complete `env` object for each request; provider-scoped values take priority over the process environment. Keep `auth.json` private. The selected Pi model ID may differ from the Azure deployment name when the mapping is configured.

Enable the Azure Responses API in the Toolkit policy and start Pi with the registered model ID:

```json
{
  "schemaVersion": 2,
  "defaults": {
    "context": {
      "mode": "remote-compaction",
      "remoteCompaction": {
        "apis": ["azure-openai-responses"]
      }
    },
    "webSearch": { "route": "hosted" }
  }
}
```

```bash
pi --model azure-openai-responses/<model-id>
```

The exact model must still be registered in Pi's model catalog and authenticated through Pi. Keep provider registration and credentials in Pi's own configuration.

---

### Web Search

`defaults.webSearch.route` and `models[exact].webSearch.route` accept:

| Route | Behavior |
| --- | --- |
| `unmanaged` | Default. Release Toolkit ownership and remove Toolkit-owned standalone exposure. Third-party search and unrelated network tools remain possible. |
| `local` | Restore the original local tool state and remove native/standalone search conflicts from provider payloads. Never activate a previously inactive local tool. |
| `hosted` | Use native Responses search with source annotations; suppress conflicting local and standalone tools. |
| `standalone-alpha` | Experimental, explicit opt-in. Expose sequential `web_run` and call the provider-relative `/alpha/search` endpoint once per execution. |

There is no v2 search master switch. `local` and `unmanaged` differ in payload cleanup and ownership. Missing auth, an unavailable route, a tool conflict, or invalid selected policy does not trigger another route. Hosted Responses search also accepts Pi's Azure Responses API; standalone-alpha remains restricted to the verified OpenAI/Codex `/alpha/search` routes. Standalone supports `search_query`, `image_query`, `open`, `click`, `find`, `screenshot`, `finance`, `weather`, `sports`, and `time`, with `response_length`. It sends a bounded command envelope rather than the full transcript; follow-up references depend on the provider's session/reference handling. The gateway must expose the endpoint and its standalone-search capability.

---

### Images

Image settings are global-only under `defaults.imageGeneration`. `enabled` defaults to `false`. `defaultModel` defaults to `"grok-imagine-image-2.0"`; `allowedModels` defaults to `["grok-imagine-image-2.0"]`.

These are bare output-model IDs, not active-session model keys. Each normalized ID must contain 1-256 characters. The allowed list must remain nonempty after normalization and contain the explicit default. A caller's one-call `model` must be a member; policy and membership are checked before auth, local-reference preparation/upload, and paid dispatch. The active session remains the routing/auth model, while the selected image model is sent in a separate Images API request. Generation uses `/images/generations`; edits use `/images/edits` (Codex uses the corresponding `/codex/images/...` paths). The wrapper never injects a Responses `image_generation` tool. Responses are accepted only when they contain one validated PNG, JPEG, or WebP `data[].b64_json` image; the canonical artifact uses the detected format extension. A literal `quality: "auto"` is omitted from the wire request for compatibility gateways that reject it. `batchSize` is a tool argument from 1-10; each item is an independent `n: 1` request, partial success preserves saved artifacts, and batch calls cannot use a single-file `outputPath`. Config does not grant permission to upload arbitrary local files or imply that a provider supports a particular image model.

Image input limits are declared in Pi's model metadata, not in Toolkit policy. For example:

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://your-gateway.example/v1",
      "api": "openai-responses",
      "apiKey": "$MY_GATEWAY_KEY",
      "models": [{
        "id": "vision-model",
        "name": "Vision Model",
        "input": ["text", "image"],
        "inputLimits": {
          "images": {
            "resize": {
              "maxWidth": 1568,
              "maxHeight": 1568,
              "maxBytes": 524288,
              "jpegQuality": 80
            },
            "maxPerMessage": 4,
            "maxPerRequest": 8
          }
        }
      }]
    }
  }
}
```

At the compaction and replay boundary, Toolkit applies the declared resize profile before dispatch, counts images per message and request, and fails closed when a limit cannot be satisfied. It creates new input values without mutating the persisted session or original provider payload.

---

### Removed Auto Mode

Auto Mode, `/auto`, and `--auto` have been removed. Toolkit no longer performs this feature's tool-call review, background classification, or review confirmations. No replacement approval gate is installed.

Legacy root `autoMode`, v2 `defaults.autoMode`, and exact-model `autoMode` sections are ignored with an explicit removal warning, regardless of their contents. They do not invalidate other valid settings. The editor schema retains only deprecated compatibility entries, not the old controls. Remove these sections and any `--auto` launcher argument manually; Toolkit does not rewrite your configuration, session history, or saved review artifacts. Unrelated invalid settings and mixed legacy/v2 documents still fail validation.

---

### Diagnostics and inspection

Diagnostics are plugin-wide, not model-scoped.

| Field | Default | Contract |
| --- | --- | --- |
| `level` | `"info"` | `error`, `warn`, `info`, or `debug`. Debug enables lifecycle/compaction debug artifacts. Configuration issues and operation-blocking failures remain visible at every level. |
| `notifyOnLoad` | `false` | Optional informational load notification. |
| `captureRequests` | `false` | Independently opt into provider request artifacts. |
| `captureResponses` | `false` | Independently capture compact responses; this is not an ordinary chat-response logger. |
| `redactSensitiveData` | `true` | Optional additional redaction. Critical credentials, account IDs, and opaque encrypted data are always redacted. |
| `artifactRoot` | `"~/.pi/agent/artifacts/pi-openai-toolkit/compaction"` | Relative paths resolve against the canonical config directory, not the current project. |

`/toolkit-config` (or `show`) displays effective values with built-in/default/exact/legacy origins. `/toolkit-config validate` reports document issues, including unrelated model entries. Reports are bounded and redacted; unknown field names are masked. Repeated issue notifications are deduplicated within a session and do not depend on compaction enablement or debug mode.

`/toolkit-config migration-preview` analyzes a legacy file without changing it. These are human commands using Pi's UI; no model tool, new headless stdout protocol, network probe, auth lookup, tool mutation, or persistent state write is added. Headless operation failures and typed resolution issues remain observable. A truncated candidate is not usable JSON.

---

### Legacy compatibility and migration

Do not combine unversioned roots (`compaction`, `webSearch`, `imageGeneration`, `autoMode`) with `schemaVersion: 2`. Remaining legacy features are retained through a compatibility adapter, including nullable model clears, legacy image-list defaults, and source-dependent hosted-search failure handling. Invalid selected legacy route values are now blocked instead of disappearing into another selection.

The preview maps recognized fields into a candidate, supplies leaf origins, lists unmapped/dormant paths, and reports `ready`, `needs-review`, `already-v2`, or `unavailable`. `ready` means no known semantic difference was found in recognized active policy; it is not authorization to apply or proof of provider support. Unknown names are masked and their values are never copied into the report. The original source bytes remain the authoritative copy of unknown and dormant content.

| Legacy input | v2 destination |
| --- | --- |
| `compaction.enabled` / `contextManagement` | `defaults.context.mode` |
| `compaction.remoteCompactModel`, `remoteV2ContextSource`, `allowCompactionContinuityBreak`, `responsesApis` | `defaults.context.remoteCompaction` fields |
| `compaction.nativeFallback` | `defaults.context.nativeFallback` |
| `compaction.leaveManagedMode`, `contextReminderThresholdPercent` | `defaults.context.remoteWindows` fields |
| `compaction.gatewayContextModels` | Exact `models[key].compatibility.transport` |
| `webSearch.defaultRoute`, `routes`, `models` | Default/exact search route candidates, subject to review below |
| `imageGeneration.models` | `allowedModels` plus an explicit default taken from the legacy first entry |
| `autoMode` | Removed; omitted from the candidate with a warning and `needs-review` |
| Legacy compaction debug/capture/path settings | `diagnostics` |

The preview cannot claim universal lossless conversion:

- A legacy hosted allowlist ignores unsupported APIs and malformed payloads; explicit v2 hosted selection fails closed. Moving a list entry to an exact hosted route changes those failure paths.
- Disabled legacy features can retain dormant model lists/routes. A simplified v2 policy cannot preserve enable-later intent without review.
- Gateway compatibility is now shared independently of context mode; review effects on compaction and image affinity.
- Unknown fields, invalid normalization, or candidate validation failures require review. `remoteV2ContextSource: "legacy"` remains `inputSource: "legacy"`; preview does not upgrade checkpoint provenance or opt any model into standalone search.

There is no automatic migration, writer, or `--write` option. Before a separately approved manual cutover, back up the original bytes and verify that every installed Toolkit copy supports v2. Older copies, including 0.14.13, do not support this format. Updating source in a checkout does not update an installed package. Keep the legacy file until that cutover is ready.
