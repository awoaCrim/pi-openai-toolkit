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
      "defaultModel": "gpt-image-2.5",
      "allowedModels": ["gpt-image-2.5"]
    },
    "autoMode": { "available": false }
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

Known nested objects merge by field. Missing fields inherit, arrays replace instead of append, and `false`/`0` retain their meanings. Only optional model references accept `null`: context producer, native-fallback model, auto reviewer, and classifier model. `null` elsewhere is invalid. Defaults do not prohibit exact overrides; an exact model can set `available: true` over a default of `false`.

A missing file uses independent built-in defaults. Invalid JSON, an unreadable file, missing/unsupported `schemaVersion` on a v2-shaped document, or mixed legacy/v2 fields are reported distinctly. Unknown v2 policy keys are errors in their owning scope. Invalid selected settings block dependent operations; they never silently pick a more permissive route. Errors in other models remain visible without replacing a valid current model's policy. A valid exact leaf may shadow an invalid default leaf, but cannot hide a malformed containing object or unknown field in that feature scope.

Each public callback, tool execution, compaction, reviewer/classifier operation, or config command uses an immutable snapshot across its awaited helpers. The next operation reads again. This does not make separate Pi headers, payload, and tool events one atomic transaction. Engagement, overrides, scores, windows, and results stay out of the config file.

---

### Context

Place `context` under `defaults` or an exact `models` entry.

| Relative field | Default | Contract |
| --- | --- | --- |
| `mode` | `"remote-compaction"` | `"pi"` relinquishes Toolkit context management; `"remote-compaction"` uses the eligible Responses checkpoint path; `"remote-windows"` selects Codex windows where supported. |
| `remoteCompaction.model` | `null` | Exact producer reference; `null` uses the active model. It must share the effective base URL required by the existing compaction path. |
| `remoteCompaction.inputSource` | `"legacy"` | `"legacy"` preserves session/raw-branch input; `"pi-context-hook"` opts into Pi's ordered context projection. Checkpoint provenance must match. |
| `remoteCompaction.allowContinuityBreak` | `false` | Allow restarting from Pi context after a foreign compaction entry. It does not make malformed opaque checkpoints replayable. |
| `remoteCompaction.apis` | `["openai-responses", "openai-codex-responses"]` | May narrow this set; `[]` permits no remote-compaction API. Unsupported entries are errors. |
| `nativeFallback.enabled` | `true` | Enable the existing native-method fallback tier. |
| `nativeFallback.model` | `null` | Optional summary-model reference on the remote-ineligible path. After a remote attempt fails, the existing producer-first fallback order is retained. |
| `nativeFallback.thinkingLevel` | `"off"` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; actual model support still applies. |
| `remoteWindows.leaveManagedMode` | `"warn"` | `"compact"` also requests a close-out when retired history exceeds 80% of the next model's window and compaction can finish. Print mode remains warning-only; turn-end close-out requires a queued trim. |
| `remoteWindows.reminderThresholdPercent` | `5` | Integer 0-100. `0` disables both the once-per-window reminder and exhausted-window fallback. |

Native Codex eligibility derives from the actual Pi provider/API. Gateways additionally need the exact transport opt-in below. `remote-windows` retains the compaction chain for models outside window capability. A configured window model whose activation fails does not silently receive a summary fallback. The rollover notes gate, durable history, producer/consumer identities, and checkpoint provenance are unchanged. See [Toolkit internals](internals.md).

---

### Compatibility transport

Only `models["provider/model-id"].compatibility.transport` is configurable: `"standard"` is the internal baseline and `"codex-gateway"` is an exact opt-in. There is no global `defaults.compatibility` and no built-in gateway model list.

This selects an existing Toolkit protocol profile, independently of context mode. It does not change Pi's provider, API, endpoint, or model. The same decoded document supplies compatibility for search, image generation, and a separately named compaction producer. A successful config resolution is not a backend capability test.

---

### Web Search

`defaults.webSearch.route` and `models[exact].webSearch.route` accept:

| Route | Behavior |
| --- | --- |
| `unmanaged` | Default. Release Toolkit ownership and remove Toolkit-owned standalone exposure. Third-party search and unrelated network tools remain possible. |
| `local` | Restore the original local tool state and remove native/standalone search conflicts from provider payloads. Never activate a previously inactive local tool. |
| `hosted` | Use native Responses search with source annotations; suppress conflicting local and standalone tools. |
| `standalone-alpha` | Experimental, explicit opt-in. Expose sequential `web_run` and call the provider-relative `/alpha/search` endpoint once per execution. |

