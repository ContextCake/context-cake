# ContextCake Core — Design

**Date:** 2026-06-24
**Status:** Approved shape (interview-driven) — pending design-doc sign-off, then implementation plan
**Workflow:** Design-first (re-architecture of the existing engine, grounded in current code)
**Supersedes the resolution model in:** `docs/architecture.md` §3–§4 (the silent-merge + shadow machinery)

---

## 1. What ContextCake is (one sentence)

> **ContextCake stitches your separate knowledge graphs — personal, team, company — into one OKF graph your agent can read, returning a primary answer and being honest about contradictions: which layers disagree, and when each was last updated.**

Two ideas, both graspable in a breath: **stitch** and **surface conflicts honestly**.

It is **not** a knowledge store. It owns no source of truth. The graphs already exist, in
different places, behind different access (a git repo you can clone; an MCP server you can only
query). They will never talk to each other by default. ContextCake is the layer that makes them
talk — and **OKF is the language they all speak once stitched.**

## 2. OKF is the first-class spine

ContextCake speaks **Open Knowledge Format natively**: concepts, frontmatter, sections, **and the
links/edges between concepts** (it is a graph, not a pile of documents — `get_links` is core).

- **OKF-native layers** (personal, team — git repos of OKF) are first-class. The engine reads them
  directly: nodes, edges, sections, provenance.
- **A foreign source** (the company graph, reachable only over MCP) is **translated into OKF** on the
  way in. It does not get to be a peer format — OKF is the lingua franca everything resolves into.
- **The stitched output is one OKF graph.** Nodes carry their **outgoing** links. (Honest POC scope:
  see §8 — outgoing links in a resolved concept are preserved; cross-source *incoming*/backlink
  discovery is **not** free, because today's `get_links` walks the filesystem and an MCP-backed layer
  has no filesystem to walk. Backlinks from a foreign source need a query that server may not expose.
  Deferred — see §10.)

## 3. Three layers

`personal` (3) · `team` (2) · `org-default` (0). The 4th "Group" layer is dropped — it was
speculative. Layer **order is a visible setting**, not hidden magic: higher wins, and the user can
see (and later change) the order.

## 4. Resolution: one answer, honest about dissent

When an agent asks for a concept, it gets **one primary answer** (by layer order) — *plus*, for any
contradicted section, what the other layers said, their source layer, and their last-updated date.

```
decisions/database-engine

  SingleStore                              ← primary   (team,        updated 2026-05-12)
  Chosen for HTAP / reporting workloads.

  ⚠ org-default disagrees:
    Postgres                                          (org-default, updated 2026-06-01)  ← newer
```

Clean answer up top; dissent + dates underneath. **The updated-date is the staleness signal** — if
org's version is newer than the team's override, you simply *see* it and judge. This replaces the
entire hash-drift / shadow-detection subsystem with one honest glance. Nothing is hidden.

Conflicts attach **per section** — each resolved section carries an optional `conflicts: [{layer,
updated, content}]`. Sections that don't conflict resolve silently (one contributor, or all layers
agree) and are just inherited — the common, non-contentious case.

**Honest limitation (accepted trade-off):** the date-only signal trusts authors to bump `updated`
when they change content. A base edit that *doesn't* bump the date won't flag as stale — the old
content-hash mechanism caught that regardless, dates don't. We accept this for simplicity. If lax
date-discipline bites in practice, the fix is a **stitch-time content fingerprint** (engine hashes
each base section at read time, no author action, alert-only — never a resolution rule). Deferred,
not built.

**One escape hatch beyond the two rules — per-section suppression.** A higher layer may blank an
inherited section it declares doesn't apply (`## Retention {#retention override=none}`), with an
audit flag, instead of restating everything to negate it. This is a deliberate third concept: teams
genuinely need to negate-without-replacing, and the alternative (suppress the whole concept) is
worse. It is the *only* rule beyond "higher wins / conflicts shown with dates."

## 5. What changes from today (mapped to code — mostly subtraction)

