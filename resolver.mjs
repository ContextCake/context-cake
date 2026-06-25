#!/usr/bin/env node

// Cascade read-path engine. Resolves one OKF concept across an ordered stack of
// layer bundles into an effective concept, merging per section and per frontmatter
// field, with provenance. Dependency-free.
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

if (isMainModule(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  const layers = (manifest.layers ?? []).map((layer) => ({
    name: layer.name,
    level: Number(layer.level),
    root: path.resolve(path.dirname(args.manifest), layer.path),
  }));

  if (!args.concept) {
    throw new Error("Provide --concept <id> and --manifest <file>.");
  }

  const resolved = resolveConcept(args.concept, layers);
  if (!resolved) {
    throw new Error(`Concept not found in any layer: ${args.concept}`);
  }
  console.log(JSON.stringify(resolved, null, 2));
}

// ---- Core resolution -------------------------------------------------------

export function resolveConcept(id, layers) {
  const contributors = layers
    .map((layer) => {
      const entry = loadConcept(layer, id);
      if (!entry) return null;
      return { layer: layer.name, level: layer.level, updated: entry.frontmatter.updated ?? null, ...entry };
    })
    .filter(Boolean);

  if (contributors.length === 0) return null;

  const ordered = orderContributors(contributors);
  const merged = mergeConcepts(ordered);

  return {
    id,
    contributors: ordered.map((c) => ({ layer: c.layer, level: c.level, updated: c.updated })),
    ...merged,
  };
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
  // ordering leads.
  const order = [];
  const winners = new Map();
  for (const c of active) {
    for (const section of c.sections) {
      if (!winners.has(section.key)) order.push(section.key);
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
    return {
      key,
      heading: section.heading,
      content: suppressed ? "" : section.lines.join("\n").trim(),
      sourceLayer: c.layer,
      sourceUpdated: section.updated ?? c.updated ?? null,
      ...(suppressed ? { suppressed: true } : {}),
    };
  });

  return { frontmatter, frontmatterProvenance, sections };
}

// Higher level wins; equal level keeps the first contributor seen
// (contributors are pre-ordered by precedence). No recency tiebreak.
function sectionBeats(a, b) {
  return a.c.level > b.c.level;
}

// ---- OKF parsing -----------------------------------------------------------

export function parseConcept(content) {
  const { frontmatter, body } = parseFrontmatter(content);
  return { frontmatter, sections: parseSections(body) };
}

function parseSections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let current = { key: "", heading: null, level: 0, lines: [], updated: null, override: null };

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match) {
      pushSection(sections, current);
      const { key, updated, override } = parseHeadingAttrs(match[2]);
      current = { key, heading: line, level: match[1].length, lines: [], updated, override };
    } else {
      current.lines.push(line);
    }
  }
  pushSection(sections, current);
  return sections;
}

// Sections align by explicit anchor (decision A). The brace may also carry a
// section-level timestamp (decision B) or a null override (decision C):
//   `## Failover {#failover updated=2026-05-01}`
//   `## Backups {#backups override=none}`  ← tombstone: suppresses inherited section
// Falls back to a normalized heading when no anchor is present.
function parseHeadingAttrs(headingText) {
  const brace = headingText.match(/\{([^}]*)\}/);
  let key = null;
  let updated = null;
  let override = null;
  if (brace) {
    for (const token of brace[1].trim().split(/\s+/)) {
      if (token.startsWith("#")) key = token.slice(1).toLowerCase();
      else if (token.startsWith("updated=")) updated = token.slice(8).replace(/^['"]|['"]$/g, "");
      else if (token.startsWith("override=")) override = token.slice(9).replace(/^['"]|['"]$/g, "");
    }
  }
  if (!key) key = normalizeHeading(headingText);
  return { key, updated, override };
}

function pushSection(sections, section) {
  const hasContent = section.lines.some((line) => line.trim() !== "");
  if (section.heading === null && !hasContent) return;
  sections.push(section);
}

function normalizeHeading(text) {
  return text.replace(/\{[^}]*\}/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: content };

  const raw = content.slice(4, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, "");
  const frontmatter = {};

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1]] = parseYamlScalar(match[2].trim());
  }

  return { frontmatter, body };
}

function parseYamlScalar(value) {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  return value.replace(/^['"]|['"]$/g, "");
}

function loadConcept(layer, id) {
  const safeId = normalizeConceptId(id);
  const filePath = path.join(layer.root, `${safeId}.md`);
  if (!fs.existsSync(filePath)) return null;
  return parseConcept(fs.readFileSync(filePath, "utf8"));
}

function normalizeConceptId(value) {
  const normalized = path.posix.normalize(String(value).replace(/\\/g, "/").replace(/\.md$/i, ""));
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Invalid concept ID: ${value}`);
  }
  return normalized;
}

function walkMarkdown(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) stack.push(fullPath);
      else if (dirent.isFile() && dirent.name.endsWith(".md")) files.push(fullPath);
    }
  }
  return files.sort();
}

function updatedTime(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
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

Resolves an OKF concept across an ordered layer stack (level desc), merging per
section and per frontmatter field with provenance. Higher level wins per section;
per-section suppression via {#anchor override=none}.

manifest.json: { "layers": [ {"name":"company","level":0,"path":"..."}, ... ] }
`);
}
