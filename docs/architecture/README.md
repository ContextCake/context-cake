> **⚠ Superseded in part (2026-06-24).** The current resolution model is the stitching-layer
> re-architecture in [`specs/contextcake-core/design.md`](../../specs/contextcake-core/design.md):
> three layers, two rules + per-section suppression, conflicts surfaced with dates, and a
> source-adapter seam (OKF-local + MCP). The shadow/hash subsystem, `override:exception`, the
> Group layer, and same-level DAG recency described below are **removed**. This document is kept
> for historical design rationale; do not treat its mechanics (notably §3–§4 merge/precedence and
> §6 shadow-staleness detection) as current — shadow detection no longer exists.

# Team Context Radar — Cascading Knowledge Layers Architecture

**Date:** 2026-06-18
**Status:** Design locked. Read-path resolver implemented and wired into MCP server. Write-path (`write.mjs`: signals → OKF layer bundle) implemented. Decisions A–D implemented. Promotion-up-the-stack is the next slice.
**Supersedes the layering question in:** `docs/team-knowledge-system-handoff.md`

---

## Diagrams

**System architecture** — capture (left) writes to layer bundles (center); serve (right) reads them:

![Cascade system architecture](architecture.svg)

**Data flow** — the write path (capture a fact) and the read path (resolve a concept), plus shadow detection:

![Cascade data flow](dataflow.svg)

---

## 1. The decision: federated-with-precedence

The original research framed the choice as **federated** (separate graphs per scope — clean
access control, but fragmented) vs. **unified** (one graph with node-level ACLs — expensive,
not turnkey). This architecture is a third option that takes the best of both:

> **Storage is federated** (one OKF bundle / git repo per layer; access control = repo membership).
> **The reading experience is unified** (layers resolve at read time into one *effective graph*,
> higher layers overriding lower ones).

The access-control problem and the override problem are solved by the **same** mechanism: the
layer boundary. No graph database, no node-level RBAC required.

---

## 2. Layer model

Knowledge is split into ordered layers. From lowest precedence (base) to highest (most specific):

| Level | Layer | Readable by | Holds |
|------:|-------|-------------|-------|
| 0 | **Company** | all employees | org-wide canonical knowledge |
| 1 | **Group** | members of that group (e.g. Data Group) | shared standards, cross-team interfaces |
| 2 | **Team** | members of that team (e.g. Data Platform) | runbooks, decisions, systems |
| 3 | **Personal** | only the owner | scratch, drafts, personal overrides |

- Each layer is its own **OKF bundle** (a git repo of markdown + YAML frontmatter).
- **Access control falls out of repo membership.** You can read a layer iff you can clone its repo.
- A viewer's **stack** is the set of layers they can read, ordered by level. Higher level = higher precedence.

### Membership is a DAG, not a path (Decision #2)

A person can belong to **multiple** teams and/or groups at once (common at director level). So a
viewer's stack can contain **two or more layers at the same level**. The resolver must therefore
handle *horizontal* conflicts (two same-level layers defining the same thing), not just vertical
ones. See §4.3.

---

## 3. Override granularity: structured section/field merge (Decision #1)

Whole-document override loses knowledge: if your Personal layer redefines `decisions/primary-db`,
you lose the Team's detail you didn't replicate — the opposite of the goal. So the unit of override
is the **section/field**, not the document.

A concept (one OKF markdown file) decomposes into addressable parts:

- **Frontmatter** → a map of `key → value`.
- **Body** → an ordered list of **sections**, keyed by an explicit anchor in the heading.

**Default = `merge`:**

- **Frontmatter:** merge by key. A higher layer's key overrides the same key below; keys only present
  below are inherited.
- **Body:** merge by section anchor. A higher layer that defines `## Failover {#failover}` overrides
  *only* that section; sections it doesn't mention are inherited from below; brand-new sections append.

**Escape hatch = `override: full`** in frontmatter — the highest layer that sets this replaces the
whole concept (everything below it is dropped). Use when you intend to wipe the slate.

