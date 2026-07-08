---
type: overview
updated: 2026-07-08
---

# The problem it solves {#the-problem-it-solves}

## Blank-context agents {#blank-context-agents}

Every new AI session starts from zero. You explain the same architecture
decisions, the same team conventions, the same "no, we don't use that
anymore" corrections, over and over, because the agent has no durable place
to keep what it learned last time. Multiply that across a team and the
re-explaining tax compounds: the same context gets typed out by five
different engineers into five different chat windows, none of which talk to
each other.

The instinct is to write it down somewhere the agent can read it. That
mostly works — until "somewhere" turns out to be three somewheres.

## Separate graphs, separate access, no bridge {#separate-graphs-separate-access}

Knowledge about a codebase or a team accumulates at different scopes, and
those scopes naturally end up in different systems with different access
rules:

- **Personal** — your own notes, half-finished decisions, drafts you are not
  ready to share. Lives in something only you can read.
- **Team** — runbooks, architecture decisions, the stuff your team agreed on
  last sprint. Lives in a repo your team can clone.
- **Company** — org-wide policy, canonical infrastructure choices, the
  things that apply everywhere. Often lives behind a completely different
  tool with its own API.

These graphs do not talk to each other by default, and there is no reason
they ever would — nobody is going to build and maintain a sync job between a
personal notes vault and a company wiki just so an AI agent has one thing to
query. Left alone, an agent working in your repo can see at most one of
these layers at a time, and has no way to know what it's missing.

## Why not one unified graph {#why-not-one-unified-graph}

The tempting fix is to dump everything into a single shared knowledge base.
It fails for the same reason a single shared notes app fails for humans:
personal drafts do not belong in company policy, team-specific decisions do
not belong at company scope, and access control gets flattened — either
everyone sees everything, or you rebuild a bespoke permission system on top
of a system that was not designed for one. You also lose the signal of
*where* a fact came from and *who* is authoritative for it.

## Why not fully siloed graphs {#why-not-fully-siloed-graphs}

The opposite failure is doing nothing: leave personal, team, and company
knowledge in their separate systems and let agents query at most one at a
time. This is where most teams actually are today. It preserves access
control perfectly but reproduces the blank-context problem at a higher
level — the agent still has to be pointed at the right source manually, and
still cannot see the other two layers' relevant context, even when they
would change the answer.

## Federated, with precedence {#federated-with-precedence}

ContextCake's answer is federation instead of unification: leave each layer
where it lives, in the system that already governs its access, and resolve
across them only at read time. Each layer stays a `source` behind a uniform
adapter — a local OKF bundle or a foreign graph reached over MCP — so access
control is inherited for free from whatever already gates that source (repo
membership, in the common case).

On top of federation, precedence gives agents a single coherent answer
instead of three disconnected ones: higher layers win per section, and
where layers disagree, the resolver does not hide it — it shows the primary
answer plus every dissenting layer's version and date. See
`overview/mental-model.md` for how the stack works, and
`nuances/conflicts-are-surfaced-not-hidden.md` for how disagreement is
represented.

This gets you the best of both failed approaches without their costs: one
coherent view for the agent, and access control that was never
ContextCake's to build in the first place.

## Next {#next}

- `overview/mental-model.md` — the layer cake in one picture
- `nuances/dependency-free-engine.md` — how the resolver stays a thin,
  auditable layer instead of a new system to operate
