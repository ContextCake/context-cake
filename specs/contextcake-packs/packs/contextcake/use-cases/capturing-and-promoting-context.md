---
type: use-case
updated: 2026-07-08
---

# Capturing context from repo activity and promoting it upward {#capturing-and-promoting-context}

Knowledge doesn't only flow down through the cascade at read time — it flows
up from real work. The write path turns repo activity into durable OKF
concepts, and a separate promotion step moves a concept up a layer once it's
proven out.

## The write path, end to end {#the-write-path-end-to-end}

```
repo activity -> classify-context.mjs -> ingest.mjs -> signals.json -> write.mjs -> layer bundle
```

`classify-context.mjs` takes one normalized event — a merged PR, a repeated
question, an incident note — and routes it into one of four outcomes using
the rules in `context-policy.json`: `ignore` (routine noise, not stored),
`local` (useful but not shared team knowledge — the default when nothing
matches), `team_candidate` (durable, confident enough to write
automatically), or `review_required` (touches auth, secrets, PII, or another
sensitive path — staged for a human, never written live).

`ingest.mjs` runs a batch of events through the same classifier and produces
`control-surface/signals.json`, which the dashboard reads:

```bash
node ingest.mjs --events mock-events.json --out control-surface/signals.json
```

## From signals to a layer bundle {#from-signals-to-a-layer-bundle}

`write.mjs` turns classified signals into real OKF files in a target layer:

```bash
node write.mjs --signals control-surface/signals.json --manifest layers.json --target-layer team
```

`team_candidate` signals are written directly, at the path from the
signal's `destination` — for example `runbooks/retry-payment-webhooks.md`.
`review_required` signals are staged under `_review/` instead — for example
`_review/payment-api/add-retry-runbook.md` — and wait for a human to move
the file into place. Every written concept carries `draft: true`, `source:
<repo>`, and an `updated` date, plus `Context` and `Signals` sections
explaining why the classifier matched. Use `--dry-run` to preview without
touching disk.

## Promoting a concept up a level {#promoting-a-concept-up-a-level}

A concept that started as a personal draft, or landed in the team layer as a
`team_candidate` capture, sometimes deserves to move up — from personal to
team, or team to company. `promote.mjs` does that as a direct bundle-to-
bundle operation, not through the manifest:

```bash
node promote.mjs --personal ~/kb-personal --shared ~/kb-team --file decisions/primary-db
```

It copies the file, rewrites any `personal:`-scoped links to shared-relative
form so cross-references stay valid in the new location, and rebuilds the
shared bundle's `index.md`. `--dry-run` prints the operations and rewritten
content without writing; `--print-git` prints (but does not run) the
suggested branch/commit/PR sequence, since the shared bundle is its own git
repo and promotion becomes a normal reviewable PR rather than a direct write
to a shared main branch.

## Why two separate mechanisms {#why-two-separate-mechanisms}

The write path is about capturing *new* context from things that already
happened in a repo — it needs the classifier's judgment about what's worth
keeping and what's risky. Promotion is about *moving* context you already
trust — it's a known concept at a known path, so it skips classification
entirely and focuses on the mechanics: copy, rewrite links, reindex, hand
you a PR.

## Next {#next}

- `examples/okf-concept-example.md` — the file shape both paths produce
- `use-cases/personal-team-company-context.md` — where a promoted concept
  ends up living once it's shared