| | Change | Where |
|---|---|---|
| **KEEP** | OKF parsing, frontmatter merge, per-section winner, provenance (`sourceLayer`/`sourceUpdated`) | `resolver.mjs` parse + merge |
| **KEEP** | **Per-section suppression** (`override=none` tombstone + audit flag) — the one escape hatch, see §4 | `parseHeadingAttrs`, merge |
| **ADD** | **Source-adapter seam** — `loadConcept` becomes `source.loadConcept(id)`; OKF-local does today's `fs` read, MCP-source queries + translates to OKF. **NB: `resolveConcept` becomes `async`** (`Promise.all` over layers); every caller threads through — `mcp-server.mjs` is already async, so this is feasible but is *not* "just the one fs touch" | `resolver.mjs:281` + `resolveConcept` signature |
| **ADD** | **Conflict retention** — keep the losing contributors per section; emit per-section `conflicts:[{layer,updated,content}]` (shape decided: per-section, see §4) | `mergeConcepts` |
| **CUT** | Shadow/staleness subsystem: `detectShadow`, `--shadow`, `--hash`, `hashConcept`, `overrides_ref`/`overrides_layer` (~40 lines) | replaced by §4 dates |
| **CUT** | `override: exception` governance metadata | merge special-case |
| **CUT** | section-level `updated=` recency tiebreak + DAG same-level resolution (moot with 3 distinct levels) | `sectionBeats`/`sectionTime` |

This is a net **reduction** in concepts a colleague must hold: from ~7 resolution rules to **two plus
one escape hatch** — higher layer wins; conflicts are shown with dates; a higher layer may suppress an
inherited section. The existing `resolver-test.sh` cases for the cut features (shadow, exception, the
`two_teams` same-level recency fixture) are removed and replaced with conflict/date assertions —
expected, not a regression. The suppression test is kept.

## 6. Components

