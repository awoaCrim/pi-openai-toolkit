# `pi-imagegen` integration research

Upstream: <https://github.com/Jon-Vii/pi-imagegen>  
Snapshot reviewed: commit `2ca63486547fdf780e84b105548783bc9de1e5c3` on `main` (`pi-imagegen` 0.2.0).  
Primary upstream files: `imagegen.ts`, `README.md`, `package.json`, `.gitignore`. The repository contains no `LICENSE` file, tests, build configuration, lockfile, or CI configuration.

## Executive recommendation

Integrate a **small, clean-room/ported core first**, not the upstream file wholesale:

1. Agent tool: `imagegen` with prompt, size, quality, background, output format, thinking, references, and optional output path.
2. Minimal `/img` commands: `gen`, `list`, `path`, `open`, `reveal`, and `info`.
3. Local image saving plus adjacent metadata and a bounded index.
4. One supported backend initially: Pi's existing `openai-codex` OAuth session, Codex Responses dispatcher, and `gpt-image-2`.
5. Defer browser studio, sketch canvas, batch gallery, and live local HTTP/SSE server until authentication, lifecycle, path safety, artifact scaling, and compaction behavior are designed and tested.

The upstream implementation is a useful behavioral prototype, but it is an 1,815-line monolith with no tests, relies on private/beta backend details, has a decorative-but-unenforced studio token, and returns large inline image data that can materially affect this repository's compaction/replay path.

## Package structure and dependencies

### Upstream package

- `package.json`
  - package: `pi-imagegen`, version `0.2.0`, ESM.
  - Pi entry point: `pi.extensions = ["./imagegen.ts"]`.
  - published files: `imagegen.ts`, `README.md`; `package.json` is included automatically by npm.
  - peer dependencies, all wildcarded:
    - `@mariozechner/pi-ai`
    - `@mariozechner/pi-coding-agent`
    - `@mariozechner/pi-tui`
    - `typebox`
  - no scripts, engines, dev dependencies, or pinned compatibility range.
- `imagegen.ts`
  - all extension logic, backend client, persistence, commands, tool, local server, HTML, CSS, and browser JavaScript in one 82,880-byte/1,815-line source file.
- `README.md`
  - user documentation and installation/auth instructions.
- `.gitignore`
  - ignores local generated images and npm artifacts.

`npm pack --dry-run` at the reviewed snapshot produced only `README.md`, `imagegen.ts`, and `package.json` (87,657 unpacked bytes). There is no separately packaged UI asset or license text.

### Integration dependency conflict

This repository uses the forked Pi package namespace in `package.json` and source imports:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

Upstream `imagegen.ts:16-19` imports the original `@mariozechner/*` packages plus `typebox`. Copying it unchanged would introduce unresolved or duplicate Pi package families and possibly incompatible runtime/type identities. Port interfaces to the `@earendil-works/*` APIs used by this repository. A renderer may additionally require the fork's Pi TUI package, if available; otherwise avoid the custom `Text` renderer in the first cut.

## User-facing capabilities

Sources: upstream `README.md`; implementations in upstream `imagegen.ts`.

### Model-facing tool

`imagegen.ts:58-83` defines `TOOL_PARAMS`; `imagegen.ts` near the extension registration defines `pi.registerTool({ name: "imagegen", ... })`.

Parameters:

- required `prompt: string`
- optional `size`: `auto`, `1024x1024`, `1536x1024`, `1024x1536`
- optional `quality`: `auto`, `low`, `medium`, `high`
- optional `background`: `auto`, `opaque`, `transparent`
- optional `outputFormat`: `png`, `webp`, `jpeg`
- optional dispatcher `thinking`: `off`, `minimal`, `low`, `medium`, `high`; default `low`
- optional `referencePaths: string[]`
- optional `outputPath: string`

The tool saves the image, returns text describing the saved path, and returns an inline Pi image content block containing the full base64 image. It also emits an `imagegen:generated` event.

### `/img` command namespace

Registered with `pi.registerCommand("img", ...)` near the end of `imagegen.ts`.

- `/img gen` / aliases `generate`, `create`
- `/img batch` / alias `variants`, capped at 12 sequential images
- `/img styles`
- `/img studio` / aliases `gallery`, `browse`
- `/img list` / aliases `ls`, `recent`, capped at 50 displayed items
- `/img open`
- `/img reveal`
- `/img path`
- `/img info`
- `/img help`

