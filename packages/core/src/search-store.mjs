// A SQLite-backed, on-disk BM25F posting store: the same ranking as
// searchConcepts (search.mjs) / createSearchIndex (search-index.mjs), answered
// from disk instead of the JS heap.
//
// Why this exists on top of search-index.mjs, which already makes repeated
// queries cheap: that index still holds one frequency Map per field per
// document, live, for as long as it is warm — corpus-scale JS heap that a
// process restart pays again from zero (re-walk, re-parse, re-stem a 50k-doc
// vault). This module persists the postings themselves, so (1) a restarted
// engine or a freshly spawned stdio MCP process answers instantly without a
// cold re-parse, and (2) no per-document term map has to live in the JS heap
// at all — SQLite owns that memory, on disk.
//
// BIT-IDENTICAL BY CONSTRUCTION, same discipline as search-index.mjs:
//   - per-document analysis is search.mjs's own analyzeConceptFields, so terms,
//     stemming, and per-field lengths match exactly;
//   - corpus statistics (document frequency, per-field length totals, document
//     count) are maintained by integer add/subtract as documents enter and
//     leave the store — integer arithmetic is order-independent, so the
//     maintained values equal a fresh build's exactly;
//   - candidate documents are reconstructed into the exact `entry.fields` shape
//     scoreEntry expects, and scoreEntry itself (imported, not reimplemented)
//     does the arithmetic;
//   - enumeration replicates collectDocuments order: contributing layers in
//     order, documents in snapshot (`ord`) order within a layer — the
//     best-layer merge keeps the FIRST layer's row on equal scores, so order
//     is part of the ranking contract, exactly as in search-index.mjs.
// search-store.test.mjs holds Object.is equality against searchConcepts AND
// createSearchIndex under randomized mutation, plus restart/identity/eviction
// scenarios specific to durability.
//
// Nothing per-document is retained in the JS heap between searches — only
// prepared statements on the instance. Every sync (the "bring the store in
// line with `contributing`" pass that runs at the start of every search, like
// update() in search-index.mjs) happens inside one transaction, so two engine
// processes sharing one file (the app and a stdio MCP process) can never see a
// half-applied sync; the worst race outcome is redundant re-analysis, never a
// wrong answer.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  analyze, analyzeConceptFields, conceptBody, makeSnippet, scoreEntry, tokenizeQuery, FIELD_COUNT,
} from "./search.mjs";
import { mergeConcepts, orderContributors } from "./resolver.mjs";

const FORMAT_VERSION = 1;

// node:sqlite is a recent built-in (Node >= 22.13; present in Node 26 here and
// in Electron 43's Node 24) and this engine otherwise supports older
// runtimes, so the require itself must not throw at import time — a
// createRequire + try/catch resolves it once, synchronously, so
// isSearchStoreAvailable/createSearchStore need no async ceremony to answer.
const require = createRequire(import.meta.url);
let sqliteModule = null;
let probeError = null;
try {
  sqliteModule = require("node:sqlite");
} catch (error) {
  probeError = error;
}

/** True iff node:sqlite loaded in this runtime. */
export function isSearchStoreAvailable() {
  return Boolean(sqliteModule);
}

function contentFingerprint(id, concept) {
  const body = conceptBody(concept);
  const basis = JSON.stringify([
    concept.frontmatter?.title ?? null,
    concept.frontmatter?.description ?? null,
    concept.frontmatter?.tags ?? null,
    body,
  ]);
  return `c:${createHash("sha256").update(basis).digest("hex")}`;
}

function fingerprintFor(view, id, concept) {
  const meta = view.fileMeta?.get(id);
  if (meta) {
    return JSON.stringify([meta.rel, meta.ext, meta.size, meta.mtimeMs, meta.authoredDate ?? null]);
  }
  return contentFingerprint(id, concept);
}

