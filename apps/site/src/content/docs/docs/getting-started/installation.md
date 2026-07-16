---
title: Installation
description: Choose a versioned ContextCake source route and run the bundled demo in a few minutes.
---

ContextCake runs directly from **versioned source**. The recommended route is a
verified source archive; shallow Git and GitHub CLI checkouts are available when
you already use source-control tooling. The engine is dependency-free: there is
no `npm install` step, no install scripts execute, and the resolver quickstart
fetches nothing after the source is on your machine.

If you are still evaluating whether the model fits your team, start with the
[demo](/demo) or [the docs overview](/docs) and come back here when you want the
local setup path.

## Prerequisites

- Node.js ≥ 18
- One download route: a browser, `curl`, GitHub CLI, or Git

## Choose a route

Every route below targets the same `console-v0.2.0` source tag. Use the archive
when you want the smallest inspectable download, or a shallow Git checkout when
you already work with source-control tools.

### Terminal download (recommended)

On macOS, Linux, or WSL:

```bash
curl --fail --location https://github.com/ContextCake/context-cake/archive/refs/tags/console-v0.2.0.tar.gz \\
  --output context-cake-console-v0.2.0.tar.gz
```

You can also [download the same archive in your browser](https://github.com/ContextCake/context-cake/archive/refs/tags/console-v0.2.0.tar.gz).

### GitHub CLI

If you already use `gh`, create a shallow checkout at the same tag:

```bash
gh repo clone ContextCake/context-cake contextcake -- \\
  --branch console-v0.2.0 --depth 1
cd contextcake
```

### Git

```bash
git clone --branch console-v0.2.0 --depth 1 \\
  https://github.com/ContextCake/context-cake.git contextcake
cd contextcake
```

Git and GitHub CLI users can skip directly to [Verify the resolver](#verify-the-resolver).

## Verify and unpack the archive

If you downloaded the archive with curl or your browser, verify it before unpacking:

```bash
printf '%s  %s\n' '013525569cd3c3cdfac77d22bf1976a1d0bc6e8ffcbdcfbbaa8bd92502bc4253' 'context-cake-console-v0.2.0.tar.gz' | shasum -a 256 --check &&
mkdir contextcake &&
tar -xzf context-cake-console-v0.2.0.tar.gz -C contextcake --strip-components=1 &&
cd contextcake
```

These commands target the `console-v0.2.0` tag instead of following the
latest source checkout, and stop before extraction if the downloaded bytes do not
match the published SHA-256.

## Verify the resolver

Resolve a concept from the bundled three-layer demo, where the layers deliberately
disagree:

```bash
node resolver.mjs --manifest playground/manifest.json --concept decisions/primary-db
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
node resolver.mjs --manifest apps/playground/manifest.json --concept decisions/primary-db
```

The current source tree uses `apps/playground/manifest.json`; the versioned archive
above predates the monorepo layout and uses `playground/manifest.json`.

## Why a source archive?

Package registries have repeatedly shipped compromised AI/agent tooling through
hijacked maintainer accounts and `postinstall` payloads. A knowledge engine your
agents read from should have a supply chain you can audit: a source archive is
small, inspectable, and runnable as plain Node.js.

There is no npm global install today. A signed macOS app and Homebrew cask belong
to the packaged distribution track and will be documented only after their real
artifacts are published. Windows users should use the terminal route in WSL until
a native Windows package is tested and signed.

## Next

- [Your first cascade](/docs/getting-started/first-cascade): build your own layers
- [Connect an agent (MCP)](/docs/getting-started/connect-an-agent): wire it into Claude
- [The trust boundary](/docs/concepts/trust-boundary): read this before pointing a
  manifest at sources you didn't write
