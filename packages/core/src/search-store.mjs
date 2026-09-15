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
// STORAGE LAYOUT: SEGMENTED POSTING BLOBS, not a row per posting.
// The first version of this store kept one SQLite row per
// (term, document, field/section, tf). That is the natural relational shape
// and it is the wrong one: a common query term materialized tens of thousands
// of JS row objects per query (a 12,000-document vault where every document
// matches every term decoded ~150,000 rows), which turned a 63 ms in-memory
// scan into a ~600 ms query and inflated the file to 689 MB for a 369 MB
// corpus. Now:
//
//   - documents are grouped into SEGMENTS of SEGMENT_DOCS documents. One
//     segment is "open" and accepts appends; the rest are sealed.
//   - `postings` holds ONE BLOB per (term, segment): fixed-width 12-byte
//     little-endian records `[doc u32][kind<<24|slot u32][tf u32]`, sorted by
//     (doc, kind, slot). kinds 0-3 are the four fixed fields
//     (id/title/description/tags); kind 4 is a section body, `slot` being the
//     section index. A query reads a handful of blobs per term and decodes
//     them with a DataView straight into the per-candidate frequency
//     structures scoring needs — no JS object per record, ever.
//   - a document ALWAYS gets a new doc id (an edit deletes the old row and
//     inserts a new one), so appends to the open segment's blob preserve
//     sorted order without a sort.
//   - a deleted document is simply absent from `docs`. Its records stay in
//     the blobs as tombstones and are skipped at scoring time (candidate rows
//     are fetched by doc id; a record with no row scores nothing). Each
//     segment tracks its dead-record count; a sealed segment past
//     DEAD_RATIO is rewritten without its dead records, one segment per
//     write transaction.
//
// BIT-IDENTICAL BY CONSTRUCTION, same discipline as search-index.mjs:
//   - per-document analysis is search.mjs's own analyzeConceptFields, so terms,
//     stemming, and per-field lengths match exactly;
//   - corpus statistics (document frequency, per-field length totals, document
//     count, section count and section term total) are maintained by integer
//     add/subtract as documents enter and leave the store — integer arithmetic
//     is order-independent, so the maintained values equal a fresh build's
//     exactly;
//   - candidate documents are reconstructed into the exact `entry.fields` shape
//     scoreEntry expects, and scoreEntry itself (imported, not reimplemented)
//     does the arithmetic;
//   - enumeration replicates collectDocuments order: contributing layers in
//     order, documents in snapshot (`ord`) order within a layer — the
//     best-layer merge keeps the FIRST layer's row on equal scores, so order
//     is part of the ranking contract, exactly as in search-index.mjs.
// search-store.test.mjs holds Object.is equality against searchConcepts AND
// createSearchIndex under randomized mutation, plus restart/identity/eviction
// scenarios and a segment-sealing/tombstone/compaction scenario specific to
// this layout.
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
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  analyze, analyzeConceptFields, conceptBody, makeSnippet, scoreEntry, tokenizeQuery, FIXED_FIELD_COUNT,
  linkPriorMultiplier,
} from "./search.mjs";
import { sectionText } from "./sections.mjs";
import { conceptLinkTargets } from "./markdown-links.mjs";
import { mergeConcepts, orderContributors } from "./resolver.mjs";

// Bumped for the segmented posting-blob layout: a store built under an
// earlier FORMAT_VERSION has row-per-posting tables this code cannot read, so
// any pre-existing file rebuilds from scratch.
const FORMAT_VERSION = 4;
// Documents per segment. Bigger segments mean fewer blobs to read per query
// term and a better compression ratio for the per-term header cost; smaller
// segments mean less bytes copied when the open segment's blob is appended
// to. 4096 keeps a common term's open-segment blob well under a megabyte.
const DEFAULT_SEGMENT_DOCS = 4096;
// Fixed-width posting record: [doc u32][kind<<24 | slot u32][tf u32].
// 12 bytes rather than the 9 a packed [doc u32][kind u8][slot u16][tf u16]
// would take: u32 tf and a 24-bit slot cannot overflow on a pathological
// document (a section repeating one term 65,536 times, or a document with
// more than 65,536 sections), and 4-byte fields keep the decode a plain
// aligned DataView read. The size difference is ~3 bytes per (term, field)
// pair — noise next to the section text the same file stores.
const REC_BYTES = 12;
const KIND_SECTION = FIXED_FIELD_COUNT; // 4: kinds 0..3 are the fixed fields
const SLOT_MASK = 0x00ffffff;
// Rewrite a sealed segment's blobs once more than this fraction of its
// records belong to documents that no longer exist.
const DEAD_RATIO = 0.25;
// A section field's contribution to scoreEntry when a section has no query
// term matches at all: {frequencies: empty, length: irrelevant} — the SAME
// object works for any unmatched section because an empty frequency map
// contributes 0 regardless of `length` (scoreEntry only reads `length` when
// `frequencies.get(term)` is truthy). This is what lets the decoder skip
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

