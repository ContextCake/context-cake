# Conflict Resolution

**Status:** Shipped predecessor. The additive professional workflow and governed
learning contract lives in `specs/contextcake-discrepancy-center/spec.md`.

ContextCake turns surfaced section conflicts into quick, reversible decisions. It resolves only meaning-preserving differences automatically, asks one clear question when judgment is required, and keeps an append-only local record of every applied choice.

## Problem Statement

ContextCake already shows which layer wins and keeps dissent visible, but the live console does not complete the job. Its resolution controls are demo-only, its choices describe internal operations instead of asking what is true, and a resolved item leaves no durable record in the product.

Users need to clear harmless formatting drift without reviewing it one item at a time. When two answers differ in meaning, they need the smallest useful amount of provenance and one plain multiple-choice decision. They must also be able to see what ContextCake changed and choose differently later.

## User Stories

- As a ContextCake user, I can resolve all meaning-equivalent conflicts in one action.
- As a ContextCake user, I can answer “Which answer should ContextCake use?” by choosing one of the contributing layer values.
- As a ContextCake user, I can see why a conflict was safe to resolve automatically.
- As a ContextCake user, I can inspect the original answers, chosen answer, method, and time after a resolution.
- As a ContextCake user, I can change a past decision without reconstructing the old answers from source control.
- As a ContextCake user, I am protected from writing to only the known-valid subset when another target is missing, read-only, or stale.

## Acceptance Criteria

- [x] WHEN every contribution has the same words in the same order after case, punctuation, whitespace, and Markdown-emphasis normalization THE SYSTEM SHALL mark the conflict safe for automatic resolution.
- [x] WHEN any normalized word differs or moves THE SYSTEM SHALL require a human choice.
- [x] WHEN the user invokes automatic resolution THE SYSTEM SHALL keep the currently effective answer.
- [x] WHEN a conflict requires judgment THE SYSTEM SHALL show the question “Which answer should ContextCake use?” and one selectable answer per contributing layer.
- [x] WHEN an answer is selected THE SYSTEM SHALL show its full section value, layer, and update date before applying it.
- [x] WHEN a resolution is applied THE SYSTEM SHALL write the chosen section value to every writable local layer that contributed to that conflict.
- [x] WHEN any contributing layer is missing, remote, no longer contains the section, or changed since resolution began THE SYSTEM SHALL write nothing and explain what blocked the action.
- [x] WHEN a resolution succeeds THE SYSTEM SHALL append a local record containing the concept, section, original contributions, chosen contribution, automatic-or-manual method, reason, and timestamp.
- [x] WHEN a conflict no longer appears in resolver output because its sources now agree THE SYSTEM SHALL keep the resolved item available from its decision record.
- [x] WHEN the user changes a past decision THE SYSTEM SHALL allow any answer saved with that decision to be chosen and SHALL append a superseding record.
- [x] WHEN a decision record does not match current source content THE SYSTEM SHALL refuse to overwrite the newer content.
- [x] WHEN the resolution controls are used with a keyboard THE SYSTEM SHALL expose the same choices, focus state, status, and errors available to pointer users.

## Out of Scope

- Semantic or model-based automatic merging.
- Resolving conflicts contributed by remote or read-only sources.
- Free-form editing of a third answer inside the conflict workflow; the Files editor remains the editing surface.
- Deleting or rewriting past decision records.
- Team identity, approval routing, or hosted synchronization of the local decision log.

## Open Questions

- A future team workflow may add actor identity and approval policy. The local v1 record uses `local-user` without claiming a verified person.
- A future resolver may consume decision records directly. V1 applies the chosen text to the contributing local source sections and keeps history outside the cascade.

## Dependencies

- Existing per-section conflict output from `resolveConcept`.
- Existing guarded section writer and local service mutation gate.
- Existing console conflict adapter and source provenance display.
