// Retrieval over a cascade of layer sources: the ranking behind the `search`
// and `find_captures` MCP tools.
//
// This lives outside mcp-server.mjs on purpose. That module parses argv and can
// call process.exit() at load time, so it cannot be imported — which meant the
// ranking had no way to be measured. The eval harness in packages/core/eval/
// scores this module directly against a golden question set; change the ranking
// and re-run it before believing the change helped.
//
// Not to be confused with tokenize.mjs, which is the BPE tokenizer used for
// context-budget accounting. The analyzer here is a query analyzer.

import { stem } from "./stem.mjs";
import { sectionText } from "./sections.mjs";
import { conceptLinkTargets } from "./markdown-links.mjs";

const DAY_MS = 86400000;
const WORD = /[a-z0-9_-]+/g;

// BM25F. Per-field boosts say where a match counts for more; per-field `b` says
// how hard to punish length. Body gets the standard 0.75 because a long
// document should not outrank a precise one merely by repeating a word; the
// short identifying fields get less, since their length carries no signal.
const FIELDS = [
  { key: "id", boost: 3, b: 0.4 },
  { key: "title", boost: 5, b: 0.4 },
  { key: "description", boost: 3, b: 0.5 },
  { key: "tags", boost: 2, b: 0.4 },
  { key: "body", boost: 1, b: 0.75 },
];
const K1 = 1.2;
// The field arity, exported for the incremental index's stat arrays.
export const FIELD_COUNT = FIELDS.length;

// Raw query words, kept unstemmed for snippet highlighting — a snippet has to
// point at text the reader can actually see.
export function tokenizeQuery(query) {
  return query.toLowerCase().match(WORD) ?? [];
}

// Index terms. Hyphenated compounds also contribute their parts so that
// "exactly-once" is reachable from "exactly once" and the reverse.
export function analyze(text) {
  const terms = [];
  for (const token of String(text).toLowerCase().match(WORD) ?? []) {
    terms.push(stem(token));
    if (token.includes("-")) {
      for (const part of token.split("-")) if (part) terms.push(stem(part));
    }
  }
  return terms;
}

function requireTokens(query, tool) {
  if (!query || typeof query !== "string") throw new Error(`${tool} requires a non-empty query string`);
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) throw new Error(`${tool} query must contain at least one searchable token`);
  return tokens;
}

// One I/O pass over the cascade. Indexing and scoring happen in memory over the
// returned array, so the extra passes cost nothing on top of the walk.
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
        body: sections.map((section) => sectionText(section)).join("\n"),
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

/** A concept's body exactly as collectDocuments concatenates it. */
export function conceptBody(concept) {
  return concept.sections.map((section) => sectionText(section)).join("\n");
}

/**
 * The per-document half of buildIndex for a concept, exposed so the
 * incremental index (search-index.mjs) analyzes a document with EXACTLY the
 * arithmetic searchConcepts uses — same analyze(), same field order, same
 * integer lengths. Bit-identical ranking depends on this staying shared.
 */
export function analyzeConceptFields(id, concept) {
  const values = [
    id,
    concept.frontmatter.title ?? "",
    concept.frontmatter.description ?? "",
    String(concept.frontmatter.tags ?? ""),
    conceptBody(concept),
  ];
  return values.map((value) => {
    const terms = analyze(value);
    const frequencies = new Map();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    return { frequencies, length: terms.length };
  });
}

function captureFields(doc) {
  // Captures carry no description or tags; keeping the arity fixed keeps the
  // positional boosts aligned with concept scoring.
  return [doc.id, doc.frontmatter.title ?? "", "", "", doc.body];
}

// ---- BM25F -----------------------------------------------------------------

