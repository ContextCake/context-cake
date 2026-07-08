---
type: overview
updated: 2026-07-08
---

# What ContextCake is {#what-is-contextcake}

ContextCake stitches your separate knowledge graphs — personal, team, company —
into one OKF graph your agent can read, returning a primary answer and being
honest about contradictions: which layers disagree, and when each was last
updated.

Unpack that sentence and there are two ideas doing the work:

## Stitch {#stitch}

Your knowledge already exists. It just lives in separate places behind
separate access: a personal notes repo only you can read, a team runbook
repo your team can clone, a company graph reachable only through some other
tool's API. Those graphs do not talk to each other today, and they never
will by default — nobody is going to write a sync job between your personal
notes and the company wiki.

ContextCake is the layer that makes them talk. It does this by treating each
graph as a `source` behind a uniform adapter — either a local OKF bundle (a
git repo of markdown) or a foreign graph reached over MCP and translated
into OKF at read time — and resolving all of them into **one effective OKF
concept** whenever an agent asks for something. See
`overview/mental-model.md` for how the layers stack and win.

## Surface conflicts honestly {#surface-conflicts-honestly}

Stitching sources together raises an obvious question: what happens when
they disagree? ContextCake's answer is to never silently pick a winner and
throw the rest away. It returns one primary answer — decided by layer
precedence — and attaches every dissenting layer's version alongside it,
tagged with that layer's name and its last-updated date. See
`nuances/conflicts-are-surfaced-not-hidden.md` for the mechanics.

That date is the whole staleness story. There is no separate drift-detection
subsystem watching for changes behind your back — you read the primary
answer, see what other layers said and when, and judge for yourself whether
the winner is actually the most current truth.

## It owns no source of truth {#owns-no-source-of-truth}

This matters enough to say plainly: ContextCake is not a knowledge store,
not a database, and not where your knowledge "lives." The company repo is
still the company's source of truth for company decisions; the team repo is
still the team's. ContextCake reads those sources at request time and hands
back a resolved view — it does not copy, own, or become authoritative over
any of them. Delete ContextCake and every layer's knowledge is exactly where
it was before. See `nuances/what-contextcake-is-not.md` for the fuller
boundary.

## Who it's for {#who-its-for}

Two audiences, same artifact:

- **Developers** who are tired of re-explaining team context to an AI agent
  every session, or who want their personal notes, team decisions, and
  company policy to show up as one coherent answer instead of three
  disconnected searches.
- **AI agents** themselves — this pack, and the resolved OKF graph it
  describes, are meant to be read as context. An agent that understands the
  layer cake and the conflict model can reason about which answer to trust
  without a human mediating every lookup.

## Where to go next {#where-to-go-next}

- `overview/the-problem-it-solves.md` — why federated layers beat one big
  graph or fully separate ones
- `overview/mental-model.md` — the layer cake, in one picture
- `nuances/precedence-and-recency.md` — how ties and staleness actually work