Argument parsing is implemented by `parseImgArgs` at `imagegen.ts:266`. It recognizes style, size, quality, background, format, thinking/reasoning, and output flags. It is a simple quoted-token parser, not a full shell parser.

### Style presets

`STYLE_PRESETS` at `imagegen.ts:32-56` contains:

- `minecraft-screenshot`
- `minecraft`
- `poster`
- `wallpaper`

Presets append prompt text and may set size, quality, and background. Explicit command/tool options override preset defaults. The browser studio exposes only the first Minecraft variant plus poster and wallpaper.

### Browser studio

`renderStudioPage` begins at `imagegen.ts:588`; the local server and routes are inside the default extension function later in the file.

Capabilities:

- image history wall and batch/contact-sheet view
- modal preview and keyboard navigation
- rerun, variation prompt, copy prompt, open, reveal, and add-as-reference actions
- generation controls for style, aspect/size, quality, thinking, and counts 1/2/4/6/9
- previous generated images as real `input_image` references
- 1024×1024 sketch canvas with brush, eraser, line, rectangle, ellipse, colors, size, undo/redo, and PNG reference upload
- live refresh over server-sent events

The studio binds an ephemeral server to `127.0.0.1` on an OS-selected port and opens the system browser.

## Pi interfaces, hooks, and runtime facilities used

Important upstream interfaces in `imagegen.ts`:

- `ExtensionAPI`, `ExtensionContext`, `getAgentDir`, `withFileMutationQueue` from Pi coding agent (`imagegen.ts:17`).
- `StringEnum` from Pi AI and TypeBox `Type`/`Static` for tool schema (`imagegen.ts:16,19,58-83`).
- `Text` from Pi TUI for custom rendering (`imagegen.ts:18`).
- `ImagegenMetadata` (`imagegen.ts:85-108`) and `ImagegenDetails` (`imagegen.ts:110-125`).
- local `ImagegenContext` (`imagegen.ts:452-456`): `cwd`, optional current model descriptor, and `modelRegistry.getApiKeyForProvider`.
- `generateImage(...)` (`imagegen.ts:460`): central auth/request/parse/save operation.

Pi registrations and calls:

- `pi.on("session_start", ...)`: retain the latest context for studio requests.
- `pi.on("session_shutdown", ...)`: end SSE clients and close the local HTTP server.
- `pi.registerMessageRenderer("imagegen-result", ...)`.
- `pi.registerTool({ name: "imagegen", ... })`.
- `pi.registerCommand("img", ...)`.
- `pi.events.emit("imagegen:generated", details)` after generation.
- `pi.sendMessage(...)` for visible command results and manual studio URL fallback.
- `ctx.ui.notify(...)`, `ctx.ui.setStatus(...)`, `ctx.ui.getEditorText()`, and `ctx.ui.setEditorText(...)`.
- `ctx.cwd`, `ctx.signal`, `ctx.model`, and `ctx.modelRegistry`.
- `getAgentDir()` for default artifacts.
- `withFileMutationQueue(path, callback)` for image and metadata writes.

The studio also exposes an `/api/insert` route that inserts `@<image path>` into Pi's editor, although the reviewed browser UI does not visibly call that route.

## Backend, configuration, and authentication model

### Supported providers and models

Hard-coded constants at `imagegen.ts:21-24`:

- Pi credential provider: `openai-codex`
- backend base URL: `https://chatgpt.com/backend-api`
- default dispatcher/Responses model: `gpt-5.5`
- image generation model: `gpt-image-2`

No other image provider/model is implemented. In particular, there is no public OpenAI Images API/API-key path, Azure OpenAI, OpenRouter, Gemini, Stability, Replicate, local diffusion, or configurable compatible endpoint.

If Pi's currently selected model has provider `openai-codex`, its model ID replaces the hard-coded `gpt-5.5` dispatcher. Otherwise the request still uses `gpt-5.5`. The image tool itself remains `gpt-image-2`.

### Authentication

