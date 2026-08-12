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

`packages/core/src/memory-pressure.mjs` gates new passes on the engine's own
live heap (`heapUsed + external`) as a fraction of total system RAM.

Two rejected alternatives, both of which read plausibly and measure nothing:

- `os.freemem()` — mostly reclaimable page cache, so a healthy machine looks
  starved.
- Raw RSS — a high-water mark V8 rarely releases, so the engine looks permanently
  worse than it is.

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
