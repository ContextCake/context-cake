# ContextCake Playground

## Commands

```bash
# From repo root
npm run playground
node apps/playground/server.mjs --manifest apps/playground/manifest.json --port 8790
bash packages/core/tests/playground-test.sh
```

## Architecture

- `server.mjs` is a dependency-free local HTTP server over the real core resolver.
- `app.js`, `index.html`, and `styles.css` are the browser UI for inspecting and editing local OKF bundles.
- `manifest.json` points at `demo-layers/` for the default personal/team/company cascade.
- `tokenize.mjs` and `vendor/` provide offline token counting and browser dependencies.
- The server imports `packages/core/src/resolver.mjs` and `packages/core/src/sources/index.mjs` directly.

## Gotchas

- The playground is local-only but still has security boundaries: path traversal, symlink escapes, CSRF, Host checks, and git transport allowlisting are covered by tests.
- Keep it dependency-free and offline. Do not add CDN assets.
- Source add/remove mutates the manifest; be careful with tests and fixtures.
- The test binds `127.0.0.1`; restricted sandboxes may block it even when code is correct.
