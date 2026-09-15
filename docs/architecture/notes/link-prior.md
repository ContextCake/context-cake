# The inbound-link prior

BM25F (`search.mjs`) ignores the graph entirely: a concept's score depends
only on its own text against the query. That misses a real signal — a concept
six other concepts link to as the canonical answer for a topic is more likely
to BE the answer than a lexically similar page nothing points at. The eval's
`standards/production-readiness` vs. `runbooks/pre-launch-checklist` pair
(questions q39-q42 in `packages/core/eval/questions.json`) is exactly that: a
hub six concepts link to, losing to an unlinked leaf whose title happens to
share more query words.

## The signal: inbound, not PageRank

`inbound(id)` is the number of DISTINCT concept ids — across every
contributing layer, any layer's body — whose content links to `id`. Not link
*count*: a concept in two layers that both link to the same target is one
source, because inbound answers "how many other things point here," not "how
many times." Two properties fall out of that definition rather than needing
separate code:

- **Self-links never count.** A concept linking to itself would otherwise be
  free reputation.
- **A link to something outside the corpus counts for nothing.** There is no
  document to boost, so it is simply never looked up.

This is deliberately not PageRank (no iteration, no damping across multiple
hops, no distinction between a link from a hub and a link from a leaf). A
one-hop distinct-source count is enough to separate "the concept six things
converge on" from "the concept nothing points at," which is the entire claim
the eval questions test. A one-hop count is also the only version that stays
bit-identical across three independent implementations (below) without a
shared fixed-point computation.

## The prior

```js
export const LINK_PRIOR_WEIGHT = 0.1;
export function linkPriorMultiplier(inbound) {
  return 1 + LINK_PRIOR_WEIGHT * Math.log1p(inbound);
}
// final score = bm25f * linkPriorMultiplier(inbound)
```

Applied once per CONCEPT, after the best-layer merge and before the sort —
not per layer contribution, so a concept three layers happen to mention does
not additionally benefit here on top of the best-layer-wins rule BM25F
already applies.

**Log-damped on purpose.** `Math.log1p` means going from 6 inbound links to
100 does not multiply the boost by anywhere near the raw 16.7x count ratio —
see the "monotone... log damping" test in `search.test.mjs`, which asserts
that ratio stays under 3x. A prior that scaled linearly would let a handful
of extremely popular hubs dominate every query they weakly match; the intent
here is a nudge for a close lexical race (q39-q41), not a signal that can
override a document that is actually about the query.

## Choosing the weight

The questions (q39–q42) were written before the prior existed, so picking the
weight against them is legitimate. The sweep, run with
`packages/core/eval/run.mjs --verbose`:

| weight | q39 | q40 | q41 | q42 (control) | q06 (original set) | q45 / q46 | recall@1 | mrr |
|---|---|---|---|---|---|---|---|---|
| 0 (no prior) | rank 4 | rank 3 | rank 2 | rank 1 | rank 1 | 1 / 3 | 0.745 | 0.809 |
| **0.1 (kept)** | rank 4 | **rank 2** | rank 2 | rank 1 | rank 1 | 1 / 5 | 0.745 | 0.806 |
| 0.15 | rank 4 | rank 2 | rank 2 | rank 1 | rank 1 | 2 / 5 | 0.725 | 0.796 |
| 0.3 | rank 1 | rank 2 | rank 1 | rank 1 | **rank 2 (new miss)** | 2 / 5 | 0.745 | 0.811 |

