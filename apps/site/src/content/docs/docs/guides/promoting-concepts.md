---
title: Promoting concepts
description: Move a concept up the stack — personal to shared.
---

A concept that started as a personal note often deserves to become team
knowledge. `promote.mjs` copies a concept from a personal OKF bundle into a
shared bundle, rewrites its links, and rebuilds the shared index — it doesn't
touch the resolver or the manifest at all; it operates directly on two
bundle directories.

## Usage

```bash
node promote.mjs --personal <dir> --shared <dir> --file <concept-or-path> [--dry-run] [--print-git]
```

`--personal <dir>` and `--shared <dir>` are the two bundle roots (required).
`--file <concept-or-path>` is the concept to promote — a bare id like
`decisions/primary-db` or a path, with or without `.md` (required).

```bash
node promote.mjs --personal ~/kb-personal --shared ~/kb-team --file decisions/primary-db
```

This copies `~/kb-personal/decisions/primary-db.md` to
`~/kb-team/decisions/primary-db.md`, preserving its relative path, and
rewrites the shared bundle's `index.md` to include it.

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
node promote.mjs --personal ~/kb-personal --shared ~/kb-team --file decisions/primary-db --dry-run
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
node promote.mjs --personal ~/kb-personal --shared ~/kb-team --file decisions/primary-db --print-git
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

## Why directories, not a manifest

`promote.mjs` takes `--personal`/`--shared` directories rather than
`--manifest`/`--target-layer` like `write.mjs`. Promotion is a bundle-to-bundle
file operation between two known OKF roots you already have local paths to
— it doesn't need the full source-adapter machinery that lets a manifest
layer be `mcp` or a remote clone.

## Next

- [The capture write path](/docs/guides/capture-write-path) — how a concept
  gets into the personal or team layer in the first place
- [OKF bundles](/docs/concepts/okf-bundles) — the file shape being copied and
  reindexed
- [Layer cake](/docs/concepts/layer-cake) — why personal, team, and company
  are separate bundles with separate precedence
