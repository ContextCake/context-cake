---
type: guide
updated: 2026-07-08
---

# Your first cascade {#your-first-cascade}

The fastest way to see the merge engine work is to build a two-layer manifest by
hand and resolve a concept that exists in both layers.

## Two ways to do this {#two-ways-to-do-this}

- Build the tiny manifest below (five minutes, teaches you the mechanics), or
- Run `npm run playground` and open the bundled three-layer demo at
  `http://127.0.0.1:8790` to see the same merge rendered visually — precedence
  chain, winning sections, and conflict panels side by side.

Both read the same engine. The manifest path is described here.

## Create two layers {#create-two-layers}

Each layer is a directory of OKF markdown. Create a company layer and a team
layer, both defining the same concept ID:

```bash
mkdir -p ~/kb-company/decisions ~/kb-team/decisions
```

```markdown
<!-- ~/kb-company/decisions/primary-db.md -->
---
type: decision
updated: 2026-05-01
---

## Engine {#engine}

Postgres.

## Backups {#backups}

Nightly snapshots to cold storage.
```

```markdown
<!-- ~/kb-team/decisions/primary-db.md -->
---
type: decision
updated: 2026-06-20
---

## Engine {#engine}

SingleStore (chosen for HTAP workloads).
```

The concept ID is the file path minus `.md` — `decisions/primary-db` — and it is
stable across layers on purpose: both files describe the *same* concept from a
different vantage point.

## Write the manifest {#write-the-manifest}

```json
{ "layers": [
  { "name": "team",    "level": 2, "path": "~/kb-team" },
  { "name": "company", "level": 0, "path": "~/kb-company" }
] }
```

`source` defaults to `okf-local` when omitted, so a plain directory `path` is
enough — you don't need to spell out `"source": "okf-local"` for local layers.

## Resolve it {#resolve-it}

```bash
node resolver.mjs --manifest layers.json --concept decisions/primary-db
```

`team` is level 2, `company` is level 0, so `team` wins `Engine` — and because
`company` disagrees on that same section, its value rides along as a
`conflicts` entry instead of being dropped. `Backups` isn't mentioned in
`team`'s file at all, so it's inherited from `company` untouched, with no
conflict.

That's the whole model: higher layer wins **per section**, unmentioned sections
inherit, and disagreements are surfaced with dates rather than silently
overwritten.

## Or just run the playground {#or-just-run-the-playground}

```bash
npm run playground
```

Open `http://127.0.0.1:8790` and select `decisions/primary-db` in the bundled
demo (`apps/playground/demo-layers/`, three layers: personal/team/company) to see
the same contributors, sourceLayer tags, and conflict panels in the inspector,
without writing any files yourself.

## Next {#next}

- `getting-started/writing-a-layer.md` — the OKF concept file shape in full
- `getting-started/connect-an-ai-agent.md` — expose this same resolved graph over MCP
