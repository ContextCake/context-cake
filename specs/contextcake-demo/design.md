# ContextCake Team Demo — Design

**Date:** 2026-06-24
**Status:** Implemented shape updated 2026-07-08 — lives in `examples/team-demo/`
**Workflow:** Design-first (explored collaboratively, grounded in a real team divergence)

---

## 1. Goal & thesis

Make ContextCake a **real, believable, live demo** that John can drive for his engineering team.
The team should walk away convinced of two linked claims:

1. **The layered cascade architecture works** — it bridges knowledge-graph layers across an org, resolving
   one concept into a per-section composite (higher layer wins per section, lower layers inherited), with
   provenance and dated conflicts surfaced honestly.
2. **Agents read the resolved context and are measurably more effective for it** — shown, not asserted.

"Testable" here means a **real (not mocked) end-to-end run** that obviously isn't smoke and mirrors —
driven live, repeatable, on curated-but-realistic data. It is *not* a self-serve hands-on kit or a formal
eval harness (those are possible later).

## 2. Approach (chosen: "C — Live contrast + repeatable harness")

A real side-by-side agent contrast on a curated scenario, made demo-safe by a small harness that seeds
data, regenerates manifests, and verifies the resolution before going live. Reuses the existing engine
(`resolver.mjs`, `mcp-server.mjs`, `control-surface/`) rather than building a page that could feel staged.

