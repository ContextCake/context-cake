#!/usr/bin/env node
// Console demo-data seam — the console counterpart of site/scripts/build-demo-data.mjs.
//
// Enumerate every concept in the demo bundle and resolve it through the REAL
// engine, then assemble a graph summary shaped exactly like the playground
// server's GET /api/graph. Emits one JSON file the console imports at build time:
//
//   console/src/generated/demo-cascade.json  →  { graph, concepts }
//
// so DemoSource and LiveSource return identical shapes (types.ts). The directory
// is gitignored: generated, never committed, never hand-edited. Wired as the
// console `predev` / `prebuild` / `pretypecheck` npm script.
//
// Engine use is READ-ONLY — we shell out to `resolver.mjs` exactly as the docs
// show (`node resolver.mjs --manifest … --concept …`). No engine file is
// imported or modified; this can never affect `npm test`.

import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url)) // console/scripts
const consoleRoot = resolve(scriptDir, '..') // console/
const repoRoot = resolve(consoleRoot, '..') // repo root
const manifestPath = join(repoRoot, 'playground', 'manifest.json')
const manifestDir = dirname(manifestPath)
const resolverPath = join(repoRoot, 'resolver.mjs')
const outDir = join(consoleRoot, 'src', 'generated')
const outFile = join(outDir, 'demo-cascade.json')

/** Recursively collect every `*.md` under `dir` (Node ≥ 18, no deps). */
function walkMarkdown(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkMarkdown(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full)
  }
  return files
}

/** Concept ID = layer-relative path minus `.md`, POSIX slashes. */
function conceptId(layerRoot, file) {
  return relative(layerRoot, file).replace(/\\/g, '/').replace(/\.md$/, '')
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const layers = manifest.layers ?? []

// Union of concept IDs across every okf-local layer path.
const ids = new Set()
for (const layer of layers) {
  if (!layer.path) continue
  const layerRoot = resolve(manifestDir, layer.path)
  for (const file of walkMarkdown(layerRoot)) ids.add(conceptId(layerRoot, file))
}

const sortedIds = [...ids].sort()
const concepts = []
for (const id of sortedIds) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [resolverPath, '--manifest', manifestPath, '--concept', id],
      { encoding: 'utf8' },
    )
    concepts.push(JSON.parse(stdout))
  } catch (err) {
    console.error(`[console build-demo-data] failed to resolve "${id}": ${err.message}`)
  }
}

// Assemble a GraphSummary matching playground server.mjs buildGraph (minus the
// token accounting, which the console does not display in demo mode).
const graphConcepts = concepts.map((c) => {
  const conflictCount = c.sections.reduce((n, s) => n + (s.conflicts?.length ? 1 : 0), 0)
  return {
    id: c.id,
    type: c.frontmatter?.type ?? 'concept',
    title: c.frontmatter?.title ?? c.id,
    contributors: c.contributors.map((k) => k.layer),
    winner: c.contributors[0]?.layer ?? null,
    conflictCount,
    tokens: 0,
  }
})

const latestPerLayer = new Map()
for (const c of concepts) {
  for (const k of c.contributors) {
    const prev = latestPerLayer.get(k.layer)
    if (k.updated && (!prev || k.updated > prev)) latestPerLayer.set(k.layer, k.updated)
  }
}

const sources = layers.map((l) => ({
  name: l.name,
  level: l.level,
  kind: l.source ?? 'okf-local',
  location: l.path ?? null,
  origin: l.origin ?? null,
  conceptCount: concepts.filter((c) => c.contributors.some((k) => k.layer === l.name)).length,
  tokens: 0,
  latestUpdated: latestPerLayer.get(l.name) ?? null,
  status: 'ok',
  error: null,
}))

const graph = {
  manifest: { path: manifestPath },
  tokenizer: 'demo',
  totals: { sourceTokens: 0, resolvedTokens: 0, concepts: concepts.length, sources: sources.length },
  sources,
  concepts: graphConcepts,
}

mkdirSync(outDir, { recursive: true })
writeFileSync(outFile, JSON.stringify({ graph, concepts }, null, 2) + '\n')

console.log(
  `[console build-demo-data] wrote ${concepts.length} concept(s), ${sources.length} source(s) → ${relative(repoRoot, outFile)}`,
)
