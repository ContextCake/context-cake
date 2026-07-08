# Start Here

This is the **ContextCake context pack** — everything an AI agent (or a new developer)
needs to actually use ContextCake in a project: what it is, how it's built, and how to
wire it into your own work.

Drop this pack into your repo, upload it to your AI tool, or install it as a Claude Code
plugin. Then your assistant can answer "how do I use ContextCake here?" from real context
instead of guessing.

## What ContextCake is, in one sentence

ContextCake stitches your separate knowledge graphs — personal, team, company — into one
OKF graph your agent can read, returning a primary answer and being honest about
contradictions: which layers disagree, and when each was last updated.

## Reading order

1. `overview/what-is-contextcake.md` — the idea and the problem it solves
2. `overview/mental-model.md` — the layer cake in one picture
3. `architecture/layers-and-precedence.md` — how higher layers win, per section
4. `architecture/okf-format.md` — the file shape everything resolves into
5. `getting-started/installation.md` — get the engine running
6. `getting-started/writing-a-layer.md` — author your first concept
7. `getting-started/connect-an-ai-agent.md` — point your agent at the resolved graph
8. `examples/` — concrete concepts, a `layers.json`, and a resolved output
9. `nuances/` — the sharp edges worth knowing before you rely on it

## How to use it with your tool

See `tool-guides/` for Claude Code, ChatGPT, Cursor, and Copilot. The short version:
keep these files where your assistant can read them, and it will have the real
architecture and conventions in context.
