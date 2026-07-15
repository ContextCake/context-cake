---
title: Installation
description: Download the current source archive and run the bundled demo in a few minutes.
---

ContextCake installs from a **direct source archive**. The engine is
dependency-free: there is no `npm install` step, no install scripts execute, and
nothing is fetched after you unpack the archive.

If you are still evaluating whether the model fits your team, start with the
[demo](/demo) or [the docs overview](/docs) and come back here when you want the
local setup path.

## Prerequisites

- A browser to download the source archive
- Node.js ≥ 18

## Download

Download the versioned [ContextCake `console-v0.2.0` source archive](https://github.com/ContextCake/context-cake/archive/refs/tags/console-v0.2.0.tar.gz), then unpack it:

```bash
mkdir contextcake
tar -xzf context-cake-console-v0.2.0.tar.gz -C contextcake --strip-components=1
cd contextcake
```

This tag is immutable: the archive and the commands above always refer to the same
released source.

## Verify

Resolve a concept from the bundled three-layer demo, where the layers deliberately
disagree:

```bash
node resolver.mjs --manifest apps/playground/manifest.json --concept decisions/primary-db
```

The JSON output shows the effective merge: `contributors` lists each layer with its
last-updated date, every section carries the `sourceLayer` that won it, and sections
where layers disagree carry a `conflicts` array with the dissenting layers' content
and dates, surfaced rather than hidden.

To run the full test suite (requires `bash`):

```bash
npm test
```

## What you just installed

| Piece | Run with |
|-------|----------|
| Cascade resolver (CLI) | `node resolver.mjs --manifest <manifest> --concept <id>` |
| MCP server for agents | `node mcp-server.mjs --manifest <manifest>` |
| Interactive playground | `npm run playground` → http://127.0.0.1:8790 |
| Capture write path | `node ingest.mjs` / `node write.mjs` |

## Source checkout

Use a git checkout when you want to inspect history, contribute changes, or pin
your own fork:

```bash
git clone https://github.com/ContextCake/context-cake.git
cd context-cake
```

## Why a source archive?

Package registries have repeatedly shipped compromised AI/agent tooling through
hijacked maintainer accounts and `postinstall` payloads. A knowledge engine your
agents read from should have a supply chain you can audit: a source archive is
small, inspectable, and runnable as plain Node.js.

## Next

- [Your first cascade](/docs/getting-started/first-cascade): build your own layers
- [Connect an agent (MCP)](/docs/getting-started/connect-an-agent): wire it into Claude
- [The trust boundary](/docs/concepts/trust-boundary): read this before pointing a
  manifest at sources you didn't write