function buildIndex(docs, fieldsOf) {
  const fieldTotals = FIELDS.map(() => 0);
  const entries = docs.map((doc) => {
    const fields = fieldsOf(doc).map((value, index) => {
      const terms = analyze(value);
      fieldTotals[index] += terms.length;
      const frequencies = new Map();
      for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      return { frequencies, length: terms.length };
    });
    return { doc, fields };
  });

  const documentFrequency = new Map();
  for (const entry of entries) {
    const seen = new Set();
    for (const field of entry.fields) for (const term of field.frequencies.keys()) seen.add(term);
    for (const term of seen) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  return {
    total: entries.length,
    averageLength: fieldTotals.map((sum) => (entries.length ? sum / entries.length : 0)),
    documentFrequency,
    entries,
  };
}

// This IDF form stays positive even for a term that appears in most documents,
// which matters here: the alternative goes negative past df > N/2 and lets a
// common word actively push a document down the list.
function inverseDocumentFrequency(index, term) {
  const df = index.documentFrequency.get(term) ?? 0;
  if (df === 0) return 0;
  return Math.log(1 + (index.total - df + 0.5) / (df + 0.5));
}

export function scoreEntry(index, entry, terms) {
  let score = 0;
  for (const term of terms) {
    const idf = inverseDocumentFrequency(index, term);
    if (idf === 0) continue;

    // Accumulate length-normalized frequency across fields first, then saturate
    // once. Saturating per field would let a term in five fields outscore the
    // same term used meaningfully in one.
    let weighted = 0;
    for (let position = 0; position < FIELDS.length; position += 1) {
      const field = entry.fields[position];
      const frequency = field.frequencies.get(term);
      if (!frequency) continue;
      const { boost, b } = FIELDS[position];
      const average = index.averageLength[position] || 1;
      weighted += (boost * frequency) / (1 - b + b * (field.length / average));
    }
    if (weighted > 0) score += (idf * weighted) / (K1 + weighted);
  }
  return score;
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

// ---- inbound-link prior -----------------------------------------------------
//
// A static hub-vs-leaf signal: a concept six other concepts link to should not
// lose to a lexically similar concept nothing links to. Weight is log-damped
// (Math.log1p) on purpose — a concept with 50 inbound links must not run away
// from one with 6; the prior nudges a close lexical race, it does not decide
// questions BM25F already answers decisively. Tuned against eval questions
// q39-q42 (packages/core/eval/questions.json) — see docs/architecture/notes/
// link-prior.md for the weight sweep and why 0.3 (the top of the allowed
// [0.05, 0.3] range) was kept: q39/q41 need it to overtake the leaf, and the
// eval's aggregate numbers do not regress at this weight.
export const LINK_PRIOR_WEIGHT = 0.1;

/** The exact multiplier applied to a concept's bm25f score. Exported so the
 * incremental index and the SQLite store apply IDENTICAL arithmetic in the
 * identical operand order — Object.is equality depends on it. */
export function linkPriorMultiplier(inbound) {
  return 1 + LINK_PRIOR_WEIGHT * Math.log1p(inbound);
}

/**
 * distinctInboundCounts(docs, layerNames) -> { inbound: Map<id, number>, targetsByDoc: Map<doc, string[]> }
 *
 * `inbound.get(id)` is the number of DISTINCT concept ids (across all
 * contributing layers, any layer's body) whose body links to `id`. Self-links
 * never count, and a link to an id outside the corpus counts for nothing (no
 * document to boost). `targetsByDoc.get(doc)` is that doc's own deduped,
 * normalized, corpus-existing outgoing targets, in document order — reused
 * for a hit's `linksTo` so the neighborhood is computed once per search, not
 * twice.
 */
function distinctInboundCounts(docs, layerNames) {
  const corpusIds = new Set(docs.map((doc) => doc.id));
  const targetsByDoc = new Map();
  const sourcesByTarget = new Map(); // target id -> Set of distinct source concept ids
  for (const doc of docs) {
    const targets = conceptLinkTargets(doc.body, doc.id, layerNames)
      .filter((target) => target !== doc.id && corpusIds.has(target));
    targetsByDoc.set(doc, targets);
    for (const target of targets) {
      let sources = sourcesByTarget.get(target);
      if (!sources) {
        sources = new Set();
        sourcesByTarget.set(target, sources);
      }
      sources.add(doc.id);
    }
  }
  const inbound = new Map();
  for (const [target, sources] of sourcesByTarget) inbound.set(target, sources.size);
  return { inbound, targetsByDoc };
}

const LINKS_TO_CAP = 3; // hits beyond this rank omit linksTo
const LINKS_TO_MAX = 5; // linksTo is capped at this many targets

export async function searchConcepts(layers, { query, limit = 10 }) {
  const rawTokens = requireTokens(query, "search");
  const terms = [...new Set(analyze(query))];
  const orderLayerNames = layerOrderer(layers);
  const layerNames = new Set(layers.map((layer) => layer.name));

  const docs = await collectDocuments(layers);
  const index = buildIndex(docs, conceptFields);
  const { inbound, targetsByDoc } = distinctInboundCounts(docs, layerNames);

  const byId = new Map();
  for (const entry of index.entries) {
    const score = scoreEntry(index, entry, terms);
    if (score <= 0) continue;
    const { doc } = entry;

    const existing = byId.get(doc.id);
    if (!existing) {
      byId.set(doc.id, {
        id: doc.id,
        title: doc.frontmatter.title ?? null,
        score,
        layers: [doc.layer],
        snippet: makeSnippet(doc.body, rawTokens),
        winningDoc: doc,
      });
    } else {
      // Best layer wins rather than the sum. Summing made a concept that three
      // layers happen to mention outrank the one document that answers the
      // question — the cascade's whole point is that those three are one
      // concept, so they should not vote three times.
      if (score > existing.score) {
        existing.score = score;
        existing.snippet = makeSnippet(doc.body, rawTokens);
        existing.winningDoc = doc;
      }
      existing.layers.push(doc.layer);
      if (!existing.title) existing.title = doc.frontmatter.title ?? null;
    }
  }

  // The prior is per CONCEPT, not per layer contribution — applied once here,
  // after the best-layer merge, before the sort.
  for (const entry of byId.values()) {
    entry.inbound = inbound.get(entry.id) ?? 0;
    entry.score *= linkPriorMultiplier(entry.inbound);
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Number(limit) || 10)
    .map((entry, rank) => {
      const { winningDoc, ...hit } = entry;
      const result = { ...hit, layers: orderLayerNames(entry.layers) };
      if (rank < LINKS_TO_CAP) {
        result.linksTo = (targetsByDoc.get(winningDoc) ?? []).slice(0, LINKS_TO_MAX);
      }
      return result;
    });
}

export async function searchCaptures(layers, { query, kinds = null, limit = 10, now = Date.now() }) {
  const rawTokens = requireTokens(query, "find_captures");
  const terms = [...new Set(analyze(query))];

  const docs = await collectDocuments(layers, { prefix: "captures/" });
  const eligible = kinds ? docs.filter((doc) => kinds.includes(doc.frontmatter.kind)) : docs;
  const index = buildIndex(eligible, captureFields);

  const rows = [];
  for (const entry of index.entries) {
    const base = scoreEntry(index, entry, terms);
    if (base <= 0) continue;
    const { doc } = entry;

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
      snippet: makeSnippet(doc.body, rawTokens),
      layer: doc.layer,
    });
  }

  return rows
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Number(limit) || 10);
}
