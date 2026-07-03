---
title: "The capture write path"
description: Classify repo activity into signals and write durable context to a layer.
---

Knowledge doesn't only flow down through the cascade — it flows up from repo
activity. The capture write path turns raw events into classified signals,
then turns high-confidence signals into durable OKF concepts:

```
repo activity → classify-context.mjs → ingest.mjs → signals.json → write.mjs → layer bundle
```

## Step 1: classify one event

`classify-context.mjs` takes a single normalized event and routes it into one
of four outcomes, using the keyword, label, and path rules in
`context-policy.json`:

```bash
node classify-context.mjs --demo
```

The demo event is a merged PR titled "Add retry runbook for payment webhook
failures," labeled `runbook` and `incident`. Because `incident` is a
`review_required` trigger (see the outcomes below), this event routes to
`review_required` — it's staged for a human decision, not written live. Try it
against your own event:

```bash
node classify-context.mjs --event my-event.json
node classify-context.mjs --event my-event.json --policy custom-policy.json
```

### The four outcomes

| Route | Meaning |
|-------|---------|
| `ignore` | Routine work (lockfile bumps, formatting, dependency bumps) — not stored as team context. |
| `local` | Useful session or author context, but not shared team knowledge. Default when no rule matches. |
| `team_candidate` | Durable team context, high enough confidence to draft or write automatically. |
| `review_required` | Risky, ambiguous, sensitive, or cross-team consequential — requires a human decision before it's written to shared context. |

`review_required` always wins when its rules match — keywords like `auth`,
`credential`, `secret`, `pii`, `incident`, `breaking change`; labels like
`security`, `incident`, `api-contract`; paths like `auth/`, `security/`,
`infra/secrets`. Otherwise the higher-scoring side of `team_candidate` vs.
`ignore` wins, and a repeated question (three or more occurrences by
default) is itself a `team_candidate` signal — the same question coming up
repeatedly is evidence the answer belongs in shared context. The classifier
result includes `route`, `confidence`, `reasons` (which rules matched), and a
`suggestedDestination` concept path — for the demo event above, that is
`review/billing-api/add-retry-runbook-for-payment-webhook-failures` (a
`review_required` staging path). A `team_candidate` event instead yields a
live destination like `runbooks/retry-payment-webhooks`.

## Step 2: ingest a batch

`ingest.mjs` runs many events through the same classifier and writes a
dashboard-ready `signals.json`:

```bash
node ingest.mjs --demo
# or explicitly:
node ingest.mjs --events mock-events.json --out control-surface/signals.json
node ingest.mjs --events mock-events.json --repos repos.json --out control-surface/signals.json
```

Flags: `--events <file>` (default `mock-events.json`), `--repos <file>`
(default `repos.json`, used to attribute an owner per repo), `--out <file>`
(default `control-surface/signals.json`), `--policy <file>` (default
`context-policy.json`), `--demo` (uses the bundled mock events), `--help`.

Each event becomes a signal carrying its `route`, `repo`, a humanized
`source` (`"merged PR"`, `"repeated question"`, `"incident note"`, …),
`confidence`, `owner`, `destination`, `reasons`, and the recommended
`action`. The output also includes a per-repo coverage summary — the share of
a repo's durable signals (`team_candidate` + `review_required`) that were
actually auto-captured, computed honestly from the signals themselves rather
than a fabricated metric.

`control-surface/signals.json` is generated output — it's gitignored. Serve
the dashboard to browse it:

```bash
python3 -m http.server 8788 --directory control-surface
# → http://127.0.0.1:8788
```

## Step 3: write signals into a layer

`write.mjs` turns classified signals into real OKF concept files in a target
layer bundle:

```bash
node write.mjs --signals control-surface/signals.json --manifest layers.json --target-layer team
```

Flags: `--signals <file>` (required), `--manifest <file>` (required),
`--target-layer <name>` (defaults to the highest layer level below 3 — i.e.
not personal — or level 3 if that's the only layer available),
`--dry-run` (prints what would be written without touching disk), `--help`.

Per signal:

- `ignore` and `local` signals are skipped — nothing is written.
- `team_candidate` signals are written **directly** to the target layer, at
  the path from `destination` (for example `runbooks/retry-payment-webhooks.md`).
- `review_required` signals are **staged under `_review/`** in the target
  layer instead of written live — `_review/payment-api/add-retry-runbook.md`
  — pending a human decision. A signal that already resolves to an existing
  file is skipped rather than overwritten.

Every written or staged concept carries `draft: true`, `source: <repo>`, and
an `updated` date in its frontmatter, plus a `## Context {#context}` section
with the recommended action and a `## Signals {#signals}` section listing the
reasons the classifier matched. A `review_required` concept additionally gets
a `## Review Required {#review-required}` note: approve by moving the file
out of `_review/` into the appropriate layer directory.

Preview before writing anything:

```bash
node write.mjs --signals control-surface/signals.json --manifest layers.json --target-layer team --dry-run
```

## Putting it together

```bash
node ingest.mjs --demo
node write.mjs --signals control-surface/signals.json --manifest layers.json --target-layer team --dry-run
node write.mjs --signals control-surface/signals.json --manifest layers.json --target-layer team
```

The concepts land as drafts in the team layer's OKF bundle — resolve them
like anything else once they're written:

```bash
node resolver.mjs --manifest layers.json --concept runbooks/retry-payment-webhooks
```

## Next

- [Your first cascade](/docs/getting-started/first-cascade) — see the layer
  bundle these concepts land in
- [Conflicts and provenance](/docs/concepts/conflicts-and-provenance) — how
  `draft` and `source` provenance show up at read time
- [Promoting concepts](/docs/guides/promoting-concepts) — move a concept from
  personal up to shared once it's proven out
- [CLI reference](/docs/reference/cli) — full flag listing for every script
