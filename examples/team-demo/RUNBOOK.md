# ContextCake Team Demo — Runbook

This demo uses the current core model: higher layers win per section, and
disagreements are surfaced as dated `conflicts[]` entries rather than hidden or
handled by the removed `--shadow` subsystem.

**Target time:** ~4 minutes, 5 beats
**Last updated:** 2026-06-24

---

## Pre-flight (run the morning of the demo)

```bash
# From repo root:
bash examples/team-demo/setup.sh && bash examples/team-demo/verify.sh
```

Must print: `demo verify passed (resolution + inheritance + provenance + conflicts + company-only)`

Then launch both sessions once briefly to confirm they boot (close them; reopen fresh before the demo):

```bash
# Terminal 1 — cascade:
claude --strict-mcp-config --mcp-config "$(pwd)/examples/team-demo/mcp/full.json"
# Terminal 2 — company-only:
claude --strict-mcp-config --mcp-config "$(pwd)/examples/team-demo/mcp/company-only.json"
```

> `setup.sh` also prints these with resolved absolute paths when you run it.

---

## The 5 beats

### Beat 1 — Frame (~30s)

> "We have four git repos — one per org layer: Company, Group, Team, Personal. Each holds
> knowledge as plain markdown. The org wants everyone on Spring Boot + Java 21. Our team doesn't
> live there. ContextCake captures that divergence so agents don't get the generic company answer."

### Beat 2 — Engine is real (~45s)

```bash
node resolver.mjs --manifest examples/team-demo/manifests/full.json --concept decisions/service-stack
```

Point out:
- `"sourceLayer": "team"` on the Language section → Team won
- `"sourceLayer": "company"` on Secrets and Security → Company inherited unchanged
- `"conflicts"` on Language → Company's Spring Boot standard is visible as dissent
- Section-by-section, not whole-document

Optionally open `apps/control-surface/` dashboard alongside for a visual.

### Beat 3 — The contrast (~90s)

Open Terminal 1 (cascade) and Terminal 2 (company-only) side by side.

**Give both agents the exact same prompt:**

> Scaffold a new streaming job that reads our events topic and writes aggregates to the warehouse.

Expected:
- **Company-only** → Spring Boot / Java 21 scaffold (`@SpringBootApplication`, Maven `pom.xml`, `@KafkaListener`). Dead on arrival in this codebase.
- **Cascade** → Scala 2.13 + Spark Structured Streaming scaffold (sbt), wiring company auth/secrets conventions, while noting company has a newer conflicting Spring Boot standard.

The contrast needs no narration.

### Beat 4 — The catch (~30s)

```bash
node resolver.mjs --manifest examples/team-demo/manifests/full.json --concept decisions/service-stack
```

> "Company tightened the standard, but the team layer still has a scoped reality.
> ContextCake gives the agent the team-correct primary answer while still showing
> the company dissent and updated date."

### Beat 5 — Close (~15s)

> "Same real engine. Three real repos. The agent reading the cascade was concretely more correct,
> and governance caught a drift we'd otherwise have missed."

---

## Fallback (if wifi or live agent flakes)

Show `examples/team-demo/transcripts/company-only.md` and `examples/team-demo/transcripts/cascade.md` — captured known-good outputs from a prior run.

---

## Reset between runs

```bash
bash examples/team-demo/setup.sh
```

Re-seeds `examples/team-demo/layers/` and regenerates `examples/team-demo/mcp/*.json` cleanly (idempotent).