Rejected alternatives: **A** (bare two-terminal version — fallback if we want it dead simple) and
**B** (narrated dashboard — the agent step can't be genuinely live in a page, drifts toward smoke-and-mirrors).

## 3. The scenario — star concept `decisions/service-stack`

Grounded in a **real divergence**: the org is pushing to standardize on **Spring Boot + Java 21**, but the
data team lives in **Scala + Spark Structured Streaming + Java 17** and operates with high infra autonomy
("our own island"). The cascade exists precisely to capture such divergences so neither humans nor agents
get fed the generic company answer — while still binding the team to the company rules it genuinely cannot
escape (secrets/auth, security/compliance).

| Layer | `decisions/service-stack` | Section outcome |
|---|---|---|
| **Company** (L0) | §Language/Framework: Spring Boot, Java 21 (org standard) · §Secrets & Auth · §Security & Compliance · §Enforcement | provides inherited sections and a dissenting language standard |
| **Team · Data** (L2) | Overrides **only** §Language/Framework → Scala + Spark Structured Streaming; Java 17 for legacy. | §Language wins; inherits Secrets/Security/Enforcement |
| **Personal** (L3) | present but silent on this concept | inherits everything |

**Resolved effective concept:** §Language ← Team (Scala/Spark); §Secrets & Auth ← Company (inherited);
§Security & Compliance ← Company (inherited). This single concept exercises **precedence**, **inheritance**,
**provenance**, and (below) **conflict surfacing**.

**Inheritance is real, not invented:** even on its own island the team still inherits company **secrets/auth**
and **security/compliance** — confirmed by John. Generated code must therefore wire into company auth/secrets
and honor compliance even while diverging on language.

**The conflict:** Company still says Spring Boot / Java 21, while Team says Scala/Spark. The resolver returns
the team-correct primary section and keeps the company value as `conflicts[]` with its updated date. This is a
governance catch a plain docs repo or company-only agent cannot surface.

## 4. The demo action — code generation (the effectiveness proof)

Because the divergence is a **language/framework**, effectiveness is shown via a **code-gen task** where
right-vs-wrong is undeniable at a glance:

> Prompt (identical to both sessions): *"Scaffold a new streaming job that reads our events topic and writes
> aggregates to the warehouse."*

- **Company-only agent** → a **Spring Boot / Java 21** app (`@SpringBootApplication`, Maven `pom.xml`,
  `@KafkaListener`). Dead on arrival in the team's codebase.
- **Cascade agent** → an idiomatic **Scala + Spark Structured Streaming** job (sbt) that fits the real repo,
  *applies the inherited company secrets/security conventions*, and notes the company conflict.

The contrast needs no narration: Spring Boot boilerplate they can't use, next to a Spark job they can.

## 5. Components

**Reuse unchanged:** `resolver.mjs` (cascade + conflicts, emits JSON for a single concept),
`mcp-server.mjs --manifest` (agent read access; `read_file` resolves via `resolver.mjs`), `apps/control-surface/`
(projected alongside, optional).

**Build — self-contained `examples/team-demo/` directory:**

| Path | Role |
|---|---|
| `examples/team-demo/layers/company/decisions/service-stack.md` + `index.md` | Company layer: language standard plus inherited secrets/security/enforcement |
| `examples/team-demo/layers/team/decisions/service-stack.md` | Team override of §Language only |
| `examples/team-demo/layers/personal/` | present but silent |
| `examples/team-demo/manifests/full.json`, `examples/team-demo/manifests/company-only.json` | the two agent contexts |
| `examples/team-demo/setup.sh` | seeds layers and regenerates MCP configs with absolute paths |
| `examples/team-demo/verify.sh` | asserts the scripted resolution **and** conflict surfacing on the curated data |
| `examples/team-demo/RUNBOOK.md` | exact prompt, expected company-only vs cascade output shape, the 5 beats, captured transcript fallback, and Claude Code MCP config snippets |

**Agent client:** Claude Code, two terminals — one per manifest.

## 6. Live run sequence (~4 min, 5 beats)

1. **Frame** — four git repos, one per org layer; the org wants Spring Boot/Java 21, we don't live there.
2. **Engine is real** — `node resolver.mjs --manifest examples/team-demo/manifests/full.json --concept decisions/service-stack`
   shows the resolved composite + provenance per section (optionally show `apps/control-surface/`).
3. **The contrast** — two Claude Code sessions, identical code-gen prompt. Company-only → Spring Boot;
   cascade → Scala/Spark + inherited secrets/security.
4. **The catch** — the Language section includes a company `conflicts[]` entry with updated date; tie to governance.
5. **Close** — same real engine, three real repos, agent concretely more correct, and it surfaced the dissent.

## 7. Believability & repeatability

- `examples/team-demo/verify.sh` proves the data resolves exactly as scripted **before** going live.
- `examples/team-demo/setup.sh` regenerates MCP configs with machine-correct paths → runs anywhere.
- The MCP/resolver layer is **deterministic**, so the *context* each agent receives is fixed; only LLM phrasing
  varies. `RUNBOOK.md` documents the expected output shape and keeps a captured transcript as fallback if the
  live agent or venue wifi flakes.
- Pre-flight (in `setup.sh`/runbook): confirm the MCP server boots and resolves the star concept.

## 8. Scope

**v1 (this design):** one concept (`decisions/service-stack`), three layers (Company/Team/Personal), the
code-gen contrast, the conflict beat. Tight and fast to a believable demo.

**Deferred (not v1):** a Group layer + a second concept for breadth; live capture from a real repo
(`ingest.mjs`/`classify-context.mjs`); a self-serve hands-on kit; a formal with/without eval harness;
a custom guided viz page (the existing brainstorm artifact in `~/claude_playground/brainstorms/` can inform it).

## 9. Acceptance criteria (EARS)

- WHEN `examples/team-demo/setup.sh` is run on a clean checkout THE SYSTEM SHALL produce the three layer bundles and both
  manifests with valid paths, with no manual editing.
- WHEN `examples/team-demo/verify.sh` is run THE SYSTEM SHALL assert that resolving `decisions/service-stack` against the full
  manifest yields §Language from Team and §Secrets/§Security from Company, and SHALL fail loudly if not.
- WHEN `examples/team-demo/verify.sh` is run THE SYSTEM SHALL assert that the company §Language dissent appears in
  `conflicts[]` with its updated date, and SHALL fail loudly if not.
- WHEN an agent queries `decisions/service-stack` via the **full** manifest THE SYSTEM SHALL return the
  Scala/Spark language guidance plus the inherited company secrets/security sections with provenance.
- WHEN an agent queries via the **company-only** manifest THE SYSTEM SHALL return only the Spring Boot/Java 21
  guidance (no team override).
- WHEN the same code-gen prompt is given to both sessions THE SYSTEM SHALL CONTINUE TO produce a Spring Boot
  result from company-only and a Scala/Spark result from the cascade (documented in `RUNBOOK.md` with a
  captured transcript).

## 10. Boundaries

- ✅ **Always:** run `examples/team-demo/verify.sh` before any live demo; keep all demo content fictional/curated.
- ⚠️ **Ask first:** before wiring the demo to any real repo or real org data; before committing the design doc.
- 🚫 **Never:** put real secrets, credentials, internal hostnames, or any PII into the demo layers or runbook.

## 11. Open items for the implementation plan

- Exact section anchors + frontmatter (`{#language}`, `{#secrets}`, `{#security}`, `{#enforcement}`).
- Whether `apps/control-surface/` needs demo signals seeded, or is shown read-only.
- The known-good transcript: capture once both manifests are wired.
