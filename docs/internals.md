# Toolkit Internals

Developer-facing reference for [pi-openai-toolkit](../README.md). The README keeps this protocol and implementation detail out of the installation path. If you are changing wire behavior, fixtures, or the compaction strategy code, start here.

---

### Table of Contents

- [Configuration resolution](#configuration-resolution)
- [Remote Context protocol](#remote-context-protocol)
- [Rollover lifecycle](#rollover-lifecycle)
- [Managed manual compact](#managed-manual-compact)
- [Remote Compaction v2 wire contract](#remote-compaction-v2-wire-contract)
- [Artifacts and debugging](#artifacts-and-debugging)
- [Provenance](#provenance)

---

### Configuration resolution

The single global document is loaded through [src/config.ts](../src/config.ts). [src/config/legacy.ts](../src/config/legacy.ts) owns unversioned compatibility; [src/config/v2.ts](../src/config/v2.ts) validates v2 scopes, resolves exact policy, and records leaf origins. [src/config/policy.ts](../src/config/policy.ts) defines effective values independently of persisted session data. See the [configuration reference](configuration.md) for supported fields and migration limits.

Feature entrypoints resolve once per public operation and pass that immutable snapshot through awaited helpers. A separately named compaction producer is resolved from the same decoded document for its own identity. Subsequent independent callbacks reload; a managed manual handoff retains its initiating context-policy snapshot until selection is restored. There is no general cross-event provider transaction, project lookup, singleton cache, or config state writer. Internal legacy-shaped engine adapters preserve compaction/search algorithms without exposing v2 parsing to consumers. Cross-feature gateway policy belongs to the resolver, not the context enable switch.

Selected invalid policy blocks dependent operations; unrelated model errors remain reportable without replacing the selected model. Retired `autoMode` sections are ignored with a warning; they never create effective policy or invalidate other features. Image choices are checked before auth, uploads, or paid requests. The human `/toolkit-config` command inspects effective values, validation, or a migration candidate without action APIs or network access. Migration is preview-only; source bytes and unknown/dormant content stay untouched.

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

After registration, Pi's published registry is authoritative. Toolkit distinguishes `verified` (all four owned definitions), `excluded` (a readable registry contains none of them), `unverified` (a transient read or partial publication), and `conflict` (registration/API/ownership failure). Only `excluded` is a live-turn downgrade: `context_with_system` strips internal window markers, provider payload/header hooks return no-op results, and the lifecycle artifact records `context-tools-excluded`. Conflicts, unreadable/partial registries, malformed window state and missing gateway identity remain fail-closed for live provider requests.

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
- Maintenance compaction and local-consumer detachment use the same effective-boundary rules. Only a safe current boundary can produce a no-summary compaction; obsolete cleanup must not move the retained start backwards or replace a newer summary/checkpoint. Preparation alone changes no durable state, and cancellation, retry and branch navigation are resolved from current evidence rather than callback acknowledgments. User manual `/compact` still follows the managed handoff below.
- A non-window consumer receives only the effective current context, with the system/tool head preserved and internal window markers removed. When detachment is needed, no compaction producer receives retired Remote history. Once a later ordinary compaction owns effective context, the historical window does not suppress its summary or valid opaque replay. A genuinely new window can retire that checkpoint. Disabling opaque checkpoint generation through `responsesApis` does not disable required replay of an inherited checkpoint; an unsupported transport, authentication failure, or endpoint mismatch aborts the request instead of exposing its placeholder. The legacy `leaveManagedMode` setting remains compatible but does not start a bulk close-out from `model_select` or `agent_settled`.
- Native text summarization delegates prompt construction, tool-result truncation, split-turn requests and output limits to Pi's `compact()`. Toolkit does not use character-count estimates to reject the configured summary model. If its resolution, authentication or summary generation fails, compaction is cancelled with the error and context is preserved; the active model is not an implicit retry target. Disabled/unset/same-model selections retain Pi's default path. Remote-window projection still excludes retired managed history before any producer call.

---

### Managed manual compact

[src/context-management/manual-compact.ts](../src/context-management/manual-compact.ts) owns manual checkpoint duty. It uses public Pi lifecycle and selection APIs; it does not replace the built-in command or patch the scheduler. [src/context-management/window-manager.ts](../src/context-management/window-manager.ts) remains the sole owner of notes pairing, window identity, projection and trim.

1. An active managed `session_before_compact` with reason `manual` validates the source/target policies from one snapshot, actual permitted tools, remaining capacity and backend/account scope. It records the original model/thinking and cancels the native compact attempt. Internal window-bulk maintenance has a separate in-process owner even though Pi also labels it `manual`.
2. The matching `session_compact_failed` callback launches duty only after Pi is idle. Public `setModel` changes the session selection, and a visible `sendUserMessage` rebuilds the target's normal prompt/tools. Delivery is observed through `message_start`; return from the fire-and-forget send API is not proof. A delivery timeout restores an abandoned idle selection.
3. The existing `new_context` gate additionally requires a successful paired notes result after this operation and any later delivered user message. It records the exact target window before queueing a context-only marker, and returns a terminating result. Ordinary tools are blocked during checkpoint duty. Normal `new_context` outside this operation is unchanged.
4. A terminating result alone does not stop mixed batches or queued messages. At `turn_end`, Toolkit requests abort without awaiting idle; context/request guards also refuse an unsafe continuation. The standard Responses and native Codex transports must not send an already-aborted continuation. Pi can deliver queued user content during that stop; it remains persisted and ordered for the original model.
5. At `agent_settled`, after Pi has flushed custom messages, the controller verifies the exact durable marker and fresh checkpoint, restores original model/thinking, and sends one visible receipt-reading continuation. Pi 0.87 defers that continuation until every settled handler has returned, so later observers still see an idle session. Restoration finishes before the next provider request; marker `message_end` alone is not proof of persistence.

Versioned `pi-openai-toolkit:manual-compact` custom entries record operation/session/branch/window identities, exact model keys, original thinking and phase. They contain no credentials, transcript copy or note contents. Reload/navigation reads the current branch and only recovers still-owned selection; it never retries notes, rollover or paid inference. A newer user model/thinking selection ends ownership. Failed restoration stays durable and blocks further provider requests until recovery or an explicit user selection.

The underlying native compact promise still rejects its intentional cancellation. Empty/already-compacted sessions can fail before the extension hook. This is a separate handoff operation, not a fabricated successful native compaction. An observed user cancellation before the owned checkpoint stop restores selection without automatically resuming. Tests use the official Pi runtime, disk-backed sessions, isolated HOME/settings and synthetic Responses/native Codex traffic in [test/pi-managed-compact.test.ts](../test/pi-managed-compact.test.ts); they assert every request's model/thinking, marker/note order, retained tool head and queue preservation.

---

### Remote Compaction v2 wire contract

v2 is what an uncovered session gets. Any model that Remote Context declines, such as a gateway without an exact transport opt-in, can still compact through v2 when its API appears in `context.remoteCompaction.apis`. Compaction generation follows the active strategy. Across mode changes, an already-persisted checkpoint remains authoritative until a safe newer window or compaction replaces it; a historical window identity alone must not suppress checkpoint replay.

A `compaction_trigger` item appended to the live streaming request yields one output item of `type: "compaction"` with non-empty `encrypted_content`, stored in `CompactionEntry.details.compactedWindow`. On later requests the opaque checkpoint is replayed ahead of live turns, with no text summary. Replay fails closed: if the summary anchor cannot be located, the request is aborted with a notification and a content-free failure artifact. The sentinel-only payload is never sent.

The incremental SSE consumer validates the first terminal event and reconciles its checkpoint with prior item evidence. A valid completed frame ends the operation even if the HTTP body stays open; reader cancellation is best-effort cleanup and is not awaited. Incomplete frames at EOF, conflicting checkpoint evidence and terminal errors cannot become successful checkpoints.

A v2 response with a missing or empty checkpoint is never stored, and the `nativeFallback` tier is skipped. Pi's own threshold drives the next attempt, which may use `remoteCompactModel` when configured. `remoteCompactModel` must resolve to the same effective base URL as the active model.

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

---

### Provenance

The Remote Context protocol was reverse-engineered from `@howaboua/pi-codex-conversion@3.0.29` (source commit `7021ae48e8efe36a3becc5830d529696ff798e5e`). The Astra compatibility layer is adapted from Oh My Pi 18.1.8 (MIT). Web Search behavior was adapted from [pi-openai-web-search](https://github.com/code-yeongyu/pi-openai-web-search) (commit `3964338`). Attribution details are in [NOTICE](../NOTICE).

Protocol fixtures live in [src/context-management/](../src/context-management/) and must be updated together with any upstream alpha endpoint change. New wire behavior requires fixture-based tests.
