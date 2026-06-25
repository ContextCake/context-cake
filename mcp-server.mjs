#!/usr/bin/env node

// Dependency-free stdio MCP server exposing a cascade of knowledge sources as one
// effective, read-time OKF graph. Reads resolve through the section/field merge in
// resolver.mjs (level precedence, provenance, per-section conflicts) over the
// source adapters in sources/ (OKF-local bundles + foreign graphs over MCP).
//
//   node mcp-server.mjs --manifest layers.json
//   node mcp-server.mjs --personal <dir> --shared <dir>   # legacy 2-layer stack

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { resolveConcept } from "./resolver.mjs";
import { buildSources } from "./sources/index.mjs";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const layers = buildLayers(args);
if (layers.length === 0) {
  printHelp();
  process.exit(1);
}

const layerByName = new Map(layers.map((layer) => [layer.name, layer]));
const serverInfo = { name: "team-knowledge", version: "0.2.0" };

const tools = [
  {
    name: "search",
    description: "Search the layer cascade. Returns one entry per concept ID with the layers that contribute and a snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for." },
        limit: { type: "number", default: 10, description: "Maximum matches to return." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description: "Read the resolved (effective) concept across the cascade, with provenance. Pass `layer` to read one layer's raw concept instead.",
    inputSchema: {
      type: "object",
      properties: {
        concept_id: { type: "string", description: "Concept ID, e.g. decisions/primary-db." },
        layer: { type: "string", description: "Optional layer name to read the raw, unmerged concept from that layer." },
      },
      required: ["concept_id"],
    },
  },
  {
    name: "list_concepts",
    description: "List effective concept IDs across the cascade with their contributing layers.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Optional OKF type filter (effective type)." },
      },
    },
  },
  {
    name: "get_links",
    description: "Return outgoing and incoming links for a concept, resolved against the effective graph.",
    inputSchema: {
      type: "object",
      properties: {
        concept_id: { type: "string", description: "Concept ID, e.g. systems/auth-service." },
      },
      required: ["concept_id"],
    },
  },
];

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
    return;
  }
  try {
    const response = await handleMessage(message);
    if (response) write(response);
  } catch (error) {
    write({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32000, message: error.message } });
  }
});

async function handleMessage(message) {
  const { id, method, params = {} } = message;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo,
      },
    };
  }
  if (method === "notifications/initialized") return null;
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools } };
  if (method === "tools/call") {
    const result = await callTool(params.name, params.arguments ?? {});
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function callTool(name, toolArgs) {
  if (name === "search") return await search(toolArgs);
  if (name === "read_file") return await readFileTool(toolArgs);
  if (name === "list_concepts") return await listConcepts(toolArgs);
  if (name === "get_links") return await getLinks(toolArgs);
  throw new Error(`Unknown tool: ${name}`);
}

// ---- tools ----------------------------------------------------------------

async function search({ query, limit = 10 }) {
  if (!query || typeof query !== "string") throw new Error("search requires a non-empty query string");
  const tokens = tokenize(query);
  if (tokens.length === 0) throw new Error("search query must contain at least one searchable token");

  const byId = new Map();
  for (const source of layers) {
    for (const id of await source.listConceptIds()) {
      const entry = await source.loadConcept(id);
      if (!entry) continue;
      const { frontmatter, sections } = entry;
      const sectionText = sections.map((s) => s.lines.join("\n")).join("\n");
      const score = scoreText(tokens, [id, frontmatter.title ?? "", frontmatter.description ?? "", String(frontmatter.tags ?? ""), sectionText]);
      if (score <= 0) continue;

      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, { id, title: frontmatter.title ?? null, score, layers: [source.name], snippet: makeSnippet(sectionText, tokens) });
      } else {
        existing.score += score;
        existing.layers.push(source.name);
        if (!existing.title) existing.title = frontmatter.title ?? null;
      }
    }
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Number(limit) || 10)
    .map((entry) => ({ ...entry, layers: orderLayerNames(entry.layers) }));
}

async function readFileTool({ concept_id, layer }) {
  const id = normalizeId(concept_id);

  if (layer) {
    const target = layerByName.get(layer);
    if (!target) throw new Error(`Unknown layer: ${layer}`);
    const entry = await target.loadConcept(id);
    if (!entry) throw new Error(`Concept not found in layer ${layer}: ${id}`);
    return { id, layer, raw: true, ...entry };
  }

  const resolved = await resolveConcept(id, layers);
  if (!resolved) throw new Error(`Concept not found in any layer: ${id}`);
  return { ...resolved, markdown: assembleMarkdown(resolved) };
}

