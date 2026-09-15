# Retained retrieval for coding agents

The stdio MCP process owns a `createRetainedSearch` instance for its selected
profile. Since 2026-09, this is backed by `search-store.mjs` — a SQLite file
(`.cache/index/search.v1.<profileId>.sqlite`, beside the manifest) holding the
BM25F postings themselves, not a JS-heap index — whenever `node:sqlite` is
available; it falls back to the previous in-memory `createSearchIndex`-backed
implementation otherwise (`isSearchStoreAvailable()`, checked once at
construction). The app does not need to run.

**No parsed document is retained in the JS heap between queries.** Each query
lists the source, asks the store which ids it does not already have a
matching fingerprint for (`store.pending(view)` — a SQL lookup, not a JS Map
of concepts), and loads only those ids via `source.loadConcept`. The view
handed to `store.search()` carries `concepts` for just the newly-loaded
documents; every other document's postings are already on disk from a
previous query, or from a previous process entirely, and need no concept to
confirm they are current. The only thing this module retains between queries
is a small per-layer `fileMeta` map (rel/ext/size/mtime/authoredDate; not the
parsed content) — kept purely so an unchanged listing can reuse the same
internal `gen` and let `search-store.mjs`'s own sync take its fast path.

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

### Current: store-backed, 12,000 documents, Node 26.8.1, 2026-09-15

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
| **Retained cold search after a restart** (close, reopen same store file) | **382 ms** | **0** |

The line this rework exists for: a cold search over a 12k-document, 368 MB
corpus costs 22.0 seconds the first time (full parse) and **382 ms, zero
document reads, after a restart** — the store answers from its persisted
postings, the same ~58x the warm-repeat numbers already showed relative to a
full rebuild, now surviving a process exit. Document-read counters are
unavailable inside the child stdio processes (separate processes); the
benchmark reports those as `null`.

One known contention edge case observed during this run: the two stdio
clients share one manifest and therefore one store file. Two independent
OS processes racing to create that file's schema for the first time can hit
"database is locked" (WAL's `busy_timeout` does not fully cover schema-DDL
contention on a brand-new file); both fall back to the legacy in-memory
retained search for the rest of that process's life (`[retained-search]
falling back to in-memory retained search: database is locked`). The test
still asserted ranking equivalence — the fallback is functionally correct,
just not store-backed for that one process. A later process opening the
(by-then-created) store file is unaffected. Not fixed as part of this work;
flagged for whoever revisits multi-process cold-start contention.

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
