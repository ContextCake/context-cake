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
//   node resolver.mjs --manifest manifest.json --concept decisions/primary-db [--profile work]
//
// manifest.json: { "layers": [ {"name":"company","level":0,"path":"..."}, ... ] }

import { pathToFileURL } from "node:url";
import { equivalent, isNewerDay } from "./conflict-policy.mjs";
import { buildProfileSources, loadProfileRuntime } from "./profile-runtime.mjs";

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.concept || !args.manifest) {
    throw new Error("Provide --concept <id> and --manifest <file>.");
  }

  const runtime = loadProfileRuntime(args.manifest, {
    requestedProfile: args.profile ?? null,
    cwd: process.cwd(),
  });
  const sources = buildProfileSources(runtime);

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

  // Frontmatter still resolves by precedence, exactly as before. The additive
  // conflict list gives inspection surfaces the values that lost without
  // changing the effective object or treating a singly-defined field as a
  // disagreement. `updated` and `override` are resolver mechanics, not domain
  // facts a person should reconcile.
  const frontmatterConflicts = [];
  const frontmatterKeys = new Set(active.flatMap((c) => Object.keys(c.frontmatter)));
  for (const key of frontmatterKeys) {
    if (key === "updated" || key === "override") continue;
    const definitions = active
      .filter((c) => Object.prototype.hasOwnProperty.call(c.frontmatter, key))
      .map((c) => ({ layer: c.layer, level: c.level, updated: c.updated, value: c.frontmatter[key] }));
    if (definitions.length < 2) continue;
    const signatures = new Set(definitions.map((item) => stableValue(item.value)));
    if (signatures.size < 2) continue;
    const winnerLayer = frontmatterProvenance[key];
    const winner = definitions.find((item) => item.layer === winnerLayer);
    frontmatterConflicts.push({ key, winner, contributions: definitions });
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
    // Formatting-equivalent restatements (whitespace, bullet glyphs) are not dissent
    // and are silently dropped — see conflict-policy.mjs for the exact normalization.
    // Suppressed sections are tombstones — no conflicts emitted (suppression IS the answer).
    const conflicts = suppressed ? [] : contenders.get(key)
      .filter((x) => x.c !== c)
      .map((x) => ({
        layer: x.c.layer,
        updated: x.section.updated ?? x.c.updated ?? null,
        content: x.section.override === "none" ? "" : x.section.lines.join("\n").trim(),
      }))
      .filter((d) => !equivalent(d.content, winnerContent));

    const sourceUpdated = section.updated ?? c.updated ?? null;
    // Freshness flag: a dissent that is strictly newer than the effective value
    // (day granularity, both dates must parse — see conflict-policy.mjs) means
    // the losing layer has spoken more recently than the winner.
    const fresherDissent = conflicts.some((d) => isNewerDay(d.updated, sourceUpdated));

    return {
      key,
      heading: section.heading,
      content: winnerContent,
      sourceLayer: c.layer,
      sourceUpdated,
      ...(suppressed ? { suppressed: true } : {}),
      ...(conflicts.length ? { conflicts } : {}),
      ...(fresherDissent ? { fresherDissent: true } : {}),
    };
  });

  return {
    frontmatter,
    frontmatterProvenance,
    ...(frontmatterConflicts.length ? { frontmatterConflicts } : {}),
    sections,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value && typeof value === "object") {
    return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  }
  return JSON.stringify(value);
}

// Higher level wins; equal level keeps the first contributor seen. Contributors
// arrive pre-sorted newest-first within a level (orderContributors, via
// resolveConcept), so on equal level the more recently updated document wins ties.
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
  node resolver.mjs --manifest manifest.json --concept <id> [--profile <id>]

Resolves an OKF concept across an ordered source stack (level desc), merging per
section and per frontmatter field with provenance. Higher level wins per section;
per-section suppression via {#anchor override=none}.

Profile selection order: explicit --profile, deepest project mapping containing
the current working directory, then default. Flat manifests remain the virtual
default profile.
`);
}
