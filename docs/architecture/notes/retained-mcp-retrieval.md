# Retained retrieval for coding agents

The stdio MCP process owns a `createRetainedSearch` instance for its selected
profile. Since 2026-09, this is backed by `search-store.mjs` — a SQLite file
(`.cache/index/search.v1.<profileId>.sqlite`, beside the manifest) holding the
BM25F postings themselves, not a JS-heap index — whenever `node:sqlite` is
available; it falls back to the previous in-memory `createSearchIndex`-backed
implementation otherwise (`isSearchStoreAvailable()`, checked once at
construction). The app does not need to run.

**No parsed document is retained in the JS heap between queries.** Each query
lists the source and asks the store what it needs. Two cases, since 2026-09-15:

- **Nothing moved** (the listing is byte-identical to last time, AND the
  store's own row for this layer already reflects this exact `gen` under
  this process's `proc` token — `store.isCurrent(name, identity, gen)`, a
  single-row lookup): `store.pending()` is skipped entirely, no document is
  loaded, and the view handed to `store.search()` carries an empty
  `concepts` map. `store.search()`'s own internal sync sees the same
  gen/identity/proc match and takes its own early exit — no per-id
  fingerprint compare anywhere. This is the common "repeat query against an
  unchanged vault" case.
- **Something might have moved**: `store.pending(view)` (a SQL lookup, not a
  JS Map of concepts) names the ids without a matching stored fingerprint.
  Those are loaded via `source.loadConcept`, in batches of 256
  (`store.beginLayer`/`upsertBatch`/`finishLayer` — see "Batched cold sync"
  below), and dropped from the JS heap the moment each batch commits. By the
  time `store.search()` runs, the store already matches this listing
  exactly, so it is called with an EMPTY `concepts` map too — the sync it
  runs internally is a no-op, the same fast exit as the first case.

Either way, `store.search()` never receives a populated `concepts` map from
this module any more; every document that needed re-analysis was already
committed to the store before `search()` is called. The only thing this
module retains between queries is a small per-layer `fileMeta` map
(rel/ext/size/mtime/authoredDate; not the parsed content) — kept purely so an
unchanged listing can reuse the same internal `gen` and let `isCurrent()`/sync
take their fast paths.

