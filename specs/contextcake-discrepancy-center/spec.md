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

- [ ] WHEN contributors define the same section differently THE SYSTEM SHALL emit a `section_content` discrepancy with every contribution and the deterministic winner reason.
- [ ] WHEN contributors define the same authored frontmatter field differently THE SYSTEM SHALL emit a `frontmatter_value` discrepancy, excluding `updated` and `override`.
- [ ] WHEN an outgoing OKF link has no target in a healthy, settled selected profile THE SYSTEM SHALL emit a `broken_link` discrepancy.
- [ ] WHEN a recorded contributor fingerprint changes after a decision THE SYSTEM SHALL reopen it as `changed_after_decision`, even if the authored date did not change.
- [ ] WHEN sources are indexing or unavailable THE SYSTEM SHALL report incomplete coverage and SHALL NOT manufacture broken-link findings.
- [ ] WHEN a discrepancy is resolved THE SYSTEM SHALL support choosing a contribution, composing a reconciled value, or acknowledging a scoped difference.
- [ ] WHEN a scoped difference is acknowledged THE SYSTEM SHALL write no source content and SHALL require a reason code.
- [ ] WHEN any source write or decision-log append fails THE SYSTEM SHALL restore every changed target or explicitly report recovery-required state.
- [ ] WHEN an incomplete prepared transaction is found at startup THE SYSTEM SHALL restore its original files and append a rollback outcome.
- [ ] WHEN a v1 conflict-resolution record is read THE SYSTEM SHALL preserve and display it without rewriting the file.
- [ ] WHEN three distinct discrepancies receive the same structural manual decision THE SYSTEM SHALL offer an evidence-backed local rule suggestion.
- [ ] WHEN a rule is approved THE SYSTEM SHALL default it to recommendation mode; automatic mode requires a separate explicit action.
- [ ] WHEN multiple matching rules disagree THE SYSTEM SHALL perform no automatic action.
- [ ] WHEN a promoted team rule reaches another user THE SYSTEM SHALL remain a recommendation until that user explicitly enables local automation.
- [ ] WHEN the Web Demo performs a decision THE SYSTEM SHALL identify it as a simulation, write no files, run no automatic rules, and state that history resets on reload.
- [ ] WHEN an agent reads an acknowledged discrepancy THE SYSTEM SHALL expose additive disposition metadata without removing the original conflicts.
- [ ] WHEN the primary review workflow is used with a keyboard THE SYSTEM SHALL expose the same evidence, actions, focus state, status, and errors as pointer use.

## Out of Scope

- Semantic entity matching, embeddings, or model-inferred contradictions.
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