- `generateImage` calls `ctx.modelRegistry.getApiKeyForProvider("openai-codex")` (`imagegen.ts:467`).
- The returned value is assumed to be a ChatGPT/Codex OAuth JWT.
- `decodeJwtPayload` and `getAccountId` (`imagegen.ts:132-147`) extract `https://api.openai.com/auth.chatgpt_account_id` without signature verification; verification is unnecessary for this local header-extraction use, but the code assumes a stable claim shape.
- The request sets bearer authorization, `chatgpt-account-id`, `originator`, `OpenAI-Beta: responses=experimental`, session/request IDs, content negotiation, and a custom user agent (`imagegen.ts:484 onward`).
- Missing credentials direct the user to `/login` and the ChatGPT Plus/Pro Codex option.

This differs from this compaction extension's newer auth abstraction in `src/runtime.ts`, which uses `modelRegistry.getApiKeyAndHeaders(model)` so provider-specific headers can be preserved. Integration should use the repository's established auth/header resolver rather than upstream's token-only shortcut where possible.

### Request shape

`buildRequest` is immediately before `parseSseForImage` (roughly `imagegen.ts:339-388`). It sends:

- a fresh one-turn Responses input containing `Generate this image: <prompt>`
- optional local references encoded as data-URL `input_image` blocks
- dispatcher instructions to call exactly one image-generation tool
- `store: false`, `stream: true`
- `tool_choice: "auto"`, `parallel_tool_calls: true`
- `text.verbosity: "low"`
- one tool `{ type: "image_generation", model: "gpt-image-2", moderation: "auto", output_compression: 100, ... }`
- optional reasoning settings and `include: ["reasoning.encrypted_content"]`

Each generation uses a fresh random `prompt_cache_key`/session ID. It does not include the active Pi transcript, previous response ID, or compaction checkpoint.

### Configuration

There is no configuration file or environment-variable model. Endpoint, provider, models, moderation, compression, instructions, output root, and style presets are source constants. User variation is only through tool/command/studio request parameters and `outputPath`.

## Output and artifact behavior

### Generated image

- Default: `~/.pi/agent/generated-images/<ISO timestamp>-<image-call-id>.<ext>` (`defaultOutputPath`, `imagegen.ts:158-162`).
- A relative `outputPath` resolves against `ctx.cwd`; a leading `@` is stripped.
- An output path without an extension is treated as a directory and gets `<image-id>.<ext>` appended (`resolveOutputPath`, `imagegen.ts:164-171`).
- Parent directories are created and bytes are written through `withFileMutationQueue` (`saveImage`, `imagegen.ts:173-179`).

### Metadata

`ImagegenMetadata` records:

- creation time and original/styled prompt
- provider, dispatcher model, image model, image ID
- saved path, metadata path, MIME type, optional revised prompt
- size, quality, background, format, thinking
- optional reference IDs/paths
- optional batch ID/prompt/index/count
- generated versus sketch kind

Each image gets:

1. an adjacent JSON sidecar with the image extension replaced by `.json`; and
2. a duplicate global index record at `~/.pi/agent/generated-images/index/<imageId>.json`.

The duplicate index makes externally directed outputs discoverable by `/img list` and the studio. `readRecentMetadata` recursively walks **all** JSON under `generated-images`, parses all candidates, deduplicates by `imageId`, sorts by `createdAt`, and only then applies the requested limit (`imagegen.ts:182-239`). This is simple but unbounded in I/O and duplicates metadata.

### Batches and sketches

- Batches: `~/.pi/agent/generated-images/batches/<timestamp-slug>/01.png`, `02.png`, etc., plus `batch.json`.
- Batch generation is sequential, not parallel, and capped at 12.
- Sketches: `~/.pi/agent/generated-images/sketches/<timestamp>-sketch_<uuid>.png` plus normal metadata/index records.
- References are embedded into backend requests as full base64 data URLs.

### Tool/session output

The `imagegen` tool result contains both:

- text with the saved path and optional revised prompt; and
- `{ type: "image", data: <full base64>, mimeType }`.

Therefore the generated image may exist simultaneously as a disk file, adjacent metadata, index metadata, and a base64 image in Pi session/tool-result state.

## Tests and quality signals

There are no upstream tests, test scripts, typecheck scripts, fixtures, CI workflows, or declared supported Pi/Node versions. The README explicitly warns that the package relies on Pi internals and the Codex Responses backend.

Minimum tests before integration:

