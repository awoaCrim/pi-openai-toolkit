# Credentialed probe: cross-model `remote_compaction_v2`

Date: 2026-08-18

## Question

Can `uwoacrimson/gpt-5.6-luna` produce an opaque `remote_compaction_v2` checkpoint from a Sol session and can `uwoacrimson/gpt-5.6-sol` subsequently consume it without losing exact pre-compaction information?

## Environment

- Endpoint: `https://newapi.uwoacrimson.com/v1/responses`
- API: `openai-responses`
- Active/consumer model: `gpt-5.6-sol`
- Remote compactor model: `gpt-5.6-luna`
- Requests used `store: false`, `stream: true`, `reasoning.effort: "low"`, and a final `{ "type": "compaction_trigger" }` item.
- API keys and encrypted checkpoint bodies were not printed or persisted.
- Each probe used a random exact secret and checked equality, not semantic similarity.

## Probe A: Luna compacts Sol history and recursively recompacts

1. Sol received a random secret and returned `ACK`.
2. Luna compacted the Sol-authored input/output window.
   - Completed successfully.
   - Returned exactly one `type: "compaction"` item.
   - `encrypted_content` length: 1592 characters.
3. Luna consumed its own checkpoint as a control and returned the exact secret.
4. Sol consumed the same Luna checkpoint and returned the exact secret.
5. Luna compacted the first checkpoint plus the Sol follow-up.
   - Completed successfully.
   - Returned exactly one replacement compaction item.
   - `encrypted_content` length: 1784 characters.
6. Sol consumed the replacement checkpoint and again returned the exact secret.

Verdict: PASS.

## Probe B: Luna takes over an existing Sol checkpoint

1. Sol received another random secret and returned `ACK`.
2. Sol produced the first remote-v2 checkpoint.
   - `encrypted_content` length: 1444 characters.
3. Luna consumed that Sol checkpoint and a new `compaction_trigger`, producing a replacement checkpoint.
   - `encrypted_content` length: 1380 characters.
4. Sol consumed Luna's replacement checkpoint and returned the original exact secret.

Verdict: PASS.

## Conclusions

The tested gateway/model pair supports all protocol transitions required by `remoteCompactModel`:

```text
Sol history -> Luna compact -> Sol replay
Luna checkpoint -> Luna recursive compact -> Sol replay
Sol checkpoint -> Luna takeover compact -> Sol replay
```

This evidence is specific to the same `uwoacrimson` provider, `openai-responses` API, base URL, and model pair. It does not establish cross-provider or cross-endpoint checkpoint portability.

## Post-implementation extension-path acceptance

The implemented extension hook was exercised with the real Pi `ModelRegistry`, configured Sol/Luna model metadata and credentials, and a temporary isolated toolkit config. The probe did not print or persist API keys, random secrets, or encrypted checkpoint bodies.

The following flows passed through `session_before_compact` and the implemented `remoteCompactModel` route:

```text
Sol session history -> Luna compact -> Sol exact-secret recall
Luna checkpoint + live tail -> Luna recursive compact -> Sol exact-secret recall
Sol-produced checkpoint -> enable Luna override -> Luna replacement -> Sol exact-secret recall
```

The hook also retained `uwoacrimson/gpt-5.6-sol` as the active model and persisted Sol as the consumer identity with Luna as `compactionModel` for override-produced checkpoints.

Reusable sanitized probe: `post-implementation-extension-probe.ts`.

Verdict: PASS.
