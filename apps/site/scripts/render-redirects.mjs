#!/usr/bin/env node
// Re-render public/_redirects from the committed src/data/app-release.json and
// src/config/flags.json. Runs as `prebuild` so the file is derived on every
// build, in CI and locally, in both flag states — no network, no GitHub token.
// scripts/sync-app-release.mjs calls the same renderer after a release sync.
import { renderRedirectsFile } from './sync-app-release.mjs'

const text = await renderRedirectsFile()
console.log(`rendered public/_redirects (${text.trimEnd().split('\n').length} rule(s))`)
