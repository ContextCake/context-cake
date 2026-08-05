import { rm } from 'node:fs/promises';

// The site used to build a second, independently deployable renderer under
// /demo-app/. The canonical Web Demo now deploys with the app release, so keep
// stale generated copies from leaking into local or production site builds.
await rm(new URL('../public/demo-app', import.meta.url), { force: true, recursive: true });
