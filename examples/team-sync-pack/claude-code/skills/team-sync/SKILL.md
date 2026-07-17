---
name: team-sync
description: Use when starting an investigation, debugging session, or design discussion in a project with a ContextCake live layer, and again when a session produces a resolution, decision, gotcha, or artifact worth sharing with the team. Covers find_captures (before) and the log_capture/confirm_capture two-phase share flow (after).
---

# Team Sync — shared working memory

The ContextCake MCP server (`contextcake`) federates this team's knowledge,
including a **live layer** of recent, unreviewed captures from teammates'
agent sessions.

## Before investigating

At the start of any investigation or debugging session, call
`find_captures` with a few keywords from the problem. If a teammate hit the
same issue recently, their capture has the problem, what they tried, and the
fix — start from there instead of from zero.

Treat results honestly: captures are **unreviewed**. Weigh the author, age,
and review status shown on every hit; prefer curated concepts (`search`,
`read_file`) where they disagree. `whats_new` at session start shows what
changed since you last looked.

## After a capture-worthy outcome

When this session produces one of the following, offer to share it:

| Kind | When | Required sections |
|---|---|---|
| `investigation` | you found a root cause / fixed a bug | `problem`, `fix` (plus `attempts`, `root-cause`) |
| `decision` | you chose X over Y for a reason | `choice`, `why` (plus `alternatives`) |
| `gotcha` | you hit a fact that will bite the next person | `body` |
| `artifact` | you produced a spec/plan/PR worth pointing at | `summary`, `pointer` |

The flow is **two-phase and never silent**:

1. Call `log_capture` with the kind, a specific title, and the sections.
2. Show the returned `preview` to the user, verbatim.
3. Only when the user explicitly says yes, call `confirm_capture` with the
   token. Never confirm on your own judgment — an explicit yes, every time.
4. If `log_capture` returns `staged: false`, the capture was routed as not
   shareable (scratch work) — tell the user why and move on. If it errors on
   a credential match, remove the secret and re-stage; never paraphrase the
   secret into the capture.

If the server reports no author identity, ask the user once for a display
name and tell them to put it in the manifest live layer as
`"git": { "profileName": "<name>" }` (or set `git config user.name` in the
live repo). Ask once, not every session.

## Keep it honest

- Provenance is not optional: when you use a teammate's capture, say whose
  capture it was and how old it is.
- Captures decay after ~14 days unless promoted through review. Durable
  knowledge belongs in the curated layers — suggest promotion when a capture
  keeps proving useful.
