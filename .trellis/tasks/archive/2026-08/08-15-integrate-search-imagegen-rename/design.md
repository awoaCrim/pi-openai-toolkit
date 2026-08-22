# Technical Design: pi-openai-toolkit

## 1. Scope and architectural decision

This task converts the repository into one Pi package with two independently selectable extension entry points:

```text
pi-openai-toolkit/
├── extensions/
│   ├── compaction.ts
│   └── web-search.ts
└── src/
    ├── existing compaction modules
    └── web-search/
        ├── extension.ts
        ├── payload.ts
        ├── prompt.ts
        └── types.ts
```

The task remains a single implementation unit rather than a parent/child tree because the package manifest, nested configuration contract, extension load order, tests, docs, and repository rename must move together. Splitting them would leave intermediate states whose package entry points or config schema are inconsistent.

Image generation is not part of this architecture.

## 2. Public package surfaces

### Package identity

- npm package: `pi-openai-toolkit`
- GitHub repository: `awoaCrim/pi-openai-toolkit`
- package description: OpenAI-focused Pi toolkit providing remote Responses compaction and native Web Search
- Pi extension entries, in this exact load order:

```json
{
  "pi": {
    "extensions": [
      "./extensions/compaction.ts",
      "./extensions/web-search.ts"
    ]
  }
}
```

Load order is a contract: compaction's `before_provider_request` handler runs first; Web Search receives and modifies the final live payload afterward.

### Runtime identities

Use branding-specific IDs only for current runtime/UI/artifact labeling:

```text
pi-openai-toolkit
pi-openai-toolkit:compaction
pi-openai-toolkit:web-search
```

Keep these persisted provider-protocol identifiers unchanged:

```text
openai-native-compact-v1
openai-remote-compaction-v2
```

They describe stored data formats, not the former package brand.

## 3. Configuration interface

Canonical path:

```text
~/.pi/agent/extensions/pi-openai-toolkit/config.json
```

Canonical shape:

```json
{
  "compaction": {
    "enabled": true,
    "allowCompactionContinuityBreak": false,
    "model": null,
    "thinkingLevel": "off",
    "responsesApis": [
      "openai-responses",
      "openai-codex-responses"
    ],
    "notifyOnLoad": false,
    "debug": false,
    "logProviderPayloads": false,
    "logCompactResponses": false,
    "redactSensitiveData": true,
    "artifactRoot": "~/.pi/agent/artifacts/pi-openai-toolkit/compaction"
  },
  "webSearch": {
    "enabled": true,
    "apis": [
      "openai-responses"
    ]
  }
}
```

The config module owns parsing, defaults, warnings, and path resolution. It returns both feature sections from one read. Each extension consumes only its section.

No runtime reads from the legacy `pi-better-compaction-v2` path. Migration is documentation-only.

Unknown or invalid fields produce warnings and fall back per field, following the existing config parser's behavior. `webSearch.apis` may only narrow the known initial set (`openai-responses`); it cannot opt into unvalidated API identifiers.

## 4. Extension seams

### Compaction extension

`extensions/compaction.ts` is a thin adapter that exports the existing compaction extension implementation. Existing compaction modules remain responsible for:

- `session_before_compact`
- live Responses opaque replay rewriting
- request-context caching
- native fallback
- compaction artifacts/debugging

The implementation changes only where required for the nested config and new branding paths/IDs.

### Web Search extension

`extensions/web-search.ts` exports a focused extension adapter. Its implementation registers:

- `session_start`
- `before_agent_start`
- `before_provider_request`

It registers no local Pi tool and no slash command.

## 5. Web Search contracts

### Supported API

Initial known set:

```ts
const WEB_SEARCH_CAPABLE_APIS = ["openai-responses"] as const;
```

The active model must use a configured API in this known set and in `webSearch.apis`.

### Payload transformation

The pure payload transformer accepts the active API, config, and unknown payload, and returns a discriminated result describing whether it:

- skipped an unsupported/disabled/non-object request;
- preserved an existing local function-tool conflict;
- preserved an existing native tool;
- injected a native tool and source include value.

Rules:

1. Non-object payloads and unsupported APIs are returned unchanged.
2. If `tools` contains `{ type: "function", name: "web_search" }`, return unchanged with collision outcome.
3. Existing `{ type: "web_search" }` or `{ type: "web_search_preview" }` is preserved and not duplicated.
4. Otherwise append `{ type: "web_search" }`.
5. Add `web_search_call.action.sources` to `include` once while preserving existing valid values.
6. Never mutate the original payload or nested arrays.

