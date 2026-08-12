# Indexing concurrency, memory pressure, and the abort gap

**Rule:** indexing passes queue — they do not all start at once. `indexing`
means "no answer yet", not "working".

## The queue

`pumpIndexQueue` in `packages/core/src/service.mjs` caps how many sources index
concurrently (`maxConcurrentIndexing`, default 4) and reports a waiting pass as
`phase: "queued"`.

It bounds **when a new pass may start**, not how long an already-running one
stays alive. A pass that blows its time budget frees its slot the instant
`withDeadline` rejects — but the abandoned `listConceptIds()` call underneath
keeps running until the adapter itself notices the abort signal.

## The gap, stated plainly

`okf-local.mjs` checks the abort signal every directory. `github.mjs` and
`mcp.mjs` currently do not check it at all during listing. So a timed-out remote
source's scanning phase can outlive both its own slot and the queued source that
took it. This is a known gap, not a subtlety to rediscover.

## Memory pressure

`packages/core/src/memory-pressure.mjs` gates new passes on the worse of two
signals: the engine's `heapUsed` as a fraction of the **measured V8
`heap_size_limit`** (elevated ≥60%, critical ≥80%), and the engine's live
bytes (`heapUsed + external`) as a fraction of total system RAM (≥12%/≥25%).

Three rejected alternatives, each of which read plausibly and measured nothing:

- `os.freemem()` — mostly reclaimable page cache, so a healthy machine looks
  starved.
- Raw RSS — a high-water mark V8 rarely releases, so the engine looks permanently
  worse than it is.
- The system-RAM fraction **alone** — unreachable on the machines that matter.
  25% of a 32GB Mac is 8GB of live heap; V8 aborts the process at its own
  ~4.2GB default limit first, and the desktop app cannot raise that ceiling
  (Electron 43 ignores every utilityProcess heap flag — probed empirically,
  see apps/desktop/CLAUDE.md). A watermark that only trips above the crash
  line is a net hung above the ceiling. The system fraction stays as a second
  signal because `external` (Buffers) lives outside the V8 heap and a
  machine-wide squeeze (jetsam) does not care which limit was hit first.

The heap ceiling is measured per process (`v8.getHeapStatistics()`), never
hardcoded, so an embedder that *can* configure a larger heap (plain Node with
`--max-old-space-size`) gets watermarks that scale with it for free.

Under critical pressure the queue holds new passes back entirely, flooring at 1
concurrent pass rather than deadlocking at 0.

`POST /api/active-source` lets a client mark the layer currently on screen so it
jumps ahead of ones nobody is looking at.

## `refreshing` is not `indexing`

A source with a snapshot that is being re-read stays `status: "ready"` and
raises the additive `indexing.refreshing` flag. A background refresh must never
flip a usable source — or the console's spinner — back to unready.
`awaitIndexes` (`?wait=`) waits on the running pass, not on `status`.

A pass dirtied mid-flight owes exactly one follow-up, and that follow-up waits
out a quiet period as long as the last pass took (clamped 1–15s). Without the
quiet period, sustained editing chained a full re-walk per keystroke, forever.
