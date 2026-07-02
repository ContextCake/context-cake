# Product

## Register

product

## Users

Developers and technical leads evaluating or dogfooding ContextCake — a federated
team-knowledge stitching layer. In the playground specifically, the user is
exploring how a concept resolves across cascading layers (personal / team /
company): who wins each section, what gets inherited, and where layers disagree.
They are in an inspection-and-understanding task, not a data-entry task.

## Product Purpose

Make ContextCake's core mechanic — per-section cascade resolution with conflicts
surfaced rather than hidden — visible and pokeable. The playground is a thin
reader over the real `resolver.mjs` engine: a canvas of source nodes feeding a
resolved concept, plus an inspector that shows provenance and dissent. Success is
a developer who, in under a minute, can see *why* a concept resolved the way it
did and trust that conflicts are never silently dropped.

## Brand Personality

Precise, honest, engineering-native. Three words: **clear, candid, technical.**
The tool should feel like it respects the user's expertise — dense where density
helps, never decorative for its own sake. The emotional goal is *confidence*:
"I can see exactly what the engine did."

## Anti-references

- Generic SaaS dashboard slop (gradient hero metrics, identical icon-card grids).
- Consumer-cutesy onboarding tone — this is a developer instrument.
- Hiding complexity behind a "clean" surface that obscures the cascade. The whole
  point is to *reveal* the merge, including its conflicts.

## Design Principles

1. **Surface, don't hide.** The engine's conflict policy is the product's design
   ethic — dissent is shown inline with its source and date, never dropped.
2. **The screen is a reading of the engine.** Every value on screen traces to
   `resolveConcept` output; nothing is invented in the UI.
3. **Earned familiarity over novelty.** Standard canvas affordances (pan, zoom,
   drag, inspector) so the tool disappears into the task.
4. **Density with hierarchy.** Show a lot, but make winner/provenance/conflict
   instantly scannable.

## Accessibility & Inclusion

Target WCAG AA. Body and label text must clear 4.5:1 on the dark surface. The
primary flow (browse concepts → inspect resolution) must be fully keyboard-
operable via the concept rail; canvas nodes should be reachable, not mouse-only.
Conflict state must not rely on color alone (it carries an icon + label + text).
Respect `prefers-reduced-motion`.