There is no v2 search master switch. `local` and `unmanaged` differ in payload cleanup and ownership. Missing auth, an unavailable route, a tool conflict, or invalid selected policy does not trigger another route. Standalone supports `search_query`, `image_query`, `open`, `click`, `find`, `screenshot`, `finance`, `weather`, `sports`, and `time`, with `response_length`. It sends a bounded command envelope rather than the full transcript; follow-up references depend on the provider's session/reference handling. The gateway must expose the endpoint and its standalone-search capability.

---

### Images

Image settings are global-only under `defaults.imageGeneration`. `enabled` defaults to `false`. `defaultModel` defaults to `"gpt-image-2.5"`; `allowedModels` defaults to `["gpt-image-2.5"]`.

These are bare output-model IDs, not active-session model keys. Each normalized ID must contain 1-256 characters. The allowed list must remain nonempty after normalization and contain the explicit default. Order has no default-selection meaning. A caller's one-call `model` must be a member; policy and membership are checked before auth, local-reference preparation/upload, and paid dispatch. The active session remains the Responses routing model. Config does not grant permission to upload arbitrary local files or imply that a provider supports a particular image model.

---

### Auto Mode

Place `autoMode` under `defaults` or an exact model. `available` permits engagement; it does not engage the runtime. Use `/auto on` or `--auto`, and `/auto off` to disengage. If an engaged session encounters invalid policy, calls remain blocked until policy is corrected or the user explicitly turns the gate off. A review timeout never means approval.

| Relative field | Default | Contract |
| --- | --- | --- |
| `available` | `false` | Model eligibility for engagement. |
| `reviewerModel` | `null` | Exact review-model reference; required for useful engagement. |
| `gate` | `"side-effect"` | Reviews `bash`, `write`, `edit`, and `extraTools`; `"all"` reviews every tool. Session gate overrides remain runtime state. |
| `extraTools` | `[]` | Additional names for the side-effect gate. |
| `timeoutMs` | `30000` | Integer 1000-120000 milliseconds. |
| `transcript` | `true` | Include transcript context in the blocking review. |
| `evidenceTools` | `true` | Permit the reviewer's existing read-only evidence tools. |
| `maxEvidenceRounds` | `3` | Integer 0-8. |
| `classifier.enabled` | `false` | Enable nonblocking trajectory pre-scoring. |
| `classifier.model` | `null` | Exact reference; `null` uses the reviewer. |
| `classifier.timeoutMs` | `15000` | Integer 1000-120000 milliseconds. |
| `classifier.maxLag` | `2` | Integer 0-20. |
| `circuitBreaker.consecutiveDenials` | `3` | Integer 0-100; `0` disables this limit. |
| `circuitBreaker.recentDenials` | `10` | Integer 0-100; `0` disables this limit. |
| `circuitBreaker.windowSize` | `50` | Integer 1-200, recent-verdict window size. |

Reviewer and classifier references are not active-session overrides. Classifier scores, denial history, and human decisions never become config entries.

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

Do not combine unversioned roots (`compaction`, `webSearch`, `imageGeneration`, `autoMode`) with `schemaVersion: 2`. Valid legacy behavior is retained through a compatibility adapter, including nullable model clears, legacy image-list defaults, and source-dependent hosted-search failure handling. Invalid selected legacy route values are now blocked instead of disappearing into another selection.

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
| `autoMode.enabled` / `models` | Default/exact `autoMode.available` |
| Legacy auto reviewer/classifier/breaker controls | Corresponding `autoMode` controls |
| Legacy compaction debug/capture/path settings | `diagnostics` |

The preview cannot claim universal lossless conversion:

- A legacy hosted allowlist ignores unsupported APIs and malformed payloads; explicit v2 hosted selection fails closed. Moving a list entry to an exact hosted route changes those failure paths.
- Disabled legacy features can retain dormant model lists/routes. A simplified v2 policy cannot preserve enable-later intent without review.
- Gateway compatibility is now shared independently of context mode; review effects on compaction and image affinity.
- Unknown fields, invalid normalization, or candidate validation failures require review. `remoteV2ContextSource: "legacy"` remains `inputSource: "legacy"`; preview does not upgrade checkpoint provenance or opt any model into standalone search.

There is no automatic migration, writer, or `--write` option. Before a separately approved manual cutover, back up the original bytes and verify that every installed Toolkit copy supports v2. Older copies, including 0.14.13, do not support this format. Updating source in a checkout does not update an installed package. Keep the legacy file until that cutover is ready.
