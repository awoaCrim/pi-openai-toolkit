# Toolkit Internals

Developer-facing reference for [pi-openai-toolkit](../README.md). The README keeps this protocol and implementation detail out of the installation path. If you are changing wire behavior, fixtures, or the compaction strategy code, start here.

---

### Table of Contents

- [Remote Context protocol](#remote-context-protocol)
- [Rollover lifecycle](#rollover-lifecycle)
- [Remote Compaction v2 wire contract](#remote-compaction-v2-wire-contract)
- [Artifacts and debugging](#artifacts-and-debugging)
- [Provenance](#provenance)

---

### Remote Context protocol

Internal alpha endpoints, adapted from `@howaboua/pi-codex-conversion`:

```text
POST {base}/alpha/history/v2/list_windows | list_items | read_item | search_contents
POST {base}/alpha/notes/v2/list_files_by_prefix | read_file | search_contents | append_to_file | write_file
POST {base}/alpha/notes/v2/thread_hint
```

The native route uses `{base} = <backend-api>/codex` with `Authorization: Bearer <oauth token>`, `ChatGPT-Account-ID`, and Codex CLI headers. The gateway route uses the configured `/v1` base with the API key configured for that provider, `originator: codex_cli_rs`, `X-Codex-Affinity-Scope`, and `X-Codex-Model` carrying the bare model ID. Inherited OAuth headers, cookies, and account IDs are stripped before the request leaves the process. Both routes set `Session-Id` and `X-Client-Request-Id` to the bounded Pi session ID, plus `x-openai-tool-output-truncation-policy` and `x-openai-encrypted-tool-arguments` for endpoints with encrypted parameters. Encrypted results come back as `encrypted_output` and are re-encoded into later requests. These are alpha contracts, so the upstream backend may change them at any time.

Search text and note bodies are sent under the encrypted-argument policy. Live model requests carry `x-codex-window-id` and `x-codex-turn-metadata` request headers derived from the active window identity.

Coverage is never inferred from model names. A native session uses provider `openai-codex` with API `openai-codex-responses` for any model ID. A gateway session uses API `openai-responses` and must carry an exact `provider/model` key listed in `compaction.gatewayContextModels`; the list ships empty and there is no built-in gateway SKU. See [src/context-management/codex-provider.ts](../src/context-management/codex-provider.ts). The toolkit registers no provider or model with Pi. It resolves credentials and base URLs through Pi's `ModelRegistry`.

---

### Rollover lifecycle

The `new_context` happy path, end to end:

```mermaid
sequenceDiagram
  accTitle: Remote Context rollover
  accDescr: A Pi model checkpoints notes, requests a local new_context boundary, and sends the next request with the new window identity.
  participant Model
  participant Toolkit
  participant Pi
  participant Backend
  Model->>Toolkit: notes append_to_file (checkpoint)
  Toolkit->>Backend: alpha notes request (encrypted args)
  Backend-->>Toolkit: encrypted_output
  Model->>Toolkit: new_context
  Toolkit->>Toolkit: verify successful notes write in this window
  Toolkit-->>Model: checkpoint receipt with the successful note path
  Toolkit-->>Pi: window marker appended, previous window trim scheduled
  Model->>Backend: next request with the new x-codex-window-id
  Pi->>Toolkit: session_before_compact
  Toolkit-->>Pi: no-summary boundary consuming the scheduled trim
```

State invariants the lifecycle code must keep honest:

- The checkpoint gate verifies a successful `notes` `append_to_file` or `write_file` against the persisted session branch after the latest window boundary, so it survives restarts and forks. A response with `ok: false` or `success: false` is not successful, even when HTTP returns 200.
- The gate uses the live session/branch identity from `ctx.sessionManager`; cached manager identity must not hide a valid current-window pair, and old or foreign-session evidence must remain rejected.
- Every rollover carries the most recent successful checkpoint path in its handoff message. The optional `thread_hint` is supplemental; a hint failure must not erase the local receipt.
- `new_context` has no force escape hatch: a persisted successful notes checkpoint in the current window is always required before rollover. The model must wait for the notes result to be persisted before retrying.
- After a marker is accepted for sending, the manager keeps a session/window-anchored pending guard until that exact target marker is persisted or the session changes. A duplicate `new_context` during this persistence gap returns `started: false` and sends no second marker; projected/in-memory messages do not retire the guard.
- Budget checks are skipped until the current window has produced its own assistant usage. Acting on the previous window's usage anchor would burn the once-per-window reminder on a false alarm.
- The scheduled trim is consumed exactly once, synchronously, by the first compaction attempt whose boundary window ID matches. Every other compaction path, including a threshold without a scheduled rollover, manual `/compact`, and overflow, is cancelled.
- A window boundary is persisted as a `codex-context-window` custom message. `session_start` replays boundaries from the branch and rebuilds identity after forks.

---

### Remote Compaction v2 wire contract

v2 is what an uncovered session gets. Any model that Remote Context declines, such as a gateway model absent from `gatewayContextModels`, can still compact through v2 when its API appears in `responsesApis`. The two strategies never compete for one session.

A `compaction_trigger` item appended to the live streaming request yields one output item of `type: "compaction"` with non-empty `encrypted_content`, stored in `CompactionEntry.details.compactedWindow`. On later requests the opaque checkpoint is replayed ahead of live turns, with no text summary. Replay fails closed: if the summary anchor cannot be located, the request is aborted with a notification and a content-free failure artifact. The sentinel-only payload is never sent.

A v2 response with a missing or empty checkpoint is never stored, and the `nativeFallback` tier is skipped. Pi's own threshold drives the next attempt, which may use `remoteCompactModel` when configured. `remoteCompactModel` must resolve to the same effective base URL as the active model.

Pi 0.85.1's `session_before_compact` event supplies preparation and branch data, while the direct Remote V2 client can bypass the provider `context` hook chain. To preserve compatibility, an omitted `compaction.remoteV2ContextSource` keeps the original `"legacy"` behavior: first compaction uses `buildSessionContext()` and falls back to `SessionBeforeCompactEvent.preparation`, while recursion uses the opaque window plus the raw branch tail.

Setting `compaction.remoteV2ContextSource: "pi-context-hook"` opts into a narrow runtime bridge around Pi's public `ExtensionRunner.createContext()`. It adds a non-enumerable `ctx.projectContextForCompaction(messages)` method backed by `ExtensionRunner.emitContext()`. In this opt-in mode, Remote V2 first reads `buildSessionContext()` and then runs the ordered projection. If the bridge, session context, or recursive summary anchor is unavailable, the extension cancels rather than sending an unprojected history. The legacy mode is an intentional compatibility trade-off and does not claim parity with provider-visible context hooks.

New checkpoints record `inputProvenance: "pi-context-hook-v1"` or `"legacy-raw-context-v1"`, and replay/recursion reject missing or mode-mismatched markers without searching past the latest compaction. Retained `role: "custom"` messages are optional during replay because they may be changed or removed by context hooks; required user, assistant, and complete tool-call/result content remains ordered and fail-closed.

---

### Artifacts and debugging

With `debug: true`, the toolkit writes lifecycle and compaction artifacts under `artifactRoot` (default `~/.pi/agent/artifacts/pi-openai-toolkit/compaction`):

- Each `session_start` writes a lifecycle artifact whose `activation` field records `active` or the exact inactive reason, such as `unsupported-model`, `unsupported-api`, `missing-api-key`, `auth-resolution-failed`, or `tool-name-conflict`.
- `logProviderPayloads` additionally writes provider request metadata and payloads, while `logCompactResponses` writes compact status and structural summaries with complete response and body fields critically redacted. Keep both off unless inspecting a specific request.
- Artifacts always redact Authorization credentials, API keys and tokens, Codex account IDs, and opaque `encrypted_content` or `encrypted_output`, even when `redactSensitiveData` is `false`.

---

### Provenance

The Remote Context protocol was reverse-engineered from `@howaboua/pi-codex-conversion@3.0.29` (source commit `7021ae48e8efe36a3becc5830d529696ff798e5e`). The Astra compatibility layer is adapted from Oh My Pi 18.1.8 (MIT). Web Search behavior was adapted from [pi-openai-web-search](https://github.com/code-yeongyu/pi-openai-web-search) (commit `3964338`). Attribution details are in [NOTICE](../NOTICE).

Protocol fixtures live in [src/context-management/](../src/context-management/) and must be updated together with any upstream alpha endpoint change. New wire behavior requires fixture-based tests.
