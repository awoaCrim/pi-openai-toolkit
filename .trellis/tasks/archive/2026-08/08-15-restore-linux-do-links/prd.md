# Restore LINUX DO links in READMEs

## Goal

Restore the clickable `https://linux.do/` link in both English and Chinese README acknowledgments while preserving the requested visible wording `LINUX DO community.` and rewrite the public README history consistently.

## Confirmed facts

- Repository: `awoaCrim/pi-openai-toolkit`
- Branch: `main`
- Current local `HEAD`, `origin/main`, and remote `main`: `1a74d1565e773048d95eeb94ac95f511bf22992e`
- Current acknowledgment lines are plain text in both files:
  - `README.md`: `- LINUX DO community.`
  - `README_zh.md`: `- LINUX DO community.`
- Existing untracked bootstrap files must remain untouched and uncommitted:
  - `.agents/`
  - `.gitattributes`
  - `.trellis/`
  - `AGENTS.md`

## Requirements

1. Change the English acknowledgment to:

```markdown
- [LINUX DO](https://linux.do/) community.
```

2. Change the Chinese acknowledgment to the same exact Markdown line:

```markdown
- [LINUX DO](https://linux.do/) community.
```

3. Preserve all other README content, including the already-removed sections.
4. Rewrite the historical paths for both `README.md` and `README_zh.md`, removing their old README-only commits and adding the corrected files in one new documentation commit.
5. Preserve the final trees and history of all non-README files.
6. Force-push rewritten `main` using `--force-with-lease` against the exact old remote SHA.

## Out of scope

- No source-code or package behavior changes.
- No changes to `README.md` or `README_zh.md` other than restoring the link target/Markdown link text.
- No changes to `README_zh.md` language or other acknowledgments.
- No npm publish.
- No modification or commit of existing untracked bootstrap files.
- No full repository history reset.

## Acceptance criteria

- [x] Both README files contain exactly `- [LINUX DO](https://linux.do/) community.`.
- [x] The rendered visible wording remains `LINUX DO community.` and `LINUX DO` is clickable.
- [x] Historical commits before the new documentation commit contain neither README path.
- [x] Each README path history contains only the new corrected documentation commit.
- [x] Existing README section removals remain present.
- [x] All non-README final trees and source history remain unchanged.
- [x] The remote `main` points to the verified rewritten tip.
- [x] Only the pre-existing untracked bootstrap files remain locally.
- [x] An external rollback bundle and old remote SHA are recorded before force push.
