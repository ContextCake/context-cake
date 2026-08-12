# What names an index entry, and when a snapshot survives

**Rule:** never match an index handoff on identity alone, and never let a
user-supplied layer field reach a reserved slot in the identity.

`packages/core/src/index-keys.mjs` is pure and separately tested because a key
collision means one source serving another source's documents.

## Three strings, not interchangeable

| String | Contains | Consequence |
|--------|----------|-------------|
| `identity` | What the layer *reads* — no name, no level | A rename or a re-level costs nothing |
| `validity` | `identity` + indexing settings + credential epoch | A settings or credential change invalidates |
| `key` | `validity` + the layer's name, uniquified by occurrence | What the entry is actually stored under |

## What `adoptIndexes` does

When a layer changes, its old entry is orphaned. `adoptIndexes` **moves** that
entry to the new key if the validity matches, and drops it otherwise.

Both halves matter. Moving on a validity match is what makes a rename free —
renaming a 3,000-note source should not cost a re-walk. Dropping otherwise is
what stops a lowered document cap, or a disconnected account, from continuing to
serve the answer computed before the change. An index that outlived the settings
that produced it is worse than no index, because nothing tells the user which
one they are reading.

A stray `kind` field once reached a reserved slot in the identity and made two
distinct layers hash to one entry. That is the failure mode the purity and the
separate test exist to prevent.

## Repointing a folder is not a rename

`PATCH /api/sources` can repoint a folder-backed source (`path`, for the
`local`/`files` kinds). A new folder is a new *content identity*, so adoption
finds nothing to carry and the source re-indexes from zero. Measured on a
3,000-note vault: `status: "indexing"`, `conceptCount: 0`, roughly 16 seconds,
and the old folder's concepts stop resolving immediately.

That is correct rather than a gap in adoption — the snapshot it would have
carried indexes a folder this source no longer reads. The response carries
`reindexing: true` so the client can name the cause before the row goes blue.

Repointing is refused for `github`/`github-rest`/`mcp`, and for a clone-backed
layer whose folder belongs to Sync (`gitCloneOrPull` writes `CACHE_DIR/<slug>`,
never `layer.path`).