**Null override = `{#anchor override=none}`** in a section heading — the section acts as a
tombstone: the inherited section is suppressed entirely from the effective output. No replacement
prose is required. The tombstone section is retained in the resolver output as `suppressed: true`
for provenance and agent audit; `assembleMarkdown` skips it when producing rendered text. Use when
a scoped layer wants to negate a lower layer's guidance without proposing a replacement.

```markdown
## Exceptions {#exceptions override=none}
```
<!-- no body required — the heading alone suppresses the inherited section -->

> **Section alignment = explicit anchors (Decision A).** Sections align by an explicit anchor —
> `## Failover {#failover}` — so the merge key is stable even when the prose heading is reworded, and
> two layers reliably align on the same section. When no anchor is present the resolver falls back to a
> normalized heading, but anchors are the convention; concepts without them merge less reliably.
> Whole-concept `override: full` is always available when alignment isn't worth it.

---

## 4. Resolution algorithm

`resolveConcept(id, viewer)` produces one effective concept assembled from every layer the viewer
can read that defines `id`.

### 4.1 Gather contributors

```
contributors = [ layer.get(id) for layer in viewer.stack if layer defines id ]
```

### 4.2 Order by precedence

Sort `contributors` highest-precedence first:

1. **Primary key: level** (Personal > Team > Group > Company).
2. **Tie-break within a level: most-recently-updated** (frontmatter `updated`, ISO-8601) — Decision #2.

### 4.3 Merge

Vertical precedence (level) dominates; **section-level recency** (Decision B) breaks same-level ties
*per section*, using an optional section timestamp `## Heading {#anchor updated=YYYY-MM-DD}` and
falling back to the contributor's document `updated`.

```
if any contributor has `override: full`:
    drop every contributor below the highest such one

effective.frontmatter = {}
for c in contributors (lowest precedence first):       # higher overwrites lower
    for key, value in c.frontmatter:
        effective.frontmatter[key] = value
        provenance.frontmatter[key] = c.layer

sectionKeys = union of all section anchors across contributors
for key in sectionKeys:
    candidates = contributors that define section `key`
    winner = max(candidates) by (level desc, then section `updated` desc)   # section-level recency
    effective.body[key] = winner.section(key)
    provenance.body[key] = winner.layer
display order = first appearance of each key in precedence order

newConcept (id absent from all lower layers) is just an append — same algorithm, single contributor.
```

### 4.4 Worked example

`decisions/primary-db`, viewer = you (Data Platform):

| Layer | Defines | `updated` |
|-------|---------|-----------|
| Company | `## Engine: Postgres`, `## Backups: nightly` | 2026-01 |
| Team (Data Platform) | `## Engine: SingleStore` | 2026-05 |
| Personal | *(silent)* | — |

**Effective:** `## Engine: SingleStore` (Team wins) **+** `## Backups: nightly` (inherited from Company,
Team never redefined it). Provenance: Engine←Team, Backups←Company. No knowledge lost.

---

## 5. Provenance

Every resolved field and section carries the **layer it came from**. This is non-negotiable because
**layer = trust level**: a Company section is reviewed and canonical; a Personal section is unreviewed
scratch. The MCP server returns provenance with each concept so the consuming agent can weight facts
accordingly. (The current `mcp-server.mjs` already tags results with their source bundle — this
generalizes that.)

---

## 6. Shadow-staleness detection (Decision #3 — day-one)

The cascade's main long-term hazard: a higher layer overrides a section, the lower (base) layer later
changes that section, and the override **silently hides** the newer base content.

**Mechanism.** When a layer overrides a concept, it records the base it overrode:

```yaml
overrides:
  - layer: company
    concept: decisions/primary-db
    ref: sha256:9f2c…        # content hash of the base concept at override time
```

> **Prototype note:** `resolver.mjs` currently uses *flat* frontmatter keys
> (`overrides_layer: company`, `overrides_ref: sha256:…`) rather than the nested `overrides:` list
> above, because the dependency-free parser doesn't handle nested YAML yet. The nested form is the
> spec target; flat keys are the interim. Reconcile when a real YAML parser is adopted.