function randomToken() {
  return createHash("sha256").update(String(Math.random())).update(String(Date.now())).update(String(process.pid)).digest("hex").slice(0, 16);
}

/**
 * Open (or create) a SQLite-backed BM25F posting store.
 *
 * `file`: absolute path, or ":memory:" for a process-local store.
 * `idleEvictMs`: accepted for API symmetry with createSearchIndex. This store
 * keeps no corpus-scale state in the JS heap between searches — only the
 * open database handle and prepared statements, which are cheap to hold — so
 * there is nothing profitable to evict on a timer. Accepted and ignored.
 */
export function createSearchStore({ file, idleEvictMs } = {}) {
  if (!sqliteModule) {
    throw new Error(
      "search-store requires node:sqlite, which failed to load in this runtime"
      + (probeError ? `: ${probeError.message}` : " (call isSearchStoreAvailable() first)"),
    );
  }
  void idleEvictMs; // see doc comment above

  const { DatabaseSync } = sqliteModule;
  const db = new DatabaseSync(file ?? ":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA temp_store = MEMORY");

  function tablesExist() {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    return Boolean(row);
  }

  function createSchema() {
    db.exec(`
      DROP TABLE IF EXISTS meta;
      DROP TABLE IF EXISTS layers;
      DROP TABLE IF EXISTS docs;
      DROP TABLE IF EXISTS postings;
      DROP TABLE IF EXISTS terms;

      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE layers(
        name TEXT PRIMARY KEY,
        identity TEXT,
        level INTEGER,
        gen INTEGER,
        proc TEXT
      );
      CREATE TABLE docs(
        doc INTEGER PRIMARY KEY,
        layer TEXT NOT NULL,
        id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        fp TEXT NOT NULL,
        title TEXT,
        frontmatter TEXT NOT NULL,
        body TEXT NOT NULL,
        len0 INTEGER, len1 INTEGER, len2 INTEGER, len3 INTEGER, len4 INTEGER,
        UNIQUE(layer, id)
      );
      CREATE TABLE postings(
        term TEXT NOT NULL,
        doc INTEGER NOT NULL,
        field INTEGER NOT NULL,
        tf INTEGER NOT NULL,
        PRIMARY KEY(term, doc, field)
      ) WITHOUT ROWID;
      CREATE INDEX postings_doc ON postings(doc);
      CREATE TABLE terms(term TEXT PRIMARY KEY, df INTEGER NOT NULL);
    `);
    db.prepare("INSERT INTO meta(key, value) VALUES ('format', ?)").run(String(FORMAT_VERSION));
  }

  function ensureSchema() {
    if (!tablesExist()) {
      createSchema();
      return;
    }
    const row = db.prepare("SELECT value FROM meta WHERE key = 'format'").get();
    if (!row || row.value !== String(FORMAT_VERSION)) createSchema();
  }

  ensureSchema();

  // This instance's identity for the "gen unchanged -> skip" fast path: a gen
  // number is only meaningful within the process that minted it (search-index.
  // mjs's own comment on why: gen is a per-process counter). A store reopened
  // on the same file must not trust a stale proc's gen numbers.
  const proc = randomToken();

  let closed = false;
  let analyzedCount = 0; // documents (re-)analyzed by THIS instance since open
  let bodyReadCount = 0; // `body` column reads by THIS instance since open — bounded by hit count per search, never corpus size

  // ---- prepared statements, cached on the instance -------------------------
  const stmts = {
    getLayer: db.prepare("SELECT identity, level, gen, proc FROM layers WHERE name = ?"),
    upsertLayer: db.prepare(
      "INSERT INTO layers(name, identity, level, gen, proc) VALUES (?, ?, ?, ?, ?) "
      + "ON CONFLICT(name) DO UPDATE SET identity = excluded.identity, level = excluded.level, "
      + "gen = excluded.gen, proc = excluded.proc",
    ),
    updateLayerLevel: db.prepare("UPDATE layers SET level = ? WHERE name = ?"),
    deleteLayer: db.prepare("DELETE FROM layers WHERE name = ?"),
    allLayerNames: db.prepare("SELECT name FROM layers"),
    docsForLayer: db.prepare("SELECT doc, id, fp, ord FROM docs WHERE layer = ?"),
    docTermsFor: db.prepare("SELECT DISTINCT term FROM postings WHERE doc = ?"),
    deletePostingsForDoc: db.prepare("DELETE FROM postings WHERE doc = ?"),
    deleteDoc: db.prepare("DELETE FROM docs WHERE doc = ?"),
    updateDocOrd: db.prepare("UPDATE docs SET ord = ? WHERE doc = ?"),
    insertDoc: db.prepare(
      "INSERT INTO docs(layer, id, ord, fp, title, frontmatter, body, len0, len1, len2, len3, len4) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    insertPosting: db.prepare("INSERT INTO postings(term, doc, field, tf) VALUES (?, ?, ?, ?)"),
    bumpTermUp: db.prepare(
      "INSERT INTO terms(term, df) VALUES (?, 1) ON CONFLICT(term) DO UPDATE SET df = df + 1",
    ),
    bumpTermDown: db.prepare("UPDATE terms SET df = df - 1 WHERE term = ?"),
    deleteZeroTerm: db.prepare("DELETE FROM terms WHERE term = ? AND df <= 0"),
    termDf: db.prepare("SELECT df FROM terms WHERE term = ?"),
    countDocs: db.prepare("SELECT COUNT(*) AS n FROM docs"),
    sumLens: db.prepare("SELECT SUM(len0) AS s0, SUM(len1) AS s1, SUM(len2) AS s2, SUM(len3) AS s3, SUM(len4) AS s4 FROM docs"),
    postingsForTerm: db.prepare("SELECT doc, field, tf FROM postings WHERE term = ?"),
    docRow: db.prepare("SELECT doc, layer, id, ord, title, frontmatter, body, len0, len1, len2, len3, len4 FROM docs WHERE doc = ?"),
    docByLayerId: db.prepare("SELECT frontmatter FROM docs WHERE layer = ? AND id = ?"),
    bodyForDoc: db.prepare("SELECT body FROM docs WHERE doc = ?"),
  };

  // SQLite's default host-parameter ceiling (SQLITE_MAX_VARIABLE_NUMBER) is
  // 32766 on recent builds but as low as 999 on older ones; chunk well under
  // either so a batched IN(...) query never risks "too many SQL variables".
  const IN_CHUNK = 500;

  /** Rows for exactly the given doc ids, batched, WITHOUT the body column. */
  function docsByIds(ids) {
    const arr = [...ids];
    const rows = [];
    for (let i = 0; i < arr.length; i += IN_CHUNK) {
      const chunk = arr.slice(i, i + IN_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const stmt = db.prepare(
        `SELECT doc, layer, id, ord, title, len0, len1, len2, len3, len4 FROM docs WHERE doc IN (${placeholders})`,
      );
      rows.push(...stmt.all(...chunk));
    }
    return rows;
  }

  /** Which of `ids` (a set/array of concept ids) belong to layer `layerName`, batched. */
  function idsInLayer(layerName, ids) {
    const arr = [...ids];
    const found = new Set();
    for (let i = 0; i < arr.length; i += IN_CHUNK) {
      const chunk = arr.slice(i, i + IN_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const stmt = db.prepare(`SELECT id FROM docs WHERE layer = ? AND id IN (${placeholders})`);
      for (const row of stmt.all(layerName, ...chunk)) found.add(row.id);
    }
    return found;
  }

  function removeDoc(doc) {
    const terms = stmts.docTermsFor.all(doc);
    for (const { term } of terms) {
      stmts.bumpTermDown.run(term);
      stmts.deleteZeroTerm.run(term);
    }
    stmts.deletePostingsForDoc.run(doc);
    stmts.deleteDoc.run(doc);
  }

  function insertDocWithPostings(layerName, id, ord, fp, concept) {
    const fields = analyzeConceptFields(id, concept);
    analyzedCount += 1;
    const lens = fields.map((f) => f.length);
    const result = stmts.insertDoc.run(
      layerName, id, ord, fp,
      concept.frontmatter?.title ?? null,
      JSON.stringify(concept.frontmatter ?? {}),
      conceptBody(concept),
      lens[0] ?? 0, lens[1] ?? 0, lens[2] ?? 0, lens[3] ?? 0, lens[4] ?? 0,
    );
    const doc = result.lastInsertRowid;
    const seen = new Set();
    for (let field = 0; field < fields.length; field += 1) {
      for (const [term, tf] of fields[field].frequencies) {
        stmts.insertPosting.run(term, doc, field, tf);
        seen.add(term);
      }
    }
    for (const term of seen) stmts.bumpTermUp.run(term);
    return doc;
  }

  function syncLayer(view) {
    const identity = view.identity ?? null;
    const existingLayer = stmts.getLayer.get(view.name);
    if (
      existingLayer
      && existingLayer.identity === identity
      && existingLayer.gen === view.gen
      && existingLayer.proc === proc
    ) {
      // gen unchanged under THIS instance's proc token: nothing moved.
      stmts.updateLayerLevel.run(view.level ?? 0, view.name);
      return;
    }

    const identityChanged = Boolean(existingLayer) && existingLayer.identity !== identity;
    const existingDocs = new Map();
    for (const row of stmts.docsForLayer.all(view.name)) existingDocs.set(row.id, row);

    const seen = new Set();
    let ord = 0;
    for (const id of view.ids) {
      const concept = view.concepts.get(id);
      // fingerprintFor only touches `concept` on its content-hash fallback
      // (no fileMeta for this id); when a fingerprint IS available from meta
      // it never dereferences `concept`, so a missing concept is safe there.
      const fp = concept
        ? fingerprintFor(view, id, concept)
        : (view.fileMeta?.get(id) ? fingerprintFor(view, id, null) : null);
      const existing = existingDocs.get(id);

      if (fp !== null && existing && !identityChanged && existing.fp === fp) {
        // Fingerprint unchanged: keep the stored document as-is, whether or
        // not `concept` was supplied. This is what lets a caller that only
        // loaded PENDING ids (see pending()) sync a view holding just those
        // few parsed concepts — every other id's stored posting rows are
        // still known-correct and need no concept to confirm that.
        seen.add(id);
        if (existing.ord !== ord) stmts.updateDocOrd.run(ord, existing.doc);
        ord += 1;
        continue;
      }
      if (!concept) {
        // No usable fingerprint match, and nothing to (re)analyze with:
        // either this id is genuinely unloadable (collectDocuments-style
        // skip — the original behavior, preserved bit-for-bit: not counted
        // in `seen`, `ord` does not advance) or a partial-view caller failed
        // to load an id pending() told it had changed. Either way, an
        // existing stale row for it is removed by the "not seen" sweep
        // below rather than served without verification.
        continue;
      }
      seen.add(id);
      if (existing) removeDoc(existing.doc);
      insertDocWithPostings(view.name, id, ord, fp, concept);
      ord += 1;
    }
    for (const [id, existing] of existingDocs) {
      if (!seen.has(id)) removeDoc(existing.doc);
    }

    stmts.upsertLayer.run(view.name, identity, view.level ?? 0, view.gen, proc);
  }

  function sync(contributing) {
    db.exec("BEGIN");
    try {
      const wanted = new Set(contributing.map((view) => view.name));
      for (const view of contributing) syncLayer(view);
      for (const { name } of stmts.allLayerNames.all()) {
        if (!wanted.has(name)) {
          for (const row of stmts.docsForLayer.all(name)) removeDoc(row.doc);
          stmts.deleteLayer.run(name);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function corpusStats(terms) {
    const { n } = stmts.countDocs.get();
    const sums = stmts.sumLens.get();
    const averageLength = [sums.s0, sums.s1, sums.s2, sums.s3, sums.s4].map(
      (sum) => (n ? (sum ?? 0) / n : 0),
    );
    const documentFrequency = new Map();
    for (const term of terms) {
      const row = stmts.termDf.get(term);
      documentFrequency.set(term, row ? row.df : 0);
    }
    return { total: n, averageLength, documentFrequency };
  }

  // doc -> { fields: [{frequencies, length}] } for scoreEntry, built ONLY for
  // documents that have at least one posting among the query terms — the
  // per-doc structures are transient, discarded after this search() call.
  function buildCandidates(terms) {
    const candidates = new Map(); // doc -> fields[]
    for (const term of terms) {
      for (const { doc, field, tf } of stmts.postingsForTerm.all(term)) {
        let fields = candidates.get(doc);
        if (!fields) {
          fields = Array.from({ length: FIELD_COUNT }, () => ({ frequencies: new Map(), length: 0 }));
          candidates.set(doc, fields);
        }
        fields[field].frequencies.set(term, tf);
      }
    }
    return candidates;
  }

  function levelOrderer(contributing) {
    const levelByName = new Map(contributing.map((view) => [view.name, view.level]));
    return (names) => [...new Set(names)].sort((a, b) => (levelByName.get(b) ?? 0) - (levelByName.get(a) ?? 0));
  }

  /**
   * Which ids in `view` (name, identity, ids, optional fileMeta — NO concepts
   * required) the store does not yet have a matching fingerprint for. A
   * caller (createRetainedSearch) uses this to load only the documents that
   * actually need re-analysis, instead of every document in the source.
   *
   * A view with no `fileMeta` at all (a remote/unfingerprinted source) has no
   * way to prove any id unchanged without reading it, so every id is pending
   * — matching search()/sync()'s own fallback (content-hash fingerprinting
   * needs the concept in hand).
   */
  function pending(view) {
    const identity = view.identity ?? null;
    const existingLayer = stmts.getLayer.get(view.name);
    const identityChanged = Boolean(existingLayer) && existingLayer.identity !== identity;
    const existingDocs = new Map();
    for (const row of stmts.docsForLayer.all(view.name)) existingDocs.set(row.id, row);

    const result = [];
    for (const id of view.ids) {
      if (!view.fileMeta) { result.push(id); continue; }
      const meta = view.fileMeta.get(id);
      const existing = existingDocs.get(id);
      if (identityChanged || !existing || !meta) { result.push(id); continue; }
      const fp = JSON.stringify([meta.rel, meta.ext, meta.size, meta.mtimeMs, meta.authoredDate ?? null]);
      if (existing.fp !== fp) result.push(id);
    }
    return result;
  }

  function typeOf(contributing, id) {
    const contributors = [];
    for (const view of contributing) {
      const row = stmts.docByLayerId.get(view.name, id);
      if (!row) continue;
      const frontmatter = JSON.parse(row.frontmatter);
      contributors.push({ layer: view.name, level: view.level, updated: frontmatter.updated ?? null, frontmatter, sections: [] });
    }
    return mergeConcepts(orderContributors(contributors)).frontmatter.type ?? "concept";
  }

  return {
    search(contributing, { query, limit = 10, source, type } = {}) {
      const rawTokens = tokenizeQuery(query);
      if (!query || typeof query !== "string" || rawTokens.length === 0) {
        throw new Error("search requires a non-empty query string with at least one searchable token");
      }
      sync(contributing);
      const terms = [...new Set(analyze(query))];
      const orderLayerNames = levelOrderer(contributing);
      const index = corpusStats(terms);

      // Candidate docs: exactly those with at least one posting among the
      // query terms. A doc outside this set has zero matching term frequency
      // in every field, so scoreEntry would score it 0 and it would be
      // filtered anyway — restricting enumeration to candidates cannot change
      // which hits are returned, only how much of the corpus we touch to
      // find out. This is the fix for the full-corpus-per-query cost: no
      // `body` (or any other column) is read for a non-candidate document,
      // ever.
      const candidates = buildCandidates(terms);
      if (candidates.size === 0) return [];

      const rowsByDoc = new Map();
      for (const row of docsByIds(candidates.keys())) rowsByDoc.set(row.doc, row);

      // source filter: which of the CANDIDATE ids belong to that named layer,
      // right now — never a full listing of the layer.
      let sourceIdSet = null;
      if (source) {
        const layerRow = stmts.getLayer.get(source);
        if (!layerRow) return [];
        const candidateIds = new Set([...rowsByDoc.values()].map((row) => row.id));
        sourceIdSet = idsInLayer(source, candidateIds);
      }

      // Enumeration order must match the ranking contract exactly: layers in
      // contributing order, `ord` within a layer (search-index.mjs's own
      // best-layer-wins-ties rule keeps the FIRST layer's row on equal
      // score). Sorting candidate rows into that order once replicates the
      // old nested "for each view, for each row" walk.
      const viewIndexByName = new Map(contributing.map((view, i) => [view.name, i]));
      const orderedRows = [...rowsByDoc.values()]
        .filter((row) => viewIndexByName.has(row.layer))
        .sort((a, b) => {
          const ai = viewIndexByName.get(a.layer);
          const bi = viewIndexByName.get(b.layer);
          return ai !== bi ? ai - bi : a.ord - b.ord;
        });

      const byId = new Map();
      for (const row of orderedRows) {
        if (sourceIdSet && !sourceIdSet.has(row.id)) continue;
        const fields = candidates.get(row.doc);
        const entry = {
          fields: fields.map((f, i) => ({
            frequencies: f.frequencies,
            length: [row.len0, row.len1, row.len2, row.len3, row.len4][i],
          })),
        };
        const score = scoreEntry(index, entry, terms);
        if (score <= 0) continue;
        const view = contributing[viewIndexByName.get(row.layer)];
        const title = row.title ?? null;
        const existing = byId.get(row.id);
        if (!existing) {
          byId.set(row.id, {
            id: row.id, title, score, layers: [view.name], doc: row.doc,
          });
        } else {
          if (score > existing.score) {
            existing.score = score;
            existing.doc = row.doc;
          }
          existing.layers.push(view.name);
          if (!existing.title) existing.title = title;
        }
      }

      let hits = [...byId.values()];
      if (type) hits = hits.filter((hit) => typeOf(contributing, hit.id) === type);

      // `body` is fetched only for the documents that survive ranking AND the
      // limit cut — one row read per returned hit, never per corpus document.
      return hits
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, Number(limit) || 10)
        .map(({ doc, ...hit }) => {
          const { body } = stmts.bodyForDoc.get(doc);
          bodyReadCount += 1;
          return {
            ...hit,
            snippet: makeSnippet(body, rawTokens),
            layers: orderLayerNames(hit.layers),
          };
        });
    },

    pending,

    close() {
      // Idempotent: unlike DatabaseSync itself (which throws on a second
      // close), createSearchIndex().close() tolerates repeat calls, and
      // callers (service.mjs's close(), test cleanup that closes both a
      // service and its own captured handle) rely on that symmetry.
      if (closed) return;
      closed = true;
      db.close();
    },

    inspect() {
      const { n: documents } = stmts.countDocs.get();
      const { n: terms } = db.prepare("SELECT COUNT(*) AS n FROM terms").get();
      const { n: postings } = db.prepare("SELECT COUNT(*) AS n FROM postings").get();
      return {
        documents, terms, postings, analyzed: analyzedCount, bodyReads: bodyReadCount,
      };
    },
  };
}
