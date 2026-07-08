---
type: use-case
updated: 2026-07-08
---

# Personal, team, and company context, resolved together {#personal-team-company-context}

The core case ContextCake exists for: the same concept is defined at more
than one layer, and you want one answer that keeps everything true, not one
layer clobbering the others.

## The setup {#the-setup}

Three OKF bundles, three git repos, three access boundaries:

- **Company** (`level: 0`) — org-wide canon. Owned by platform/security,
  slow-moving, broadly readable.
- **Team** (`level: 2`) — runbooks and decisions your team actually lives
  by. Owned by the team, changes often.
- **Personal** (`level: 3`) — your drafts, working notes, local overrides.
  Owned by you, changes constantly, seen by nobody else by default.

All three can hold a file at the same path — `decisions/primary-db.md` — and
the resolver treats that shared path as one concept ID,
`decisions/primary-db`, stitched from whichever layers define it.

## What each layer says {#what-each-layer-says}

Company sets the org default and ownership. Team overrides the parts that
are actually true for its stack. Personal adds a draft note only relevant to
one engineer's local setup:

```markdown
Company `decisions/primary-db.md`:
##Choice {#choice}
Postgres (org standard). All services provision managed RDS by default.

##Ownership {#ownership}
Platform team owns provisioning, upgrades, and the backup policy.

Team `decisions/primary-db.md`:
##Rationale {#rationale}
Postgres for OLTP — but we added ClickHouse for analytics after reporting
queries started locking the primary.

##Analytics store {#analytics-store}
ClickHouse, self-hosted on the data cluster. Read replica only, never a
source of truth.

Personal `decisions/primary-db.md`:
##My notes {#my-notes}
Running SQLite locally for the test suite — faster iteration, not
representative of prod behavior.
```

## What the agent gets back {#what-the-agent-gets-back}

`read_file` on `decisions/primary-db` returns one merged concept: `Choice`
and `Ownership` inherited from Company (nobody above spoke to them),
`Rationale` and `Analytics store` from Team, `My notes` from Personal. No
layer needed to restate what another layer already said — each speaks only
to the sections it owns, and precedence resolves the rest per section, not
per document. See `examples/resolved-output-example.md` for the exact
response shape.

## Why this beats the alternatives {#why-this-beats-the-alternatives}

One shared graph forces every team to negotiate every fact through a single
owner, or lets any team overwrite another's canon. Fully separate graphs
mean an agent has to know which of three places to check, and nothing
reconciles when they disagree. Layered precedence gets you a single answer
per query without deleting anyone's context to get there — drop the
personal layer and the team+company answer is still complete underneath.

## Next {#next}

- `use-cases/foreign-mcp-sources.md` — when one of these layers isn't a
  local git bundle at all
- `examples/layers-json-example.md` — the manifest that wires these three
  layers together
