---
title: Promoting concepts
description: Promote a live capture into a curated layer without crossing profile boundaries.
---

A useful live capture often deserves to become curated team knowledge.
`promote.mjs` uses the same Project Profile selection as MCP, resolves both
the live source and curated target from that one profile, and stages a review
before it removes anything from the live repository.

## Usage

Request a promotion:

```bash
contextcake promote --capture captures/investigation/<id> --target-layer team --dest systems/<id>
```

The command selects an explicit `--profile <id>`, the deepest project mapping
for the current directory, or `default`, in that order. The selected profile
must contain exactly one `live: true` local OKF layer and the named curated
`--target-layer`.

After reviewing the generated file under the curated layer's
`_review/promotions/` directory, approve it:

```bash
contextcake promote --approve /ABS/PATH/team/_review/promotions/<slug>.md --target-layer team
```

The review carries the profile id, manifest revision, live-layer and
target-layer fingerprints, capture id, destination, and capture-content hash
from the request. Approval reselects the same profile and fails if configuration
or capture content changed. ContextCake holds the manifest boundary across that
check and the local mutation. Only after the curated write verifies and the
live deletion commits does it remove the review entry; a failed commit restores
the capture and leaves the review retryable.

Live captures and review entries must be regular files inside their selected
layer roots. Symlinked files and any parent path that escapes its selected root
are rejected rather than followed.
The editable review carries an opaque binding id; its authoritative tuple is
kept in ContextCake's machine-local state, not in the team repository. This
lets people edit the proposed prose without letting the review redefine its
source capture, destination, or trust boundary.

## Legacy raw-directory mode

The original personal-to-shared copy and raw live-root flow remain available
for advanced compatibility. They require `--legacy-paths` so a command that
bypasses Project Profile isolation is explicit:

```bash
node promote.mjs --legacy-paths --personal ~/kb-personal --shared ~/kb-team --file decisions/primary-db
node promote.mjs --legacy-paths --from-live ~/kb-live --capture captures/investigation/<id> --target ~/kb-team
```

The remaining options on this page describe that legacy personal-to-shared
copy mode.

## Link rewriting

Promotion isn't a blind copy. Any personal-scoped links in the file are
rewritten to shared-relative form before the copy is written:

- Markdown links like `](personal:some/concept)` or `](/personal/some/concept)`
  become a relative path from the promoted file's new location.
- Wikilinks like `[[personal:some/concept]]` (with or without an alias)
  become `[[some/concept]]`.

This keeps cross-references valid once the file lives in the shared bundle
instead of pointing back at a `personal:` scope that won't resolve there.

## Index rebuild

After the copy, `promote.mjs` rewrites `index.md` at the root of the shared
bundle: it walks every markdown file in the shared bundle (skipping
`index.md` itself), extracts each file's title (frontmatter `title:`, or
else its first `# heading`), and writes a sorted list of links. This keeps
the shared index authoritative without hand-maintaining it.

## Preview before writing

`--dry-run` prints the operations and the rewritten content as JSON without
touching disk:

```bash
node promote.mjs --legacy-paths --personal ~/kb-personal --shared ~/kb-team --file decisions/primary-db --dry-run
```

```json
{
  "dryRun": true,
  "operations": [
    "copy /Users/you/kb-personal/decisions/primary-db.md -> /Users/you/kb-team/decisions/primary-db.md",
    "update /Users/you/kb-team/index.md"
  ],
  "content": "---\ntype: decision\n..."
}
```

## The git/PR flow

`--print-git` prints suggested git commands after a real (non-dry-run) write
— it doesn't run them for you:

```bash
node promote.mjs --legacy-paths --personal ~/kb-personal --shared ~/kb-team --file decisions/primary-db --print-git
```

```
Promoted decisions/primary-db.md

Suggested git commands:
  cd /Users/you/kb-team
  git checkout -b promote/decisions-primary-db
  git add decisions/primary-db.md index.md
  git commit -m "docs: promote decisions/primary-db"
  git push -u origin HEAD
  gh pr create --fill
```

The branch name defaults to `promote/<path-without-.md>` with any character
outside `[a-zA-Z0-9._-]` collapsed to a hyphen; pass `--branch <name>` to
override it. Since the shared bundle is its own git repo, promotion becomes a
normal reviewable PR against team or company knowledge — nothing is written
straight to a shared main branch unreviewed.

## Why the legacy mode still exists

Older scripts may already know two explicit bundle roots and may not use a
ContextCake manifest. `--legacy-paths` preserves that workflow, but it cannot
claim cross-profile isolation or bind an approval to a manifest revision. New
team-sync workflows should use `--manifest`/`--target-layer` (or the packaged
CLI defaults) instead.

## Next

- [The capture write path](/docs/guides/capture-write-path) — how a concept
  gets into the personal or team layer in the first place
- [OKF bundles](/docs/concepts/okf-bundles) — the file shape being copied and
  reindexed
- [Layer cake](/docs/concepts/layer-cake) — why personal, team, and company
  are separate bundles with separate precedence
