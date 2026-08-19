# One discrepancy projection, memoized where it is read

**Rules:** every discrepancy read — the list, the compact list, the summary,
`?id=`, the decision guard, the batch, the automatic-rules job — answers from
`createDiscrepancyOperations().project()`. Nothing else calls
`buildDiscrepancies` over the corpus. A write into the live team layer from a
decision goes through `git-core.mjs` inside the control operation, never
through `layer-files.mjs`. Every content-changing decision — choose, compose,
rewrite a link, remove a link, create a stub — takes the one write tail
(`commitDecisionWrite`); a batch is that tail N times under one lock, never a
new one.

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
- `sourceHealthSig` is the aggregate `indexing` flag plus `[name, status,
  error]` per source — the fields `healthSummary` keeps and
  `coverageComplete` tests. Progress fields (`loaded`, `total`, `phase`) are
  deliberately outside it; a first index over a big vault would otherwise
  miss the memo on every poll for no change in the answer. In the service
  `indexing` is derived from the source statuses, so naming it costs no extra
  miss; it is there so a host whose flag can move on its own still gets a
  fresh coverage answer.
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

## Batch and write actions

### Why per-item transactions, even in a batch

A batch (`decideBatch`) is one lock and one projection, but each item stays
its own journal transaction with its own commit or rollback. Users expect "37
fixed, 3 need attention", not one stale file vetoing 40 unrelated fixes; the
decision log stays 1:1 with the files that changed; and the recovery path
(`transactionJournal.recover`) never has to reason about a partial batch. The
cost — N git commits into the live layer for a batch of N — is auditability,
and is called out in the spec. Two things the batch does hold in common:
every item is validated against the projection *before* anything is applied
(NOT_OPEN, STALE, DUPLICATE, and every parameter check that needs no disk
read — `validateDecisionParams`, the same function `applyDecision` runs), so a
client that sent one bad revision or one rewrite to a concept that does not
exist learns about it in the same response as the 40 that landed; and the
push, the `onWritten`, and the suggestion mining happen once at the end.
`stopOnError` turns the rest of the list into `SKIPPED` after the first
failure; a `RECOVERY_REQUIRED` does that regardless, because a write that
could not be rolled back needs a person before anything else is applied.

The lock is held for the whole batch, and the manifest lock has waiters: a
concurrent decision, rule edit, or source add gives up after
`MANIFEST_LOCK_TIMEOUT_MS` (15 s). So the apply loop has a wall-clock budget
(`BATCH_TIME_BUDGET_MS`, 10 s): items not reached in time come back
`BATCH_TIME_BUDGET` — counted as `notAttempted`, not `failed` — and the caller
resubmits them (the console's "continue"; the automatic job simply picks them
up on its next pass). The budget never stops a batch before its first attempt,
so a run whose projection alone outlasted it still makes progress and a queue
of automatic work still converges. 500 acknowledgements or local rewrites fit
comfortably; 500 commits into the live layer do not, and should not hold every
other writer off for a minute.

`dryRun` reuses the same code path with the stage's `probe` flag: every
precondition a real apply checks — writability, the live section read, the
rewrite target's existence, a stub's collision, `expectedContent` — runs, and
the answer is the list of targets, without a byte staged. That is what lets
the console say "N files change across L layers" before it commits, from the
engine's own checks rather than a client-side guess.

The automatic-rules job is the same batch with `methodOverride: "automatic"`
and two hooks: a `guard` that re-checks each item against the locked
projection (rule state can change while the job waits for the lock —
disabling a rule, an ambiguity, a source generation change always wins over a
previously scheduled action) and declines silently, exactly as the
one-per-pass loop did; and an `onApplyError` that appends the `blocked`
record inside the same lock. Bounded at 500 per pass; the writes invalidate
the index, the host re-runs the job after the next pass, and the queue
converges — now 500 at a time instead of one.

### Why a rewrite touches only the effective contributor

A `broken_link` record has exactly one contribution: the effective section
the user is shown. `rewrite_link` and `unlink` edit that section in that
layer and nothing else. A dissenting copy of the section in a lower layer is
not a discrepancy today (the resolver's dissent is section-level, and the
link there is not effective); if precedence later flips, the copy surfaces
as its own broken_link with the same candidates and the user decides it then.
Reaching into layers the record does not name would be a write the user
never saw. The section is read live (`readLiveSection`), not from the
projection, because a broken link's `revision` fingerprints its target, not
the section text — so two links in one section share a revision, and the
second rewrite in a batch must see the first one's edit rather than fail
`expectedContent` against a stale copy.