**Detector.** For each override entry, hash the *current* base concept; if it differs from `ref`,
flag **“shadowed base changed”**. This surfaces as a new alert type in the Radar control surface,
alongside the existing stale/missing-context alerts. It's the cascade equivalent of "your branch is
behind base — rebase."

> Known tradeoff of the recency tiebreak (§4.2): "most-recently-updated wins" can reward whoever
> touched a concept last rather than who's authoritative, and can flap. Accepted for v1 for
> simplicity; a future option is explicit per-viewer priority ordering of their same-level layers.

---

## 7. Mapping to the current implementation

The cascade is a **generalization** of what's built, not a rewrite:

| Built today (`tools/team-knowledge/`) | Becomes |
|---|---|
| `mcp-server.mjs` unions `--personal` + `--shared` (2-layer, no precedence) | **Done:** `--manifest` N-layer cascade; `read_file` resolves the effective concept via `resolver.mjs` (section/field merge, section-level recency, provenance); legacy 2-layer flags still supported |
| `promote.mjs` (personal → shared) | **Promote up one level** (personal → team → group → company); each promotion = a PR into the next repo up, with more review as facts rise |
| `repos.json` | **Layer-stack manifest**: ordered layers, each with `level`, repo, and read-ACL; a viewer may have multiple same-level layers |
| `classify-context.mjs` routes (`team_candidate`, `review_required`…) | Route selects the target layer; `write.mjs` acts on the signals |
| *(missing)* | **Done:** `write.mjs` reads `signals.json` + manifest → writes `team_candidate` concepts directly to target layer, stages `review_required` under `_review/` |
| Control surface alerts | Add **"shadowed base changed"** alert (§6) |

### New frontmatter conventions

```yaml
---
type: decision            # OKF required
updated: 2026-05-12T00:00:00Z   # required: horizontal tiebreak + shadow detection
override: merge           # merge (default) | full
overrides:                # optional; powers shadow detection
  - layer: company
    concept: decisions/primary-db
    ref: sha256:9f2c…
---
```

---

## 8. Decisions log

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Override granularity | **Structured section/field merge** (default), `override: full` escape hatch | Whole-concept override loses inherited team knowledge; section merge is surgical + deterministic |
| 2 | Membership shape | **DAG** (multi-team/group allowed); horizontal ties → **most-recently-updated wins** | Directors span multiple teams; recency is the simplest v1 tiebreak |
| 3 | Shadow staleness | **Detect on day one** via base content-hash refs | The cascade's primary rot vector; cheap to record now |
| A | Section alignment | **Explicit anchors** `{#anchor}` (heading-normalize fallback) | Stable merge key that survives heading rewording; reliable cross-layer alignment |
| B | Recency granularity | **Section-level** timestamps `{#anchor updated=…}`, fall back to document `updated` | Two same-level teams can edit the same section; precise per-section tie-break |
| C | Null override | **Section tombstone** `{#anchor override=none}` suppresses inherited section; retained as `suppressed: true` for audit | Higher layer may need to negate lower guidance without providing replacement prose |
| D | Exception governance | **`override: exception`** (concept) or `{#anchor override=exception}` (section) — resolves identically to `merge`, adds `exception: true` to output | Distinguishes scoped deviation from policy (reviewable) vs. normal specialization |

---

## 9. Open questions / risks

1. ~~Heading-alignment discipline~~ → **Resolved (Decision A):** explicit `{#anchor}` keys, normalized-heading fallback.
2. ~~Section-level recency~~ → **Resolved (Decision B):** section-level timestamps `{#anchor updated=…}`, document fallback. Implemented in `resolver.mjs`.
3. **Promotion link rewriting** across levels (carried over from the original handoff): when a concept
   moves up a layer, how are its links re-resolved against the new effective graph?
4. **Recency-tiebreak flapping** (§6): acceptable for v1, but watch for thrash; explicit priority
   ordering is the escape valve.
5. **Nested-YAML frontmatter** (§6 prototype note): the flat `overrides_*` keys should become the nested
   `overrides:` list once a real YAML parser is adopted.
