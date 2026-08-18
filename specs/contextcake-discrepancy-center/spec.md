# ContextCake Discrepancy Center

ContextCake turns structural disagreement across a selected source profile into
decision-ready evidence, safe resolution, and user-approved reusable policy. It
extends the shipped conflict-resolution workflow without changing resolver
precedence or inferring semantic contradictions.

## Problem Statement

The shipped resolver and Conflicts view expose same-concept, same-section text
differences, but professional teams also need metadata disagreements, broken
knowledge links, decisions that reopen after sources change, inspectable diffs,
and a trustworthy explanation of what an action will write. Repeated human
choices should make the product faster without granting an opaque model the
authority to change knowledge.

## User Stories

- As an engineer, I can understand why a discrepancy exists and what currently wins.
- As a technical leader, I can filter actionable discrepancies by kind, owner, source, status, and priority.
- As a reviewer, I can choose an existing answer, compose a reconciled answer, or acknowledge an intentional scoped difference.
- As an auditor, I can inspect every original answer and every superseding decision.
- As a user, I can approve an explainable rule recommendation and separately decide whether it may run automatically.
- As a teammate, I can promote a local recommendation without silently enabling automation for other people.

## Acceptance Criteria

- [x] WHEN contributors define the same section differently THE SYSTEM SHALL emit a `section_content` discrepancy with every contribution and the deterministic winner reason.
- [x] WHEN contributors define the same authored frontmatter field differently THE SYSTEM SHALL emit a `frontmatter_value` discrepancy, excluding `updated` and `override`.
- [x] WHEN an outgoing OKF link has no target in a healthy, settled selected profile THE SYSTEM SHALL emit a `broken_link` discrepancy, carrying deterministic structural repair `candidates` (relative path, case, extension, slug, moved basename, title, bounded edit distance — never model-inferred) and a `bestCandidate` only when one candidate is confident and unambiguous; candidates SHALL NOT participate in the record's `revision`.
- [x] WHEN a recorded contributor fingerprint changes after a decision THE SYSTEM SHALL reopen it as `changed_after_decision`, even if the authored date did not change.
- [x] WHEN sources are indexing or unavailable THE SYSTEM SHALL report incomplete coverage and SHALL NOT manufacture broken-link findings.
- [x] WHEN a discrepancy is resolved THE SYSTEM SHALL support choosing a contribution, composing a reconciled value, or acknowledging a scoped difference.
- [x] WHEN a scoped difference is acknowledged THE SYSTEM SHALL write no source content and SHALL require a reason code.
- [x] WHEN any source write or decision-log append fails THE SYSTEM SHALL restore every changed target or explicitly report recovery-required state.
- [x] WHEN an incomplete prepared transaction is found at startup THE SYSTEM SHALL restore its original files and append a rollback outcome.
- [x] WHEN a v1 conflict-resolution record is read THE SYSTEM SHALL preserve and display it without rewriting the file.
- [x] WHEN three distinct discrepancies receive the same structural manual decision THE SYSTEM SHALL offer an evidence-backed local rule suggestion.
- [x] WHEN a rule is approved THE SYSTEM SHALL default it to recommendation mode; automatic mode requires a separate explicit action.
- [x] WHEN multiple matching rules disagree THE SYSTEM SHALL perform no automatic action.
- [x] WHEN a promoted team rule reaches another user THE SYSTEM SHALL remain a recommendation until that user explicitly enables local automation.
- [x] WHEN the Web Demo performs a decision THE SYSTEM SHALL identify it as a simulation, write no files, run no automatic rules, and state that history resets on reload.
- [x] WHEN an agent reads an acknowledged discrepancy THE SYSTEM SHALL expose additive disposition metadata without removing the original conflicts.
- [x] WHEN the primary review workflow is used with a keyboard THE SYSTEM SHALL expose the same evidence, actions, focus state, status, and errors as pointer use.

*Amended 2026-08-18 — Discrepancy Center at scale (read side and live-layer writes):*

- [x] WHEN a client asks for the discrepancy summary (`GET /api/discrepancies/summary`) or the compact, filtered, or paged list (`GET /api/discrepancies?fields=compact&…`) THE SYSTEM SHALL answer from the same memoized projection the full list, the detail read (`?id=`), and the decision guard answer from — one build per change of corpus, source health, or sidecar state — and every such response SHALL carry the same `projectionRevision` for the same build; the bare `GET /api/discrepancies` envelope SHALL remain unchanged.
- [x] WHEN a decision writes into a contributor inside the live team layer THE SYSTEM SHALL stage and commit that write inside the locked git path (`git-core.mjs`) as one pathspec commit per decision (`chore(contextcake): resolve <kind> <conceptId>#<key> (<action>)`), record `liveLayerCommit` on the decision, push once per request, report an unreachable remote as `{ pushed: false, queued: true }` rather than a failure, refuse with 409 `LIVE_LAYER_BUSY` and no bytes changed while another process holds the repo lock, and commit nothing when the decision leaves the live file byte-identical.
- [x] WHEN startup recovery restores a prepared transaction whose targets lie inside the live team layer THE SYSTEM SHALL commit the restore (`chore(contextcake): roll back uncommitted discrepancy transaction <id>`) before marking the transaction rolled back, so git history and the decision log agree.

## Out of Scope

- Semantic entity matching, embeddings, or model-inferred contradictions.
- Candidate ranking for broken links beyond lexical/structural rules (no
  content similarity, no model).
- Cross-source incoming links not exposed by a source adapter.
- Hosted policy infrastructure, approval routing, or new shared telemetry fields.
- Treating missing concepts or singly defined fields as discrepancies.
- Learning or replaying free-form reconciled content.

## Defaults and Boundaries

- Resolver precedence, per-section conflict retention, and explicit suppression remain unchanged.
- Priority defaults to `unassigned`; ContextCake does not invent business severity.
- Local rules outrank shared recommendations only for the current profile; conflicts between rules disable automation.
- Rules store structural metadata and decision ids only, never source content, notes, prompts, or excerpts.
- Shared rules use the existing live-layer git trust boundary and remain recommendations for other users.

## Dependencies

- Existing resolver provenance and conflict output.
- Existing manifest/profile lock and guarded section writers.
- Existing append-only conflict-resolution log.
- Existing live-layer git mutation and offline queue.
- Existing console Review surface and generated demo bundle.
