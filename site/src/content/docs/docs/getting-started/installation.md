---
title: Installation
description: Clone and run — no npm install, no install scripts, plain Node.js ≥ 18.
---

ContextCake is **clone-and-run**. The engine is dependency-free: there is no
`npm install` step, no install scripts execute, and nothing is fetched beyond the
clone itself. What you clone is what runs.

## Prerequisites

- `git`
- Node.js ≥ 18

## Clone

```bash
git clone https://github.com/siracusa5/context-cake.git
cd context-cake
```

That's the whole installation.

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

## Why there's no npm package

Deliberate, for now. Package registries have repeatedly shipped compromised
AI/agent tooling through hijacked maintainer accounts and `postinstall` payloads.
A knowledge engine your agents read from should have a supply chain you can audit
in an afternoon — a git clone at a commit you can review is exactly that. If a
package is published later, it will be announced in the
[changelog](/changelog) with provenance attestation.

## Next

- [Your first cascade](/docs/getting-started/first-cascade) — build your own layers
- [Connect an agent (MCP)](/docs/getting-started/connect-an-agent) — wire it into Claude
- [The trust boundary](/docs/concepts/trust-boundary) — read this before pointing a
  manifest at sources you didn't write