0.3 flips q39 and q41 and looks best on paper. It was rejected for two
reasons. First, it costs an original question: q06 ("what TLS version is
required?") loses rank 1 to the hub, which is exactly the failure a prior must
not introduce — the hub is not about TLS. Second, the eval hub has only six
inbound links, so the multiplier that barely moves it here (`1 + 0.3·ln 7 ≈
1.58`) becomes `≈ 2.2` for a real vault's hub with fifty inbound links, enough
to put that hub near the top of every generic query. A weight chosen to win on
a small corpus extrapolates badly.

At 0.1 no original question regresses, q40 improves, and the only loss is
q46, a section-depth question whose fix is section-level retrieval, not the
prior. On this corpus the prior is close to neutral in aggregate (mrr 0.809 →
0.806); its value is on vaults with real hub structure, which the eval corpus
is too small to contain. Fifty inbound links at 0.1 is a `≈ 1.39` multiplier:
noticeable on near-ties, not a takeover.

The remaining gap on q39/q41 is not a weight problem. `pre-launch-checklist`
outranks the hub on lexical score by a margin a damped prior should not close,
and a topic-conditioned signal (does the hub's neighborhood match the query?)
is the honest fix, not a bigger constant.

This is the expected shape of ANY static, query-independent prior: it cannot
know that "how do I check before shipping" wants the hub while "what TLS
version" doesn't. A better fix would condition the prior on some notion of
topical relevance (only boost a hub when the query is already close to a
match), which is out of scope here — flagged as a known limitation, not
silently smoothed over.

## Three implementations, one arithmetic

Like `scoreEntry` itself, `linkPriorMultiplier` is exported from `search.mjs`
and imported verbatim by `search-index.mjs` and `search-store.mjs` — neither
reimplements the formula, so `Object.is` equality across all three holds by
construction, not by coincidence.

- **`search.mjs` (reference):** rebuilds inbound counts from scratch every
  query — `distinctInboundCounts()` walks every document's resolved link
  targets and groups them by target into a `Set` of source ids.
- **`search-index.mjs` (in-memory incremental):** maintains
  `target -> Map<sourceConceptId, refcount>` (`linkRefs`), updated on
  add/remove exactly like `documentFrequency` is. A source concept present in
  two layers increments and decrements the same map entry — deleting it only
  when the refcount reaches zero — so inbound counts stay integer-exact and
  order-independent across edits, same discipline as the existing stats
  bookkeeping in that file.
- **`search-store.mjs` (SQLite):** a new `links(doc, ord, target)` table
  (indexed on `target`; `FORMAT_VERSION` bumped so an existing store file
  rebuilds rather than silently answering `inbound: 0` forever) answers
  inbound with `COUNT(DISTINCT docs.id)` joined through `links.doc =
  docs.doc` — the DISTINCT is what turns "how many link rows" into "how many
  distinct source concepts," matching the other two implementations exactly.

All three resolve link targets through the SAME pure function,
`conceptLinkTargets` (`markdown-links.mjs`), which is also what `get_links`
now calls (moved out of `mcp-server.mjs`, which used to keep its own copy) —
so inbound counts agree with what `get_links` reports as a concept's
`incoming` list by construction, not by parallel maintenance.

### `linksTo`: shown, not scored

The top 3 hits additionally carry `linksTo`: up to 5 of the WINNING layer's
own outgoing targets that exist in the corpus right now, in document order.
This is display only — it does not feed back into scoring — so an agent can
see a hit's immediate neighborhood without a second `get_links` call. It is
capped at the top 3 ranks because computing it (a corpus-existence check per
target) costs a small amount of extra work per hit, and only the ranks an
agent is likely to actually look at benefit.

`linksTo` is rank-WITHIN-THIS-CALL dependent, not globally dependent: the
same concept can carry `linksTo` in one search and not in another, if a
filter (`source`, `type`) changes which rank it lands at. Tests that compare
a filtered result against a slice of an unfiltered one (in
`search-index.test.mjs` and `search-filters-service.test.mjs`) strip
`linksTo` before comparing for exactly this reason — the field is documented
as call-relative here so that divergence is never mistaken for a ranking bug.

## What stayed unchanged

Field boosts, `b`, `K1`, and the stemmer are untouched. `searchCaptures`
(captures have no link graph worth boosting) is untouched. `get_links`'s own
output — `outgoing`/`incoming` shape — is untouched; only its internals now
share code with `search.mjs` instead of duplicating it.
