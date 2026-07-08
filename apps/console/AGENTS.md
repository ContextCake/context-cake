# ContextCake Console

## Commands

```bash
cd apps/console
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm run build:live

# From repo root, build and serve live mode through the playground
npm run console:live
```

## Architecture

- React + Vite + TypeScript SPA for reading the resolved cascade.
- `src/api.ts` is the data seam. Demo mode uses generated resolver output; live mode calls the same-origin playground API.
- `src/store.tsx` owns app state and actions. `src/App.tsx` owns shell routing and keyboard handling.
- `src/views/` contains Canvas, Overview, Triage, Conflicts, and Concepts.
- `src/components/` contains shared chrome and detail panels.
- `scripts/build-demo-data.mjs` shells out to `packages/core/src/resolver.mjs` and writes `src/generated/demo-cascade.json`.

## Gotchas

- `src/generated/` is generated and ignored. Do not edit it by hand.
- `npm run typecheck`, `npm test`, and `npm run build` all regenerate demo data through pre-hooks.
- Strict unused checks fail builds. Remove unused imports, locals, and parameters.
- Keep dependencies inside `apps/console/package.json`; do not add root dependencies.
- `build:live` uses `--base=/console/` for the playground `/console/` mount.
