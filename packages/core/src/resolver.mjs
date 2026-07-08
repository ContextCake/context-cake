#!/usr/bin/env node

// Cascade read-path engine. Resolves one OKF concept across an ordered set of
// sources (each behind a uniform async adapter) into an effective concept,
// merging per section and per frontmatter field, with provenance.
// Dependency-free.
//
// Resolution rules:
//   - Order contributors by level (desc). Higher level wins per section.
//   - `override: full` on a contributor drops everything below it.
//   - Otherwise: each section (by heading) and each frontmatter key is won by the
//     highest-precedence contributor that defines it; the rest are inherited.
//   - Per-section suppression: `{#anchor override=none}` tombstone hides a section.
//
// Usage:
//   node resolver.mjs --manifest layers.json --concept decisions/primary-db
//
// manifest.json: { "layers": [ {"name":"company","level":0,"path":"..."}, ... ] }

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSources } from "./sources/index.mjs";

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.concept) {
    throw new Error("Provide --concept <id> and --manifest <file>.");
  }

  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  const sources = buildSources(manifest, path.dirname(args.manifest));

  try {
    const resolved = await resolveConcept(args.concept, sources);
    if (!resolved) throw new Error(`Concept not found in any source: ${args.concept}`);
    console.log(JSON.stringify(resolved, null, 2));
  } finally {
    for (const s of sources) s.close();
  }
}

// ---- Core resolution -------------------------------------------------------

export async function resolveConcept(id, sources) {
  const loaded = await Promise.all(
    sources.map(async (source) => {
      const entry = await source.loadConcept(id);
      if (!entry) return null;
      return { layer: source.name, level: source.level, updated: entry.frontmatter.updated ?? null, ...entry };
    }),
  );
  const contributors = loaded.filter(Boolean);
  if (contributors.length === 0) return null;
  const ordered = orderContributors(contributors);
  const merged = mergeConcepts(ordered);
  return { id, contributors: ordered.map((c) => ({ layer: c.layer, level: c.level, updated: c.updated })), ...merged };
}

// Highest precedence first: level desc, then most-recently-updated (horizontal tie-break).
export function orderContributors(contributors) {
  return [...contributors].sort((a, b) => {
    if (b.level !== a.level) return b.level - a.level;
    return updatedTime(b.updated) - updatedTime(a.updated);
  });
}

// contributors must be ordered highest-precedence first.
export function mergeConcepts(contributors) {
  let active = contributors;
  const fullIndex = active.findIndex((c) => c.frontmatter.override === "full");
  if (fullIndex !== -1) active = active.slice(0, fullIndex + 1);

  const frontmatter = {};
  const frontmatterProvenance = {};
  for (const c of [...active].reverse()) {
    for (const [key, value] of Object.entries(c.frontmatter)) {
      frontmatter[key] = value;
      frontmatterProvenance[key] = c.layer;
    }
  }

  // Per-section winner: highest level wins (vertical precedence). Display order
  // follows first appearance in precedence order, so a higher layer's section
  // ordering leads. Dissenters are collected per section for honest-conflict output.
  const order = [];
  const winners = new Map();
  const contenders = new Map(); // key -> [{ c, section }]
  for (const c of active) {
    for (const section of c.sections) {
      if (!winners.has(section.key)) order.push(section.key);
      if (!contenders.has(section.key)) contenders.set(section.key, []);
      contenders.get(section.key).push({ c, section });
      const challenger = { c, section };
      const current = winners.get(section.key);
      if (!current || sectionBeats(challenger, current)) {
        winners.set(section.key, challenger);
      }
    }
  }

  const sections = order.map((key) => {
    const { c, section } = winners.get(key);
    const suppressed = section.override === "none";
    const winnerContent = suppressed ? "" : section.lines.join("\n").trim();

    // Dissent: any OTHER contributor that defines this section with different content.
    // Suppressed sections are tombstones — no conflicts emitted (suppression IS the answer).
    const conflicts = suppressed ? [] : contenders.get(key)
      .filter((x) => x.c !== c)
      .map((x) => ({
        layer: x.c.layer,
        updated: x.section.updated ?? x.c.updated ?? null,
        content: x.section.override === "none" ? "" : x.section.lines.join("\n").trim(),
      }))
      .filter((d) => d.content !== winnerContent);

    return {
      key,
      heading: section.heading,
      content: winnerContent,
      sourceLayer: c.layer,
      sourceUpdated: section.updated ?? c.updated ?? null,
      ...(suppressed ? { suppressed: true } : {}),
      ...(conflicts.length ? { conflicts } : {}),
    };
  });

  return { frontmatter, frontmatterProvenance, sections };
}

// Higher level wins; equal level keeps the first contributor seen
// (contributors are pre-ordered by precedence). No recency tiebreak.
function sectionBeats(a, b) {
  return a.c.level > b.c.level;
}

function updatedTime(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node resolver.mjs --manifest layers.json --concept <id>

Resolves an OKF concept across an ordered source stack (level desc), merging per
section and per frontmatter field with provenance. Higher level wins per section;
per-section suppression via {#anchor override=none}.

manifest.json: { "layers": [ {"name":"company","level":0,"path":"..."}, ... ] }
`);
}