- exact request body/header snapshots and dispatcher-model selection
- JWT/account-claim errors and auth/header resolution
- SSE chunk fragmentation, CRLF framing, multiple events per chunk, malformed JSON, backend failure, EOF, and abort
- image format/MIME/path extension consistency
- path traversal/arbitrary-output and reference-file policy
- metadata sidecar/index deduplication and large-history behavior
- command parsing, styles, batches, and count/reference limits
- studio token enforcement, local-origin checks, CORS/CSRF behavior, server lifecycle, concurrent calls, and request size limits
- tool-result image behavior through normal provider requests, remote compaction, persisted JSONL, opaque replay, and debug artifact logging

## Licensing and attribution

Evidence:

- upstream `package.json` declares `"license": "MIT"`;
- upstream `README.md` says MIT and links to a GitHub `LICENSE` path;
- the reviewed repository has **no `LICENSE` file**;
- the npm package dry run contains no license text or copyright notice.

Risk: MIT permission is normally conditioned on including the copyright and permission notice in copies or substantial portions. Package metadata saying `MIT` does not provide the exact upstream copyright/permission notice to retain. Before copying substantial source or the studio HTML/CSS/JavaScript, obtain a canonical license file/notice from the author or a commit/tag that contains it. Then retain that notice in the distributed package/source and document the derivation. Until then, prefer independent reimplementation from observed behavior and retain an engineering attribution/link in the research/design notes.

## Reuse versus reimplementation

### Behavior/design worth reusing

Subject to resolving the license notice:

- the compact tool parameter vocabulary and enum set (`TOOL_PARAMS`)
- the one-turn Codex Responses image-dispatch request pattern (`buildRequest`)
- the metadata fields and adjacent-sidecar concept (`ImagegenMetadata`)
- default agent-directory artifact location
- use of `withFileMutationQueue`
- command UX and target resolution (`latest`, numeric recent item, or path)
- real reference images as `input_image` data URLs
- `imagegen:generated` as a namespaced integration event
- explicit session-shutdown cleanup for studio resources

### Code that should be reimplemented/refactored

- **Backend client and SSE parser:** upstream `parseSseForImage` only searches for `\n\n`, does not robustly normalize CRLF, does not process a final unterminated event, ignores most completion semantics, and returns the first image call. Reuse or extract the tested SSE/event machinery already developed for this repository's Responses compaction client.
- **Auth/header resolution:** use this repository's `getApiKeyAndHeaders`/provider-header pattern, then add the ChatGPT account header intentionally. Do not duplicate token-only provider logic.
- **Storage/index:** avoid recursive full-tree scans and duplicate sidecars as the sole index. Use an append/update index or bounded manifest with corruption recovery.
- **Path/reference policy:** validate output extensions, allowed output roots (or require explicit opt-in for arbitrary paths), real image MIME/signatures, readable file size limits, and reference count/byte limits.
- **Extension decomposition:** create modules for schema/options, auth, request construction, SSE parsing, generation service, storage/index, command/tool adapter, studio server, and studio assets. Do not import the 82 KB monolith.
- **Studio:** serve separate static assets, enforce a real capability token, add security headers, validate methods/content types, and test lifecycle/concurrency. Consider omitting it from the initial integration.
- **Renderers:** avoid a hard dependency on a second Pi TUI package family. Use the local fork's renderer API or plain tool/command results.

## Concrete integration risks with the compaction extension

1. **Large inline images enter compaction/replay.** Upstream returns the full base64 image as tool-result content. This repository's `src/serializer.ts` serializes image-bearing tool results as `function_call_output` with data-URL `input_image` blocks when the active model accepts images. Remote compaction can therefore resend megabytes of generated image data, increasing latency, request size, failure rate, and cost. A deliberate policy is required: preserve, compress, omit with a textual/path placeholder, or keep only selected references.

2. **Debug artifacts can balloon and expose prompts/paths/images.** `src/debug.ts` redacts credential-like keys but does not redact generic data URLs, prompts, or local paths. With provider-payload/compact logging enabled, image tool results can be duplicated into debug JSON. Add size-aware elision/redaction before enabling image generation in the same package.

3. **Direct fetch bypasses Pi's `before_provider_request` hook.** This is good isolation—the dispatcher request will not be rewritten with the conversation's opaque compaction item—but it also bypasses centralized provider auth/headers, payload instrumentation, and any future request policy. Keep the image backend call explicitly separate from conversational replay and share only tested low-level auth/SSE facilities.

