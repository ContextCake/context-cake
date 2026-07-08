---
type: guide
updated: 2026-07-08
---

# Installing ContextCake {#installing-contextcake}

ContextCake installs from a **versioned release archive**, not `npm install`. The
engine is dependency-free — no install scripts run, and nothing is fetched after
you unpack the archive.

## Prerequisites {#prerequisites}

- Node.js >= 18
- `gh` for the terminal download path, or a browser for manual download

## Download and unpack {#download-and-unpack}

```bash
gh release download --repo siracusa5/context-cake --archive=tar.gz --output contextcake.tar.gz
mkdir contextcake
tar -xzf contextcake.tar.gz -C contextcake --strip-components=1
cd contextcake
```

You can also grab the archive from the latest GitHub release page and unpack it
by hand. Either way, what you get is plain `.mjs` scripts and a couple of JSON
fixtures — nothing to build, nothing to compile.

## Why an archive, not a package registry {#why-an-archive}

Package registries have repeatedly shipped compromised AI/agent tooling through
hijacked maintainer accounts and `postinstall` payloads. A knowledge engine your
agents read from should have a supply chain you can audit: a tagged archive is
small, inspectable, and runnable as plain Node.js — no transitive dependency tree
to trust.

## Verify the install {#verify-the-install}

Resolve a concept from the bundled three-layer demo, where the layers
deliberately disagree:

```bash
node resolver.mjs --manifest playground/manifest.json --concept decisions/primary-db
```

The JSON output shows `contributors` (each layer and its last-updated date),
per-section `sourceLayer` (which layer won each section), and `conflicts` on
sections where layers disagree.

Run the full test suite (requires `bash`):

```bash
npm test
```

## The CLI entry points {#the-cli-entry-points}

| Tool | Run with |
|------|----------|
| Cascade resolver | `node resolver.mjs --manifest <file> --concept <id>` |
| MCP server for agents | `node mcp-server.mjs --manifest <file>` |
| Interactive playground | `npm run playground` (http://127.0.0.1:8790) |
| Signal ingestion | `node ingest.mjs --events <file> --out <file>` |
| Layer bundle writer | `node write.mjs --signals <file> --manifest <file> --target-layer <name>` |

Every script accepts `--help` and prints its own usage.

## Source checkout (optional) {#source-checkout-optional}

Use a git checkout only if you want to inspect history, contribute, or pin your
own fork — it is not the primary install path:

```bash
git clone https://github.com/siracusa5/context-cake.git
cd context-cake
```

## Next {#next}

- `getting-started/your-first-cascade.md` — build your own two-layer manifest and resolve a concept
- `getting-started/writing-a-layer.md` — author your first OKF concept file
