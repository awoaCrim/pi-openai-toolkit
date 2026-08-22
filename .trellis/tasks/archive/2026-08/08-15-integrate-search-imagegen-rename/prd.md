# Integrate OpenAI web search and rename package

## Goal

Evolve the current compaction-focused Pi package into `pi-openai-toolkit`, preserving remote compaction while adding the useful native Web Search behavior from `code-yeongyu/pi-openai-web-search`.

The package will contain two independently selectable Pi extension entry points:

1. Remote compaction
2. OpenAI native Web Search

Image generation is explicitly excluded from this task and from the renamed package's initial scope.

## Requirements

### Package structure

- Rename the GitHub repository and npm package surfaces to `pi-openai-toolkit`.
- Ship one npm package with two independent Pi extension entry points: compaction and Web Search.
- Keep both capabilities independently configurable, loadable, and testable.
- Use one canonical configuration file at `~/.pi/agent/extensions/pi-openai-toolkit/config.json`, with separate nested `compaction` and `webSearch` sections.
- Place compaction-specific fallback, Responses API, logging, debug, and artifact options under `compaction`; place Web Search enablement and supported API options under `webSearch`.
- Share only contracts and utilities that are genuinely common; Web Search must not become coupled to compaction internals.

### Existing compaction behavior

- Preserve existing remote-compaction behavior, opaque replay, native fallback, tests, and supported provider/API contracts.
- Preserve provider-protocol and persisted compaction data identifiers that are not branding-specific.
- Ensure Web Search mutation happens after live-request compaction replay rewriting and is not cached into synthetic remote-compaction requests.

### Web Search behavior

- Adapt the user-visible behavior of `code-yeongyu/pi-openai-web-search` to the official Pi interfaces and this repository's `@earendil-works/*` dependency family.
- Inject OpenAI's native `{ "type": "web_search" }` tool idempotently for explicitly supported live Responses requests.
- Preserve an existing native `web_search` or `web_search_preview` definition without duplication.
- Request `web_search_call.action.sources` metadata idempotently, while tolerating gateways that omit the `action.sources` array but still return standard URL citation annotations.
- Add deduplicated Web Search prompt guidance for supported live model turns.
- If Pi has a registered local function tool named `web_search`, preserve that local tool and skip native Web Search injection whenever the conflicting function is present in the live provider payload.
- During `session_start`, inspect `pi.getAllTools()` and show one UI warning when a local `web_search` tool is registered, explaining that the local tool takes precedence and native OpenAI Web Search will be skipped while the conflict is active.
- Do not append native Web Search prompt guidance for turns where the conflicting local function tool takes precedence.
- Allow Web Search to be enabled or disabled independently from compaction; default it to enabled for supported requests.
- Initially support native Web Search only when the active API is `openai-responses`; do not enable it for `openai-codex-responses`, `azure-openai-responses`, or other API identifiers.
- When a nominally supported gateway rejects native Web Search, do not automatically retry or replay the model turn; preserve the provider's original error, leave session/compaction state unchanged, and require the user to disable `webSearch.enabled` before retrying.

### Rename and migration

- Perform a clean rename: runtime code uses only the new package name, extension IDs, configuration paths, artifact paths, repository URLs, and documentation names.
- Do not retain automatic fallback to legacy branded package/config/artifact paths.
- Provide manual migration instructions from `pi-remote-compact` and `pi-better-compaction-v2` configuration paths.
- Do not automatically delete or move user files.

### License and attribution

- Preserve this repository's MIT license.
- Include the required MIT copyright/permission notice and attribution for the Web Search behavior adapted from `code-yeongyu/pi-openai-web-search` at the researched upstream commit.

## Confirmed Upstream Facts

- The upstream Web Search extension registers no local Pi tool or slash command.
- It uses `before_provider_request` to modify the provider payload and `before_agent_start` to append prompt guidance.
- It performs no direct HTTP requests and delegates authentication to Pi's active provider/model.
- Its tested behavior includes native-tool injection, source metadata inclusion, duplicate prevention, function-tool collision handling, and enable/disable parsing.
- It targets `openai-responses` and `azure-openai-responses`; support in this package must be based on explicit validation rather than mechanically copying or unioning API lists.
- It is MIT licensed and includes both LICENSE and NOTICE files.
- The deployment at `https://newapi.uwoacrimson.com/v1` was live-probed with its configured `gpt-5.5` `openai-responses` model: a native Web Search request returned HTTP 200, response status `completed`, completed `web_search_call` items, and a `url_citation` annotation.
- The same deployment did not return `web_search_call.action.sources` even when requested through `include`; its search action contained query fields and its answer remained attributable through URL citation annotations. The integration must therefore treat the sources array as optional.

## Deliverables

1. Web Search extension entry point and focused pure payload/prompt helpers.
2. Web Search unit and integration tests, including compaction hook ordering.
3. Package/repository/configuration rename to `pi-openai-toolkit`.
4. Attribution, installation, configuration, usage, and manual migration documentation.
5. Updated packaging and Pi loading smoke tests for both extension entry points.

## Acceptance Criteria

- [x] Existing remote-compaction tests and supported flows continue to pass.
- [x] Supported live Responses requests receive exactly one native Web Search tool and the source metadata include value.
- [x] The validated NewAPI deployment can complete a Web Search turn with at least one `web_search_call` and an attributable URL citation; omission of `action.sources` does not break the turn.
- [x] Unsupported or disabled requests remain unchanged.
- [x] Web Search prompt guidance is present exactly once on supported turns.
- [x] Web Search is not copied into synthetic remote-compaction requests.
- [x] A registered local `web_search` function tool triggers one startup warning; when present in a live payload it is preserved, native Web Search is skipped, and native-specific prompt guidance is omitted.
- [x] Compaction and Web Search can each load and operate without requiring the other.
- [x] Required upstream license notice and attribution are distributed with the package.
- [x] `pi-openai-toolkit` is reflected consistently across approved public and runtime branding surfaces.
- [x] Manual migration instructions are documented; runtime code contains no legacy branded path aliases.
- [x] Type checking, tests, package dry-run, and Pi extension loading checks pass.

## Out of Scope

- Image generation, `/img` commands, image artifacts, galleries, studios, sketch tools, or image-provider dependencies.
- Publishing a new npm release.
- Deleting the old GitHub repository or npm package.
- Changing protocol or persisted compaction data identifiers solely for branding purposes.
- Adding unrelated search providers or implementing a separate local search engine.

