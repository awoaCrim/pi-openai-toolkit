# Release design: model-scoped Web Search

## 1. Release surface

The release consists of the already implemented source/configuration changes plus README corrections and the public npm package publication. Source behavior is not redesigned in this task.

- Configuration contract: `webSearch.models` exact `provider/model-id` entries.
- Supported Web Search APIs: hard-coded `openai-responses` and `openai-codex-responses`.
- Package entry points: `extensions/compaction.ts` and `extensions/web-search.ts`.
- Distribution channels: GitHub `origin/main` and public npm package `pi-openai-toolkit@0.3.0`.

## 2. Documentation design

Both language-specific READMEs will show two installation paths:

1. Recommended public package installation:

   ```bash
   pi install npm:pi-openai-toolkit
   ```

2. Git installation for development or users who explicitly prefer the repository source:

   ```bash
   pi install git:github.com/awoaCrim/pi-openai-toolkit
   ```

The feature overview and configuration sections must agree: Web Search is not globally enabled by API alone; it requires an exact allowlisted `provider/model-id`, and the selected model must use either supported Responses API identifier. The local function-tool ownership behavior remains documented without implying that native search yields to the local tool.

## 3. Validation and packaging boundary

Validation is performed from the repository root before any irreversible release operation:

- TypeScript typecheck and full Bun tests validate source behavior.
- The direct Pi smoke command validates extension/package loading.
- `npm pack --dry-run` is inspected against `package.json.files` to ensure the published tarball contains runtime files and bilingual documentation while excluding Trellis/bootstrap files.

The product commit stages tracked changes only (`git add -u` or an explicit tracked-file list). Existing untracked `.agents/`, `.trellis/`, `AGENTS.md`, and `.gitattributes` remain outside the commit.

## 4. Publication order

1. Update README files.
2. Run all validation and package dry-run checks.
3. Review the diff and stage only intended tracked changes.
4. Create one release commit on `main`.
5. Push `main` to `origin`.
6. Publish the unchanged committed package version `0.3.0` to npm.
7. Verify GitHub branch state and npm metadata.

This order leaves a reproducible Git commit behind before npm publication. If npm publication fails after the push, retry publication without rewriting the Git history.

## 5. Compatibility and rollback

- Keep the current package version at `0.3.0` because the registry has no package entry yet.
- Do not modify compaction behavior or local Pi deployment settings in this release.
- If `0.3.0` is already claimed at execution time, stop before publication and report the immutable-version conflict.
- If the source validation fails, fix the source/docs and repeat validation before committing.
- If the npm package is published but GitHub verification reveals a bad commit, do not unpublish or rewrite history automatically; report the issue for an explicit corrective release.
