# Toolkit Internals

Developer-facing reference for [pi-openai-toolkit](../README.md). See the [configuration reference](configuration.md) for supported settings and retirement guidance.

---

### Table of Contents

- [Configuration resolution](#configuration-resolution)
- [Codex Fast session control](#codex-fast-session-control)
- [Remote Windows retirement](#remote-windows-retirement)
- [Remote Compaction v2 wire contract](#remote-compaction-v2-wire-contract)
- [Artifacts and debugging](#artifacts-and-debugging)
- [Provenance](#provenance)

---

### Configuration resolution

The single global document is loaded through [src/config.ts](../src/config.ts). [src/config/legacy.ts](../src/config/legacy.ts) owns unversioned compatibility; [src/config/v2.ts](../src/config/v2.ts) validates v2 scopes, resolves exact policy, and records leaf origins. [src/config/policy.ts](../src/config/policy.ts) defines effective values independently of persisted session data.

Feature entrypoints resolve once per public operation and pass that immutable snapshot through awaited helpers. A separately named compaction producer is resolved from the same decoded document for its own identity. Subsequent independent callbacks reload. There is no general cross-event provider transaction, project lookup, singleton policy cache, or config writer. Shared gateway compatibility belongs to the resolver, independently of context mode.

Selected invalid policy blocks dependent operations; unrelated model errors remain reportable without replacing the selected policy. Retired Auto Mode and ancillary window sections are ignored with controlled warnings and create no effective policy. Selecting the removed window mode blocks context instead of implicitly choosing another route. Image choices are checked before auth, uploads, or paid requests. Human /toolkit-config commands inspect effective values, validation or preview-only migration without action APIs or network access; source bytes remain unchanged.

---

### Codex Fast session control

[src/codex-fast/extension.ts](../src/codex-fast/extension.ts) registers the human-only, no-argument /fast toggle and an owned ctx.ui.setStatus() item. It accepts UI-backed TUI/RPC (including pi-web) and older UI contexts without mode; print/JSON and headless commands cannot toggle. Notifications confirm changes, while rendering belongs to the client. Default OFF requests service_tier default; ON requests priority. This is the local request preference, not verified backend acceleration. Fast may increase cost; no config setting, model tool, credential probe, reasoning change or custom footer is added.

Native openai-codex-responses routes qualify. Non-official HTTP(S) openai-responses gateways qualify for recognizable GPT/Codex IDs or an exact Codex gateway identity, including a resolved virtual route. Unknown opaque aliases without that identity, Azure, other APIs and ordinary api.openai.com API-key routes remain untouched. Capability does not establish entitlement.

Version-1 pi-openai-toolkit:codex-fast entries contain only the owning Pi sessionId and enabled boolean and stay outside model context. Reload/resume and active-branch navigation restore the latest valid owned preference; malformed latest metadata defaults OFF. New/forked sessions ignore foreign preferences and start OFF. Model switches show N/A without discarding the saved preference. Missing identity or a failed append cannot report success.

The payload hook snapshots selection and returns a new object only when an eligible ordinary request needs a tier change. Explicit OFF overrides existing Fast/Flex preferences to Standard. Compaction shapes and malformed/foreign payloads stay unchanged. Fast loads after Web Search/images and before Astra; it cannot change pre-search extras cached for separate clients. Native and Toolkit gateway WebSocket adapters compare non-input body fields, so a tier change invalidates an incompatible previous_response_id delta. Offline actual-encoder fixtures live in [test/pi-codex-fast.test.ts](../test/pi-codex-fast.test.ts), not live Fast availability evidence.

---

### Remote Windows retirement

Remote Windows and its execution/compatibility chain are removed: no window tools, history/notes/thread-hint client, window metadata/ingest rewriting, reminders, rollover, maintenance, scoped-window compaction or manual selection recovery remain. Shared ordinary gateway/auth/session-affinity support is separate and retained.

A minimal pure detector recognizes reserved evidence on the **current branch**: codex-context-window custom messages, cleanup compaction strategies or the exact old no-summary sentinel, and pi-openai-toolkit:manual-compact custom records. Malformed, terminal or superseded evidence is also refused; abandoned sibling entries do not affect a clean branch. No old ownership/projector is reconstructed.

Full-context and provider-dispatch boundaries abort legacy-window requests before old plaintext/sentinels can be transmitted. Compression returns an explicit cancellation before remote, standalone, native or host-default dispatch, including Pi/disabled modes. Throwing alone is insufficient because Pi can treat a rejected before-compact hook as absent. Startup/navigation notices do not replace per-operation checks.

Start a new session to continue. Toolkit does not rewrite/delete files, migrate backend notes, restore temporary models/thinking, create a new session automatically or synthesize a continuation. The extension must be loaded to enforce refusal; historical markers alone are not native Pi cutoffs. See [retirement configuration](configuration.md#removed-remote-windows).

---

### Remote Compaction v2 wire contract

Eligible remote-compaction operations use the same ordinary policy for manual, threshold and overflow. APIs are narrowed by context.remoteCompaction.apis. Pi mode leaves clean-session compaction with Pi; retired sessions remain refused in every mode. Pi owns eligibility, scheduling, persistence and continuation; there is no replacement scheduler or manual post-idle driver.

The selected model is the checkpoint **consumer**. An optional configured model is the synthetic **producer**, never a selected-model change. An unset producer or an exact full provider/model-id match reuses the current runtime, auth snapshot and session directly; a current virtual selection reuses its resolved physical runtime. Different provider/model identities still resolve separately and must share the consumer's normalized authenticated effective base URL. Matching bare model IDs or endpoint alone is not same-model equality. A successful exact-match remote path is not a native-summary shortcut.

A compaction_trigger item appended to a separate synthetic streaming Responses request yields one output item of type compaction with nonempty encrypted_content, stored in CompactionEntry.details.compactedWindow. The request retains the current conversation identity; the selected model/thinking never changes and no new session or synthetic continuation is created. On later requests the opaque checkpoint replaces Pi's verified summary anchor ahead of live turns. Missing anchors abort with a notification and content-free failure artifact; sentinel-only payloads are never sent.

The incremental SSE consumer validates the first terminal event and reconciles its checkpoint with prior item evidence. A valid completed frame ends the operation even if the body stays open; best-effort reader cancellation is not awaited. Incomplete EOF, conflicting evidence and terminal errors cannot become successful checkpoints. Astra-only configuration_update items and injected native Web Search are excluded from synthetic compaction.

Missing/invalid checkpoints are not stored. Ordinary compaction may try the gated standalone protocol below; exhausted remote attempts warn once before native text summary. A failed remote attempt selects remoteCompactModel for the configured native tier; remote-ineligible resolution selects nativeFallback.model. Disabled/unset/same-model native selections keep Pi's default, including when nativeFallback.enabled is false. Explicit summary failures, aborts and projection/provenance/context-edit failures cancel; an invalid producer does not silently retry Remote V2 using the consumer.

#### Official API-key standalone fallback

The ordinary path reuses one resolved physical producer, auth snapshot and prepared input. After a qualifying V2 failure, at most one POST goes to https://api.openai.com/v1/responses/compact. Eligibility requires openai-responses, no Codex affinity, public hasConfiguredAuth(model) true and isUsingOAuth(model) false, and final Authorization matching the resolved Bearer key. Missing/throwing/nonboolean metadata is unknown. OAuth, native Codex, Azure and custom gateways do not opt in; provider aliases can qualify at the official endpoint. There is no token-shape inference, extra auth resolution, account/model switch, redirect, capability cache or automatic version/beta header.

Qualifying failures include HTTP 400/404/405/422/501 without auth/quota exclusions, invalid/empty successful V2 checkpoints and recognized unsupported-protocol streamed errors. HTTP 401/403/429, subscription/auth/billing/rate-limit restrictions, network errors, aborts and generic server outages never authorize a probe. OpenAI subscription-sharing OAuth and native Codex OAuth are separate grants, not interchangeable credentials.

Standalone JSON contains model, input, instructions and only validated service-tier/cache fields. It omits previous_response_id, stream/store/tools/reasoning/text and the V2 trigger. A nonempty output needs at least one valid encrypted checkpoint; all items and unknown structured fields, including an own __proto__ key, survive in order. Unlike V2, multiple checkpoints are allowed. Persist the existing openai-native-compact-v1 strategy and honest opaque sentinel with consumer/producer/provenance/deferred metadata and Pi's tokensBefore. Retained assistant text is not a portable summary.

Replay splices the **whole canonical array** between leading prompts and the live tail. Recursion sends the array plus live tail once; retained copies are verified/removed, current deferred schemas load after the whole array and historical declarations stay intact. Standalone cancellation can win before JSON acceptance; a validated V2 terminal wins over later cleanup cancellation. Isolated mock wire and real-Pi persistence/reopen/continuation fixtures cover both input modes; they do not establish live API-key acceptance.

#### Canonical context and replay

Pi SessionManager supplies model-visible context. The default legacy source reads buildSessionProjection() for first compaction (using Pi preparation only when projection is unavailable) and uses the opaque checkpoint plus canonical branch tail recursively. Persisted context edits remain effective; this mode bypasses request-time extension transforms.

The pi-context-hook source uses the existing narrow bridge around ExtensionRunner.createContext(), exposing non-enumerable ctx.projectContextForCompaction(messages) backed by emitContext(). Both ordered conversation-only and full-transcript phases run on canonical input. Missing bridge/projection/recursive summary anchor cancels rather than sending raw unprojected history.

Retained-copy matching uses canonical contributions and real source IDs. Older retained compactions contribute no second summary; a kept boundary equal to the checkpoint itself retains none. Post-checkpoint edits apply to the live tail. An edit targeting sealed history blocks replay/recursion with checkpoint-context-edited: encrypted content cannot be selectively rewritten. Navigate before it or start a new session to rebuild; raw logs stay unchanged.

Checkpoints record pi-context-hook-v1 or legacy-raw-context-v1 provenance. Missing/mismatched provenance is not repaired by searching past the newest checkpoint. Effective endpoint compatibility is authoritative; consumer/producer provider/API/model fields are diagnostic. Optional custom retained messages may be changed/removed by hooks, but required user/assistant/complete tool pairs remain ordered and fail-closed.

Deferred-tool carryover uses valid cache-stack activation metadata without taking ownership of it. Only uniquely matched real schemas are moved to supported additional_tools/tool_search load points immediately after the full checkpoint boundary. Preserve unrelated tools, immutable payloads, unknown fields and current prompt state.

---

### Artifacts and debugging

Debug diagnostics write lifecycle/compaction artifacts under diagnostics.artifactRoot, defaulting to ~/.pi/agent/artifacts/pi-openai-toolkit/compaction. Request capture and compact-response capture are independently opt-in; neither is a reason to log ordinary conversation responses. Keep them off unless diagnosing a specific operation.

Credentials, account IDs and opaque encrypted_content/encrypted_output are critically redacted even when optional redaction is disabled. Failures retain protocol, stable reason/status, controlled public identifiers/hints and next step, not arbitrary provider messages or raw bodies. Debug headless operation records remote-to-native transitions without dumping configuration to stdout. Retired-session diagnostics contain controlled reasons and guidance, never saved note/transcript content.

---

### Provenance

Historical Remote Context work was adapted from @howaboua/pi-codex-conversion@3.0.29 (commit 7021ae48e8efe36a3becc5830d529696ff798e5e); that active feature has been removed. Astra compatibility is adapted from Oh My Pi 18.1.8 (MIT). Web Search behavior was adapted from [pi-openai-web-search](https://github.com/code-yeongyu/pi-openai-web-search) (commit 3964338). Attribution is preserved in [NOTICE](../NOTICE). Current protocol changes require fixture-based ordinary compaction/search/image/transport regressions, not resurrected window fixtures.