### Prompt guidance

The prompt module owns a marked Web Search section. It appends the section only when:

- Web Search is enabled;
- the current API is supported;
- active Pi tools do not contain a local `web_search` function tool;
- the section marker is not already present.

### Local-tool conflict

At `session_start`, call `pi.getAllTools()`. If a local tool named `web_search` is registered and UI is available, notify once:

```text
pi-openai-toolkit:web-search: local web_search tool detected; local tool takes precedence and native OpenAI Web Search will be skipped while active
```

At request time, the provider payload is authoritative. If a local function tool named `web_search` is present, preserve it and skip native injection.

At prompt time, use `pi.getActiveTools()` to omit native-specific guidance while the conflicting local tool is active.

## 6. Hook ordering and compaction isolation

Package extension order guarantees:

```text
Pi payload
  -> compaction before_provider_request
     - cache original compact-relevant fields
     - optionally rewrite opaque replay input
  -> Web Search before_provider_request
     - inject native live-request tool/include
  -> provider
```

This prevents native Web Search from entering `request-context-cache` and therefore from being copied into synthetic `remote_compaction_v2` requests.

Web Search must not import compaction state or know about checkpoints. The ordering contract is verified through integration tests over chained handlers/final payloads.

## 7. Failure behavior

The extension does not intercept or retry provider failures caused by unsupported hosted search:

- preserve the provider's original error;
- do not replay the model turn;
- do not modify session/compaction state;
- instruct users through documentation to set `webSearch.enabled` to `false` and retry.

The validated NewAPI deployment returns completed `web_search_call` items and URL citation annotations. `action.sources` is optional even when requested.

## 8. License and attribution

Add a distributed `NOTICE` file containing:

- attribution to `code-yeongyu/pi-openai-web-search`;
- inspected upstream commit `39643380682f02f306b0de2673ff136c45ccc2a2`;
- Yeongyu Kim's MIT copyright and permission notice or the complete upstream notice required by its license;
- a statement that the implementation was adapted for `pi-openai-toolkit` and the `@earendil-works/*` Pi interfaces.

Include `NOTICE` in package files and reference it from README.

## 9. Rename and migration

Code/runtime changes:

- package name, description, repository, bugs, homepage, keywords;
- Pi extension entries and package file allowlist;
- config directory/path;
- runtime notification/debug extension IDs;
- default artifact root;
- README title, install commands, paths, examples, mutual-exclusion notes, and migration section;
- smoke-test descriptions and path assumptions.

Manual migration instructions:

1. uninstall/disable `pi-remote-compact`;
2. install `pi-openai-toolkit`;
3. manually translate the flat old config into nested `compaction` fields;
4. configure `webSearch` or accept defaults;
5. keep old session JSONL files;
6. do not enable old and new packages simultaneously.

External repository rename occurs only after source verification and a work commit. Use authenticated GitHub tooling to rename `awoaCrim/pi-remote-compact` to `awoaCrim/pi-openai-toolkit`, then update the local `origin`. Do not publish npm in this task.

Rollback:

- before GitHub rename: revert the work commit;
- after GitHub rename: rename the repository back and restore the old remote URL, then revert the work commit;
- no user files are automatically migrated, so rollback has no filesystem reversal step.

## 10. Verification strategy

### Unit tests

- nested config defaults, overrides, warnings, path resolution, and no legacy fallback;
- Web Search API guard;
- native injection and idempotence;
- existing native tool preservation;
- local function-tool conflict preservation;
- source include preservation/deduplication;
- immutable payload transformation;
- prompt guidance enablement, deduplication, unsupported API, disabled state, and active conflict;
- startup conflict warning exactly once.

### Integration tests

- package registers both entry points in correct order;
- compaction sees/caches the pre-search payload;
- Web Search modifies the final live payload after compaction replay rewrite;
- synthetic remote compaction request does not contain native Web Search;
- existing compaction validation suite passes unchanged in behavior.

### Packaging/load tests

- typecheck;
- complete Bun suite;
- separate Pi smoke load for each entry point;
- package-level Pi smoke load;
- `npm pack --dry-run --json` contains both entries, required source, README, LICENSE, and NOTICE;
- optional credentialed NewAPI acceptance probe confirms `web_search_call` and URL citation behavior without requiring `action.sources`.
