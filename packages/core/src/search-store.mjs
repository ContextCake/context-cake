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
  analyze, analyzeConceptFields, conceptBody, makeSnippet, scoreEntry, tokenizeQuery, FIXED_FIELD_COUNT,
  linkPriorMultiplier,
} from "./search.mjs";
import { sectionText } from "./sections.mjs";
import { conceptLinkTargets } from "./markdown-links.mjs";
import { mergeConcepts, orderContributors } from "./resolver.mjs";

// Bumped for the `sections`/`section_postings` tables (section-level body
// scoring, mirroring search.mjs's scoreConceptSections): a store built under
// an earlier FORMAT_VERSION has no per-section postings, so any pre-existing
// file rebuilds from scratch rather than silently scoring the whole body as
// section 0.
const FORMAT_VERSION = 3;
// A section field's contribution to scoreEntry when a section has no query
// term matches at all: {frequencies: empty, length: irrelevant} — the SAME
// object works for any unmatched section because an empty frequency map
// contributes 0 regardless of `length` (scoreEntry only reads `length` when
// `frequencies.get(term)` is truthy). This is what lets buildCandidates skip
// enumerating a document's non-matching sections entirely: their score is
// this baseline, provably true for every candidate document (see the header
// comment on scoreBestSection).
const EMPTY_SECTION_FIELD = { frequencies: new Map(), length: 0 };
const LINKS_TO_CAP = 3;
const LINKS_TO_MAX = 5;

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
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA temp_store = MEMORY");

  // Two processes cold-starting on the same brand-new store file can both
  // reach schema creation at once; WAL's busy_timeout does not cover DDL lock
  // contention on a file that has no WAL mode yet. Bounded retry with a
  // synchronous sleep (Atomics.wait — this API is synchronous end to end, so
  // there is no async ceremony available) turns "one process throws and
  // permanently falls back to the in-memory index" into "one process waits a
  // few tens of milliseconds for the other's DDL transaction to commit."
  function sleepSync(ms) {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
  }

  function isBusyError(error) {
    return /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(error?.message ?? "");
  }

  function withBusyRetry(fn) {
    const MAX_ATTEMPTS = 10;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return fn();
      } catch (error) {
        if (!isBusyError(error) || attempt === MAX_ATTEMPTS) throw error;
        sleepSync(Math.min(20 * attempt, 200));
      }
    }
    return undefined; // unreachable — the loop above always returns or throws
  }

  function tablesExist() {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    return Boolean(row);
  }

  function createSchema() {
    db.exec(`
      DROP TABLE IF EXISTS meta;
      DROP TABLE IF EXISTS layers;
      DROP TABLE IF EXISTS docs;
      DROP TABLE IF EXISTS sections;
      DROP TABLE IF EXISTS postings;
      DROP TABLE IF EXISTS section_postings;
      DROP TABLE IF EXISTS terms;
      DROP TABLE IF EXISTS links;

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
        len0 INTEGER, len1 INTEGER, len2 INTEGER, len3 INTEGER,
        UNIQUE(layer, id)
      );
      -- One row per concept.sections element (or one synthetic empty section
      -- for a zero-section concept, matching analyzeConceptFields exactly).
      -- text is the raw section text, kept ONLY so a winning section's
      -- snippet can be built without re-reading the whole document.
      CREATE TABLE sections(
        doc INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        key TEXT,
        heading TEXT,
        text TEXT NOT NULL,
        length INTEGER NOT NULL,
        PRIMARY KEY(doc, idx)
      ) WITHOUT ROWID;
      -- Fixed per-concept fields only: id/title/description/tags (positions
      -- 0-3). Body postings live in section_postings, one row per section,
      -- since a term's frequency must be scored PER SECTION, not summed
      -- across a document's sections.
      CREATE TABLE postings(
        term TEXT NOT NULL,
        doc INTEGER NOT NULL,
        field INTEGER NOT NULL,
        tf INTEGER NOT NULL,
        PRIMARY KEY(term, doc, field)
      ) WITHOUT ROWID;
      CREATE INDEX postings_doc ON postings(doc);
      CREATE TABLE section_postings(
        term TEXT NOT NULL,
        doc INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        tf INTEGER NOT NULL,
        PRIMARY KEY(term, doc, idx)
      ) WITHOUT ROWID;
      CREATE INDEX section_postings_doc ON section_postings(doc);
      -- df counts DISTINCT DOCUMENTS containing a term in ANY field or ANY
      -- section (buildConceptIndex's own dedup-per-doc rule) — bumped once
      -- per doc regardless of how many fields/sections mention the term.
      CREATE TABLE terms(term TEXT PRIMARY KEY, df INTEGER NOT NULL);
      CREATE TABLE links(
        doc INTEGER NOT NULL,
        ord INTEGER NOT NULL,
        target TEXT NOT NULL
      );
      CREATE INDEX links_target ON links(target);
      CREATE INDEX links_doc ON links(doc);
    `);
    db.prepare("INSERT INTO meta(key, value) VALUES ('format', ?)").run(String(FORMAT_VERSION));
  }

  function ensureSchema() {
    // BEGIN IMMEDIATE grabs the write lock before any read, so a concurrent
    // opener that loses the race sees SQLITE_BUSY here (caught by
    // withBusyRetry) rather than a half-created schema. tablesExist() and the
    // format check are re-run INSIDE the lock — a process that lost the race
    // and retried finds the winner's schema already in place and does
    // nothing, rather than dropping and recreating it a second time.
    withBusyRetry(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!tablesExist()) {
          createSchema();
        } else {
          const row = db.prepare("SELECT value FROM meta WHERE key = 'format'").get();
          if (!row || row.value !== String(FORMAT_VERSION)) createSchema();
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  ensureSchema();
  // Set only after schema creation has committed — WAL mode itself can throw
  // busy on a fresh file under the same cross-process race ensureSchema
  // guards against, so it gets the same bounded retry.
  withBusyRetry(() => db.exec("PRAGMA journal_mode = WAL"));

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
    docTermsFor: db.prepare(
      "SELECT term FROM postings WHERE doc = ? UNION SELECT term FROM section_postings WHERE doc = ?",
    ),
    deletePostingsForDoc: db.prepare("DELETE FROM postings WHERE doc = ?"),
    deleteSectionPostingsForDoc: db.prepare("DELETE FROM section_postings WHERE doc = ?"),
    deleteSectionsForDoc: db.prepare("DELETE FROM sections WHERE doc = ?"),
    deleteDoc: db.prepare("DELETE FROM docs WHERE doc = ?"),
    updateDocOrd: db.prepare("UPDATE docs SET ord = ? WHERE doc = ?"),
    insertDoc: db.prepare(
      "INSERT INTO docs(layer, id, ord, fp, title, frontmatter, body, len0, len1, len2, len3) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    insertSection: db.prepare(
      "INSERT INTO sections(doc, idx, key, heading, text, length) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    insertPosting: db.prepare("INSERT INTO postings(term, doc, field, tf) VALUES (?, ?, ?, ?)"),
    insertSectionPosting: db.prepare("INSERT INTO section_postings(term, doc, idx, tf) VALUES (?, ?, ?, ?)"),
    bumpTermUp: db.prepare(
      "INSERT INTO terms(term, df) VALUES (?, 1) ON CONFLICT(term) DO UPDATE SET df = df + 1",
    ),
    bumpTermDown: db.prepare("UPDATE terms SET df = df - 1 WHERE term = ?"),
    deleteZeroTerm: db.prepare("DELETE FROM terms WHERE term = ? AND df <= 0"),
    termDf: db.prepare("SELECT df FROM terms WHERE term = ?"),
    countDocs: db.prepare("SELECT COUNT(*) AS n FROM docs"),
    sumLens: db.prepare("SELECT SUM(len0) AS s0, SUM(len1) AS s1, SUM(len2) AS s2, SUM(len3) AS s3 FROM docs"),
    sectionAgg: db.prepare("SELECT SUM(length) AS total, COUNT(*) AS cnt FROM sections"),
    postingsForTerm: db.prepare("SELECT doc, field, tf FROM postings WHERE term = ?"),
    sectionPostingsForTerm: db.prepare("SELECT doc, idx, tf FROM section_postings WHERE term = ?"),
    docByLayerId: db.prepare("SELECT frontmatter FROM docs WHERE layer = ? AND id = ?"),
    bodyForDoc: db.prepare("SELECT body FROM docs WHERE doc = ?"),
    sectionByDocIdx: db.prepare("SELECT key, heading, text FROM sections WHERE doc = ? AND idx = ?"),
    insertLink: db.prepare("INSERT INTO links(doc, ord, target) VALUES (?, ?, ?)"),
    deleteLinksForDoc: db.prepare("DELETE FROM links WHERE doc = ?"),
    linksForDoc: db.prepare("SELECT target FROM links WHERE doc = ? ORDER BY ord"),
    docExists: db.prepare("SELECT 1 FROM docs WHERE id = ? LIMIT 1"),
    existingDocByLayerId: db.prepare("SELECT doc, fp, ord FROM docs WHERE layer = ? AND id = ?"),
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
        `SELECT doc, layer, id, ord, title, len0, len1, len2, len3 FROM docs WHERE doc IN (${placeholders})`,
      );
      rows.push(...stmt.all(...chunk));
    }
    return rows;
  }

  /** Map<doc, Map<idx, length>> for exactly the given candidate doc ids,
   * batched — the section LENGTHS only (not text), needed to score each
   * matched section with its own length normalization. */
  function sectionLensForDocs(ids) {
    const arr = [...ids];
    const byDoc = new Map();
    for (let i = 0; i < arr.length; i += IN_CHUNK) {
      const chunk = arr.slice(i, i + IN_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const stmt = db.prepare(`SELECT doc, idx, length FROM sections WHERE doc IN (${placeholders})`);
      for (const row of stmt.all(...chunk)) {
        let m = byDoc.get(row.doc);
        if (!m) { m = new Map(); byDoc.set(row.doc, m); }
        m.set(row.idx, row.length);
      }
    }
    return byDoc;
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
    const terms = stmts.docTermsFor.all(doc, doc);
    for (const { term } of terms) {
      stmts.bumpTermDown.run(term);
      stmts.deleteZeroTerm.run(term);
    }
    stmts.deletePostingsForDoc.run(doc);
    stmts.deleteSectionPostingsForDoc.run(doc);
    stmts.deleteSectionsForDoc.run(doc);
    stmts.deleteLinksForDoc.run(doc);
    stmts.deleteDoc.run(doc);
  }

  /** The raw section objects analyzeConceptFields iterated, in the same
   * order (including the single synthetic `null` for a zero-section
   * concept) — needed here only to recover each section's raw TEXT, which
   * analyzeConceptFields does not return (it returns term stats, not text). */
  function rawSectionsFor(concept) {
    return concept.sections.length ? concept.sections : [null];
  }

  function insertDocWithPostings(layerName, id, ord, fp, concept, layerNames) {
    const { fields, sections } = analyzeConceptFields(id, concept);
    analyzedCount += 1;
    const lens = fields.map((f) => f.length);
    const result = stmts.insertDoc.run(
      layerName, id, ord, fp,
      concept.frontmatter?.title ?? null,
      JSON.stringify(concept.frontmatter ?? {}),
      conceptBody(concept),
      lens[0] ?? 0, lens[1] ?? 0, lens[2] ?? 0, lens[3] ?? 0,
    );
    const doc = result.lastInsertRowid;
    const seen = new Set();
    for (let field = 0; field < fields.length; field += 1) {
      for (const [term, tf] of fields[field].frequencies) {
        stmts.insertPosting.run(term, doc, field, tf);
        seen.add(term);
      }
    }
    const rawSections = rawSectionsFor(concept);
    sections.forEach((section, idx) => {
      const text = rawSections[idx] ? sectionText(rawSections[idx]) : "";
      stmts.insertSection.run(doc, idx, section.key ?? null, section.heading ?? null, text, section.length);
      for (const [term, tf] of section.frequencies) {
        stmts.insertSectionPosting.run(term, doc, idx, tf);
        seen.add(term);
      }
    });
    for (const term of seen) stmts.bumpTermUp.run(term);

    // Self-excluded, deduped, normalized outgoing targets — document order
    // preserved via `ord` so a later linksTo read reproduces it exactly.
    // Corpus existence is NOT filtered here (it can change on every sync
    // without this document being re-read); linksTo checks it at read time.
    const targets = conceptLinkTargets(conceptBody(concept), id, layerNames).filter((target) => target !== id);
    targets.forEach((target, index) => stmts.insertLink.run(doc, index, target));

    return doc;
  }

  function syncLayer(view, layerNames) {
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
      insertDocWithPostings(view.name, id, ord, fp, concept, layerNames);
      ord += 1;
    }
    for (const [id, existing] of existingDocs) {
      if (!seen.has(id)) removeDoc(existing.doc);
    }

    stmts.upsertLayer.run(view.name, identity, view.level ?? 0, view.gen, proc);
  }

  /**
   * True iff the store's stored row for layer `name` already reflects `gen`
   * under THIS instance's proc token, with a matching `identity` — i.e.
   * nothing about this layer's listing has moved since the last time this
   * process synced it (syncLayer's own "nothing moved" fast path, exposed so
   * a caller can skip pending() entirely rather than pay a per-id fingerprint
   * compare to rediscover what it already knows).
   */
  function isCurrent(name, identity, gen) {
    const existingLayer = stmts.getLayer.get(name);
    return Boolean(existingLayer)
      && existingLayer.identity === (identity ?? null)
      && existingLayer.gen === gen
      && existingLayer.proc === proc;
  }

  /**
   * Streaming counterpart to syncLayer, for a cold build over many pending
   * documents: beginLayer/upsertBatch/finishLayer lets a caller commit small batches
   * of newly-analyzed documents one at a time instead of holding every
   * pending concept in a JS Map before a single sync() call. Each function
   * below opens and commits (or rolls back) its own transaction, so a batch
   * is durable — and visible to another process reading the same file — the
   * moment upsertBatch/finishLayer returns. The worst race this allows is a
   * concurrent reader seeing a partially-synced layer mid-build (some
   * documents from the new listing, some still from the old one); it can
   * never see a half-written document, because insertDocWithPostings's own
   * doc+postings+links insert happens inside one batch's transaction.
   *
   * beginLayer records just enough to let upsertBatch/finishLayer proceed;
   * it does not touch the database. Call it once per layer before any
   * upsertBatch calls for that layer.
   */
  function beginLayer({
    name, identity, level, gen,
  }) {
    return { name, identity: identity ?? null, level, gen };
  }

  /**
   * Commit one batch of freshly-analyzed documents for `name`. Each item is
   * `{ id, ord, concept, fileMeta }` — `fileMeta` is that one document's own
   * file metadata (or omitted for an unfingerprinted source, which falls
   * back to the same content-hash fingerprint syncLayer uses). Replaces
   * docs/postings/links/df for exactly these ids, in one transaction, the
   * same as syncLayer's own insert path — never touches a row for any other
   * id.
   */
  function upsertBatch(name, items, layerNames) {
    if (!items.length) return;
    // BEGIN IMMEDIATE + bounded retry: a concurrent writer on the same file
    // (another process's own cold build, or a query mid-sync) can hold the
    // write lock past a single attempt; same discipline as ensureSchema,
    // covering the general "two processes racing to write" case, not only
    // first-open schema creation.
    withBusyRetry(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const {
          id, ord, concept, fileMeta,
        } of items) {
          const fp = fileMeta
            ? JSON.stringify([fileMeta.rel, fileMeta.ext, fileMeta.size, fileMeta.mtimeMs, fileMeta.authoredDate ?? null])
            : contentFingerprint(id, concept);
          const existingRow = stmts.existingDocByLayerId.get(name, id);
          if (existingRow && existingRow.fp === fp) {
            // Same discipline as syncLayer: an unfingerprinted (remote)
            // source is always reloaded, but identical content still hashes
            // to the same fingerprint, so it is kept as-is rather than
            // reanalyzed — only the position may need fixing.
            if (existingRow.ord !== ord) stmts.updateDocOrd.run(ord, existingRow.doc);
            continue;
          }
          if (existingRow) removeDoc(existingRow.doc);
          insertDocWithPostings(name, id, ord, fp, concept, layerNames ?? new Set([name]));
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /**
   * Finish a streaming layer sync: sweep out any stored document whose id is
   * no longer in `ids` (a deletion — upsertBatch never sees these, since a
   * caller only batches ids it actually loaded), fix `ord` for documents
   * that were already correct and so were never touched by upsertBatch, and
   * write the layer's row (identity/level/gen/proc) so a later isCurrent()
   * check recognizes this exact listing as already synced. Own transaction,
   * same durability story as upsertBatch.
   */
  function finishLayer(state, { ids, gen, level }) {
    withBusyRetry(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const seen = new Set(ids);
        const rows = stmts.docsForLayer.all(state.name);
        for (const row of rows) {
          if (!seen.has(row.id)) removeDoc(row.doc);
        }
        const byId = new Map(stmts.docsForLayer.all(state.name).map((row) => [row.id, row]));
        ids.forEach((id, ord) => {
          const row = byId.get(id);
          if (row && row.ord !== ord) stmts.updateDocOrd.run(ord, row.doc);
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    withBusyRetry(() => stmts.upsertLayer.run(state.name, state.identity, level ?? 0, gen, proc));
  }

  function sync(contributing) {
    // BEGIN IMMEDIATE (not the plain deferred BEGIN this used to open with):
    // grabbing the write lock up front means a concurrent writer surfaces as
    // one clean SQLITE_BUSY at the BEGIN itself — caught by withBusyRetry —
    // instead of partway through the loop below after some statements on
    // this connection have already run.
    withBusyRetry(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const wanted = new Set(contributing.map((view) => view.name));
        for (const view of contributing) syncLayer(view, wanted);
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
    });
  }

  // averageLength is FIXED_FIELD_COUNT (4) per-concept averages plus ONE
  // aggregate body figure — the mean SECTION length across every section in
  // the corpus (total section terms / total section count), matching
  // buildConceptIndex exactly: a 9-section runbook contributes 9 length
  // samples to that average, not one.
  function corpusStats(terms) {
    const { n } = stmts.countDocs.get();
    const sums = stmts.sumLens.get();
    const sectionAgg = stmts.sectionAgg.get();
    const averageLength = [
      ...[sums.s0, sums.s1, sums.s2, sums.s3].map((sum) => (n ? (sum ?? 0) / n : 0)),
      sectionAgg.cnt ? (sectionAgg.total ?? 0) / sectionAgg.cnt : 0,
    ];
    const documentFrequency = new Map();
    for (const term of terms) {
      const row = stmts.termDf.get(term);
      documentFrequency.set(term, row ? row.df : 0);
    }
    return { total: n, averageLength, documentFrequency };
  }

  // doc -> { fixed: [{frequencies,length}] x FIXED_FIELD_COUNT, sections:
  // Map<idx, {frequencies}> } for scoreBestSection, built ONLY for documents
  // that have at least one posting (fixed-field OR section) among the query
  // terms — the per-doc structures are transient, discarded after this
  // search() call.
  function buildCandidates(terms) {
    const candidates = new Map();
    const ensure = (doc) => {
      let c = candidates.get(doc);
      if (!c) {
        c = {
          fixed: Array.from({ length: FIXED_FIELD_COUNT }, () => ({ frequencies: new Map(), length: 0 })),
          sections: new Map(),
        };
        candidates.set(doc, c);
      }
      return c;
    };
    for (const term of terms) {
      for (const { doc, field, tf } of stmts.postingsForTerm.all(term)) {
        ensure(doc).fixed[field].frequencies.set(term, tf);
      }
      for (const { doc, idx, tf } of stmts.sectionPostingsForTerm.all(term)) {
        const c = ensure(doc);
        let section = c.sections.get(idx);
        if (!section) {
          section = { frequencies: new Map() };
          c.sections.set(idx, section);
        }
        section.frequencies.set(term, tf);
      }
    }
    return candidates;
  }

  /**
   * The store's counterpart to search.mjs's scoreConceptSections: score every
   * section of `doc` as its own body candidate and return the max, with the
   * winning section's index and whether the winning score came from an
   * actual section match (`matched`).
   *
   * Unlike scoreConceptSections, this does NOT need every section of the
   * document — only the ones `candidate.sections` names (i.e. the ones with
   * at least one query-term posting). Proof: a section's score is
   * baseScore + a NON-NEGATIVE per-matched-term contribution (idf > 0 for
   * any term with a posting, and a stored posting always has tf >= 1, so
   * `weighted > 0` and the term's contribution to scoreEntry is strictly
   * positive). So any section with zero matching postings scores EXACTLY
   * `baseScore` (the fixed-fields-only score — section-invariant, since an
   * empty section frequency map contributes 0 regardless of that section's
   * own length), and any matched section scores STRICTLY more than
   * baseScore. The true maximum is therefore always baseScore itself (when
   * no section matched) or the best matched section (when any did) — never
   * an unmatched section "winning" by tying above every matched section.
   * Iterating matched sections in ascending idx order and comparing with
   * strict `>` reproduces scoreConceptSections's first-on-ties rule exactly.
   */
  function scoreBestSection(index, fixedFields, candidate, terms, sectionLens) {
    const matchedIdx = [...(candidate?.sections ?? [])].sort((a, b) => a[0] - b[0]);
    if (matchedIdx.length === 0) {
      const score = scoreEntry(index, { fields: [...fixedFields, EMPTY_SECTION_FIELD] }, terms);
      return { score, sectionIndex: 0, matched: false };
    }
    let bestScore = -Infinity;
    let bestIndex = 0;
    for (const [idx, section] of matchedIdx) {
      const sectionField = { frequencies: section.frequencies, length: sectionLens.get(idx) ?? 0 };
      const score = scoreEntry(index, { fields: [...fixedFields, sectionField] }, terms);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    }
    return { score: bestScore, sectionIndex: bestIndex, matched: true };
  }

  /**
   * inbound(id) for each of `ids`: the number of DISTINCT concept ids (across
   * all contributing layers, any layer's body — hence COUNT(DISTINCT
   * docs.id), not COUNT(*)) with a stored link row targeting `id`. Self-links
   * were never stored (insertDocWithPostings excludes them); a target outside
   * `ids` was never asked for. Ids with zero inbound rows are simply absent
   * from the returned Map — callers read it with `?? 0`.
   */
  function inboundCounts(ids) {
    const arr = [...ids];
    const counts = new Map();
    for (let i = 0; i < arr.length; i += IN_CHUNK) {
      const chunk = arr.slice(i, i + IN_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const stmt = db.prepare(
        `SELECT links.target AS target, COUNT(DISTINCT docs.id) AS n `
        + `FROM links JOIN docs ON links.doc = docs.doc `
        + `WHERE links.target IN (${placeholders}) GROUP BY links.target`,
      );
      for (const row of stmt.all(...chunk)) counts.set(row.target, row.n);
    }
    return counts;
  }

  /** Up to LINKS_TO_MAX outgoing targets of `doc` that exist in the corpus
   * right now, in document order. Corpus existence is checked here (not at
   * insert time) because it can change without this document being re-read. */
  function linksToFor(doc) {
    const targets = stmts.linksForDoc.all(doc).map((row) => row.target);
    const out = [];
    for (const target of targets) {
      if (out.length >= LINKS_TO_MAX) break;
      if (stmts.docExists.get(target)) out.push(target);
    }
    return out;
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
      const sectionLensByDoc = sectionLensForDocs(candidates.keys());

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
        const candidate = candidates.get(row.doc);
        const fixedFields = candidate.fixed.map((f, i) => ({
          frequencies: f.frequencies,
          length: [row.len0, row.len1, row.len2, row.len3][i],
        }));
        const sectionLens = sectionLensByDoc.get(row.doc) ?? new Map();
        const best = scoreBestSection(index, fixedFields, candidate, terms, sectionLens);
        if (best.score <= 0) continue;
        const view = contributing[viewIndexByName.get(row.layer)];
        const title = row.title ?? null;
        const existing = byId.get(row.id);
        if (!existing) {
          byId.set(row.id, {
            id: row.id, title, score: best.score, layers: [view.name], doc: row.doc, sectionIndex: best.sectionIndex, matched: best.matched,
          });
        } else {
          if (best.score > existing.score) {
            existing.score = best.score;
            existing.doc = row.doc;
            existing.sectionIndex = best.sectionIndex;
            existing.matched = best.matched;
          }
          existing.layers.push(view.name);
          if (!existing.title) existing.title = title;
        }
      }

      // The prior is per CONCEPT, not per layer contribution — applied once
      // here, after the best-layer merge, before the type filter and sort.
      const inbound = inboundCounts(byId.keys());
      for (const hit of byId.values()) {
        hit.inbound = inbound.get(hit.id) ?? 0;
        hit.score *= linkPriorMultiplier(hit.inbound);
      }

      let hits = [...byId.values()];
      if (type) hits = hits.filter((hit) => typeOf(contributing, hit.id) === type);

      // Section/body text is fetched only for the documents that survive
      // ranking AND the limit cut — one text read per returned hit, never
      // per corpus document. A matched hit reads its winning section's own
      // text (for the snippet) and reports `section: {key, heading}`; an
      // unmatched hit (the score came entirely from fixed fields — no
      // section had a query-term match) falls back to the whole-document
      // body for the snippet and reports `section: null`, exactly as
      // searchConcepts does.
      return hits
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, Number(limit) || 10)
        .map(({
          doc, sectionIndex, matched, ...hit
        }, rank) => {
          let snippetSource;
          let section;
          if (matched) {
            const srow = stmts.sectionByDocIdx.get(doc, sectionIndex);
            snippetSource = srow.text;
            section = { key: srow.key, heading: srow.heading };
          } else {
            snippetSource = stmts.bodyForDoc.get(doc).body;
            section = null;
          }
          bodyReadCount += 1;
          const result = {
            ...hit,
            snippet: makeSnippet(snippetSource, rawTokens),
            section,
            layers: orderLayerNames(hit.layers),
          };
          if (rank < LINKS_TO_CAP) result.linksTo = linksToFor(doc);
          return result;
        });
    },

    pending,
    isCurrent,
    beginLayer,
    upsertBatch,
    finishLayer,

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
