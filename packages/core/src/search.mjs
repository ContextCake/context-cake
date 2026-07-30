// Retrieval over a cascade of layer sources: the ranking behind the `search`
// and `find_captures` MCP tools.
//
// This lives outside mcp-server.mjs on purpose. That module parses argv and can
// call process.exit() at load time, so it cannot be imported — which meant the
// ranking had no way to be measured.
//
// Not to be confused with tokenize.mjs, which is the BPE tokenizer used for
// context-budget accounting. The tokenizer here is a query analyzer.

const DAY_MS = 86400000;

// Field order is load-bearing: scorers weight by position. 0-2 are the
// identifying fields (id, title, description), 3 is tags, 4 is the body.
const WEIGHTS = [4, 4, 4, 2, 1];

export function tokenizeQuery(query) {
  return query.toLowerCase().match(/[a-z0-9_-]+/g) ?? [];
}

function requireTokens(query, tool) {
  if (!query || typeof query !== "string") throw new Error(`${tool} requires a non-empty query string`);
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) throw new Error(`${tool} query must contain at least one searchable token`);
  return tokens;
}

// One I/O pass over the cascade. Callers score the returned array in memory, so
// adding a second scoring pass costs nothing on top of the walk.
async function collectDocuments(layers, { prefix = null } = {}) {
  const docs = [];
  for (const source of layers) {
    for (const id of await source.listConceptIds()) {
      if (prefix && !id.startsWith(prefix)) continue;
      const entry = await source.loadConcept(id);
      if (!entry) continue;
      const { frontmatter, sections } = entry;
      docs.push({
        id,
        layer: source.name,
        frontmatter,
        body: sections.map((section) => section.lines.join("\n")).join("\n"),
      });
    }
  }
  return docs;
}

function conceptFields(doc) {
  return [
    doc.id,
    doc.frontmatter.title ?? "",
    doc.frontmatter.description ?? "",
    String(doc.frontmatter.tags ?? ""),
    doc.body,
  ];
}

function captureFields(doc) {
  // Captures carry no description or tags; keeping the arity fixed keeps the
  // positional weights aligned with concept scoring.
  return [doc.id, doc.frontmatter.title ?? "", "", "", doc.body];
}

export function scoreFields(tokens, fields) {
  return tokens.reduce((total, token) => {
    return total + fields.reduce((subtotal, field, index) => {
      return subtotal + countOccurrences(String(field).toLowerCase(), token) * WEIGHTS[index];
    }, 0);
  }, 0);
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

export function makeSnippet(body, tokens) {
  const lower = body.toLowerCase();
  const positions = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0);
  if (positions.length === 0) return body.trim().slice(0, 240);
  const start = Math.max(0, Math.min(...positions) - 80);
  const end = Math.min(body.length, start + 240);
  return `${start > 0 ? "..." : ""}${body.slice(start, end).trim()}${end < body.length ? "..." : ""}`;
}

function layerOrderer(layers) {
  const levelByName = new Map(layers.map((layer) => [layer.name, layer.level]));
  return (names) => [...new Set(names)].sort((a, b) => (levelByName.get(b) ?? 0) - (levelByName.get(a) ?? 0));
}

export async function searchConcepts(layers, { query, limit = 10 }) {
  const tokens = requireTokens(query, "search");
  const orderLayerNames = layerOrderer(layers);
  const docs = await collectDocuments(layers);

  const byId = new Map();
  for (const doc of docs) {
    const score = scoreFields(tokens, conceptFields(doc));
    if (score <= 0) continue;

    const existing = byId.get(doc.id);
    if (!existing) {
      byId.set(doc.id, {
        id: doc.id,
        title: doc.frontmatter.title ?? null,
        score,
        layers: [doc.layer],
        snippet: makeSnippet(doc.body, tokens),
      });
    } else {
      existing.score += score;
      existing.layers.push(doc.layer);
      if (!existing.title) existing.title = doc.frontmatter.title ?? null;
    }
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Number(limit) || 10)
    .map((entry) => ({ ...entry, layers: orderLayerNames(entry.layers) }));
}

export async function searchCaptures(layers, { query, kinds = null, limit = 10, now = Date.now() }) {
  const tokens = requireTokens(query, "find_captures");
  const docs = await collectDocuments(layers, { prefix: "captures/" });

  const rows = [];
  for (const doc of docs) {
    if (kinds && !kinds.includes(doc.frontmatter.kind)) continue;
    const base = scoreFields(tokens, captureFields(doc));
    if (base <= 0) continue;

    const capturedAt = doc.frontmatter.captured ?? null;
    const capturedTime = capturedAt ? new Date(capturedAt).getTime() : NaN;
    // An unparseable `captured` must not poison scoring with NaN (which makes
    // the sort unstable). Treat it as age 0 (freshest) — it still surfaces.
    const ageDays = Number.isNaN(capturedTime) ? 0 : Math.max(0, (now - capturedTime) / DAY_MS);
    rows.push({
      id: doc.id,
      title: doc.frontmatter.title ?? null,
      kind: doc.frontmatter.kind ?? null,
      author: doc.frontmatter.author ?? null,
      capturedAt,
      ageDays: Math.round(ageDays * 10) / 10,
      status: doc.frontmatter.status ?? "unreviewed",
      score: base * 2 ** (-ageDays / 7), // true 7-day half-life
      snippet: makeSnippet(doc.body, tokens),
      layer: doc.layer,
    });
  }

  return rows
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Number(limit) || 10);
}
