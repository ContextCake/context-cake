# ContextCake Playground

## Commands

```bash
# From repo root
npm run playground
node apps/playground/server.mjs --manifest apps/playground/manifest.json --port 8790
bash packages/core/tests/playground-test.sh
```

## Architecture

- `server.mjs` is a dependency-free local HTTP shell: it mounts the embeddable engine service (`packages/core/src/service.mjs` — read API, sources CRUD, `/console/` mount) and adds the playground-only file explorer/editor APIs and workbench static UI.
- `app.js`, `index.html`, and `styles.css` are the browser UI for inspecting and editing local OKF bundles.
- `manifest.json` points at `demo-layers/` for the default personal/team/company cascade.
- `vendor/` holds vendored browser dependencies; token counting lives in the engine (`packages/core/src/tokenize.mjs` + its vendored tokenizer).
- The server imports `packages/core/src/service.mjs` directly (which in turn uses `resolver.mjs` and `sources/index.mjs`).

## Gotchas

- The playground is local-only but still has security boundaries: path traversal, symlink escapes, CSRF, Host checks, and git transport allowlisting are covered by tests.
- Keep it dependency-free and offline. Do not add CDN assets.
- Source add/remove mutates the manifest; be careful with tests and fixtures.
- The test binds `127.0.0.1`; restricted sandboxes may block it even when code is correct.
