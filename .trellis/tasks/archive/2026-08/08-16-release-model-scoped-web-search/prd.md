# Release model-scoped Web Search

## Goal

Release the completed model-scoped native Web Search implementation so users can install it from the public npm registry, while keeping the GitHub installation path and making both README files accurately describe the new configuration and supported endpoints.

## Confirmed facts

- The working tree contains the completed model-scoped Web Search implementation, tests, and documentation changes from the previous task.
- `package.json` identifies the package as `pi-openai-toolkit@0.3.0`, is not private, and publishes to `https://registry.npmjs.org/` with public access.
- `pi-openai-toolkit` is not currently present in the npm registry (`npm view` returned `E404`), so the existing `0.3.0` version can be published as the initial public package version.
- npm authentication is available for the `cr1ms0n` account.
- `origin/main` still points to the previous commit; the product changes are not committed or pushed.
- README configuration sections already describe `webSearch.models`, the exact model allowlist, and both supported APIs, but the installation sections only show Git installation and the introductory Web Search descriptions need the same model/API scope.
- `.agents/`, `.trellis/`, `AGENTS.md`, and `.gitattributes` are existing Trellis/bootstrap working-tree files and must not be included in the product release commit.

## Requirements

1. Update `README.md` and `README_zh.md` to:
   - document installation through the Pi npm package source using `pi install npm:pi-openai-toolkit`;
   - retain the Git installation path for development or environments that prefer Git;
   - state that Toolkit Web Search requires an exact `provider/model-id` allowlist entry and supports `openai-responses` and `openai-codex-responses`.
2. Preserve the already implemented model-scoped Web Search behavior and all unrelated compaction behavior.
3. Run the repository validation before release:
   - `npm run typecheck`;
   - `bun test`;
   - `bun test ./test/pi-smoke.test.ts` (the direct Bun command is the reliable smoke-test invocation in this environment);
   - `npm pack --dry-run` and inspect that the package contains the extension sources, runtime sources, bilingual README files, and required metadata.
4. Commit only the tracked product source, test, and README changes. Do not stage existing Trellis/bootstrap untracked files.
5. Push the release commit to `origin/main`.
6. Publish `pi-openai-toolkit@0.3.0` to the configured public npm registry and verify the published version and package contents are visible through npm metadata.

## Out of scope

- Changing the package version or adding a separate release tag; `0.3.0` is currently unpublished and is the requested release version.
- Modifying the local Pi installation/settings or migrating the local `webSearch.apis` configuration; that can be handled separately after the package is published.
- Changing source behavior beyond corrections required by the README or release validation.
- Publishing any private or alternate registry package.

## Acceptance criteria

- [x] Both README files show the npm Pi installation command, retain the Git path, and accurately document model-scoped Web Search and both supported APIs.
- [x] Typecheck passes.
- [x] Full Bun test suite passes.
- [x] Pi smoke tests pass.
- [x] `npm pack --dry-run` contains the intended package files and no Trellis/bootstrap files.
- [x] A commit containing only the intended product changes exists on `main` and is pushed to `origin/main`.
- [x] `npm view pi-openai-toolkit version` reports `0.3.0` after publication.
- [x] Existing untracked Trellis/bootstrap files remain untouched and are not part of the release commit.

## Risks and rollback

- npm versions are immutable. If `0.3.0` becomes published between planning and execution, stop before publishing and report the conflict rather than changing the version without approval.
- If Git push succeeds but npm publication fails, keep the commit and report the package-publication failure for retry; do not rewrite history.
- If package dry-run reveals missing runtime files, fix the package file list before publishing and rerun all release checks.
- Publication initially failed because the existing npm credential did not satisfy the 2FA policy. After the user supplied a publish-capable credential, `pi-openai-toolkit@0.3.0` was published successfully and its registry metadata and tarball contents were verified.
