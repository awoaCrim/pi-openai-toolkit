# Fix Pi ProviderHeaders compatibility

## Goal

Make the extension's remote compaction and configured native-fallback paths honor the official Pi 0.84.x `ProviderHeaders` contract, so nullable header deletion markers are handled correctly instead of being sent as the literal string `"null"`.

## Background

Official Pi 0.84.x represents provider headers as values that may be either strings or `null`. A `null` value removes an inherited header. The extension currently treats resolved headers as string-only values and forwards them directly through its compaction paths.

## Requirements

- Preserve nullable provider headers when resolving authentication data.
- Merge model headers and resolved authentication headers case-insensitively, with later `null` values deleting earlier values.
- Ensure remote v2 compaction requests receive only concrete string headers and never send `"null"` as a header value.
- Ensure the configured native fallback receives only concrete string headers.
- Keep the change focused on the active remote-v2 and native-fallback paths.
- Add regression coverage for nullable headers and header precedence without changing existing compaction behavior.

## Acceptance Criteria

- [x] A nullable header is removed rather than serialized as the string `"null"`.
- [x] Authentication headers override model headers case-insensitively, and nullable overrides delete prior values.
- [x] Remote v2 compaction builds valid request headers under the official Pi 0.84.x header contract.
- [x] Configured native fallback passes normalized headers to Pi's `compact()` method.
- [x] Existing tests continue to pass, and new regression tests cover the fixed behavior.
- [x] Type checking passes.

## Out of Scope

- Resolving authentication-provided `baseUrl` overrides.
- Changing provider environment propagation.
- Changing the package's supported Pi version range.
- Refactoring the unused legacy direct compact client unless the focused fix requires it.
