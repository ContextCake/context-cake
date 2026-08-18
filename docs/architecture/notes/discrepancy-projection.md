# One discrepancy projection, memoized where it is read

**Rules:** every discrepancy read — the list, the compact list, the summary,
`?id=`, the decision guard, the automatic-rules job — answers from
`createDiscrepancyOperations().project()`. Nothing else calls
`buildDiscrepancies` over the corpus. A write into the live team layer from a
decision goes through `git-core.mjs` inside the control operation, never
through `layer-files.mjs`.

## The cost that forced the memo

`GET /api/discrepancies` used to re-project on every request: resolve the
corpus (memoized), read four sidecar files, and run `buildDiscrepancies` —
fingerprint every contribution, extract every link, match every rule — over
every concept. Every decision POST did it twice more (once to guard the
revision, once inside `runAutomaticRules`). At ~1,500 findings over a
4,000-note vault that is hundreds of milliseconds per request, and the console
issues several of them per generation change: the list, then a refetch after
each decision. The Review tab was slow in exactly the state it was built for.

The projection is a pure function of four inputs. Memoize on those inputs and
the request cost is a stat and a key compare.

## What keys it

`corpusKey | sourceHealthSig | sidecarRevision`

- `corpusKey` is `contributingKey(pinned)` — the same `(name, level, gen)`
  triples that key `resolvedCorpus`. Immutable snapshots make it correct by
  construction: it changes exactly when a concept an answer was built from
  would.
- `sourceHealthSig` is `[name, status, error]` per source — the three fields
  `healthSummary` keeps and `coverageComplete` tests. Progress fields
  (`loaded`, `total`, `phase`) are deliberately outside it; a first index over
  a big vault would otherwise miss the memo on every poll for no change in the
  answer.
- `sidecarRevision` is `size:mtimeMs` of the decision log, the local rules,
  the team rules, and the priorities file (ENOENT → `0`), plus an in-process
  write counter that every write path in the operations bumps. The stat
  covers the CLI's second engine; the counter covers the case a stat cannot —
  an in-process rewrite landing at the same size in the same millisecond.

`generation` is **not** in the key. It moves on progress; the projection does
not. A memo hit still reports the live generation so the number the console
stores names the status it would see on `/api/status`.

Eviction is idle-TTL, the same pattern as `corpusMemo` and for the same
reason: the memo holds every record's contribution bodies. Staleness is
impossible by construction because the key is re-derived on every access; the
TTL bounds memory only.

## Why the memo lives in the control operation, not the service

The projection is "buildDiscrepancies over a corpus, with this profile's
stores." The corpus is the host's business (the service's background index,
or a CLI's `resolveConcept` over every id); the stores, the rules, and the
decision guard are the operation's. Putting the memo beside the guard means
`decide()`, `runAutomaticRules()`, and the batch that follows all read the
same object the routes serve, and a host that isn't the HTTP service gets the
memo for free by supplying `corpus`. The alternative — memo in the service,
`project` injected into the operation — leaves the operation unable to know
when its own writes invalidated it.

## Why the read shapes are pure functions

`summarizeDiscrepancies`, `compactDiscrepancy`, and `filterDiscrepancies` take
the projected list and return a new shape; they never read a store or mutate a
record. That is what lets the summary be memoized on the build (`summary()` is
lazy and cached on the memo value), lets `?fields=compact` and `/summary`
answer with the same `projectionRevision`, and lets the console mirror the
summary for the demo and for older engines without a second implementation of
the projection.

## Why broken-link candidates ride the record but not the revision

A candidate is a suggestion about the corpus, not a fact about the link. A
concept appearing elsewhere changes what we would propose; it does not change
what the section says. If candidates were fingerprinted into `revision`, a
decision taken against a link would go stale because a suggestion improved.
They are computed once per projection (the link index is built lazily on the
first broken link, and the search is memoized per target and linking folder)
and are bounded: length buckets, a histogram reject before any matrix work,
a longest-prefix-first scan cap. 1,500 dangling links over 3,000 ids cost
~300ms; the test pins it under 1.5s.

## Why per-item transactions, even in a batch

A batch (next PR) is one lock and one projection, but each item stays its own
journal transaction with its own commit or rollback. Users expect "37 fixed,
3 need attention", not one stale file vetoing 40 unrelated fixes; the decision
log stays 1:1 with the files that changed; and the recovery path
(`transactionJournal.recover`) never has to reason about a partial batch. The
cost — N git commits into the live layer for a batch of N — is auditability,
and is called out in the spec.

## Why F30 is fixed in the operation and not in `layer-files.mjs`

`stageSectionTransaction` and `stageFrontmatterTransaction` are the guarded
writers every host uses, and they must not know what git is: a `files`
folder, an `okf-local` bundle, and a live team clone all stage the same way.
Whether a target is inside the live layer's root is a property of the
manifest (`resolveLiveLayer`), and the operation already reads the manifest
view. So the operation stages, journals `prepared`, then asks: are any staged
targets inside the live root? If so the commit callback runs **inside**
`git-core.commitPathsWithMutation` — the same lock and pathspec-only commit
the capture and rules-promotion paths use — and a `LockBusy` answers 409
`LIVE_LAYER_BUSY` with nothing changed. Push is once per request; offline is
`{ pushed: false, queued: true }` in the response, never a thrown error, and
`POST /api/sources/sync` lands the queue.

`skipIfClean` exists in git-core for one reason: choosing the source that
already wins writes its own bytes back to that layer, and a byte-identical
file is not a commit — git would refuse "nothing to commit" and the decision
would roll back for no reason.

The recovery edge is the crash between the git commit and the decision
append: startup recovery restores the backups (the log has no decision, so
the write did not happen), and now the tree disagrees with HEAD. Recovery
commits the restored paths as `chore(contextcake): roll back uncommitted
discrepancy transaction <id>` from inside the journal's restore step, before
the journal marks `rolled_back`, so a failed commit leaves the transaction
retryable rather than half-recorded.
