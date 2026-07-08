# Core Bin Entrypoints

Root `.mjs` files preserve the public CLI commands for now:

- `resolver.mjs`
- `mcp-server.mjs`
- `classify-context.mjs`
- `ingest.mjs`
- `write.mjs`
- `promote.mjs`

Keep this directory for future packaged binary shims. Do not move the root
compatibility wrappers without updating docs, tests, and release notes.
