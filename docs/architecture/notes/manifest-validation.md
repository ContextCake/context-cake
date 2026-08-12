# Tolerant reads, strict writes, one repair door

**Rule:** do not make `mutateContextManifest` tolerant in order to make some
other route work.

## The asymmetry

A hand-edited manifest with one bad layer used to 500 every route. Now:

- **Reads tolerate.** `readContextManifestQuarantined` — reached through
  `readManifestForRead()` in `service.mjs` — lifts a failing layer out of the
  manifest it returns. The layer becomes an error row with `quarantined: true`
  in `/api/graph`. One bad layer costs you that layer, not the app.
- **Writes stay strict.** `mutateContextManifest` reads through the *strict*
  reader, and every write goes through `writeContextManifest`, which validates
  the whole manifest.

## The one exception

`repairContextManifest`, used only by `removeSourceApi`. It:

- tolerates an invalid layer on the way **in** (same rule as the read path),
- hands the callback the **raw** manifest, so a removal drops exactly the entry
  asked for rather than an index shifted by quarantine,
- refuses any callback that lengthens a layers array,
- and still validates in full before writing.

The repair door is the one that removes, which is why it is the one allowed to
see the mess. Widening any other door instead is the mistake this note exists to
prevent.

## Removal is all-or-nothing

Because only a valid manifest may be persisted, and a write rewrites the whole
file, any removal that would leave an invalid layer behind is refused —
including a removal that only meant to drop a healthy source.

Two consequences, both load-bearing:

- `DELETE /api/sources?name=` repeats the parameter (`searchParams.getAll`).
- The console's Remove on **any** row names every invalid row and sends them
  together.

A removal blocked this way answers 409 listing what blocked it, never a 500.

## Profile views are unified at one seam

`openSources()` builds one `{...manifest, layers: getManifestProfileLayers(manifest)}`
view and threads it through every read site — index keys, `buildSources`, the
manifest watcher, `layerMeta`, sync lookups — plus `layer-files.mjs`'s
`layerRootMap`. Before that seam existed, a manifest migrated to v2 (by
`contextcake profile create`, say) emptied the app's source list.

## Key order is not content

`stableJson` in `manifest.mjs` is key-order-independent, so a manifest rewrite
that only reorders fields never re-indexes a source.
