# Why clients poll `/api/status`, never `/api/graph`

**Rule:** never reintroduce a per-request `countTokens` over the corpus.

## The cost that forced this

`/api/graph` used to tokenize the whole corpus on every request. On a 139MB
vault that cost 14.5 seconds per call — and the console was polling it every
900ms. The page was never wrong, exactly; it was just permanently behind its own
requests.

## The split

`/api/status` is O(sources): index progress and per-source state, no resolve, no
tokenize, roughly 370 bytes. It carries a `generation` counter that moves
whenever the *content* of the graph payload would differ.

Progress-only fields — `indexing.elapsedMs`, `passes` — are deliberately kept
**outside** `generation`. A counter that moved every millisecond through an
index would defeat the very poll it exists to gate.

## `generation` is necessary, not sufficient

The console refetches only when `generation` changed **and** either the
per-source content signature changed or nothing is in flight. Measured on a
3,000-note vault: 24 status calls and 2 resolve-alls, where the old loop issued
24 requests against 150MB of payload.

Polling pauses on `visibilitychange` and resumes on return.

## Where the remaining cost went

`/api/graph`'s expensive half — concept rows plus `resolvedTokens` — is memoized
on the identity of the snapshots it read, and per-concept token counts come from
the index rather than a per-request BPE encode.

That cache is keyed by live state on **every** request rather than cleared by an
invalidation event. This is deliberate: there is no trigger to forget, so there
is no code path that can forget to fire one.

## Partial answers are normal

`/api/graph` and `/api/resolve-all` answer from whatever is indexed right now
and report `indexing` / `indexingSources`. Clients render what they have and
poll. Any assertion about completeness — in a test or a script — must pass
`?wait=<ms>`, and `?wait=` is clamped to 5 minutes (`WAIT_MAX_MS` in
service.mjs) regardless of how large `sourceBudgetMs` grows — a socket held
open for a 30-minute index budget is a hang with a header. Something that
genuinely needs to outwait a longer index polls `/api/status` like the
console does. `/api/resolve` deliberately reads one concept live.

`/api/resolve-all` also shares one corpus materialization with
`/api/discrepancies` (`resolvedCorpus` memo, keyed like the graph memo, 30s
idle eviction because it holds corpus-scale strings) and streams its response
one concept at a time — the old whole-payload `JSON.stringify` was a
~50MB-per-4k-notes single string with a hard V8 ceiling at ~512MB.
