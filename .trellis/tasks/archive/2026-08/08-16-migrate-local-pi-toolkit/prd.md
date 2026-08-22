# Migrate local Pi toolkit configuration

## Goal

Switch the local Pi installation from the old Git-pinned `pi-openai-toolkit` commit to the published `npm:pi-openai-toolkit@0.3.0` package and migrate the local Web Search configuration to the model allowlist without changing existing compaction settings.

## Confirmed facts

- Global Pi settings are stored at `C:/Users/Administrator/.pi/agent/settings.json`.
- The current package entry is the old Git pin `git:github.com/awoaCrim/pi-openai-toolkit@439af06d650d82b846a5578759a2bcb7bd272b94`.
- The current toolkit config is `C:/Users/Administrator/.pi/agent/extensions/pi-openai-toolkit/config.json`.
- The current config still uses `webSearch.apis: ["openai-responses"]`.
- The published package `pi-openai-toolkit@0.3.0` is available from npm.
- Existing backups are present under `C:/Users/Administrator/.pi/agent/backups/`.

## Requirements

1. Create a timestamped backup of the current settings and toolkit config before changing them.
2. Install the published package with the Pi package manager using the exact source `npm:pi-openai-toolkit@0.3.0`, replacing the old Git package entry in the global settings.
3. Update the toolkit config to:
   - preserve every existing `compaction` field and value;
   - replace `webSearch.apis` with `webSearch.models`;
   - allow the current configured model `uwoacrimson/gpt-5.6-luna` by setting `models: ["uwoacrimson/gpt-5.6-luna"]`.
4. Validate that the settings package source, config schema, installed package version, and extension loading all match the published release.
5. Do not modify repository files or commit local machine configuration into the project.

## Out of scope

- Changing model credentials, provider definitions, or compaction behavior.
- Adding other models to the Web Search allowlist without explicit configuration.
- Removing existing backups.
- Modifying the repository's tracked or untracked files.

## Acceptance criteria

- [x] A backup exists for the pre-migration settings and toolkit config at `C:/Users/Administrator/.pi/agent/backups/pi-openai-toolkit-local-migration-20260816030933/`.
- [x] Global Pi settings contain `npm:pi-openai-toolkit@0.3.0` and no old Git pin for this package.
- [x] Toolkit config has `webSearch.enabled: true` and `webSearch.models: ["uwoacrimson/gpt-5.6-luna"]`.
- [x] Toolkit config has no `webSearch.apis` field.
- [x] Existing compaction settings are unchanged.
- [x] The installed package reports version `0.3.0` and contains the model-scoped Web Search implementation.
- [x] Pi lists the configured package as `npm:pi-openai-toolkit@0.3.0`; the installed package contents match the published build.
- [x] Repository working-tree files remain unchanged by this local migration.