4. **Package namespace/API mismatch.** Upstream imports `@mariozechner/*`; this extension imports `@earendil-works/*`. Mixing both can fail installation/typechecking or create duplicate API implementations. Port all imports and verify `registerTool`, `registerCommand`, message renderer, events, UI/editor, mutation queue, and model-registry signatures against the forked Pi version.

5. **No hook-name collision, but shared lifecycle must remain composable.** Upstream adds `session_start` and `session_shutdown`; the compaction extension adds `session_start`, `session_before_compact`, and `before_provider_request`. These are conceptually compatible if Pi supports multiple listeners, but a combined default export must register both sets exactly once and ensure studio shutdown errors cannot prevent compaction cleanup or process exit.

6. **Model/provider assumptions are narrower than compaction support.** Compaction supports Responses-compatible APIs and custom gateways; image generation supports only the literal `openai-codex` provider and ChatGPT backend. A user on a custom `openai-responses` provider may have working compaction but no image auth. Error messaging and capability detection must make this distinction clear.

7. **Dispatcher model selection may be invalid.** Any selected `openai-codex` model ID is used as dispatcher; otherwise `gpt-5.5` is assumed. Not every current/future model or account may support the native image tool. Introduce an explicit configurable/validated dispatcher model rather than coupling it silently to the conversation model.

8. **Opaque-checkpoint continuity does not apply to image requests.** Each image call is an independent one-turn request with a random session/prompt-cache key. Do not attach the compaction checkpoint or conversation transcript automatically; references and prompt text should be explicit.

9. **Output-format/path mismatch in batches.** CLI parsing allows `--format`, but batch output paths are always named `.png`. A WebP/JPEG response can therefore be written under a `.png` name while metadata reports the actual MIME/format. Build paths from the chosen format and validate explicit extensions.

10. **Arbitrary local read/write surface.** The model-facing tool can read arbitrary `referencePaths` and transmit their bytes to ChatGPT, and can write image bytes/metadata to arbitrary accessible `outputPath` locations. This needs path allowlisting/confirmation or a clearly documented trust boundary, especially in a coding agent.

11. **Studio token is not enforced.** The page appends `?token=<uuid>` to requests, but `handleStudioRequest` never compares it with `studioToken`. The server is loopback-only and checks the Host header, but any local process can list metadata, fetch known images, trigger generations using the active Pi context, or invoke open/reveal actions. Reimplement authentication rather than carrying this behavior forward.

12. **Backend contract fragility.** The code depends on `chatgpt.com/backend-api/codex/responses`, a JWT claim, beta header, native image tool event shape, `gpt-5.5`, and `gpt-image-2`. None is abstracted or covered by tests. Backend errors are returned largely verbatim. Treat this provider as experimental and fail without affecting compaction/session integrity.

13. **Artifact/history scaling.** Every studio refresh recursively reads all JSON records, including duplicate index and sidecar files. Image-heavy sessions can make `/img list` and studio refresh progressively expensive while the compaction extension may also be writing debug artifacts. Use bounded/indexed storage and separate image artifacts from compaction debug roots.

14. **Cancellation and concurrency semantics need separation.** Studio calls use the retained `lastCtx.signal`; multiple browser requests can overlap, while batch calls are sequential. Verify that a Pi turn/session abort cancels only intended image calls and that studio calls cannot reuse a stale context after session transitions.

## Recommended staged feature subset

### Stage 1: safe core

- `imagegen` tool and `/img gen`
- OpenAI Codex OAuth only, clearly capability-gated
- size/quality/background/format/thinking
- optional references restricted to verified image files under explicit roots and byte limits
- generated-images root plus adjacent metadata and a bounded index
- `/img list`, `path`, `open`, `reveal`, `info`
- robust shared SSE parser and repository-standard auth/header resolver
- tests covering compaction serialization and debug elision of image payloads

### Stage 2

- batches with format-correct filenames, cancellation, partial-result metadata, and tested limits
- style presets stored as data/config rather than embedded command logic
- explicit event API for generated artifacts

### Stage 3

- authenticated local studio and sketch workflow, only after server security/lifecycle tests
- separate UI assets and stable API contracts
- configurable provider/dispatcher abstraction if additional image backends are required

This sequencing preserves the upstream package's main user value—generate and save an image with the user's existing Codex login—without immediately importing its largest security, maintenance, licensing, and compaction risks.
