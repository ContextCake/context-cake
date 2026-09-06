# Retained retrieval for coding agents

The stdio MCP process owns a `createRetainedSearch` instance for its selected
profile. It uses the same incremental BM25F scorer as HTTP search. Initialization
does not read the corpus; the first search does. The app does not need to run.

Each query checks source listings. Local adapters provide document fingerprints
(relative path, extension, size, modification time and, for OKF, authored date).
Unchanged documents keep their parsed object and analyzed terms. Changed, added,
removed and newly dated documents update the ranking statistics. Concurrent
queries share the in-flight scan. There is no result cache that can hide an edit
behind a query TTL.

The retained state belongs to one process and one immutable selected profile.
Changing the manifest requires a new MCP session, as it did before this change.
It never adopts an index from another profile. After 60 seconds idle, both parsed
snapshots and the assembled index are released. Existing local walk limits bound
the selected corpus; retention does not accumulate past generations or queries.

Remote adapters without document fingerprints still read according to their own
cache/freshness policies. Equal returned documents reuse analysis, but uncached
remote reads remain potentially expensive. This change does not promise a fast
cold network scan. `find_captures` also retains its existing separate scoring path.

Search annotations resolve against the same snapshots that produced the hits,
avoiding extra source reads and generation mismatches. Ranking, scores, snippets
and layer ordering are differential-tested against `searchConcepts`; the retrieval
eval remains unchanged. The existing cap of five contested-hit resolutions stays.

## Controlled measurement

Run `node packages/core/eval/benchmark-retained-search.mjs 3000`. The script creates
and removes an isolated 3,000-document, 92.1 MB synthetic corpus and asserts exact
ranking equivalence before and after an edit. It also launches two real stdio MCP
clients with independent processes. It does not edit the installed app's sources.

One local run on 2026-09-06, Node 26.8.1:

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