async function listConcepts({ type } = {}) {
  const byId = new Map();
  for (const source of layers) {
    for (const id of await source.listConceptIds()) {
      const entry = await source.loadConcept(id);
      const frontmatter = entry?.frontmatter ?? {};
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, { id, type: frontmatter.type ?? null, title: frontmatter.title ?? null, layers: [source.name] });
      } else {
        existing.layers.push(source.name);
      }
    }
  }

  const entries = [...byId.values()].map((entry) => ({ ...entry, layers: orderLayerNames(entry.layers) }));
  if (!type) return entries.sort((a, b) => a.id.localeCompare(b.id));

  const resolvedAll = await Promise.all(entries.map((e) => resolveConcept(e.id, layers)));
  return entries
    .filter((_, i) => resolvedAll[i]?.frontmatter.type === type)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function getLinks({ concept_id }) {
  const id = normalizeId(concept_id);
  const resolved = await resolveConcept(id, layers);
  if (!resolved) throw new Error(`Concept not found in any layer: ${id}`);

  const body = resolved.sections.map((s) => `${s.heading ?? ""}\n${s.content}`).join("\n");
  const rawLinks = extractLinks(body).map((link) => {
    const targetId = resolveLinkTarget(id, link.target);
    return { raw: link.raw, target: link.target, id: targetId };
  });
  const outgoing = await Promise.all(rawLinks.map(async (link) => ({
    ...link,
    layers: link.id ? orderLayerNames(await layersWith(link.id)) : [],
  })));

  const incoming = [];
  for (const source of layers) {
    for (const sourceId of await source.listConceptIds()) {
      if (sourceId === id) continue;
      const entry = await source.loadConcept(sourceId);
      if (!entry) continue;
      const sourceBody = entry.sections.map((s) => `${s.heading ?? ""}\n${s.lines.join("\n")}`).join("\n");
      for (const link of extractLinks(sourceBody)) {
        if (resolveLinkTarget(sourceId, link.target) === id) {
          incoming.push({ id: sourceId, layer: source.name, raw: link.raw });
          break;
        }
      }
    }
  }

  return {
    source: { id, contributors: resolved.contributors },
    outgoing,
    incoming: dedupeIncoming(incoming).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// ---- helpers --------------------------------------------------------------

function buildLayers(parsed) {
  if (parsed.manifest) {
    const manifest = JSON.parse(fs.readFileSync(parsed.manifest, "utf8"));
    return buildSources(manifest, path.dirname(parsed.manifest));
  }
  if (parsed.personal && parsed.shared) {
    return buildSources(
      {
        layers: [
          { name: "personal", level: 3, source: "okf-local", path: path.resolve(parsed.personal) },
          { name: "shared", level: 0, source: "okf-local", path: path.resolve(parsed.shared) },
        ],
      },
      process.cwd(),
    );
  }
  return [];
}

async function layersWith(id) {
  const results = await Promise.all(layers.map(async (source) => {
    const entry = await source.loadConcept(id);
    return entry ? source.name : null;
  }));
  return results.filter(Boolean);
}

function orderLayerNames(names) {
  const unique = [...new Set(names)];
  return unique.sort((a, b) => (layerByName.get(b)?.level ?? 0) - (layerByName.get(a)?.level ?? 0));
}

function resolveLinkTarget(sourceId, target) {
  const clean = stripDecoration(target);
  if (!clean || isExternal(clean)) return null;

  const prefix = clean.indexOf(":");
  if (prefix !== -1) {
    const name = clean.slice(0, prefix);
    if (layerByName.has(name)) return safeId(clean.slice(prefix + 1));
  }

  const base = path.posix.dirname(sourceId);
  const joined = clean.startsWith("/") ? clean.slice(1) : path.posix.join(base, clean);
  return safeId(joined);
}

function safeId(value) {
  try {
    return normalizeId(value);
  } catch {
    return null;
  }
}

function normalizeId(value) {
  if (!value || typeof value !== "string") throw new Error("concept_id is required");
  const normalized = path.posix.normalize(stripDecoration(value).replace(/\\/g, "/").replace(/\.md$/i, ""));
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Invalid concept ID: ${value}`);
  }
  return normalized;
}

function extractLinks(body) {
  const links = [];
  for (const match of body.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
    if (match[0].startsWith("!")) continue;
    links.push({ raw: match[0], target: match[1] });
  }
  for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?]]/g)) {
    links.push({ raw: match[0], target: match[1] });
  }
  return links.filter((link) => link.target && !isExternal(stripDecoration(link.target)));
}

function dedupeIncoming(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.id}@${row.layer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function assembleMarkdown(resolved) {
  const fmLines = Object.entries(resolved.frontmatter).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`);
  const front = `---\n${fmLines.join("\n")}\n---\n\n`;
  const bodyParts = resolved.sections
    .filter((s) => !s.suppressed)
    .map((s) => {
      const head = s.heading ? `${s.heading}\n\n${s.content}` : s.content;
      if (!s.conflicts || s.conflicts.length === 0) return head;
      const notes = s.conflicts
        .map((c) => `> ⚠ ${c.layer} disagrees (updated ${c.updated ?? "?"}): ${c.content.replace(/\n+/g, " ")}`)
        .join("\n");
      return `${head}\n\n${notes}`;
    });
  return front + bodyParts.join("\n\n");
}

function scoreText(tokens, haystacks) {
  return tokens.reduce((total, token) => {
    return total + haystacks.reduce((subtotal, haystack, index) => {
      const weight = index <= 2 ? 4 : index === 3 ? 2 : 1;
      return subtotal + countOccurrences(String(haystack).toLowerCase(), token) * weight;
    }, 0);
  }, 0);
}

function tokenize(query) {
  return query.toLowerCase().match(/[a-z0-9_-]+/g) ?? [];
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function makeSnippet(body, tokens) {
  const lower = body.toLowerCase();
  const positions = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0);
  if (positions.length === 0) return body.trim().slice(0, 240);
  const start = Math.max(0, Math.min(...positions) - 80);
  const end = Math.min(body.length, start + 240);
  return `${start > 0 ? "..." : ""}${body.slice(start, end).trim()}${end < body.length ? "..." : ""}`;
}

function stripDecoration(value) {
  return value.split("#")[0].split("?")[0].trim();
}

function isExternal(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) && !layerByName.has(value.slice(0, value.indexOf(":")));
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

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function printHelp() {
  console.log(`Usage:
  node mcp-server.mjs --manifest layers.json
  node mcp-server.mjs --personal <dir> --shared <dir>

Stdio MCP server exposing a cascade of knowledge sources (OKF-local bundles +
foreign graphs over MCP) as one effective read-time OKF graph. read_file
resolves the effective concept (section/field merge + provenance + per-section
conflicts); pass a layer name to read a single layer's raw concept.
`);
}
