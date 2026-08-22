# Technical Design: remote compaction model override

## 1. Configuration contract

Extend `CompactionConfig` with one optional field:

```typescript
type CompactionConfig = {
  // existing fields...
  remoteCompactModel?: string;
  model?: string; // existing Pi native-summary fallback model
};
```

Canonical JSON:

```json
{
  "compaction": {
    "remoteCompactModel": "uwoacrimson/gpt-5.6-luna",
    "model": "uwoacrimson/gpt-5.6-luna"
  }
}
```

`remoteCompactModel` selects the model used for `remote_compaction_v2`. `model` remains the separate native-summary fallback. Omission or `null` preserves the current active-model remote-v2 path. Parsing follows the existing trimmed `provider/model-id` convention and warning behavior.

## 2. Separate consumer and compactor identities

The current runtime conflates two roles:

- **consumer**: Pi's active session model, which receives normal post-compaction requests and replays the checkpoint;
- **compactor**: the model used only for the synthetic `remote_compaction_v2` request.

Introduce an explicit internal execution shape rather than mutating `ctx.model`:

```typescript
type RemoteCompactionExecution = {
  consumer: ResponsesRuntimeIdentity;
  compactor: NativeCompactionRuntime;
};
```

The consumer remains derived from `ctx.model`. If `remoteCompactModel` is unset, consumer and compactor refer to the same model and behavior is unchanged. If set, resolve the model through `ctx.modelRegistry.find()` and credentials through `getApiKeyAndHeaders()`.

The override is eligible only when consumer and compactor have:

```text
same provider
same supported Responses API identifier
same normalized base URL
```

The compactor's model descriptor, authentication, headers, and model ID drive the synthetic request. Pi's selected model is never changed.

## 3. Persisted checkpoint identity

Keep the existing top-level `NativeCompactionIdentity` fields as the **consumer/replay identity** so current replay lookup remains model-safe and old persisted checkpoints stay valid:

```typescript
type NativeCompactionDetails = NativeCompactionIdentity & {
  // existing fields...
  compactionModel?: NativeCompactionIdentity;
};
```

`compactionModel` records the actual producer when it differs from the consumer; it may also be recorded unconditionally if that makes validation and diagnostics simpler. For legacy entries where it is absent, infer producer identity from the top-level identity.

Replay matching uses the top-level consumer identity. Compact execution uses the currently configured compactor and may feed it an older same-gateway checkpoint produced by either the consumer or the same compactor. This supports enabling the override after an existing Sol checkpoint, as verified by the handoff probe.

## 4. Remote-v2 data flow

### No override

```text
ctx.model
  -> current Responses runtime/auth
  -> serialize with current model
  -> remote_compaction_v2 using current model
  -> persist consumer=current, producer=current
  -> replay to current model
```

### Override configured

```text
ctx.model (Sol consumer)
  -> resolve remoteCompactModel (Luna compactor)
  -> verify same provider/API/base URL
  -> serialize current session or latest checkpoint + live tail for Luna
  -> send model=Luna + compaction_trigger using Luna auth/headers
  -> persist consumer=Sol, producer=Luna
  -> next live provider request remains model=Sol
  -> replay Luna checkpoint to Sol
```

For repeated compaction, resolve the latest checkpoint by consumer identity, then send its opaque window plus the live tail to the currently configured compactor. Do not fall back to an older matching checkpoint when a newer consumer checkpoint exists.

## 5. Request extras and serialization

The live request context cache describes the active session request, not the producer model. Continue looking up extras by the consumer identity so tool schemas, parallel tool settings, reasoning options, service tier, prompt cache key, and text settings survive into the synthetic compact request.

The compact request's `model` field and message serialization use the compactor descriptor. Native Web Search remains excluded because compaction captures request extras before the later Web Search payload transform.

Headers are built from the compactor model headers plus the compactor's resolved authentication headers through `mergeProviderHeaders`; no credential is logged.

## 6. Failure behavior

| Condition | Result |
|---|---|
| `remoteCompactModel` absent/null | Existing current-model remote-v2 path |
| Override equals active model | Existing same-model remote-v2 behavior |
| Malformed model spec | Remote override resolution fails; enter native fallback |
| Model not found | Enter native fallback with warning/debug reason |
| Auth resolution fails | Enter native fallback |
| Unsupported API | Enter native fallback |
| Provider/API/base URL differs from consumer | Enter native fallback; do not attempt cross-endpoint opaque transfer |
| Remote-v2 request aborts | Cancel compaction as today |
| Remote-v2 request fails | Enter existing native fallback |
| Override configured but unusable | Do not retry remote-v2 with the active consumer model |
| Latest checkpoint belongs to another consumer identity | Preserve current fail-open behavior; do not replay stale state |

The native fallback order remains:

```text
configured compaction.model
-> Pi default current-model compaction
```

## 7. Compatibility and migration

- Default configuration is unchanged because `remoteCompactModel` defaults to `undefined`.
- Existing JSON files remain valid.
- Existing native checkpoint details remain valid because the producer field is optional.
- Existing same-model replay behavior remains exact.
- Removing or setting the field to `null` is the rollback: future compactions again use the active model.
- Sessions already containing a same-gateway Sol checkpoint may be handed off to Luna; the credentialed probe verified this transition.

## 8. Testing strategy

### Configuration tests

- default and null behavior;
- trimmed valid model spec;
- malformed type warning;
- unknown fields remain warned.

### Runtime resolution tests

- unset uses current model;
- override resolves Luna and Luna credentials;
- same-model override;
- not found/auth failure/unsupported API;
- provider/API/base URL mismatch rejection.

### Compaction/replay integration tests

- Sol active, Luna compact request model;
- session model remains Sol after compact;
- persisted consumer=Sol and producer=Luna;
- Sol replays Luna checkpoint;
- Luna recursively compacts latest checkpoint + live tail;
- Luna takes over an existing Sol-produced checkpoint;
- manual, threshold, and overflow reasons share the same route;
- current behavior remains when the field is absent;
- override failure enters native fallback without a Sol remote-v2 retry;
- tool/result ordering and request extras remain intact.

### Credentialed acceptance

Repeat the sanitized gateway probe for:

```text
Sol history -> Luna compact -> Sol recall
Sol checkpoint -> Luna handoff compact -> Sol recall
Luna checkpoint -> Luna recursive compact -> Sol recall
```

Do not log the API key or `encrypted_content` body.