| Path | Role | Status |
|---|---|---|
| `resolver.mjs` | Core engine: OKF parse, source adapters, primary+conflict resolution | refactor (§5) |
| `sources/okf-local.mjs` | Adapter: read an OKF git bundle from disk (today's logic, extracted) | new (extracted) |
| `sources/mcp.mjs` | Adapter: query a foreign graph over MCP, translate response → OKF concept (+edges) | new |
| `examples/mock-context-source.mjs` | A tiny **non-OKF** MCP graph server for the POC's `org-default` layer (proves translation; self-contained, dependency-free) | new |
| `mcp-server.mjs` | The read surface agents connect to; resolves via `resolver.mjs`; `read_file`/`get_links`/`search` now return primary+conflicts | light change |
| manifest | A layer now declares a `source` type: `{ "name":"org-default", "level":0, "source":"mcp", "command":"node", "args":["./examples/mock-context-source.mjs"] }` vs `"source":"okf-local","path":"..."` | schema add |

## 7. POC scope

Prove the stitch across **heterogeneous** sources. **The real artifact is the source-adapter
abstraction** — a generic contract any MCP-backed context source can implement. The product does not
care what a foreign source looks like; the adapter's whole job is to bring *whatever* shape into OKF
alongside the native layers. The POC instantiates that contract once, with a mock:

- `personal` → OKF git bundle (native)
- `team` → OKF git bundle (native)
- `org-default` → **a mock MCP source** standing in for "some MCP that pulls in context from
  somewhere." Its shape is deliberately **arbitrary and non-OKF** — chosen to prove the adapter maps
  an unknown shape into OKF, not to mirror any specific system. (Real targets like membrain slot in
  later by writing another adapter against the same contract — no engine change.)

One star concept that exercises both **agreement-inheritance** and **honest conflict**:
`decisions/database-engine` (team: SingleStore; org-default: Postgres, updated *later*) — plus a
second non-conflicting concept so the common inherit-silently path is visible.

**Deferred (not POC):** the "hide this conflict" user preference (show first, learn frequency, suppress
later); additional adapters beyond OKF-local + one MCP; the live demo content/runbook (separate track).

## 8. Acceptance criteria (EARS)

- WHEN an agent requests a concept that exists in multiple layers and the sections agree THE SYSTEM
  SHALL return one effective OKF concept with per-section provenance and no conflict annotations.
- WHEN two layers define the same section with different content THE SYSTEM SHALL return the
  higher-layer value as primary AND attach each dissenting layer's value, source layer, and
  last-updated date.
- WHEN a layer's `source` is `mcp` THE SYSTEM SHALL spawn and query that MCP server and translate its
  response into OKF concepts and edges before resolving, indistinguishably from an OKF-local layer.
- WHEN a resolved concept's body contains **outgoing** links THE SYSTEM SHALL preserve them in the
  stitched OKF output. (Cross-source **incoming**/backlink discovery from an MCP-backed layer is
  out of POC scope — see §10.)
- WHEN a higher layer marks an inherited section `override=none` THE SYSTEM SHALL blank that section
  and flag it as suppressed (the one escape hatch, §4).
- WHEN two sources disagree on whether a concept exists at all THE SYSTEM SHALL treat the source(s)
  that have it as the contributor set (a missing concept in one layer is simply not a contributor),
  and SHALL NOT error.
- WHEN an MCP source is unreachable THE SYSTEM SHALL resolve from the remaining reachable layers and
  surface the missing source as a warning, NOT fail the whole resolution.
- WHEN the resolver runs THE SYSTEM SHALL NOT require or read any `overrides_ref`/hash metadata
  (the shadow subsystem is removed).
- WHEN layer order is requested THE SYSTEM SHALL expose it as readable configuration, not hidden logic.

## 9. Boundaries

- ✅ **Always:** keep the mental model to two rules + one escape hatch (higher wins; conflicts shown
  with dates; a higher layer may suppress an inherited section). If a feature needs *another* rule to
  explain, it goes to Deferred or gets cut. Per-section suppression is the agreed ceiling on complexity.
- ✅ **Always:** OKF is the canonical output format; foreign sources translate *into* it.
- ⚠️ **Ask first:** before adding any resolution rule beyond §4; before adding an npm dependency
  (engine stays dependency-free); before re-introducing any CUT feature.
- 🚫 **Never:** silently hide a contradiction; put real secrets/hostnames/PII in any source or fixture.

## 10. Open items for the plan

**Resolved by the rubber-duck pass (2026-06-24):**
- ~~Conflict JSON shape~~ → **decided: per-section** (`section.conflicts: [{layer, updated, content}]`).
- ~~Staleness vs. hash~~ → **decided: accept date-only**, document the gap (§4); stitch-time
  fingerprint deferred.
- ~~Per-section suppression~~ → **decided: keep** as the one escape hatch (§4).

**Still to pin in the plan (must-decide before coding the relevant slice):**
- **The adapter contract is the deliverable** (must-pin). Every source implements:
  - `async loadConcept(id) → {frontmatter, sections} | null` — resolve one concept by id (powers `read_file`)
  - `async listConceptIds() → string[]` — enumerate concept ids (powers `search` / `list_concepts` /
    `get_links` so they see *every* source, not just the filesystem ones — otherwise the "stitch"
    can't list half your context)
  - `close()` — release resources (noop for OKF-local; kills the child process for MCP)
  - plus `name` and `level`
  The mock's own JSON shape is *deliberately arbitrary and non-OKF* — any simple non-OKF structure, so
  the translation step is real. We explicitly do **not** care what it looks like; that's the point of
  the abstraction. Real sources (membrain, etc.) are future adapters against this same contract.
- **Async contract:** define the adapter interface as `async loadConcept(id) → {frontmatter,
  sections} | null`, make `resolveConcept` async via `Promise.all` over layers, thread through all
  callers. Confirm `mcp-server.mjs` call sites (already async) need only an added `await`.
- **MCP-source failure handling:** unreachable source → warn-and-continue (per §8), don't fail.
- **How `mcp-server.mjs` surfaces conflicts to the agent** (inline in `read_file` text vs. a
  structured field) — and how `get_links` behaves when a layer has no filesystem root.

**Deferred (explicitly not in the POC):**
- Stitch-time content fingerprint for drift alerting (only if date-discipline proves unreliable).
- Cross-source incoming/backlink discovery from MCP-backed layers (needs a foreign backlink query).
- The "hide this conflict" user preference.
- Additional real adapters (membrain, etc.) against the source contract.

**Demo collision (decided 2026-06-24):** this re-arch deletes `--shadow`/`--hash`, which the paused
`demo/` track (`demo/setup.sh`, `demo/verify.sh`) depends on. Decision: **clean-delete now**, let the
demo's shadow beat go stale, and reconcile the demo (swap shadow → the dates-based conflict beat) when
that track resumes. No deprecated shims carried through the rebuild.