/**
 * True iff node:sqlite loaded in this runtime. `CONTEXTCAKE_DISABLE_SEARCH_STORE=1`
 * forces false regardless — the DI seam that lets a test exercise the
 * in-memory fallback path (retained-search.mjs's legacy implementation, and
 * service.mjs's createSearchIndex branch) on a Node build where node:sqlite
 * IS available, since that fallback is otherwise unreachable and untested on
 * any Node this engine supports (>=22.13, where node:sqlite is unflagged).
 * Real callers never set this; it exists only to make the fallback testable.
 */
export function isSearchStoreAvailable() {
  if (process.env.CONTEXTCAKE_DISABLE_SEARCH_STORE === "1") return false;
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

/** A stored u32 array column (section lengths) as a Uint32Array, copying only
 * when the driver handed back a view whose byteOffset is not 4-aligned. */
function u32ArrayOf(bytes) {
  if (!bytes || bytes.byteLength === 0) return new Uint32Array(0);
  if (bytes.byteOffset % 4 === 0) {
    return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
  }
  const copy = Uint8Array.prototype.slice.call(bytes);
  return new Uint32Array(copy.buffer, copy.byteOffset, copy.byteLength >>> 2);
}

/**
 * A candidate document's per-field term frequencies, backed by a slice of a
 * flat Uint32Array rather than a Map per field per document. scoreEntry only
 * ever calls `.get(term)` and treats 0 as "no match", so this is a drop-in
 * for the Map the in-memory index holds — without allocating one per field
 * per candidate, which is precisely the cost this layout exists to avoid.
 */
class TermFrequencies {
  constructor(values, base, termIndex) {
    this.values = values;
    this.base = base;
    this.termIndex = termIndex;
  }

  get(term) {
    const i = this.termIndex.get(term);
    return i === undefined ? undefined : this.values[this.base + i];
  }

  has(term) {
    const i = this.termIndex.get(term);
    return i !== undefined && this.values[this.base + i] > 0;
  }
}

/**
 * Open (or create) a SQLite-backed BM25F posting store.
 *
 * `file`: absolute path, or ":memory:" for a process-local store.
 * `segmentDocs`: documents per posting segment (tests lower it to exercise
 * sealing and compaction without writing 4,096 documents).
 * `idleEvictMs`: accepted for API symmetry with createSearchIndex. This store
 * keeps no corpus-scale state in the JS heap between searches — only the
 * open database handle and prepared statements, which are cheap to hold — so
 * there is nothing profitable to evict on a timer. Accepted and ignored.
 */
export function createSearchStore({ file, idleEvictMs, segmentDocs = DEFAULT_SEGMENT_DOCS } = {}) {
  if (!sqliteModule) {
    throw new Error(
      "search-store requires node:sqlite, which failed to load in this runtime"
      + (probeError ? `: ${probeError.message}` : " (call isSearchStoreAvailable() first)"),
    );
  }
  void idleEvictMs; // see doc comment above

  const { DatabaseSync } = sqliteModule;
  const path = file ?? ":memory:";
  const db = new DatabaseSync(path);
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
      DROP TABLE IF EXISTS segments;
      DROP TABLE IF EXISTS terms;
      DROP TABLE IF EXISTS stats;
      DROP TABLE IF EXISTS links;

      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE layers(
        name TEXT PRIMARY KEY,
        identity TEXT,
        level INTEGER,
        gen INTEGER,
        proc TEXT
      );
      -- AUTOINCREMENT, not a bare INTEGER PRIMARY KEY: doc ids must be
      -- MONOTONIC. Plain rowid assignment reuses the id of a deleted last row,
      -- which would let a new document inherit a deleted one's tombstoned
      -- posting records. Monotonic ids are also what makes an append to the
      -- open segment's blob sorted by construction.
      -- seg is the segment this document's records live in, nrec how many
      -- records it contributed (both needed to account for its tombstones on
      -- delete), dterms its distinct terms (newline-joined; the analyzer's
      -- alphabet cannot contain a newline) so a delete can decrement df
      -- without a row-per-(doc, term) table, and seclens its per-section
      -- term lengths as packed u32 — read at query time instead of a
      -- 6-rows-per-document join.
      CREATE TABLE docs(
        doc INTEGER PRIMARY KEY AUTOINCREMENT,
        layer TEXT NOT NULL,
        id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        fp TEXT NOT NULL,
        title TEXT,
        frontmatter TEXT NOT NULL,
        len0 INTEGER, len1 INTEGER, len2 INTEGER, len3 INTEGER,
        seg INTEGER NOT NULL,
        nrec INTEGER NOT NULL,
        dterms TEXT NOT NULL,
        seclens BLOB NOT NULL,
        UNIQUE(layer, id)
      );
      CREATE INDEX docs_seg ON docs(seg);
      CREATE INDEX docs_id ON docs(id);
      -- One row per concept.sections element (or one synthetic empty section
      -- for a zero-section concept, matching analyzeConceptFields exactly).
      -- text is the raw section text. It is the ONLY copy of the document
      -- body the store keeps: a hit whose score came entirely from the fixed
      -- fields needs the whole body for its snippet, and the whole body is
      -- exactly these texts joined with "\\n" (conceptBody in search.mjs), so
      -- storing both would double the file for nothing.
      -- A ROWID table with a unique index, deliberately NOT a WITHOUT ROWID
      -- table keyed on (doc, idx): section text is kilobytes, and an index
      -- b-tree keeps only ~1 KB of a row locally before spilling the rest to
      -- overflow pages, so multi-kilobyte sections wasted most of an overflow
      -- page each (measured: +45% on the file for a 3.5 KB-per-section
      -- corpus). A table b-tree keeps ~4 KB locally and spills the remainder
      -- densely.
      CREATE TABLE sections(
        doc INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        key TEXT,
        heading TEXT,
        text TEXT NOT NULL,
        length INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX sections_doc_idx ON sections(doc, idx);
      -- One open segment (sealed = 0) accepts appends; the rest are sealed.
      -- records counts every record in this segment's blobs, dead how many
      -- of those belong to documents that have since been removed.
      CREATE TABLE segments(
        seg INTEGER PRIMARY KEY,
        sealed INTEGER NOT NULL,
        docCount INTEGER NOT NULL,
        records INTEGER NOT NULL,
        dead INTEGER NOT NULL
      );
      -- One blob per (term, segment): fixed-width records sorted by
      -- (doc, kind, slot). See the module header for the encoding.
      CREATE TABLE postings(
        term TEXT NOT NULL,
        seg INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY(term, seg)
      ) WITHOUT ROWID;
      CREATE INDEX postings_seg ON postings(seg);
      -- df counts DISTINCT DOCUMENTS containing a term in ANY field or ANY
      -- section (buildConceptIndex's own dedup-per-doc rule) — bumped once
      -- per doc regardless of how many fields/sections mention the term.
      CREATE TABLE terms(term TEXT PRIMARY KEY, df INTEGER NOT NULL);
      -- Corpus aggregates, maintained by integer add/subtract rather than
      -- recomputed with SUM() per query: at 12k documents a SUM over the
      -- sections table is a 72,000-row scan on the warm path.
      CREATE TABLE stats(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE links(
        doc INTEGER NOT NULL,
        ord INTEGER NOT NULL,
        target TEXT NOT NULL
      );
      CREATE INDEX links_target ON links(target);
      CREATE INDEX links_doc ON links(doc);
    `);
    db.prepare("INSERT INTO meta(key, value) VALUES ('format', ?)").run(String(FORMAT_VERSION));
    const insertStat = db.prepare("INSERT INTO stats(key, value) VALUES (?, 0)");
    for (const key of ["docs", "len0", "len1", "len2", "len3", "secLen", "secCount"]) insertStat.run(key);
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
  let bodyReadCount = 0; // section/body text reads by THIS instance since open — bounded by hit count per search, never corpus size
  let lastStats = { candidateCount: 0, syncMs: 0, decodedRecords: 0 };

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
    docForRemoval: db.prepare("SELECT seg, nrec, dterms, len0, len1, len2, len3, seclens FROM docs WHERE doc = ?"),
    deleteSectionsForDoc: db.prepare("DELETE FROM sections WHERE doc = ?"),
    deleteDoc: db.prepare("DELETE FROM docs WHERE doc = ?"),
    updateDocOrd: db.prepare("UPDATE docs SET ord = ? WHERE doc = ?"),
    insertDoc: db.prepare(
      "INSERT INTO docs(layer, id, ord, fp, title, frontmatter, len0, len1, len2, len3, seg, nrec, dterms, seclens) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    insertSection: db.prepare(
      "INSERT INTO sections(doc, idx, key, heading, text, length) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    bumpTerm: db.prepare(
      "INSERT INTO terms(term, df) VALUES (?, ?) ON CONFLICT(term) DO UPDATE SET df = df + excluded.df",
    ),
    deleteZeroTerm: db.prepare("DELETE FROM terms WHERE term = ? AND df <= 0"),
    termDf: db.prepare("SELECT df FROM terms WHERE term = ?"),
    allStats: db.prepare("SELECT key, value FROM stats"),
    addStat: db.prepare("UPDATE stats SET value = value + ? WHERE key = ?"),
    openSegment: db.prepare("SELECT seg, docCount FROM segments WHERE sealed = 0 LIMIT 1"),
    maxSegment: db.prepare("SELECT MAX(seg) AS m FROM segments"),
    insertSegment: db.prepare("INSERT INTO segments(seg, sealed, docCount, records, dead) VALUES (?, 0, 0, 0, 0)"),
    sealSegment: db.prepare("UPDATE segments SET sealed = 1, docCount = ? WHERE seg = ?"),
    setSegmentDocCount: db.prepare("UPDATE segments SET docCount = ? WHERE seg = ?"),
    addSegmentRecords: db.prepare("UPDATE segments SET records = records + ? WHERE seg = ?"),
    addSegmentDead: db.prepare("UPDATE segments SET dead = dead + ? WHERE seg = ?"),
    resetSegmentDead: db.prepare("UPDATE segments SET records = ?, dead = 0 WHERE seg = ?"),
    dirtySegment: db.prepare(
      `SELECT seg FROM segments WHERE sealed = 1 AND records > 0 AND dead * ${Math.round(1 / DEAD_RATIO)} > records LIMIT 1`,
    ),
    segmentCount: db.prepare("SELECT COUNT(*) AS n FROM segments"),
    docsInSegment: db.prepare("SELECT doc FROM docs WHERE seg = ?"),
    postingsInSegment: db.prepare("SELECT term, data FROM postings WHERE seg = ?"),
    getPosting: db.prepare("SELECT data FROM postings WHERE term = ? AND seg = ?"),
    insertPosting: db.prepare("INSERT INTO postings(term, seg, data) VALUES (?, ?, ?)"),
    updatePosting: db.prepare("UPDATE postings SET data = ? WHERE term = ? AND seg = ?"),
    deletePosting: db.prepare("DELETE FROM postings WHERE term = ? AND seg = ?"),
    postingsForTerm: db.prepare("SELECT data FROM postings WHERE term = ? ORDER BY seg"),
    docByLayerId: db.prepare("SELECT frontmatter FROM docs WHERE layer = ? AND id = ?"),
    sectionTextsForDoc: db.prepare("SELECT text FROM sections WHERE doc = ? ORDER BY idx"),
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

  /** Rows for exactly the given doc ids, batched, WITHOUT the document text. */
  function docsByIds(ids) {
    const arr = [...ids];
    const rows = [];
    for (let i = 0; i < arr.length; i += IN_CHUNK) {
      const chunk = arr.slice(i, i + IN_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const stmt = db.prepare(
        `SELECT doc, layer, id, ord, title, len0, len1, len2, len3, seclens FROM docs WHERE doc IN (${placeholders})`,
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

  // ---- write session -------------------------------------------------------
  //
  // Every write transaction runs against one of these. Posting records are
  // accumulated per (segment, term) as flat arrays of numbers — never one
  // object per record — and each touched blob is read/concatenated/written
  // ONCE at flush, instead of once per document. Document-frequency and
  // corpus-aggregate deltas are likewise summed in memory and applied once,
  // so a 256-document batch costs a handful of statements per distinct term
  // rather than a statement per (document, term).

  function newWriter() {
    return {
      bySeg: new Map(), // seg -> { terms: Map<term, number[]>, count }
      dfDelta: new Map(), // term -> integer delta
      stats: {
        docs: 0, len0: 0, len1: 0, len2: 0, len3: 0, secLen: 0, secCount: 0,
      },
      seg: -1,
      segDocCount: 0,
      segTouched: false,
    };
  }

  function segmentForInsert(writer) {
    if (writer.seg < 0) {
      const open = stmts.openSegment.get();
      if (open) {
        writer.seg = open.seg;
        writer.segDocCount = open.docCount;
      } else {
        const next = (stmts.maxSegment.get()?.m ?? -1) + 1;
        stmts.insertSegment.run(next);
        writer.seg = next;
        writer.segDocCount = 0;
      }
    }
    if (writer.segDocCount >= segmentDocs) {
      stmts.sealSegment.run(writer.segDocCount, writer.seg);
      const next = (stmts.maxSegment.get()?.m ?? -1) + 1;
      stmts.insertSegment.run(next);
      writer.seg = next;
      writer.segDocCount = 0;
    }
    writer.segDocCount += 1;
    writer.segTouched = true;
    return writer.seg;
  }

  function pushRecord(writer, seg, term, doc, kind, slot, tf) {
    let bucket = writer.bySeg.get(seg);
    if (!bucket) {
      bucket = { terms: new Map(), count: 0 };
      writer.bySeg.set(seg, bucket);
    }
    let nums = bucket.terms.get(term);
    if (!nums) {
      nums = [];
      bucket.terms.set(term, nums);
    }
    nums.push(doc, ((kind << 24) | slot) >>> 0, tf);
    bucket.count += 1;
  }

  function flushWriter(writer) {
    for (const [seg, bucket] of writer.bySeg) {
      for (const [term, nums] of bucket.terms) {
        const existing = stmts.getPosting.get(term, seg);
        const old = existing ? existing.data : null;
        const oldLength = old ? old.byteLength : 0;
        const buffer = Buffer.allocUnsafe(oldLength + (nums.length / 3) * REC_BYTES);
        if (oldLength) Buffer.from(old.buffer, old.byteOffset, oldLength).copy(buffer, 0);
        let offset = oldLength;
        for (let i = 0; i < nums.length; i += 3) {
          buffer.writeUInt32LE(nums[i], offset);
          buffer.writeUInt32LE(nums[i + 1], offset + 4);
          buffer.writeUInt32LE(nums[i + 2], offset + 8);
          offset += REC_BYTES;
        }
        if (existing) stmts.updatePosting.run(buffer, term, seg);
        else stmts.insertPosting.run(term, seg, buffer);
      }
      if (bucket.count) stmts.addSegmentRecords.run(bucket.count, seg);
    }
    if (writer.segTouched) stmts.setSegmentDocCount.run(writer.segDocCount, writer.seg);
    for (const [term, delta] of writer.dfDelta) {
      if (delta === 0) continue;
      stmts.bumpTerm.run(term, delta);
      if (delta < 0) stmts.deleteZeroTerm.run(term);
    }
    for (const [key, delta] of Object.entries(writer.stats)) {
      if (delta !== 0) stmts.addStat.run(delta, key);
    }
  }

  /**
   * Rewrite one sealed segment's blobs without the records of documents that
   * no longer exist. Runs inside the caller's transaction, at most one
   * segment per transaction — a bounded amount of work attached to the write
   * that crossed the threshold, never a background sweep that could surprise
   * a query with a long lock hold.
   */
  function compactSegment(seg) {
    const live = new Set(stmts.docsInSegment.all(seg).map((row) => row.doc));
    let kept = 0;
    for (const row of stmts.postingsInSegment.all(seg)) {
      const data = row.data;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const total = (data.byteLength / REC_BYTES) | 0;
      const out = Buffer.allocUnsafe(data.byteLength);
      let offset = 0;
      for (let r = 0; r < total; r += 1) {
        const at = r * REC_BYTES;
        if (!live.has(view.getUint32(at, true))) continue;
        out.writeUInt32LE(view.getUint32(at, true), offset);
        out.writeUInt32LE(view.getUint32(at + 4, true), offset + 4);
        out.writeUInt32LE(view.getUint32(at + 8, true), offset + 8);
        offset += REC_BYTES;
      }
      if (offset === 0) stmts.deletePosting.run(row.term, seg);
      else if (offset !== data.byteLength) stmts.updatePosting.run(out.subarray(0, offset), row.term, seg);
      kept += offset / REC_BYTES;
    }
    stmts.resetSegmentDead.run(kept, seg);
  }

  function maybeCompact() {
    const row = stmts.dirtySegment.get();
    if (row) compactSegment(row.seg);
  }

  /** Open a write transaction with a fresh writer, flush it, compact at most
   * one over-dead segment, and commit — with the same bounded busy retry
   * every other write path uses. */
  function writeTransaction(body) {
    return withBusyRetry(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const writer = newWriter();
        const result = body(writer);
        flushWriter(writer);
        maybeCompact();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  function removeDoc(writer, doc) {
    const row = stmts.docForRemoval.get(doc);
    if (!row) return;
    // The document's records stay in their segment's blobs as tombstones —
    // scoring skips them because no `docs` row will be found for that id —
    // and the segment's dead counter is what eventually triggers a rewrite.
    if (row.nrec) stmts.addSegmentDead.run(row.nrec, row.seg);
    if (row.dterms) {
      for (const term of row.dterms.split("\n")) {
        writer.dfDelta.set(term, (writer.dfDelta.get(term) ?? 0) - 1);
      }
    }
    const seclens = u32ArrayOf(row.seclens);
    writer.stats.docs -= 1;
    writer.stats.len0 -= row.len0 ?? 0;
    writer.stats.len1 -= row.len1 ?? 0;
    writer.stats.len2 -= row.len2 ?? 0;
    writer.stats.len3 -= row.len3 ?? 0;
    writer.stats.secCount -= seclens.length;
    for (let i = 0; i < seclens.length; i += 1) writer.stats.secLen -= seclens[i];
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

  function insertDocWithPostings(writer, layerName, id, ord, fp, concept, layerNames) {
    const { fields, sections } = analyzeConceptFields(id, concept);
    analyzedCount += 1;

    const distinct = new Set();
    let nrec = 0;
    for (const field of fields) {
      nrec += field.frequencies.size;
      for (const term of field.frequencies.keys()) distinct.add(term);
    }
    const seclens = new Uint32Array(sections.length);
    sections.forEach((section, idx) => {
      seclens[idx] = section.length;
      nrec += section.frequencies.size;
      for (const term of section.frequencies.keys()) distinct.add(term);
    });

    const seg = segmentForInsert(writer);
    const lens = fields.map((field) => field.length);
    const result = stmts.insertDoc.run(
      layerName, id, ord, fp,
      concept.frontmatter?.title ?? null,
      JSON.stringify(concept.frontmatter ?? {}),
      lens[0] ?? 0, lens[1] ?? 0, lens[2] ?? 0, lens[3] ?? 0,
      seg, nrec, [...distinct].join("\n"),
      Buffer.from(seclens.buffer, seclens.byteOffset, seclens.byteLength),
    );
    const doc = Number(result.lastInsertRowid);
    if (doc > 0xffffffff) {
      // 4.29 billion document VERSIONS written to one store file. Practically
      // unreachable (a 50k-doc vault would have to fully re-index 86,000
      // times), but a silent wrap here would alias a new document onto an old
      // one's postings, so it fails loudly instead.
      throw new Error("search-store: document id space exhausted; delete the store file to rebuild");
    }

    // Records are pushed in (doc, kind, slot) order, and doc ids are
    // monotonic, so appending to the open segment's blob keeps it sorted
    // without ever sorting.
    for (let kind = 0; kind < fields.length; kind += 1) {
      for (const [term, tf] of fields[kind].frequencies) pushRecord(writer, seg, term, doc, kind, 0, tf);
    }
    const rawSections = rawSectionsFor(concept);
    sections.forEach((section, idx) => {
      const text = rawSections[idx] ? sectionText(rawSections[idx]) : "";
      stmts.insertSection.run(doc, idx, section.key ?? null, section.heading ?? null, text, section.length);
      for (const [term, tf] of section.frequencies) {
        pushRecord(writer, seg, term, doc, KIND_SECTION, idx & SLOT_MASK, tf);
      }
    });

    for (const term of distinct) writer.dfDelta.set(term, (writer.dfDelta.get(term) ?? 0) + 1);
    writer.stats.docs += 1;
    writer.stats.len0 += lens[0] ?? 0;
    writer.stats.len1 += lens[1] ?? 0;
    writer.stats.len2 += lens[2] ?? 0;
    writer.stats.len3 += lens[3] ?? 0;
    writer.stats.secCount += seclens.length;
    for (let i = 0; i < seclens.length; i += 1) writer.stats.secLen += seclens[i];

    // Self-excluded, deduped, normalized outgoing targets — document order
    // preserved via `ord` so a later linksTo read reproduces it exactly.
    // Corpus existence is NOT filtered here (it can change on every sync
    // without this document being re-read); linksTo checks it at read time.
    const targets = conceptLinkTargets(conceptBody(concept), id, layerNames).filter((target) => target !== id);
    targets.forEach((target, index) => stmts.insertLink.run(doc, index, target));

    return doc;
  }

  function syncLayer(writer, view, layerNames) {
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
      if (existing) removeDoc(writer, existing.doc);
      insertDocWithPostings(writer, view.name, id, ord, fp, concept, layerNames);
      ord += 1;
    }
    for (const [id, existing] of existingDocs) {
      if (!seen.has(id)) removeDoc(writer, existing.doc);
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
   * doc+sections+links insert and the batch's posting-blob writes happen
   * inside one batch's transaction.
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
   * docs/sections/postings/links/df for exactly these ids, in one
   * transaction, the same as syncLayer's own insert path — never touches a
   * row for any other id.
   */
  function upsertBatch(name, items, layerNames) {
    if (!items.length) return;
    // BEGIN IMMEDIATE + bounded retry: a concurrent writer on the same file
    // (another process's own cold build, or a query mid-sync) can hold the
    // write lock past a single attempt; same discipline as ensureSchema,
    // covering the general "two processes racing to write" case, not only
    // first-open schema creation.
    writeTransaction((writer) => {
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
        if (existingRow) removeDoc(writer, existingRow.doc);
        insertDocWithPostings(writer, name, id, ord, fp, concept, layerNames ?? new Set([name]));
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
    writeTransaction((writer) => {
      const seen = new Set(ids);
      const rows = stmts.docsForLayer.all(state.name);
      for (const row of rows) {
        if (!seen.has(row.id)) removeDoc(writer, row.doc);
      }
      const byId = new Map(stmts.docsForLayer.all(state.name).map((row) => [row.id, row]));
      ids.forEach((id, ord) => {
        const row = byId.get(id);
        if (row && row.ord !== ord) stmts.updateDocOrd.run(ord, row.doc);
      });
    });
    withBusyRetry(() => stmts.upsertLayer.run(state.name, state.identity, level ?? 0, gen, proc));
  }

  function sync(contributing) {
    // BEGIN IMMEDIATE (not a plain deferred BEGIN): grabbing the write lock
    // up front means a concurrent writer surfaces as one clean SQLITE_BUSY at
    // the BEGIN itself — caught by withBusyRetry — instead of partway through
    // the loop below after some statements on this connection have run.
    writeTransaction((writer) => {
      const wanted = new Set(contributing.map((view) => view.name));
      for (const view of contributing) syncLayer(writer, view, wanted);
      for (const { name } of stmts.allLayerNames.all()) {
        if (!wanted.has(name)) {
          for (const row of stmts.docsForLayer.all(name)) removeDoc(writer, row.doc);
          stmts.deleteLayer.run(name);
        }
      }
    });
  }

  // averageLength is FIXED_FIELD_COUNT (4) per-concept averages plus ONE
  // aggregate body figure — the mean SECTION length across every section in
  // the corpus (total section terms / total section count), matching
  // buildConceptIndex exactly: a 9-section runbook contributes 9 length
  // samples to that average, not one. Every input is a maintained integer
  // counter, so the ratio is bit-identical to a fresh build's.
  function corpusStats(terms) {
    const totals = {};
    for (const row of stmts.allStats.all()) totals[row.key] = row.value;
    const n = totals.docs ?? 0;
    const averageLength = [
      ...[totals.len0, totals.len1, totals.len2, totals.len3].map((sum) => (n ? (sum ?? 0) / n : 0)),
      totals.secCount ? (totals.secLen ?? 0) / totals.secCount : 0,
    ];
    const documentFrequency = new Map();
    for (const term of terms) {
      const row = stmts.termDf.get(term);
      documentFrequency.set(term, row ? row.df : 0);
    }
    return { total: n, averageLength, documentFrequency };
  }

  /**
   * Decode every posting blob touching a query term into per-candidate
   * frequency structures — the whole point of the segmented layout.
   *
   * A candidate's fixed-field frequencies live in ONE flat Uint32Array of
   * `FIXED_FIELD_COUNT * terms.length` slots; a matched section's live in a
   * Uint32Array of `terms.length`. Nothing allocates per record. Records for
   * documents that no longer exist (tombstones) produce candidates that no
   * `docs` row will match, so they fall out at the row-join below.
   */
  function decodePostings(terms) {
    const termCount = terms.length;
    const termIndex = new Map();
    terms.forEach((term, i) => termIndex.set(term, i));
    const candidates = new Map();
    let decodedRecords = 0;

    for (let ti = 0; ti < termCount; ti += 1) {
      for (const row of stmts.postingsForTerm.all(terms[ti])) {
        const data = row.data;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const total = (data.byteLength / REC_BYTES) | 0;
        let lastDoc = -1;
        let candidate = null;
        for (let r = 0, offset = 0; r < total; r += 1, offset += REC_BYTES) {
          const doc = view.getUint32(offset, true);
          const packed = view.getUint32(offset + 4, true);
          const tf = view.getUint32(offset + 8, true);
          if (doc !== lastDoc) {
            lastDoc = doc;
            candidate = candidates.get(doc);
            if (!candidate) {
              candidate = { fixed: new Uint32Array(FIXED_FIELD_COUNT * termCount), sections: null };
              candidates.set(doc, candidate);
            }
          }
          const kind = packed >>> 24;
          if (kind === KIND_SECTION) {
            let sections = candidate.sections;
            if (!sections) {
              sections = new Map();
              candidate.sections = sections;
            }
            const idx = packed & SLOT_MASK;
            let frequencies = sections.get(idx);
            if (!frequencies) {
              frequencies = new Uint32Array(termCount);
              sections.set(idx, frequencies);
            }
            frequencies[ti] = tf;
          } else {
            candidate.fixed[kind * termCount + ti] = tf;
          }
        }
        decodedRecords += total;
      }
    }
    return { candidates, termIndex, decodedRecords };
  }

  /**
   * The store's counterpart to search.mjs's scoreConceptSections: score every
   * section of a document as its own body candidate and return the max, with
   * the winning section's index and whether the winning score came from an
   * actual section match (`matched`).
   *
   * Unlike scoreConceptSections, this does NOT need every section of the
   * document — only the ones the decoded candidate names (i.e. the ones with
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
   *
   * `fields` is a reusable 5-slot array whose last slot this mutates: one
   * array for the whole search instead of one per section candidate.
   */
  function scoreBestSection(index, fields, entry, candidate, terms, termIndex, sectionLengths) {
    const sections = candidate.sections;
    if (!sections || sections.size === 0) {
      fields[FIXED_FIELD_COUNT] = EMPTY_SECTION_FIELD;
      return { score: scoreEntry(index, entry, terms), sectionIndex: 0, matched: false };
    }
    const indexes = [...sections.keys()].sort((a, b) => a - b);
    let bestScore = -Infinity;
    let bestIndex = 0;
    const field = { frequencies: null, length: 0 };
    fields[FIXED_FIELD_COUNT] = field;
    for (const idx of indexes) {
      field.frequencies = new TermFrequencies(sections.get(idx), 0, termIndex);
      field.length = sectionLengths[idx] ?? 0;
      const score = scoreEntry(index, entry, terms);
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

  /** A document's whole body, exactly as conceptBody concatenates it: the
   * section texts joined with "\n". The store keeps no separate body column
   * — that would double the largest thing in the file for a string it can
   * rebuild from the rows it already has. */
  function bodyFor(doc) {
    return stmts.sectionTextsForDoc.all(doc).map((row) => row.text).join("\n");
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

  function storeBytes() {
    if (path === ":memory:") return null;
    let total = 0;
    for (const suffix of ["", "-wal"]) {
      try {
        total += statSync(`${path}${suffix}`).size;
      } catch {
        // -wal is absent between checkpoints, and the main file is absent
        // only for an in-memory store (handled above) — either way, nothing
        // to add.
      }
    }
    return total;
  }

  return {
    search(contributing, { query, limit = 10, source, type } = {}) {
      const rawTokens = tokenizeQuery(query);
      if (!query || typeof query !== "string" || rawTokens.length === 0) {
        throw new Error("search requires a non-empty query string with at least one searchable token");
      }
      const syncStarted = performance.now();
      sync(contributing);
      const syncMs = performance.now() - syncStarted;
      const terms = [...new Set(analyze(query))];
      const orderLayerNames = levelOrderer(contributing);
      const index = corpusStats(terms);

      // Candidate docs: exactly those with at least one posting among the
      // query terms. A doc outside this set has zero matching term frequency
      // in every field, so scoreEntry would score it 0 and it would be
      // filtered anyway — restricting enumeration to candidates cannot change
      // which hits are returned, only how much of the corpus we touch to
      // find out. No text is read for a non-candidate document, ever.
      const { candidates, termIndex, decodedRecords } = decodePostings(terms);
      if (candidates.size === 0) {
        lastStats = { candidateCount: 0, syncMs, decodedRecords };
        return [];
      }

      const rowsByDoc = new Map();
      for (const row of docsByIds(candidates.keys())) rowsByDoc.set(row.doc, row);
      lastStats = { candidateCount: rowsByDoc.size, syncMs, decodedRecords };

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

      // One 5-slot field array and one entry wrapper for the entire search:
      // scoreEntry only reads them, and scoreBestSection rewrites the body
      // slot per section candidate.
      const fields = new Array(FIXED_FIELD_COUNT + 1);
      const entry = { fields };

      const byId = new Map();
      for (const row of orderedRows) {
        if (sourceIdSet && !sourceIdSet.has(row.id)) continue;
        const candidate = candidates.get(row.doc);
        const lens = [row.len0, row.len1, row.len2, row.len3];
        for (let k = 0; k < FIXED_FIELD_COUNT; k += 1) {
          fields[k] = {
            frequencies: new TermFrequencies(candidate.fixed, k * terms.length, termIndex),
            length: lens[k],
          };
        }
        const sectionLengths = u32ArrayOf(row.seclens);
        const best = scoreBestSection(index, fields, entry, candidate, terms, termIndex, sectionLengths);
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
            snippetSource = bodyFor(doc);
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

    /**
     * What the last search() call cost, for diagnostics: how many candidate
     * documents it scored, how long its sync took, and how many stored
     * posting records it decoded. Read opportunistically (optional chaining)
     * by callers that may hold either backend.
     */
    lastSearchStats() {
      return { ...lastStats };
    },

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
      const totals = {};
      for (const row of stmts.allStats.all()) totals[row.key] = row.value;
      const { n: terms } = db.prepare("SELECT COUNT(*) AS n FROM terms").get();
      const { live } = db.prepare("SELECT COALESCE(SUM(records - dead), 0) AS live FROM segments").get();
      const { n: segments } = stmts.segmentCount.get();
      return {
        documents: totals.docs ?? 0,
        terms,
        postings: Number(live),
        analyzed: analyzedCount,
        bodyReads: bodyReadCount,
        segments,
        storeBytes: storeBytes(),
      };
    },
  };
}
