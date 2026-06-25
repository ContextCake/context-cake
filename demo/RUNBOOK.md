# ContextCake Team Demo — Runbook

**Target time:** ~4 minutes, 5 beats
**Last updated:** 2026-06-24

---

## Pre-flight (run the morning of the demo)

```bash
# From repo root:
bash demo/setup.sh && bash demo/verify.sh
```

Must print: `demo verify passed (resolution + inheritance + provenance + shadow + company-only)`

Then launch both sessions once briefly to confirm they boot (close them; reopen fresh before the demo):

```bash
# Terminal 1 — cascade:
claude --strict-mcp-config --mcp-config "$(pwd)/demo/mcp/full.json"
# Terminal 2 — company-only:
claude --strict-mcp-config --mcp-config "$(pwd)/demo/mcp/company-only.json"
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
node resolver.mjs --manifest demo/manifests/full.json --concept decisions/service-stack
```

Point out:
- `"sourceLayer": "team"` on the Language section → Team won
- `"sourceLayer": "company"` on Secrets and Security → Company inherited unchanged
- Section-by-section, not whole-document

Optionally open `control-surface/` dashboard alongside for a visual.

### Beat 3 — The contrast (~90s)

Open Terminal 1 (cascade) and Terminal 2 (company-only) side by side.

**Give both agents the exact same prompt:**

> Scaffold a new streaming job that reads our events topic and writes aggregates to the warehouse.

Expected:
- **Company-only** → Spring Boot / Java 21 scaffold (`@SpringBootApplication`, Maven `pom.xml`, `@KafkaListener`). Dead on arrival in this codebase.
- **Cascade** → Scala 2.13 + Spark Structured Streaming scaffold (sbt), wiring company auth/secrets conventions, possibly noting the stale exemption.

The contrast needs no narration.

### Beat 4 — The catch (~30s)

```bash
node resolver.mjs --manifest demo/manifests/full.json --shadow
```

> "Company tightened the standard after we recorded our exemption. ContextCake catches the drift
> the moment the base hash changes — something a plain docs repo or company-only agent can't surface."

### Beat 5 — Close (~15s)

> "Same real engine. Three real repos. The agent reading the cascade was concretely more correct,
> and governance caught a drift we'd otherwise have missed."

---

## Fallback (if wifi or live agent flakes)

Show `demo/transcripts/company-only.md` and `demo/transcripts/cascade.md` — captured known-good outputs from a prior run.

---

## Reset between runs

```bash
bash demo/setup.sh
```

Re-seeds `demo/layers/` and regenerates `demo/mcp/*.json` cleanly (idempotent).
