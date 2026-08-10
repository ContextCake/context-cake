---
title: ContextCake and agent memory
description: "ContextCake is a context-resolution system: it combines scoped sources without hiding where an answer came from or where they disagree."
---

Many products called “agent memory” help an AI retain something from earlier work. That
is useful, but it is not the whole problem ContextCake is built to solve.

ContextCake is a **context-resolution system**. It gives an agent an effective answer
from deliberately scoped sources — company policy, team practice, Pack material, and
personal judgment — selected for the project while preserving the evidence underneath
that answer. It is less about teaching a model to remember and more about giving it
the right, inspectable context for the work in front of it.

## The practical difference

“Agent memory” is a broad category, so the comparison below describes common patterns,
not a claim that every product works the same way.

| Common agent-memory pattern | ContextCake |
| --- | --- |
| Stores chat history, extracted facts, embeddings, or a growing global profile. | Reads structured source material at resolution time: Markdown folders, git-backed OKF bundles, Packs, and trusted MCP sources. |
| Retrieves a few likely-relevant snippets. The ranking and the omitted material may be hard to inspect. | Resolves a named concept section by section. The effective answer names the layer that supplied each part. |
| Treats memory as one shared pool or a per-user store. | Keeps organization, team, Pack, and personal context in separate layers with explicit precedence, and selects the applicable cascade by project profile. |
| Resolves conflicting memories by recency, similarity, or an opaque model decision. | Gives the higher-precedence section as the primary answer and returns different lower-layer versions as dated dissent. |
| Learns from agent activity automatically or through an implicit write-back loop. | Makes the write path explicit: captures are staged, previewed, and shared only after confirmation; promotion into curated shared knowledge can follow a reviewable repository flow. |
| Often makes the vendor’s database the system of record. | Keeps the knowledge in files and repositories you control. The local engine works without an account, and core resolution does not phone home. |

The outcome is different. A memory system can help an agent recall that something was
said. ContextCake helps it answer: **which guidance applies here, who said it, what
overrides what, and what disagreement should the user know about?**

## Why resolution matters more than recall

Teams rarely have one universally correct memory. A company may set a production
standard, a team may document an approved exception, and an individual may carry a
local constraint needed for the task at hand. Flattening those into a profile or a
semantic search index makes the result convenient, but can erase the distinction that
makes the answer safe.

ContextCake keeps that distinction intact:

1. [Layers](/docs/concepts/layer-cake) express scope and precedence openly.
2. [Section-level merge](/docs/concepts/merge-semantics) lets a local layer change only
   the part it knows about while retaining everything else.
3. [Provenance and conflicts](/docs/concepts/conflicts-and-provenance) make the source,
   date, and dissent visible to the agent instead of silently blending them away.
4. [Capture and promotion](/docs/guides/capture-write-path) separate a fresh observation
   from reviewed, durable team knowledge.

That makes ContextCake especially useful when the cost of an untraceable answer is
high: engineering decisions, operational runbooks, regulated or policy-bound work,
and teams where local reality legitimately differs from the company baseline.

## What ContextCake is not trying to replace

ContextCake does not need to replace a chat client’s conversation history, a vector
search system, or an agent framework’s short-term scratchpad. Those can still be good
at their jobs.

It supplies the missing governance layer: the durable, scoped context an agent should
consult before it improvises from a transcript, a retrieved fragment, or a past
interaction. A trusted [foreign MCP source](/docs/guides/foreign-mcp-sources) can also
participate in the same cascade when an existing system must remain in place.

## A useful test

Ask of any “memory” feature: *Can I see exactly why the agent was told this, what it
overrode, and whether a more authoritative or newer source disagrees?*

If the answer needs to be inspectable and governable, ContextCake is the layer for
that job.

## Next

- [The layer cake](/docs/concepts/layer-cake) — see the source scopes ContextCake resolves
- [Conflicts and provenance](/docs/concepts/conflicts-and-provenance) — see what an agent receives with an answer
- [Your first cascade](/docs/getting-started/first-cascade) — run a small example locally
