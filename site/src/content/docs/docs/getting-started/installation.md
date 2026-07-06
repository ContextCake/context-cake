---
title: Installation
description: Install from a versioned release archive — no npm install, no install scripts, plain Node.js ≥ 18.
---

ContextCake installs from a **versioned release archive**. The engine is
dependency-free: there is no `npm install` step, no install scripts execute, and
nothing is fetched after you unpack the archive.

## Prerequisites

- `gh` for the terminal path, or a browser for manual download
- Node.js ≥ 18

## Download

```bash
gh release download --repo siracusa5/context-cake --archive=tar.gz --output contextcake.tar.gz
mkdir contextcake
tar -xzf contextcake.tar.gz -C contextcake --strip-components=1
cd contextcake
```

You can also download the source archive from the
[latest ContextCake release](https://github.com/siracusa5/context-cake/releases/latest).

## Verify

Resolve a concept from the bundled three-layer demo, where the layers deliberately
disagree:

```bash
node resolver.mjs --manifest playground/manifest.json --concept decisions/primary-db
```

The JSON output shows the effective merge: `contributors` lists each layer with its
last-updated date, every section carries the `sourceLayer` that won it, and sections
where layers disagree carry a `conflicts` array with the dissenting layers' content
and dates — surfaced, not hidden.

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
git clone https://github.com/siracusa5/context-cake.git
cd context-cake
```

## Why a release archive?

Package registries have repeatedly shipped compromised AI/agent tooling through
hijacked maintainer accounts and `postinstall` payloads. A knowledge engine your
agents read from should have a supply chain you can audit: a tagged archive is
small, inspectable, and runnable as plain Node.js.

## Next

- [Your first cascade](/docs/getting-started/first-cascade) — build your own layers
- [Connect an agent (MCP)](/docs/getting-started/connect-an-agent) — wire it into Claude
- [The trust boundary](/docs/concepts/trust-boundary) — read this before pointing a
  manifest at sources you didn't write