`create_stub` is the one action that resolves more than the record it was
taken on: every link to that target across the corpus resolves once the
concept exists. Only the one decision is recorded; the created concept is the
audit trail for the rest. It goes through the create-mode transaction in
`layer-files.mjs` — no backup, exclusive placement, rollback by unlink — and
recovery of a `prepared` create removes the file (bounded to that window,
called out in the spec).

### Why `target` is never wildcarded, and why only broken-link rules wildcard at all

A broken-link rule may say `conceptType: "*"` and `key: "*"` — "every broken
link to `old/decisions` from the team layer, whatever section it sits in" —
and the miner only offers that generalization when the evidence spans at
least two distinct (conceptType, key) pairs, because three acknowledgements
of the same section are a pattern about that section, not about the target.
The target itself is exact, always. A broken link's identity *is* the missing
target; a rule that matched any target in a section would auto-acknowledge
(or auto-rewrite) a future, unrelated dangling link — a typo nobody reviewed
— which is precisely the failure the target pin exists to prevent. And it is
the target pin that makes a wildcard tolerable at all: a `section_content` or
`frontmatter_value` rule with `*` on both fields would be pinned by kind and
sources alone, and one `PATCH … mode: "automatic"` would overwrite every
disagreement between two layers, sight unseen. `validateRule` refuses
`target: "*"` and refuses the wildcard for any kind but `broken_link`;
`ruleConflict` is unchanged: a wildcard rule and an exact rule that disagree
both match and disable automation; no specificity order is invented, because
"the more specific rule wins" is a policy the user never approved.

### Why the push happens after the lock, and every restore inside git-core's

The manifest lock serializes decisions with source and settings edits, and it
has waiters that give up after 15 s — including synchronous ones (`POST
/api/sources`, `PATCH /api/settings`) that spin the event loop while they
wait. A push is up to three network calls of 90 s each. Pushing under that
lock would time every concurrent writer out, freeze the process for those
sync waiters, and past the 60 s stale threshold let another process
legitimately steal the lock. So `commitDecisionWrite` never pushes: it
returns a `git.pushRoot` marker once the decision is durable, and the caller
— `decide`, `decideBatch`, `runAutomaticRules`, the legacy conflict route —
pushes once through `pushAfterUnlock` after releasing the lock, exactly as
`promoteRule` always did.

The mirror rule for the repo lock: every byte a locked git mutation changes
lands inside `commitPathsWithMutation`'s `mutate`, and its `rollback` runs
under that same lock even when the mutation itself throws (the mutation is
inside git-core's try, not before it), so a half-applied staged transaction
is restored before another process can pull over it. Startup recovery follows
it too: the journal hands its restore step to the operation (`restore(tx,
targets, applyRestore)`), which restores live-layer targets *inside* the
mutate that commits the restore, and everything else on the plain path.

## Why F30 is fixed in the operation and not in `layer-files.mjs`

`stageSectionTransaction` and `stageFrontmatterTransaction` are the guarded
writers every host uses, and they must not know what git is: a `files`
folder, an `okf-local` bundle, and a live team clone all stage the same way.
Whether a contributor is the live layer is a property of the manifest
(`resolveLiveLayer`), and the operation already reads the manifest view. So
`commitDecisionWrite` — the one write tail every content-changing decision
takes, the legacy "change a past decision" route included — asks first: is
one of the layers being written the live layer? If so, staging, the journal's
`prepared` record, and the rename all run **inside**
`git-core.commitPathsWithMutation` — the same lock and pathspec-only commit
the capture and rules-promotion paths use. Staging goes inside the lock on
purpose: it reads the target to back it up, and that read must not race
another process's pull of the same file. A `LockBusy` therefore answers 409
`LIVE_LAYER_BUSY` with nothing read, journaled, or renamed. Push is once per
request, after the decision is durable; offline is `{ pushed: false, queued:
true }` in the response, never a thrown error, and `POST /api/sources/sync`
lands the queue.

`skipIfClean` exists in git-core for one reason: choosing the source that
already wins writes its own bytes back to that layer, and a byte-identical
file is not a commit — git would refuse "nothing to commit" and the decision
would roll back for no reason. `--literal-pathspecs` rides every pathspec
call because the paths are concept ids, and a `[` in a name is a glob.

Two edges close the gap between "git has it" and "the log has it". If the
git commit lands and the decision append then throws, the restore is itself a
commit under the same lock (`chore(contextcake): roll back uncommitted
discrepancy transaction <id>`), never a bare copy that would leave HEAD
holding a write the log denies. If the process dies in that window instead,
startup recovery restores the backups and commits the restore from inside
the journal's restore step (`onRestored`), before the journal marks
`rolled_back`, so a failed commit leaves the transaction retryable rather
than half-recorded. And once the decision *is* appended, nothing rolls back:
a journal or cleanup failure after that point is logged, and recovery
reconciles the `prepared` record against the committed decision.
