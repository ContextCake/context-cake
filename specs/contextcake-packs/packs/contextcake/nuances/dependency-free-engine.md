---
type: nuance
updated: 2026-07-08
---

# The engine is dependency-free {#the-engine-is-dependency-free}

The core of ContextCake — the resolver, the source adapters, the CLI tools —
runs on plain Node.js (>= 18) built-ins only. No npm packages. `npm install`
in the repo root has nothing to install; the engine simply requires none.

## What that covers {#what-that-covers}

The dependency-free boundary applies to the engine surface:

- `resolver.mjs` — the cascade engine: OKF parsing, section merge,
  precedence, provenance, conflict surfacing
- `packages/core/src/sources/okf-local.mjs`, `packages/core/src/sources/mcp.mjs`, `packages/core/src/sources/index.mjs` — the
  source-adapter layer
- `mcp-server.mjs` — the stdio MCP server that exposes the resolved graph
- `classify-context.mjs`, `ingest.mjs`, `write.mjs`, `promote.mjs` — the
  write path
- `apps/playground/` — the interactive playground ships its own dependency-free
  HTTP server (`server.mjs`) rather than pulling in a framework

If you are integrating against ContextCake as a library or spawning
`mcp-server.mjs` as a subprocess, you are not inheriting any transitive
dependency tree. That is a deliberate property, not an accident of the
current version — it keeps the trust surface small, especially given that
the manifest can spawn arbitrary MCP server processes (see the security note
in `nuances/what-contextcake-is-not.md`).

## What is exempt: `apps/console/` and `apps/site/` {#what-is-exempt}

Two parts of the repository are explicitly carved out of this rule, and
carved out *cleanly* — they are separate npm packages with their own
`package.json`, their own build step, and their own dependency tree:

- `apps/console/` — a React + Vite + TypeScript web UI (the ContextCake Console),
  deployed to Cloudflare Pages
- `apps/site/` — the public product site and docs, built on Astro + Starlight

Both exist because a real UI and a real docs site are reasonable things to
want npm's ecosystem for, and pretending otherwise would just mean
reinventing a worse version of React or Astro by hand. The boundary that
matters is that **neither imports from the engine as a library** — they
talk to it the same way any other consumer would: `apps/console/` calls the
resolved graph over its API surface, and `apps/site/` just documents the engine,
it does not embed it.

## Why this boundary is enforced, not just documented {#why-enforced}

Adding an npm dependency to the engine is explicitly gated: it requires
asking first, per the project's boundaries (see the design doc's
constitution-style rules). This is not bureaucracy for its own sake — a
dependency-free engine is easier to audit line by line, easier to vendor or
embed in another tool without pulling in a `node_modules` tree, and easier
to trust when it is already spawning subprocesses declared in a manifest
you may or may not have authored yourself.

If you are contributing to ContextCake and find yourself reaching for a
package to solve something in `resolver.mjs` or `packages/core/src/sources/`, that is a
signal to slow down and either solve it with built-ins or raise the
question explicitly — not a signal to `npm install` and move on.

## What this means for you {#what-this-means-for-you}

- Running the engine (`node mcp-server.mjs --manifest layers.json`, `node
  resolver.mjs ...`) never requires an `npm install` step.
- `apps/console/` and `apps/site/` do require `npm install` / `npm ci` — run those
  commands from inside those subdirectories, not the repo root.
- If you are writing your own source adapter or extending the engine, keep
  it to built-ins, or expect to have that conversation before it lands.

## Next {#next}

- `nuances/what-contextcake-is-not.md` — the manifest-as-trust-boundary
  point this dependency discipline supports
