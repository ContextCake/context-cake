#!/usr/bin/env node
// Demo-data seam (design.md §11.4).
//
// Enumerate every concept in the demo bundle and resolve it through the REAL
// engine, so the site never hand-authors merge output. Emits a single JSON
// file the marketing pages import at build time:
//
//   apps/site/src/data/demo-cascade.json  →  { "concepts": [ <resolved concept>, … ] }
//
// The directory is gitignored: this file is generated, never committed, never
// hand-edited. Wired as the `prebuild`/`predev` npm script.
//
// Engine use is READ-ONLY — we shell out to `resolver.mjs` exactly as the docs
// show (`node resolver.mjs --manifest … --concept …`). No engine file is
// modified and this can never affect `npm test`.

import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url)); // apps/site/scripts
const siteRoot = resolve(scriptDir, '..');
const repoRoot = resolve(siteRoot, '..', '..'); // repo root
const manifestPath = join(repoRoot, 'apps', 'playground', 'manifest.json');
const manifestDir = dirname(manifestPath);
const resolverPath = join(repoRoot, 'packages', 'core', 'src', 'resolver.mjs');
const outDir = join(siteRoot, 'src', 'data');
const outFile = join(outDir, 'demo-cascade.json');

/** Recursively collect every `*.md` file under `dir` (Node ≥ 18, no deps). */
function walkMarkdown(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return []; // missing layer path → no concepts, not fatal
	}
	const files = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walkMarkdown(full));
		else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
	}
	return files;
}

/** Concept ID = layer-relative path minus `.md`, POSIX slashes. */
function conceptId(layerRoot, file) {
	return relative(layerRoot, file).replace(/\\/g, '/').replace(/\.md$/, '');
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// Union of concept IDs across every okf-local layer path. Foreign (mcp) layers
// have no on-disk markdown to glob; they contribute at resolve time, not here.
const ids = new Set();
for (const layer of manifest.layers ?? []) {
	if (!layer.path) continue;
	const layerRoot = resolve(manifestDir, layer.path);
	for (const file of walkMarkdown(layerRoot)) ids.add(conceptId(layerRoot, file));
}

const sortedIds = [...ids].sort();
const concepts = [];
for (const id of sortedIds) {
	try {
		const stdout = execFileSync(
			process.execPath,
			[resolverPath, '--manifest', manifestPath, '--concept', id],
			{ encoding: 'utf8' },
		);
		concepts.push(JSON.parse(stdout));
	} catch (err) {
		console.error(`[build-demo-data] failed to resolve "${id}": ${err.message}`);
	}
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify({ concepts }, null, 2) + '\n');

console.log(
	`[build-demo-data] wrote ${concepts.length} concept(s) → ${relative(repoRoot, outFile)}`,
);
