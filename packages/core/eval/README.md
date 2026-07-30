# Retrieval eval

Every other suite in this repo tests mechanism: does the merge pick the right
section, does the walk stay bounded, does the token guard hold. None of them can
answer the question the product actually lives or dies on — **would an agent find
the right concept from a question a person actually typed?**

This measures that.

```bash
npm run eval                                              # report + regression gate
node packages/core/eval/run.mjs --verbose                 # show what each miss returned instead
node packages/core/eval/run.mjs --json                    # machine-readable
node packages/core/eval/run.mjs --record --label "why"    # accept a new number
```

## What is here

| Path | Role |
|------|------|
| `corpus/` | Three committed OKF layers — company (0), team (2), personal (3) — with deliberate cross-layer overrides |
| `questions.json` | 38 natural-language questions, each with the concept ids that answer it and a `probes` note saying why the question exists |
| `manifest.json` | Points the engine at the corpus; also usable by hand with `resolver.mjs` or `mcp-server.mjs` |
| `run.mjs` | Runner and regression gate |
| `baseline.json` | Current metrics plus the history of every superseded number |

## Metrics

- **recall@1** — the right concept is the first hit.
- **recall@5** — it is in the top five, which is realistically what an agent reads.
- **mrr** — mean reciprocal rank; moves when a hit is merely demoted rather than lost.
- **conflict** — for questions where layers disagree, resolving the answer still
  surfaces the dissenting layers. Finding the concept is only half the claim: if
  the disagreement does not survive retrieval, the answer is just the top layer's
  opinion wearing a provenance badge.

## Results so far

| Scorer | recall@1 | recall@5 | mrr | conflict |
|---|---|---|---|---|
| Substring occurrence counting | 0.263 | 0.500 | 0.348 | 1.000 |
| BM25F over Porter-stemmed tokens | 0.895 | 1.000 | 0.947 | 1.000 |

The old scorer counted `indexOf` hits with fixed field weights. Three things
were wrong with it, and the eval separated them:

1. **Substring matching, not token matching.** The query word `I` matched the
   `i` inside *identifier*, *in*, and *with*. Natural questions carry several
   such words, so the longest document usually won.
2. **No inverse document frequency.** A word in every document counted as much
   as a word in one.
3. **No length normalization.** Repetition beat precision.

`conflict` was already 1.000 before the rewrite. That is the honest read on the
engine: the cascade and the conflict surfacing worked; retrieval was the broken
half, and it was broken badly enough to hide the working half.

## Adding questions

Write the question the way someone would actually type it, *then* see what the
ranker does. A question written after looking at the corpus tends to reuse the
document's own vocabulary, which grades the ranker on the one case it is
guaranteed to pass.

Fill in `probes` with what the question is testing — a morphological variant, a
distractor term, a genuine synonym gap. When a question flips from hit to miss,
that note is what tells you whether the change was real.

## Known ceilings

Some questions cannot be won by lexical ranking at any amount of tuning. `q07`
("how long do we keep logs?") asks with *keep* against a corpus that says
*retained*; no stemmer bridges that. Those questions stay in the set on purpose
— they are the honest measure of what a lexical ranker leaves on the table, and
the number to beat if embeddings ever earn their dependency.
