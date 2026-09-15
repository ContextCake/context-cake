# Section-level body scoring

Before this change, `search.mjs` treated a concept's whole body — every
section concatenated into one string — as a single BM25F field. A 9-section
runbook was length-normalized as one long document, so an answer that lived
in section 7 competed on equal footing with the padding in sections 1-6. The
eval's `runbooks/database-migration-guide` questions (q43-q46 in
`packages/core/eval/questions.json`) exist to measure exactly this: each one
targets an answer buried in a specific late section of a ~275-token, 9-section
document.

## Why sections, not a bigger `b`

Length normalization already punishes a long document; the failure here is
narrower than "long documents rank too low." A 9-section runbook whose answer
is in section 7 should not be punished for the OTHER 8 sections' length at
all — those sections are irrelevant to this query, not merely diluting. No
single `b` value fixes that, because `b` trades off against every OTHER
question in the eval that correctly relies on whole-document length to
demote a long, unfocused document. Scoring the actual unit of relevance (a
section) instead of the whole document sidesteps the trade-off.

## The scoring model

- **The four short fields — `id`, `title`, `description`, `tags` — are
  unchanged.** One analysis each, per concept, as before.
- **The body field becomes one BM25F body candidate per section.** A concept
  with sections `s_1..s_n` gets `n` candidates: `[id, title, description,
  tags, section_i]` for each `i`. A concept with zero sections gets exactly
  one candidate with an empty section, so callers never special-case "no
  sections" as a different shape — `analyzeConceptFields` (`search.mjs`)
  always returns at least one section entry.
- **A concept's score is the max over its sections**, via
  `scoreConceptSections`: run the existing `scoreEntry` once per section
  candidate (same BM25F math, same field boosts, same `K1`), and keep the
  highest. This is the entire fix — a document's WORST sections can no longer
  drag down, or its scattered mentions across sections no longer
  cross-boost, the one section that actually answers the query.

## Corpus statistics: what stays per concept, what becomes per section

- **`N` (document count) and `df` (document frequency) stay per CONCEPT.** A
  term appearing in three sections of the same concept still counts as df=1
  for that concept — the question IDF answers ("how many concepts mention
  this term") does not change just because the body got split. Getting this
  wrong (counting df per section) would shrink IDF for common terms in
  well-organized, many-sectioned documents for no principled reason, and
  would break `Object.is` equality with the incremental index the moment a
  document's section count differs from another's.
- **The body field's average length is the mean SECTION length across the
  corpus** — `sum(section term counts) / count(sections)` — not a per-concept
  average. A 9-section runbook contributes 9 length samples to this average,
  not one; a single-section note contributes 1. This is what lets a short,
  focused section compete on length terms with other short, focused
  sections, instead of being measured against the average WHOLE-DOCUMENT
  length of a corpus containing much shorter unsectioned notes.
- The four short fields' averages are unchanged: per-concept, as before.

## Ties: first section in document order

`scoreConceptSections` replaces the running best only on a STRICT
improvement (`score > bestScore`), so equal-scoring sections keep whichever
came first in `concept.sections` — the same "first contributor wins on a
tie" discipline the best-layer merge already uses. This matters most for the
degenerate case below.

## `section` on a hit, and what `null` means

Every concept hit now carries `section: { key, heading } | null`. It is
`null` in exactly two cases, both meaning "this hit did not win because of
its body": the concept has no sections (the synthetic empty candidate always
ties at the fixed-fields-only score), or the winning section's frequency
map has no overlap with any query term. The second case matters because of
the tie rule above: when NO section actually matches a query term, every
section ties at the same fixed-fields-only baseline, and without the
explicit `matched` check `scoreConceptSections` would report `section_0`
as the "winner" by the tie rule — misrepresenting a title-only match as a
body match on that document's first section. `matched` is computed by
checking whether the query's stemmed terms intersect the winning section's
term-frequency map; if they don't, the hit is a title/id/description/tags
match and `section` is `null`.

The snippet follows the same rule: `makeSnippet(sectionText(winningSection),
rawTokens)` when a section matched, falling back to the whole concatenated
body otherwise — a reader should see the text that actually justified the
match, not an arbitrary section when nothing in the body was relevant.

## Two implementations, one arithmetic

Like `scoreEntry` and `linkPriorMultiplier` before it, `scoreConceptSections`
is exported from `search.mjs` and imported verbatim by `search-index.mjs`
rather than reimplemented — `Object.is` equality between the two holds by
construction. `analyzeConceptFields` is the shared per-document analysis
step; its shape is:

```js
{
  fields: [idField, titleField, descriptionField, tagsField], // each { frequencies, length }
  sections: [{ key, heading, frequencies, length }, ...],      // one per concept.sections entry,
                                                                // or one synthetic empty entry
}
```

`search-index.mjs`'s incremental stats track `fixedTotals` (per-concept, one
slot per short field, exactly as before) plus a corpus-wide `bodyTermTotal`
and `sectionCount`, maintained by the same integer add/subtract discipline
as every other stat in that file — a section entering or leaving the index
adds or subtracts its term count from `bodyTermTotal` and 1 from
`sectionCount`.

`packages/core/src/search-store.mjs` (the SQLite-backed store) is expected to
grow a matching `sections`/`section_postings` schema so it answers
bit-identically too; that work is tracked separately and is NOT part of this
change — `tests/search-store.test.mjs` is expected to be red until it lands.

## What stayed unchanged

`searchCaptures` keeps whole-body scoring: captures are short session
findings, not multi-section documents, so there is no dilution problem to
solve and no section boundary worth tracking. The inbound-link prior and
`linksTo` (`link-prior.md`) are unaffected — they operate on the resolved
concept hit, after section scoring has already picked a winner.

## A known, honest limitation

Section-level scoring is a length-normalization fix, not a term-aggregation
fix. When a query's matching terms are genuinely CONCENTRATED in one section
(the eval's q43 and q45: a `lock_timeout` value, a rename/retype rule), this
change widens that section's margin over competing documents, as intended.
When a query's matching terms are instead SCATTERED THIN across many
sections of the same document (q44, q46), whole-document BM25 used to get an
incidental boost from summing a term's frequency across every section it
appeared in — a boost this change deliberately removes, because that
cross-section aggregation is not a real signal that the document is the
right answer. The eval's q44 (`packages/core/eval/questions.json`) is the
concrete case: `database-migration-guide`'s sign-off answer drops from rank 3
to rank 5, behind `standards/code-review`, whose shorter, single-topic
section happens to share more query terms at higher frequency. This is
scored correctly by the model described above; fixing it would need a
different signal (e.g., a smaller per-query aggregation across a document's
top-N sections), which is out of scope here and would reintroduce some of
the dilution this change removes for q43/q45. Flagged as a limitation, not
smoothed over.
