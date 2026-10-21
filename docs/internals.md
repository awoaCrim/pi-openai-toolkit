# Toolkit Internals

Developer-facing reference for [pi-openai-toolkit](../README.md). The README keeps this protocol and implementation detail out of the installation path. If you are changing wire behavior, fixtures, or the compaction strategy code, start here.

---

### Table of Contents

- [Configuration resolution](#configuration-resolution)
- [Codex Fast session control](#codex-fast-session-control)
- [Remote Context protocol](#remote-context-protocol)
- [Rollover lifecycle](#rollover-lifecycle)
- [Managed manual compact](#managed-manual-compact)
- [Remote Compaction v2 wire contract](#remote-compaction-v2-wire-contract)
- [Artifacts and debugging](#artifacts-and-debugging)
- [Provenance](#provenance)

---

### Configuration resolution

The single global document is loaded through [src/config.ts](../src/config.ts). [src/config/legacy.ts](../src/config/legacy.ts) owns unversioned compatibility; [src/config/v2.ts](../src/config/v2.ts) validates v2 scopes, resolves exact policy, and records leaf origins. [src/config/policy.ts](../src/config/policy.ts) defines effective values independently of persisted session data. See the [configuration reference](configuration.md) for supported fields and migration limits.

Feature entrypoints resolve once per public operation and pass that immutable snapshot through awaited helpers. A separately named compaction producer is resolved from the same decoded document for its own identity. Subsequent independent callbacks reload; active Remote manual compression retains its initiating context-policy snapshot through the owned operation, while legacy handoffs retain theirs through owned selection recovery. There is no general cross-event provider transaction, project lookup, singleton cache, or config state writer. Internal legacy-shaped engine adapters preserve compaction/search algorithms without exposing v2 parsing to consumers. Cross-feature gateway policy belongs to the resolver, not the context enable switch.

Selected invalid policy blocks dependent operations; unrelated model errors remain reportable without replacing the selected model. Retired `autoMode` sections are ignored with a warning; they never create effective policy or invalidate other features. Image choices are checked before auth, uploads, or paid requests. The human `/toolkit-config` command inspects effective values, validation, or a migration candidate without action APIs or network access. Migration is preview-only; source bytes and unknown/dormant content stay untouched.

---

### Codex Fast session control

[src/codex-fast/extension.ts](../src/codex-fast/extension.ts) registers the human-only, no-argument `/fast` toggle and an owned `ctx.ui.setStatus()` item. The command accepts UI-backed TUI/RPC (including pi-web) and older UI contexts without `mode`; print/JSON and headless commands cannot toggle. Notifications confirm changes, while status rendering belongs to the client. Default OFF requests `service_tier: "default"`; ON requests `"priority"`, the Codex Fast wire value. The status is the local request preference, not verified server acceptance or latency. Fast can increase usage/cost. No config setting, model tool, credential probe, retry, new header, reasoning-effort change or custom footer is added.

Native `openai-codex-responses` routes qualify. Non-official HTTP(S) `openai-responses` gateways qualify for recognizable GPT/Codex IDs or an existing exact Codex gateway identity, including a resolved virtual route. Unknown opaque aliases without that identity, Azure, other APIs and ordinary `api.openai.com` API-key routes remain untouched. A capability marker is not backend entitlement.

Version-1 `pi-openai-toolkit:codex-fast` custom entries contain only the owning Pi `sessionId` and `enabled` boolean. They are excluded from model context. Reload/resume and active-branch navigation reconstruct the latest valid owned preference; malformed latest metadata defaults OFF. Independent new/forked sessions ignore copied foreign preferences and start OFF. Remote window UUID changes do not reset the Pi session selection. A model switch shows N/A without discarding it. Missing identity or a failed append does not report a successful toggle.

The payload hook takes one selection snapshot and returns a new object only when a matching ordinary Responses request needs a tier change. Explicit OFF also overrides an existing Fast/Flex tier to Standard. Dedicated compaction shapes and malformed/foreign payloads are left unchanged. Fast loads after Web Search/image registration and before the final Astra effort pass, so its tier does not alter the pre-search cached extras used by separate search/image/compaction clients.

Native Pi and Toolkit gateway WebSocket adapters already compare non-input body fields before incremental reuse. A changed `service_tier` invalidates the incompatible `previous_response_id` delta; the existing transport/retry logic is retained. Offline official-Pi fixtures in [test/pi-codex-fast.test.ts](../test/pi-codex-fast.test.ts) cover TUI/RPC command/status/notifications, actual native/gateway HTTP/WebSocket bodies, saved reopen/reload, fork isolation and continuation transitions. They do not establish live Fast availability.

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

Coverage is never inferred from model names. A native session uses provider `openai-codex` with API `openai-codex-responses` for any model ID. A gateway session uses API `openai-responses` and must carry an exact `provider/model` key whose `models[exact].compatibility.transport` is `"codex-gateway"` (legacy `compaction.gatewayContextModels`); no gateway is opted in by default. See [src/context-management/codex-provider.ts](../src/context-management/codex-provider.ts). The toolkit registers no provider or model with Pi. It resolves credentials and base URLs through Pi's `ModelRegistry`.

---

### Tool-selection boundary and unavailable Context Management

The four Toolkit context tools are `new_context`, `get_context_remaining`, `history`, and `notes`. The canonical names live in [src/context-management/tool-contract.ts](../src/context-management/tool-contract.ts). A launcher that creates a Pi session for an exact `compaction.gatewayContextModels` model should union those names into an explicit `tools` allowlist before `createAgentSession`, unless the caller selected `noTools`/`--no-tools`; an explicit `excludeTools` entry remains authoritative and is never re-added. This package does not contain the `pi-subagent` or child-session launcher source, so the helper and contract here do not claim to modify that external layer.

After registration, Pi's published registry is authoritative. Toolkit distinguishes `verified` (all four owned definitions), `excluded` (a readable registry contains none of them), `unverified` (a transient read or partial publication), and `conflict` (registration/API/ownership failure). Only `excluded` is a live-turn downgrade: `context_with_system` applies the safe local projection at any effective inherited window boundary and strips internal markers, provider payload/header hooks return no-op results, and the lifecycle artifact records `context-tools-excluded`. Without an owned boundary, ordinary child requests remain unchanged apart from marker filtering. Conflicts, unreadable/partial registries, malformed window state and missing gateway identity remain fail-closed for live provider requests.

If a covered Remote Context session reaches `session_before_compact` without an active context runtime, the first compaction path is the configured `compaction.remoteCompactModel` through Remote V2. The active session model remains the checkpoint consumer; the configured remote model is only the compactor. If that model is missing/unusable, only an explicitly configured/enabled `nativeFallback.model` may run. Otherwise the hook cancels rather than silently invoking the active model or Pi's default compaction. This compaction fallback does not weaken the live-provider safety rules above.

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
  Toolkit-->>Pi: new window marker persisted
  Note over Model: Context switch is complete; read the receipt once, then resume the active task
  Model->>Backend: next request with the new x-codex-window-id
  Pi->>Toolkit: session_before_compact
  Toolkit->>Toolkit: resolve boundary against Pi's effective context
  Toolkit-->>Pi: safe no-summary boundary, or cancel obsolete cleanup
```

State invariants the lifecycle code must keep honest:

- The checkpoint gate verifies a successful `notes` `append_to_file` or `write_file` against the persisted session branch after the latest window boundary, so it survives restarts and forks. A response with `ok: false` or `success: false` is not successful, even when HTTP returns 200.
- The gate uses the live session/branch identity from `ctx.sessionManager`; cached manager identity must not hide a valid current-window pair, and old or foreign-session evidence must remain rejected.
- Every rollover carries the most recent successful checkpoint path in its handoff message. The optional `thread_hint` is supplemental; a hint failure must not erase the local receipt.
- A successful rollover closes the pre-rollover checkpoint phase. The first turn in the new window reads the receipt once and resumes the active user task; it must not immediately create another checkpoint or call `new_context` as part of that handoff. A later checkpoint is only for a later rollover, and `canRolloverFromCurrentWindow()` enforces it: a window entered by a rollover has to produce a tool result from a tool that is not one of `new_context`, `get_context_remaining`, `history`, or `notes` before it can roll over again.
- Pi 0.87 separates conversation-only `context` handlers from full-transcript `context_with_system` handlers. Toolkit uses the latter to trim windows and re-anchor the merged prompt/tool state with `preserveSystemHead()`. The output owns its leading system message; Pi does not repair it after this phase.
- When even that rebuild would lose declared tools, the trim is refused and the full message list is sent: a window that still carries the previous turns is usable, a window with no tools silently degrades into a chat the model can only narrate. Each refusal is reported once per window and lost-tool set through `takeProjectionDiagnostics()`, which writes a `context.projection.tool_loadout_shrink` compaction artifact and warns in the UI.
- The manager also remembers the head it last anchored. When a boundary compaction retires the transcript entry that declared the tools, the branch itself no longer contains a system message, and the remembered head is re-anchored instead of sending a tool-less window. The cache is request-time only, refreshed by every projection, and cleared by `reset()`.
- `new_context` has no force escape hatch: a persisted successful notes checkpoint in the current window is always required before rollover. The model must wait for the notes result to be persisted before retrying.
- After a marker is accepted for sending, the manager keeps a session/window-anchored pending guard until that exact target marker is persisted or the session changes. A duplicate `new_context` during this persistence gap returns `started: false` and sends no second marker; projected/in-memory messages do not retire the guard. The exact queued target can already trim the current Remote request and select its metadata, but this preview is recomputed per request and never authorizes maintenance compaction before persistence.
- Budget checks are skipped until the current window has produced its own assistant usage. Acting on the previous window's usage anchor would burn the once-per-window reminder on a false alarm.
- Pi's canonical session projection is the source of effective history. Toolkit may further restrict that projection, but never reconstruct omitted or summarized messages from the raw branch. Boundary resolution uses projected source entries and the active branch's latest compaction; an older marker retained inside a newer compaction does not authorize dropping that compaction's summary.
- Window identity and cleanup eligibility are separate. A persisted `codex-context-window` message restores identity after reload/fork, but its historical `trimPreviousWindow` flag is not an outstanding command. A newer native summary or opaque checkpoint supersedes old cleanup without erasing window identity. Missing or edited boundary evidence is never repaired by loading raw history.
- Maintenance compaction and local-consumer detachment use the same effective-boundary rules. Only a safe current boundary can produce a no-summary compaction; obsolete cleanup must not move the retained start backwards or replace a newer summary/checkpoint. Preparation alone changes no durable state, and cancellation, retry and branch navigation are resolved from current evidence rather than callback acknowledgments. A boundary already consumed by its own no-summary compaction is not a dead end: the scheduled-trim path still refuses a second boundary, but a local consumer falls through to the ordinary compaction chain, because Pi's canonical projection already starts at that boundary and retired Remote history is outside every producer's input. User manual `/compact` still follows the managed handoff below.
- An effective persisted window boundary belongs to the session, not the selected model or context mode. `context_with_system`, `before_provider_request`, and `session_before_compact` synchronize it before mode-specific exits, including `remote-compaction`, `pi`, and legacy disabled/off selections. A non-window consumer receives only the effective current context, with the current system/tool head preserved and internal markers removed; no Remote tools, metadata or affinity headers are activated by the local safety check. A pre-window opaque checkpoint cannot rehydrate retired history after local projection. When detachment is needed, the existing no-summary boundary runs before any configured, remote, native or Pi-default compaction producer. A boundary that a previous detach already persisted yields to that same producer chain instead of cancelling the operation. Once a later ordinary compaction owns effective context, the historical window does not suppress its summary or valid opaque replay. A genuinely new window can retire that checkpoint. Disabling opaque checkpoint generation through `responsesApis` does not disable required replay of an inherited checkpoint; an unsupported transport, authentication failure, or endpoint mismatch aborts the request instead of exposing its placeholder. The legacy `leaveManagedMode` setting remains compatible but does not start a bulk close-out from `model_select` or `agent_settled`.
- Native text summarization delegates prompt construction, tool-result truncation, split-turn requests and output limits to Pi's `compact()`. Toolkit does not use character-count estimates to reject the configured summary model. If its resolution, authentication or summary generation fails, compaction is cancelled with the error and context is preserved; the active model is not an implicit retry target. Disabled/unset/same-model selections retain Pi's default path. Remote-window projection still excludes retired managed history before any producer call.

---

### Managed manual compact

Active Remote Window manual `/compact` uses the shared Remote V2 client, not a notes-writing agent. [src/context-management/manual-compact.ts](../src/context-management/manual-compact.ts) owns its narrow cancellation/continuation lifecycle; [src/context-management/window-manager.ts](../src/context-management/window-manager.ts) remains the owner of window identity, canonical projection, notes pairing and trim. The built-in command and Pi scheduler are unchanged.

1. `session_before_compact` distinguishes user-manual requests from Toolkit-owned maintenance even though both have reason `manual`. Resolve the producer and original consumer from one policy snapshot without invoking model/thinking setters.
2. Prepare only the canonical effective current window. A later window retires an older opaque checkpoint; a newer checkpoint supersedes historical window markers. Preserve the prompt/tool head, context edits, complete tool pairs, native encrypted notes/history output and current deferred schemas. Hook-source preparation runs the ordered context phases once without triggering a budget reminder or maintenance. Unsafe projection cancels instead of recovering raw history.
3. Send one synthetic Remote V2 request, validate it and recheck operation ownership, then return a real compaction result for Pi to persist. Select a genuine retained start within the submitted window. Resolution, protocol, network, validation and cancellation failures stop with no standalone/text-summary fallback, notes duty or continuation.
4. `session_compact` synchronizes and verifies the latest exact persisted checkpoint. Repeated checkpoints share a summary string, so an event entry ID or summary match alone is insufficient proof. The callback returns without awaiting idle or sending a prompt: Pi emits it before clearing manual-compaction state.
5. A cancellable bounded deferred check uses public `ctx.isIdle()` and exact session/branch/window/checkpoint/selection evidence before one normal `sendUserMessage` continuation. New user work, selection, navigation, queued work, another compact or shutdown invalidates stale continuation. Host queues stay untouched. If safe continuation is unavailable, keep the successful checkpoint and stop without inference.

Compression preserves the same session/window identity and does not call `new_context`. Ordinary notes/history and explicit rollover remain available; a later queued or persisted window must exclude the retired opaque checkpoint. The original working model consumes the checkpoint only after it is durable and manual compression is idle. Pi's pre-hook empty/already-compacted outcomes remain unchanged.

Old version-1 `pi-openai-toolkit:manual-compact` records remain decodable for owned selection recovery. Reload/navigation never retries their notes, rollover or inference; a newer user selection wins. New direct compression does not create notes-duty records or change the current model. Tests in [test/pi-managed-compact.test.ts](../test/pi-managed-compact.test.ts) use the official SDK, disk-backed sessions, isolated HOME/settings and mocked native/gateway traffic to verify input, persistence, continuation and failure ordering.

---

### Remote Compaction v2 wire contract

V2 serves ordinary eligible compaction and active Remote Window user-manual compaction. A model that Remote Context declines, such as a gateway without an exact transport opt-in, can still use the ordinary V2 path when its API appears in `context.remoteCompaction.apis`. Active Remote manual compression uses the stricter current-window and stop-on-failure contract above. Compaction generation follows the active strategy. Across mode changes, an already-persisted checkpoint remains authoritative until a safe newer window or compaction replaces it; a historical window identity alone must not suppress checkpoint replay.

A `compaction_trigger` item appended to the live streaming request yields one output item of `type: "compaction"` with non-empty `encrypted_content`, stored in `CompactionEntry.details.compactedWindow`. On later requests the opaque checkpoint is replayed ahead of live turns, with no text summary. Replay fails closed: if the summary anchor cannot be located, the request is aborted with a notification and a content-free failure artifact. The sentinel-only payload is never sent.

The incremental SSE consumer validates the first terminal event and reconciles its checkpoint with prior item evidence. A valid completed frame ends the operation even if the HTTP body stays open; reader cancellation is best-effort cleanup and is not awaited. Incomplete frames at EOF, conflicting checkpoint evidence and terminal errors cannot become successful checkpoints.

A missing, empty, or invalid V2 checkpoint is never stored. Ordinary compaction may then try the gated standalone protocol below; exhausted remote attempts warn once and enter the unchanged native text-summary chain. A failed remote operation selects `remoteCompactModel` for the configured native tier; a remote-ineligible model selects `nativeFallback.model`. Disabled/unset/same-model selections delegate to Pi's default summary, including when `nativeFallback.enabled` is false. Explicit summary-model failures cancel instead of retrying with the active model. Aborts and projection/provenance/context-edit failures still cancel immediately. `remoteCompactModel` must resolve to the same effective base URL as the active consumer, which is never switched for synthetic requests.

#### Official API-key standalone fallback

The ordinary path reuses one resolved physical producer, auth snapshot, and prepared full input. After a qualifying V2 failure, it makes at most one POST to `https://api.openai.com/v1/responses/compact`. Eligibility requires `openai-responses`, no Codex gateway affinity, public `ModelRegistry.hasConfiguredAuth(model) === true` and `isUsingOAuth(model) === false`, and the final Authorization header matching the resolved Bearer key. Missing/throwing/nonboolean metadata is unknown, not API-key evidence. Provider aliases may qualify at the official endpoint; OAuth, native Codex, Azure, custom gateways, active Remote Window manual compression and inactive Remote Context recovery do not opt into this standalone fallback. No token-shape inspection, extra auth resolution, model/account switch, redirect, capability cache, or generated version/beta header is introduced.

Qualifying failures are HTTP 400/404/405/422/501 without auth/quota exclusions, invalid/empty successful V2 checkpoint responses, or streamed errors with a recognized unsupported-protocol code. HTTP 401/403/429, known subscription/auth/billing/rate-limit restrictions, network failures, aborts, and generic server outages never trigger another protocol probe. OpenAI subscription-sharing OAuth and native Codex OAuth are distinct grants; selecting a separately authenticated Codex route does not authorize copying its credential to OpenAI.

Standalone JSON contains `model`, `input`, `instructions` and only validated SDK-supported service-tier/cache fields. It omits `previous_response_id`, stream/store/tools/reasoning/text and the V2 trigger. A nonempty output must contain at least one nonempty encrypted `compaction` item and no malformed checkpoint. Every returned item and unknown structured field survives in original order, including retained user/assistant messages. Unlike V2, this protocol does not impose a single-output-item invariant. The existing `openai-native-compact-v1` strategy and an honest opaque window marker are persisted with consumer/producer identity, input provenance, deferred tools and Pi's `tokensBefore`. Retained assistant text is not a portable summary.

Existing persistence/replay splices the entire canonical window between the leading prompt and live tail. Recursion uses that window plus current live tail once; verified Pi-retained copies are removed, current deferred schemas load after the end of the whole window, and historical declarations remain intact. Standalone cancellation can win before JSON checkpoint acceptance; V2's validated terminal remains authoritative over later reader cleanup cancellation.

The API-key path is covered by isolated mocked wire tests and real Pi persistence/reopen/continuation fixtures in both input-source modes. This is not live API-key acceptance. Earlier credentialed evidence used native Codex OAuth only; it does not establish API-key or OpenAI subscription-sharing OAuth support for every model/account.

Pi 0.87 makes `SessionManager` the source of model-visible context. An omitted `context.remoteCompaction.inputSource` keeps `"legacy"` behavior: first compaction reads `buildSessionProjection()` (falling back to Pi's preparation if unavailable), and recursion uses the opaque window plus the canonically projected branch tail. Both paths honor persisted context edits. Legacy mode still bypasses request-time extension transforms.

Setting `context.remoteCompaction.inputSource: "pi-context-hook"` opts into a narrow runtime bridge around Pi's public `ExtensionRunner.createContext()`. It adds a non-enumerable `ctx.projectContextForCompaction(messages)` method backed by `ExtensionRunner.emitContext()`. This runs the ordered conversation-only and full-transcript phases on the canonical projection. If the bridge, session projection, or recursive summary anchor is unavailable, the extension cancels rather than sending unprojected history.

Retained-message matching uses the SDK projection and source entry IDs, including omissions and replacements made before compaction. Older retained compaction entries contribute no second summary. A compaction whose kept boundary is its own ID retains no earlier messages. Edits to post-checkpoint input are applied to the live tail; an edit targeting history already sealed in an opaque checkpoint blocks replay and recursive compaction with `checkpoint-context-edited`. The encrypted checkpoint cannot be selectively rewritten. Start a new session or navigate before that checkpoint to rebuild from editable history; the raw log remains unchanged.

New checkpoints record `inputProvenance: "pi-context-hook-v1"` or `"legacy-raw-context-v1"`, and replay/recursion reject missing or mode-mismatched markers without searching past the latest compaction. Retained `role: "custom"` messages are optional during replay because they may be changed or removed by context hooks; required user, assistant, and complete tool-call/result content remains ordered and fail-closed.

---

### Artifacts and debugging

With `diagnostics.level: "debug"`, the toolkit writes lifecycle and compaction artifacts under `diagnostics.artifactRoot` (default `~/.pi/agent/artifacts/pi-openai-toolkit/compaction`):

- Each `session_start` writes a lifecycle artifact whose `activation` field records `active` or the exact inactive reason, such as `unsupported-model`, `unsupported-api`, `missing-api-key`, `auth-resolution-failed`, or `tool-name-conflict`.
- `diagnostics.captureRequests` independently writes provider request metadata and payloads, while `diagnostics.captureResponses` writes compact status and structural summaries with complete response and body fields critically redacted. Keep both off unless inspecting a specific request.
- Artifacts always redact Authorization credentials, API keys and tokens, Codex account IDs, and opaque `encrypted_content` or `encrypted_output`, even when `diagnostics.redactSensitiveData` is `false`.
- Compaction failures record protocol, stable reason/status, controlled public error identifiers/hints and the next step. Arbitrary provider messages and raw bodies are never promoted into diagnostics; unknown identifiers are omitted, and network exceptions use a generic content-free message. Debug-enabled headless runs record the same remote-to-native transition without requiring UI notifications.

---

### Provenance

The Remote Context protocol was reverse-engineered from `@howaboua/pi-codex-conversion@3.0.29` (source commit `7021ae48e8efe36a3becc5830d529696ff798e5e`). The Astra compatibility layer is adapted from Oh My Pi 18.1.8 (MIT). Web Search behavior was adapted from [pi-openai-web-search](https://github.com/code-yeongyu/pi-openai-web-search) (commit `3964338`). Attribution details are in [NOTICE](../NOTICE).

Protocol fixtures live in [src/context-management/](../src/context-management/) and must be updated together with any upstream alpha endpoint change. New wire behavior requires fixture-based tests.