**Batched cold sync.** Before 2026-09-15, a cold build (first query, or a
listing with many pending ids) loaded EVERY pending document into one JS Map
before a single `store.search()` call synced them — a 50,000-document vault
held the whole parsed batch in memory at once, the exact thing the store
exists to avoid holding for repeat queries. Now `retained-search.mjs` streams:
`store.beginLayer({name, identity, level, gen})` starts the layer sync,
`store.upsertBatch(name, items, layerNames)` commits up to 256 freshly-loaded
`{id, ord, concept, fileMeta}` documents per call (its own transaction —
docs/postings/sections/section_postings/links/df replaced for exactly those
ids, matching syncLayer's own insert path), and `store.finishLayer(state,
{ids, gen, level})` sweeps out any stored document no longer in `ids` (a
deletion), fixes `ord` for documents nothing touched, and writes the layer's
row so the next query's `isCurrent()` check recognizes this listing as
already synced. Peak JS-heap residency during a cold build is bounded by the
batch size, not corpus size. `search(contributing)` (the HTTP service's own
call path, which still hands `store.search()` a complete `concepts` map every
time) is unchanged — this streaming path is additive, used only by
`retained-search.mjs`.

**Partial visibility during a streaming build is an accepted semantic, not a
bug.** Each batch commits independently, so a second process reading the same
store file mid-build can observe a layer with some documents from the new
listing and some still from the old one — never a half-written document
(insertDocWithPostings's own doc+postings+sections+links insert happens
inside one batch's transaction), but a genuinely mixed-generation view of the
layer as a whole. The worst outcome is a query landing in that window seeing
a partially-updated layer; it resolves itself the moment the build's next
batch (or its own) commits. This trades a small, self-healing staleness
window for never holding a corpus-scale parse in memory.

**Schema-creation race (fixed 2026-09-15).** Two processes cold-starting on
the same brand-new store file can both reach schema creation (or the WAL
pragma) at once. `search-store.mjs` now runs both inside `BEGIN IMMEDIATE` /
`COMMIT`, with a bounded retry (up to 10 attempts, capped exponential backoff
via `Atomics.wait` — the API here is synchronous end to end, so there is no
async sleep available) on a busy/locked error; the losing process's retry
re-checks `tablesExist()`/the format row INSIDE its own retried transaction,
so it finds the winner's schema already in place and does nothing further,
rather than throwing and permanently falling back to the in-memory index for
its whole lifetime (the failure mode described in the dated section below).
The same retry wraps every other write transaction the store opens (`sync()`,
`upsertBatch()`, `finishLayer()`) — not just first-open schema creation —
since two processes can race on an ordinary write just as easily as on DDL.
`search-store.test.mjs` covers this with two `worker_threads` opening the
same fresh file at once and both completing a real search.

Local adapters provide document fingerprints (relative path, extension, size,
modification time and, for OKF, authored date); a document whose fingerprint
is unchanged is never re-read, in this process or the next one. Remote
adapters without fingerprints are reloaded every query (there is no way to
prove one unchanged without reading it), but the store's own content-hash
fingerprint still recognizes identical content and skips re-analyzing it.
Changed, added, and removed documents update the ranking statistics; a
deletion costs no read at all. Concurrent queries share the in-flight
refresh. There is no result cache that can hide an edit behind a query TTL.

The retained state belongs to one process and one immutable selected profile.
Changing the manifest requires a new MCP session, as it did before this
change. It never adopts an index from another profile — the store's `layers`
table is keyed by name and content identity (`index-keys.mjs`'s
`layerIdentity`, the same computation service.mjs uses), so a folder
repointed under a reused layer name between two runs re-indexes rather than
serving stale postings under the old name. Because nothing corpus-scale is
retained, there is no idle-eviction timer any more — a process left open on
an unchanged vault does not grow.

The legacy `--personal`/`--shared` invocation (no manifest, so no directory to
persist a store file beside) runs the store `:memory:` — no cross-restart
durability, but still no per-document JS Map retained across queries within
that one process's lifetime.

`find_captures` retains its existing separate scoring path, unaffected.

Search annotations (`annotateContested`, the ≤5-hit contested check) resolve
against the real source adapters passed into `createRetainedSearch`, not a
point-in-time snapshot — so a contested-hit resolve always reads live.
Ranking, scores, snippets and layer ordering are differential-tested against
`searchConcepts` (both in `search-store.test.mjs` and, transitively, via the
same store the HTTP service now uses); the retrieval eval remains unchanged.
The existing cap of five contested-hit resolutions stays.

## Controlled measurement

Run `node packages/core/eval/benchmark-retained-search.mjs 12000`. The script
creates and removes an isolated synthetic corpus, uses a file-backed (not
`:memory:`) store so a real restart can be measured, and asserts exact ranking
equivalence before and after an edit and after a restart. It also launches two
real stdio MCP clients with independent processes. It does not edit the
installed app's sources.

### Current: warm/batched-cold rework, 12,000 documents, Node 26.8.1, 2026-09-15

Two measurements, because `benchmark-retained-search.mjs`'s own corpus (one
repeated boilerplate paragraph, varied only by a topic word) makes nearly
every document a BM25F candidate for any common query term — it measures
candidate-count-proportional scoring cost, not the warm/cold store behavior
this section is about. Both are reported so neither reads as cherry-picked.

**(a) `benchmark-retained-search.mjs 12000`** (boilerplate corpus, unchanged
script, continuing the history below for direct comparison). 368.5 MB
synthetic corpus. Peak RSS across the whole run: **1,073.0 MB** (12k
documents' worth of file writes, two live stdio child processes, and the
in-process store all resident at once — not a per-process figure; this
number is dominated by corpus generation + two full processes, not by the
store's own batching, which is measured separately in (b) below).

| Operation | Time | Documents read |
| --- | ---: | ---: |
| Previous full-rebuild search (`searchConcepts`, no store) | 22,245 ms | 12,000 |
| Retained cold search (first ever query, cold store) | 28,167 ms | 12,000 |
| Retained repeated searches | 992–1,064 ms | 0 |
| Two stdio clients initialize | 46 ms | n/a |
| Two stdio clients cold-search concurrently | 31,480 ms total | n/a |
| Repeated stdio search | 1,001–1,073 ms | n/a |
| Different stdio query | 1,004 ms | n/a |
| Retained search after one edit | 1,129 ms | 1 |
| Two stdio clients search after one edit | 1,887 ms total | n/a |
| **Retained cold search after a restart** (close, reopen same store file) | **1,198 ms** | **0** |

Warm/restart times on THIS corpus rose relative to the 2026-09-06 history
below (235–241 ms → ~1,000 ms) because the concurrently-landed section-level
scoring feature (per-section postings, scored independently) roughly doubles
the query/scoring work per BM25F candidate — and on this corpus nearly the
whole 12k-document vault is a candidate for the benchmark's query terms
("database", "migrations" both appear in every document's boilerplate
paragraph). Document-read counts (still 0 warm, 0 after restart) confirm the
store itself is not re-parsing anything; the added time is candidate-set
scoring cost, present for `searchConcepts` and `createSearchIndex` too, not
something this rework introduced or could remove.

**(b) Isolated probe, large-vocabulary corpus (a real knowledge base's word
diversity, not one repeated paragraph) — the number the "under 30 ms warm"
target in the work item actually refers to.** 12,000 documents, ~3,000-word
vocabulary, query "postgres deploy" seeded onto 3 documents (a realistically
selective query). Real stdio `mcp-server.mjs` child process.

| Operation | Time | RSS |
| --- | ---: | ---: |
| Cold search (fresh store, full parse) | 19.4 s | peak 195.5 MB during the build (after: 176.8 MB) |
| Warm search ×30 (unchanged vault) | 68–115 ms each | flat: 178 MB → plateaus ~235 MB, no further growth |
| Restart cold search (same store file, fresh process) | 149.5 ms | — |

The 68–115 ms end-to-end warm figure is dominated by the source adapter's own
`listEntries()` directory walk (~87 ms measured in isolation over 12,000
files — stat() on every file, unrelated to search-store.mjs). Isolating the
store itself (`store.search()` called directly with `gen` unchanged and an
empty `concepts` map, bypassing the listing walk): **~20 ms**, under the
30 ms target. `store.pending()` over 12,000 already-current ids costs ~15 ms;
`store.isCurrent()` (the new warm-path check that skips calling `pending()`
at all) costs **~0.06 ms** — the specific saving this rework's task A adds,
on top of `pending()` already being fast at this scale.

**Batched cold build.** Peak RSS during the (b) cold build was 195.5 MB for
12,000 documents — well below the 754 MB this rework's own "measured
problems" baseline recorded for a cold first search before batching. Peak RSS
across the 30 warm queries plateaus (235–242 MB) rather than climbing
monotonically — some early growth as buffers/caches warm, then flat, matching
the "no parsed content retained" design: each warm query's cost is the
listing walk plus small per-query allocations, not a growing retained set.

One known contention edge case from the 2026-09-06/2026-09-15 runs below is
now fixed (see "Schema-creation race" above): repeated runs of both (a) and
(b) here, plus a dedicated `worker_threads` test in `search-store.test.mjs`,
completed without the `[retained-search] falling back to in-memory retained
search: database is locked` fallback that the history section documents.

### History: store-backed, before batching/warm-path/schema-lock work, 12,000 documents, Node 26.8.1, 2026-09-15

368.5 MB synthetic corpus. Peak RSS across the whole run: **1,078.9 MB** (12k
documents' worth of file writes, two live stdio child processes, and the
in-process store all resident at once — not a per-process figure).

| Operation | Time | Documents read |
| --- | ---: | ---: |
| Previous full-rebuild search (`searchConcepts`, no store) | 17,501 ms | 12,000 |
| Retained cold search (first ever query, cold store) | 22,050 ms | 12,000 |
| Retained repeated searches | 235–241 ms | 0 |
| Two stdio clients initialize | 51 ms | n/a |
| Two stdio clients cold-search concurrently | 26,040 ms total | n/a |
| Repeated stdio search | 60–65 ms | n/a |
| Different stdio query | 59 ms | n/a |
| Retained search after one edit | 398 ms | 1 |
| Two stdio clients search after one edit | 107 ms total | n/a |
| Retained cold search after a restart (close, reopen same store file) | 382 ms | 0 |

The line that rework existed for: a cold search over a 12k-document, 368 MB
corpus cost 22.0 seconds the first time (full parse) and 382 ms, zero
document reads, after a restart — the store answered from its persisted
postings, the same ~58x the warm-repeat numbers already showed relative to a
full rebuild, surviving a process exit. Document-read counters are
unavailable inside the child stdio processes (separate processes); the
benchmark reports those as `null`.

Known contention edge case observed during this run, since fixed (see
"Schema-creation race" above and the (a)/(b) measurements in the current
section): the two stdio clients share one manifest and therefore one store
file. Two independent OS processes racing to create that file's schema for
the first time could hit "database is locked" (WAL's `busy_timeout` did not
cover schema-DDL contention on a brand-new file, and neither the pre-WAL
pragmas nor the plain `BEGIN` used by `sync()` retried); both fell back to
the legacy in-memory retained search for the rest of that process's life
(`[retained-search] falling back to in-memory retained search: database is
locked`). The test still asserted ranking equivalence — the fallback was
functionally correct, just not store-backed for that one process. A later
process opening the (by-then-created) store file was unaffected.

### History: in-memory (`search-index.mjs`)-backed, 3,000 documents, Node 26.8.1, 2026-09-06

| Operation | Time |
| --- | ---: |
| Previous full-rebuild search | 4,348 ms |
| Retained first search | 4,491 ms |
| Retained repeated searches | 45–58 ms |
| Two stdio clients initialize | 55 ms |
| Two stdio clients cold-search concurrently | 4,848 ms total |
| Repeated stdio search | 21–22 ms |
| Different stdio query | 20 ms |
| Two stdio clients search after one edit | 35 ms total |

The direct retained-search probe recorded zero document reads on warm queries
and one read after a single edit. Document counters are unavailable inside the
child processes; the benchmark reports those as null. These are controlled
observations, not production percentiles or a measurement of the packaged app.

## Recorded context resolutions

`read_file` and `get_links` outgoing traversal apply source-preserving decisions only to their fresh resolved result,
never to a retained source snapshot. It reads the profile's current decision state
and compares the selected layers and settings with the process's original binding.
Changes to an inactive profile do not invalidate that binding.
Undo, disabled policies, changed evidence and changed manifests stop application.
Provenance and dissent remain in both the JSON and Markdown output.

HTTP and stdio use `blockedContextResolutionKeys` over the same section evidence
and effective rules. Matching automatic legacy rules or disagreeing rule actions
stop application; unrelated rules and a single recommendation do not. This is
the existing pure rule matcher, not a second discrepancy projection. Before
applying a recorded choice, stdio also checks source-listing coverage: truncated,
skipped and unreadable documents require abstention even when the adapter is up.
Cache wrappers preserve these coverage notes on both fresh and cached listings.
`get_links` incoming references remain original source evidence, labeled with
their source layer; they can include a reference from a losing contribution.
