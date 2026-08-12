// ContextCake engine HTTP service — the embeddable half of the playground
// server. createEngineService() wraps the cascade engine (sources + resolver)
// in a framework-free request handler a host mounts inside its own node:http
// server: the read API (/api/status, /api/graph, /api/resolve,
// /api/resolve-all), the sources CRUD (/api/sources, /api/sources/sync), and an
// optional static mount for a built console app under /console/.
// Dependency-free — plain Node built-ins, like the rest of packages/core.
//
//   const svc = createEngineService({ manifestPath, consoleDist, token, allowMutations });
//   http.createServer(async (req, res) => {
//     if (await svc.handleRequest(req, res)) return; // service wrote the response
//     // ...the host's own routes / 404...
//   });
//
// handleRequest() resolves true when the service handled the request (a
// service-owned /api/* route or a consoleDist path — guard rejections
// included), false to let the host fall through. close() releases adapter
// resources (kills spawned MCP children); reload() re-reads the manifest and
// rebuilds the sources — the CRUD routes call it after every mutation.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { buildSourcesQuarantined, createErrorSource, resolveTokenState } from "./sources/index.mjs";
import { MAX_DOC_BYTES } from "./sources/okf-local.mjs";
import { FILES_EXTENSIONS } from "./sources/files.mjs";
import { createSourceOperations, normalizeRepo } from "./control/sources.mjs";
import { patchSettings, settingsView } from "./control/settings.mjs";
import { withDeadline } from "./control/util.mjs";
import { mergeConcepts, resolveConcept } from "./resolver.mjs";
import { searchConcepts, tokenizeQuery } from "./search.mjs";
import { countTokens, conceptText, warmTokenizer, TOKENIZER } from "./tokenize.mjs";
import { resolveSettings, walkLimitsFrom } from "./settings.mjs";
import {
  assertInsideRoot, guardMutatingRequest, httpError, json, MIME, parseJson, readBody,
} from "./http-util.mjs";
import {
  layerRootMap, listFilesApi, readFileApi, serveRawApi, writeFileApi, writeSectionApi,
  stageSectionTransaction, stageFrontmatterTransaction,
} from "./layer-files.mjs";
import {
  createConflictResolutionLog, createDiscrepancyTransactionJournal, trivialConflictReason,
} from "./conflict-resolutions.mjs";
import { buildDiscrepancies } from "./discrepancies.mjs";
import {
  createDiscrepancyRuleStore, parseRuleDocument, serializeRuleDocument, suggestDiscrepancyRules,
} from "./discrepancy-rules.mjs";
import { createDiscrepancyPriorityStore } from "./discrepancy-priorities.mjs";
import { resolveLiveLayer } from "./sources/git-sync.mjs";
import { commitPathsWithMutation, push as pushGit } from "./sources/git-core.mjs";
import { indexEntryKeys, layerIdentity } from "./index-keys.mjs";
import { memorySnapshot } from "./memory-pressure.mjs";
import {
  getManifestProfileLayers,
  readContextManifestQuarantined,
  stableJson,
  withManifestLockAsync,
} from "./manifest.mjs";

// Re-exported so hosts (apps/playground/server.mjs) keep importing the shared
// HTTP internals from the service, wherever they are actually defined.
export { assertInsideRoot, guardMutatingRequest, httpError, json, MIME, readBody };
export { withDeadline };

// Constant-time bearer comparison (hash both sides so lengths never diverge).
// Parsed without a regex on purpose: `/^Bearer\s+(.+)$/` backtracks
// polynomially (js/polynomial-redos) on an attacker-supplied header full of
// whitespace. This single-pass slice/trim is linear.
function bearerMatches(header, expected) {
  const h = header ?? "";
  if (h.slice(0, 6).toLowerCase() !== "bearer") return false;
  const rest = h.slice(6);
  const token = rest.trim();
  if (!token || rest.length === token.length) return false; // require ≥1 separator space
  const presented = createHash("sha256").update(token).digest();
  const wanted = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(presented, wanted);
}

// ---- background source indexing ---------------------------------------------
//
// Reading a source is the expensive part of the cascade: list every concept,
// parse it, count its tokens. Doing that inside a request meant the first
// /api/graph after setup could take minutes on a big folder, and the app sat
// on a "Resolving…" screen for all of it.
//
// Instead each source is indexed by a background job and every request answers
// from whatever is ready *right now*. A source that is still working reports
// its phase and progress; a source that fails or exceeds its budget reports an
// error. Nothing a request does can block on a slow source — the UI comes up
// immediately and fills in as sources land.

const YIELD_EVERY = 25;
const yieldNow = () => new Promise((resolve) => setImmediate(resolve));

// Reads one source end to end, reporting progress into `entry` as it goes so
// the UI can show "Indexed 340 of 1,500" instead of an opaque spinner.
async function snapshotSource(source, entry, signal = null) {
  const throwIfAborted = () => {
    if (signal?.aborted) throw signal.reason ?? new Error("Indexing cancelled");
  };
  throwIfAborted();
  entry.phase = "scanning";
  // The signal goes INTO the listing, not just around it: scanning a big tree
  // is one long await, so a cancel that only fires between phases leaves the
  // walk running to completion — and a churning layer would stack one live walk
  // per cancelled job. Adapters that ignore the argument are unaffected.
  //
  // `notes` rides along the same way: what a walk had to leave out — a document
  // over the size cap, a subtree it lacks permission to read — belongs on the
  // snapshot, because the row the user sees is built from the snapshot.
  const notes = { skipped: [], unreadable: [], hidden: 0 };
  const ids = typeof source.listConceptIds === "function" ? await source.listConceptIds({ signal, notes }) : [];
  throwIfAborted();
  entry.phase = "loading";
  entry.total = ids.length;
  const concepts = new Map();
  // Per-concept token counts, kept rather than only summed. The index already
  // pays one BPE encode per document, and buildGraph used to pay a second one
  // over the whole merged corpus on every request — 14 seconds on a 139MB
  // vault. Keeping the number here is what makes that rebuild cheap.
  const tokensById = new Map();
  let tokens = 0;
  let n = 0;
  for (const id of ids) {
    throwIfAborted();
    const concept = await source.loadConcept(id);
    throwIfAborted();
    concepts.set(id, concept);
    tokens += tokenizeConcept(source, id, concept, tokensById);
    if (++n % YIELD_EVERY === 0) {
      entry.loaded = n;
      await yieldNow();
    }
  }
  entry.loaded = n;
  // A generation, assigned once, never reused. Snapshots are immutable after
  // this returns, so "same generation" is the same content — which is what lets
  // buildGraph key a memo on live state instead of on invalidation events.
  return {
    ids, concepts, tokens, tokensById, gen: ++SNAPSHOT_SEQ,
    skipped: notes.skipped, unreadable: notes.unreadable, hidden: notes.hidden,
  };
}

let SNAPSHOT_SEQ = 0;

// Count a concept the way the cascade will read it back: through the same
// mergeConcepts the resolver runs, over this source alone. For any concept only
// this source contributes, resolveConcept(id, [thisSource]) reduces to exactly
// this call, so buildGraph can reuse the number verbatim rather than re-encoding
// the text. Exact by construction — not an estimate — because it is the same
// function applied to the same contributor.
//
// This also makes a source's own `tokens` total the count of what it CONTRIBUTES
// rather than of its raw file text: a tombstoned section, a blank-line-padded
// body, two sections sharing an anchor. `sourceTokens` and `resolvedTokens` are
// shown side by side in the UI, and they were previously measured differently.
//
// The raw-text fallback keeps an adapter that returns an unmergeable shape from
// failing the whole index; that concept simply stays out of tokensById and
// buildGraph counts it itself, rather than inheriting a number derived
// differently from every other row.
function tokenizeConcept(source, id, concept, tokensById) {
  try {
    const contributor = {
      layer: source.name,
      level: source.level,
      updated: concept.frontmatter.updated ?? null,
      ...concept,
    };
    const count = countTokens(conceptText(mergeConcepts([contributor])));
    tokensById.set(id, count);
    return count;
  } catch {
    return countTokens(conceptText(concept));
  }
}

// What a source could not read, said in the words a person would use. The
// counts alone would not do: "1 warning" on a vault tells you nothing, and the
// whole failure being fixed here is that a permission-blocked subfolder indexed
// silently partial — the user needs the name of the folder to go unlock it.
function sourceWarnings(snap) {
  if (!snap) return [];
  const mb = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;
  return [
    ...(snap.skipped ?? []).map(
      (item) => `Skipped ${item.rel} — ${mb(item.bytes)} is over the ${mb(MAX_DOC_BYTES)} per-file limit`,
    ),
    ...(snap.unreadable ?? []).map(
      (item) => `Could not read ${item.rel} — permission denied. Documents inside it are missing from this source.`,
    ),
  ];
}

// A source view resolveConcept can consume that serves from the snapshot —
// same name/level, zero further disk or MCP reads.
function snapshotView(source, snap) {
  return {
    name: source.name,
    level: source.level,
    async loadConcept(id) { return snap.concepts.get(id) ?? null; },
  };
}

// The same idea, shaped for search.mjs's adapter contract instead of
// resolveConcept's: searchConcepts walks listConceptIds() itself (it has no
// other way to know what to score), so this view answers that from the
// snapshot's own id list rather than reopening the source it was read from.
function searchSnapshotView(source, snap) {
  return {
    name: source.name,
    level: source.level,
    async listConceptIds() { return snap.ids; },
    async loadConcept(id) { return snap.concepts.get(id) ?? null; },
  };
}

// The identity a memoized read is keyed on: which sources contributed, and
// which generation of each. A snapshot is immutable once assigned, so this
// string changes exactly when an answer built from these sources would —
// shared by every reader of the background index that memoizes on it
// (buildResolvedIndex, search) rather than each re-deriving its own key.
function contributingKey(contributing) {
  return JSON.stringify(contributing.map((p) => [p.source.name, p.source.level, p.snap.gen]));
}

// The watcher must filter exactly what the walk filters, or a file the index
// would never read still costs a full re-index. This is walkDocs' skip rule
// (dot-entries and node_modules), applied to the path fs.watch reports.
// Obsidian rewrites .obsidian/workspace.json every few hundred milliseconds for
// as long as a vault is open, and that one unread file is why a user's vault
// sat at zero concepts indefinitely.
//
// A null filename — macOS can report one — is unknown, not uninteresting. It
// invalidates: a missed edit is a wrong answer, a needless re-index is only
// work.
function isSkippedPath(filename) {
  if (filename == null) return false;
  return String(filename).split(/[\\/]/).some((segment) => segment.startsWith(".") || segment === "node_modules");
}

// The same argument for extensions, but only where the answer is certain — and
// a dot in a name is NOT that.
//
// A directory routinely has one ("Archive 2024.10", "notes.old", "Project.v2"),
// and dragging a folder of notes into a vault delivers exactly one event, for
// the folder, never for the documents inside it. Inferring file-ness from
// path.extname therefore filtered that event out and every document in the
// folder stayed invisible until something else happened to invalidate the
// layer: silent data loss, where the failure mode in the other direction is a
// re-index nobody notices.
//
// So ask the filesystem instead of the string, and only for the events an
// extension check cannot already accept. A path that is GONE by the time we
// look (deleted, renamed away, moved out) counts as a change: whatever it was,
// the index may hold it.
//
// Async because this runs inside the fs.watch callback, on the event loop of a
// service whose whole premise is that no slow source blocks it. One statSync
// against an iCloud, Dropbox or SMB-backed vault — the exact mounts that made
// the per-source budget 120s — stalls every request for the mount's timeout.
// The caller already defers its real work behind a debounce, so awaiting here
// costs nothing.
async function isIndexableFile(root, filename, kind) {
  if (filename == null) return true;
  const extensions = kind === "files" ? FILES_EXTENSIONS : [".md"];
  const ext = path.extname(String(filename).split(/[\\/]/).pop()).toLowerCase();
  if (extensions.includes(ext)) return true;
  try {
    return (await fsp.stat(path.join(root, String(filename)))).isDirectory();
  } catch {
    return true;
  }
}

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

// ---- the service -------------------------------------------------------------

export function createEngineService({
  manifestPath,          // required: path to manifest.json (may not exist yet)
  consoleDist = null,    // optional: dir of a built console app to serve at /console/
  token = null,          // optional: when set, every /api/* request must carry
                         //   Authorization: Bearer <token> — else 401
  allowMutations = true, // when false, mutating /api routes return 405 — except
                         //   POST /api/active-source, a scheduling hint that
                         //   never touches the manifest (see its route handler)
  tokens = {},           // optional: alias -> {secret, host} for remote sources.
                         //   Injected by the caller that owns the OS keychain;
                         //   the engine never reads a keychain itself and never
                         //   returns these over HTTP. See setTokens().
} = {}) {
  if (!manifestPath) throw new Error("createEngineService: manifestPath is required");
  const MANIFEST = path.resolve(manifestPath);
  const MANIFEST_DIR = path.dirname(MANIFEST);
  const CONSOLE_DIR = consoleDist ? path.resolve(consoleDist) : null;
  // Git-backed sources clone next to the manifest that declares them.
  const CACHE_DIR = path.join(MANIFEST_DIR, ".cache", "repos");
  // The service serves the default profile view (see openSources), so its
  // decision history, rules, priorities, and journal are default's — a
  // control operation selecting another profile constructs its own stores.
  const SERVICE_PROFILE_ID = "default";
  const conflictResolutionLog = createConflictResolutionLog(MANIFEST, { profileId: SERVICE_PROFILE_ID });
  const discrepancyTransactionJournal = createDiscrepancyTransactionJournal(MANIFEST, { profileId: SERVICE_PROFILE_ID });
  const discrepancyRuleStore = createDiscrepancyRuleStore(MANIFEST, { profileId: SERVICE_PROFILE_ID });
  const discrepancyPriorityStore = createDiscrepancyPriorityStore(MANIFEST, { profileId: SERVICE_PROFILE_ID });
  // Shared control operations (control/sources.mjs): the CRUD routes below are
  // parsing shims over these. Credentials flow in as a capability so the
  // operations never touch tokenState directly.
  const sourceOps = createSourceOperations({
    manifestPath: MANIFEST,
    gitCredentialsForUrl: (url) => gitCredentialsForUrl(url),
  });
  let discrepancyRecovery = null;
  let automaticTimer = null;
  let automaticTail = Promise.resolve();

  // ---- source lifecycle ------------------------------------------------------
  //
  // One live set of adapters, rebuilt whenever the manifest file changes on
  // disk (a stat per request — cheap) or reload() is called. This keeps the
  // playground's edit-and-refresh semantics: single-concept reads are live,
  // file writes/watchers invalidate aggregate snapshots, and manifest edits
  // (by the CRUD routes or by hand) invalidate the set. Unlike the old per-request
  // rebuild it does NOT re-spawn MCP children on every request — they live
  // until the manifest changes, reload(), or close().

  let closed = false;
  // Credentials for remote sources, and a counter that changes whenever they
  // do. The epoch is load-bearing: an index entry is keyed by its layer's
  // configuration, and connecting an account changes no layer JSON at all — so
  // without it a source indexed anonymously would keep serving that partial
  // index after the token arrived, and look simply empty.
  let tokenState = { tokens: tokens ?? {}, epoch: 0 };
  let cache = null; // { stamp, manifest, settings, sources, keys }
  // Background index entries, keyed by the layer's own configuration so that
  // adding a second source does NOT re-index the first — the common setup flow.
  let indexes = new Map();

  // ---- derived-read caches ---------------------------------------------------
  //
  // Both are keyed by state read live at request time, never invalidated by an
  // event. That is deliberate: an event-driven cache is stale exactly when
  // someone forgets a trigger, and a stale graph is worse than a slow one. A
  // snapshot is immutable once assigned and carries a unique generation, so a
  // key built from the current (name, level, generation) triple cannot outlive
  // what it describes.
  let graphMemo = null;      // { key, promise } — the O(corpus) half of /api/graph
  // { key, hits: Map<"query limit", Promise<hits>> } — GET /api/search. One
  // query against unchanged content answers from the map; the whole map is
  // replaced (not merged) the instant `key` moves, same as graphMemo, because
  // a stale hit list is worse than a slow one. A promise lives in the map
  // before it settles, so two requests for the same query while a build is in
  // flight join it instead of running the corpus scan twice.
  let searchMemo = null;
  const SEARCH_MEMO_CAP = 200; // distinct queries per content generation before the map is dropped, not the search
  let conceptTokens = new Map(); // concept id -> { sig, tokens } for merged concepts
  // Monotonic counter behind /api/status. Bumped whenever the signature of what
  // the heavy routes would return changes, so a client can poll cheaply and
  // refetch only on a real move.
  let generation = 0;
  let generationSig = null;

  // Pay the tokenizer's one-time init at boot, right after creation, instead
  // of blocking the first /api/graph for ~800ms mid-setup.
  setImmediate(warmTokenizer).unref?.();

  function manifestStamp() {
    try {
      const st = fs.statSync(MANIFEST);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "absent"; // manifestPath may not exist yet — surfaced per request
    }
  }

  // The read path's manifest, where a single malformed layer is quarantined
  // rather than fatal: validation used to throw inside every route's
  // openSources(), so one bad layer answered 500 on /api/settings and
  // /api/graph — the two screens a user needs to see the problem and fix it.
  // The quarantined layers are NOT in the manifest this returns: they cannot be
  // built, watched, or reached by the file APIs, only shown as broken rows.
  // Mutations live in control/sources.mjs and read strictly there, so nothing
  // invalid is ever written.
  function readManifestForRead() {
    return readContextManifestQuarantined(MANIFEST, { allowMissing: false });
  }

  // A rebuild (manifest edit, or a CRUD/sync route) must not close the adapter
  // set an in-flight read is still iterating — closing an MCP adapter kills its
  // child and rejects that read's pending calls, silently dropping the source
  // from the response. Defer the close past a grace window so concurrent reads
  // finish on the set they started with. unref so a pending close never holds
  // the process open at exit.
  const CLOSE_GRACE_MS = 15000;
  function deferClose(set) {
    if (!set) return;
    const t = setTimeout(() => { for (const s of set.sources) s.close?.(); }, CLOSE_GRACE_MS);
    t.unref?.();
  }

  function openSources() {
    if (closed) throw httpError(503, "Engine service is closed");
    const stamp = manifestStamp();
    if (cache && cache.stamp === stamp) return cache;
    // Throws while the manifest is missing, unparseable, or broken in a way no
    // single layer explains; a layer that merely fails validation comes back in
    // `quarantined` instead.
    const { manifest: stored, quarantined } = readManifestForRead();
    // ONE profile view of the manifest, built here and nowhere else. Every read
    // this service does — the layers list, buildSources' own internal
    // `manifest.layers` read, the index keys, the index↔layer correlation in
    // ensureIndexes, buildGraph's layerMeta, syncSourceApi's lookup, the
    // watcher roots, and layerRootMap for the file APIs — flows from
    // `cache.manifest`, so pointing them all at this view is what keeps a v2
    // manifest (profiles.default) and the flat manifest it migrated from
    // producing identical service responses. Mutation routes deliberately keep
    // re-reading the stored manifest through the profile-aware helpers.
    const manifest = { ...stored, layers: getManifestProfileLayers(stored) };
    const settings = resolveSettings(manifest);
    const layers = manifest.layers;
    // Only the profile this service actually reads. A layer quarantined out of
    // some other profile's stack has no row here because it has no source here.
    const broken = quarantined.filter((entry) => entry.profileId === "default");
    // What each row *reads*, with the two fields that only decide how it is
    // presented left out. See layerIdentity().
    const rows = [
      ...layers.map((layer) => ({
        name: layer.name,
        identity: layerIdentity(layer),
        // A token that arrives after an anonymous GitHub index must invalidate
        // that index, but connecting an account must not rescan every local
        // folder and MCP graph in the cascade.
        epoch: layer.source === "github" && layer.auth ? tokenState.epoch : 0,
      })),
      // A quarantined layer reads nothing, so its "identity" is the complaint
      // itself: stable across rebuilds (no needless restart) and distinct per
      // row (two broken layers never share one index entry).
      ...broken.map((entry) => ({
        name: entry.name,
        identity: stableJson({ quarantined: entry.name, error: entry.error }),
        epoch: 0,
      })),
    ];
    // Two strings per row, and they are not the same string: `validities` says
    // whether a finished entry is still a correct index of this layer (so it
    // can be carried across a re-key), `keys` says which row owns it. See
    // index-keys.mjs.
    const { validities, keys } = indexEntryKeys(rows, settings);
    const next = {
      stamp,
      manifest,
      settings,
      validities,
      // Appended, never interleaved: `manifest.layers` holds the valid layers
      // alone — it is what feeds the watchers and the file APIs' sandbox roots —
      // so a broken layer's path must not reach it. The stubs ride alongside in
      // the source list purely so the index gives each one an error row.
      sources: [
        ...buildSourcesQuarantined(manifest, MANIFEST_DIR, { tokens: tokenState.tokens }),
        ...broken.map((entry) => createErrorSource({ ...entry, quarantined: true })),
      ],
      keys,
    };
    const prev = cache;
    cache = next;
    deferClose(prev);
    // Carry entries this rebuild orphaned over to the row that still wants
    // them, and drop the rest.
    adoptIndexes(next);
    // Deferred: syncWatchers calls openSources() itself, and cache is now set,
    // so this returns immediately rather than recursing.
    queueMicrotask(() => { try { syncWatchers(); } catch { /* watching is best effort */ } });
    return next;
  }

  function getSources() {
    return openSources().sources;
  }

  function reload() {
    const prev = cache;
    cache = null;
    deferClose(prev);
    return getSources();
  }

  // Replace the injected credentials wholesale (connect, disconnect, or an
  // account switch). Bumping the epoch before the rebuild is what makes the
  // affected sources re-index against their new auth rather than keep serving
  // the index they built without it. Never logged, never echoed back.
  function setTokens(next) {
    tokenState = { tokens: next ?? {}, epoch: tokenState.epoch + 1 };
    if (closed) return;
    reload();
  }

  function close() {
    closed = true;
    clearTimeout(automaticTimer);
    automaticTimer = null;
    clearTimeout(memoryRetryTimer);
    memoryRetryTimer = null;
    closeWatchers();
    const prev = cache;
    cache = null;
    for (const entry of indexes.values()) entry.cancel?.();
    indexes = new Map();
    graphMemo = null;
    searchMemo = null;
    conceptTokens = new Map();
    if (prev) for (const s of prev.sources) s.close?.();
  }

  // ---- indexing concurrency --------------------------------------------------
  //
  // ensureIndexes used to call startIndex for every source with nothing
  // throttling how many ran at once — a manifest with a dozen layers meant a
  // dozen simultaneous folder walks, git clones, and MCP child spawns
  // competing for disk and CPU the instant the app opened. The queue below
  // makes `maxConcurrentIndexing` (settings.mjs) real: a pass waits here,
  // reported as `phase: "queued"`, until a slot frees up.
  //
  // Bounds when a NEW pass may start, not how long an already-running one
  // stays alive: a pass that blows its time budget frees its slot the moment
  // `withDeadline` rejects (see releaseIndexSlot below), but the abandoned
  // `listConceptIds()` call underneath keeps running until IT notices the
  // abort. okf-local's walk checks the signal every directory; github.mjs and
  // mcp.mjs currently don't check it at all during listing, so a timed-out
  // remote source's scanning phase can keep running in the background after
  // its slot — and the queued source that took it — have both moved on. Wiring
  // signal support into those two adapters would close that gap; out of scope
  // here since it touches files this change otherwise doesn't.
  //
  // Queueing costs nothing for a refreshing source — it keeps serving
  // `previousSnap` and stays `status: "ready"` the whole time, exactly as
  // before.
  let runningIndexCount = 0;
  const indexQueue = []; // { sourceName, run }
  // A hint from the client (setActiveSource) naming the layer currently on
  // screen. Purely a scheduling tie-breaker — never rejected, never required —
  // so the source the user is looking at claims the next free slot instead of
  // waiting behind background layers it arrived after.
  let activeSourceName = null;
  // Set while a memory-pressure retry is pending, so a burst of releases and
  // enqueues under sustained pressure doesn't stack one timer per call.
  let memoryRetryTimer = null;
  const MEMORY_RETRY_MS = 1500;

  function pumpIndexQueue(limit) {
    // Floored at 1 regardless of what `limit` says: settings.mjs's env-var
    // path rounds rather than rejects (CONTEXTCAKE_MAX_CONCURRENT_INDEXING=0.4
    // resolves to 0), and a cap of 0 would mean nothing ever starts, forever
    // — the queue would accept work and never drain it.
    const normalCap = Math.max(1, limit);
    // Under critical memory pressure, no NEW pass may start — a pass already
    // running is left to finish (aborting mid-walk loses the work it already
    // paid for and frees nothing until GC runs anyway). At least one pass is
    // still allowed through even under pressure: with `runningIndexCount` at
    // 0 the alternative is the queue simply never draining, since nothing
    // already in flight exists to trigger the next pump via releaseIndexSlot.
    const cap = memorySnapshot().level === "critical"
      ? Math.min(normalCap, runningIndexCount > 0 ? runningIndexCount : 1)
      : normalCap;
    while (runningIndexCount < cap && indexQueue.length) {
      let i = 0;
      if (activeSourceName) {
        const preferred = indexQueue.findIndex((item) => item.sourceName === activeSourceName);
        if (preferred !== -1) i = preferred;
      }
      const [item] = indexQueue.splice(i, 1);
      runningIndexCount += 1;
      item.run();
    }
    // Only pressure can leave work queued here with nothing running to
    // trigger the next pump via releaseIndexSlot — ordinary saturation at the
    // configured limit already gets re-pumped for free the moment any
    // in-flight pass finishes, so arming a timer for that case would just be
    // a redundant wakeup that never actually did anything pressure-related.
    if (indexQueue.length && cap < normalCap && runningIndexCount >= cap && !memoryRetryTimer) {
      memoryRetryTimer = setTimeout(() => {
        memoryRetryTimer = null;
        pumpIndexQueue(limit);
      }, MEMORY_RETRY_MS);
      memoryRetryTimer.unref?.();
    }
  }

  function releaseIndexSlot(limit) {
    runningIndexCount = Math.max(0, runningIndexCount - 1);
    pumpIndexQueue(limit);
  }

  // Resolves once a concurrency slot is free. A signal that aborts while still
  // queued removes the waiter and rejects without ever occupying a slot — a
  // source cancelled or superseded before its turn never touches disk.
  function acquireIndexSlot(sourceName, signal, limit) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error("Indexing cancelled")); return; }
      const item = {
        sourceName,
        run: () => { signal?.removeEventListener?.("abort", onAbort); resolve(); },
      };
      const onAbort = () => {
        const i = indexQueue.indexOf(item);
        if (i !== -1) indexQueue.splice(i, 1);
        reject(signal.reason ?? new Error("Indexing cancelled"));
      };
      signal?.addEventListener?.("abort", onAbort);
      indexQueue.push(item);
      pumpIndexQueue(limit);
    });
  }

  // Called by the /api/active-source route. Re-pumps immediately so the newly
  // preferred source can jump a queue it was already waiting in. Clamped to a
  // real layer-name length: it is only ever compared with === against a
  // source's own name, never used as a path or a key, so an oversized value
  // can't do anything but sit in memory for no reason.
  function setActiveSource(name) {
    activeSourceName = typeof name === "string" && name ? name.slice(0, 200) : null;
    try { pumpIndexQueue(openSources().settings.maxConcurrentIndexing); } catch { /* no manifest yet */ }
  }

  // ---- background index ------------------------------------------------------

  /**
   * Re-home index entries this rebuild orphaned, and drop the ones nothing
   * wants.
   *
   * An entry is orphaned when its key is no longer in the live set, which does
   * NOT mean it is worthless: the key carries the layer row (its name) as well
   * as what the layer reads, so renaming a source orphans an entry that is
   * still a perfectly correct index of that source. Such an entry is MOVED to
   * the new key — snapshot, status, and any pass still in flight — rather than
   * mined for its snapshot and restarted. The rename costs nothing at all,
   * which is the point: re-reading a 3,000-note vault because the user edited
   * its label is the bug this whole split exists to prevent.
   *
   * The match is on `validity`, which is what makes the handoff safe rather
   * than merely convenient. Validity carries the indexing settings and the
   * credential epoch, so an entry orphaned BY a policy change — a lowered
   * document cap, a disconnected account — never matches anything and is
   * dropped. It has to be: its answer was produced under rules the user has
   * since changed, and handing it forward served a pre-change answer as if it
   * were current (indefinitely, when the re-index then failed) and kept
   * serving a private repo's content after Disconnect.
   *
   * Entries move before any caller can observe the rebuild, so there is no
   * window in which one consumer sees the handoff and another misses it.
   */
  function adoptIndexes(next) {
    const live = new Set(next.keys);
    // Live rows with no entry yet, grouped by what would make an orphan valid
    // for them. Rows that already have an entry are not looking for one.
    const wanted = new Map();
    next.keys.forEach((key, i) => {
      if (indexes.has(key)) return;
      const validity = next.validities[i];
      if (!wanted.has(validity)) wanted.set(validity, []);
      wanted.get(validity).push(key);
    });
    for (const key of [...indexes.keys()]) {
      if (live.has(key)) continue;
      const entry = indexes.get(key);
      indexes.delete(key);
      const claim = entry?.validity != null ? wanted.get(entry.validity)?.shift() : undefined;
      if (claim === undefined) {
        entry?.cancel?.();
        continue;
      }
      // The entry's own completion handlers find themselves through
      // `entry.key`, so a move is a single assignment rather than a rebind.
      entry.key = claim;
      indexes.set(claim, entry);
    }
  }

  /**
   * The current index entry for every source, starting background jobs for any
   * source that doesn't have one yet. Never awaits a job — callers read
   * whatever state exists right now.
   */
  function ensureIndexes() {
    const open = openSources();
    const entries = open.sources.map((source, i) => {
      const key = open.keys[i];
      let entry = indexes.get(key);
      if (!entry) {
        // Nothing to inherit: an entry that could legitimately have been
        // inherited was already moved here by adoptIndexes, before any caller
        // reached this function. A row with no entry at this point is a row
        // whose previous answer is not valid any more, and an empty source
        // being re-read is the honest way to say so.
        entry = startIndex(source, key, open.settings, { validity: open.validities[i] });
        indexes.set(key, entry);
      }
      return { source, key, entry, layer: (open.manifest.layers ?? [])[i] ?? {} };
    });
    return { ...open, entries };
  }

  /**
   * Start one index pass over one source.
   *
   * `previousSnap` keeps the last good answer readable while a re-index runs,
   * so a file edit refreshes the cascade without the UI blinking to empty —
   * and, because that answer is genuinely usable, a pass with one does NOT
   * report the source as `indexing`. It stays `ready` and raises `refreshing`
   * alongside it: the data stays usable and the status stays honest while work
   * proceeds in the background. Only a source with nothing to serve is
   * `indexing`, which is the one case where a client has a reason to wait.
   *
   * `dirty` is the coalesce flag: an invalidation that arrives mid-pass sets it
   * instead of cancelling, and the entry owes exactly one follow-up when this
   * pass lands (see scheduleFollowUp for when it actually runs).
   */
  function startIndex(source, key, settings, {
    validity = null, previousSnap = null, previousSuccessAt = null, previousHealth = null, passes = 1,
  } = {}) {
    const controller = new AbortController();
    const refreshing = previousSnap !== null;
    const entry = {
      key,
      status: refreshing ? "ready" : "indexing",
      phase: refreshing ? "ready" : "queued",
      loaded: 0,
      total: null,
      snap: previousSnap,
      // Carried across a refresh/rename the same way `snap` is, so a source
      // with no health() of its own does not forget its last real success the
      // moment a follow-up pass starts.
      lastSuccessAt: previousSuccessAt,
      // Adapter instances are rebuilt after manifest mutations, while a valid
      // index entry is deliberately adopted without re-reading. Preserve the
      // health observation that belongs to that snapshot so an unrelated
      // source add/remove cannot temporarily repaint a failed remote as ok.
      lastHealth: previousHealth,
      validity,
      // Whether a pass is in flight, tracked separately from `status` — which
      // now says "ready" through a background refresh — because every decision
      // about coalescing and waiting is about the PASS, not about whether the
      // source can be read.
      running: true,
      refreshing,
      passes,
      dirty: false,
      followUp: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      cancel: () => {
        clearTimeout(entry.followUp);
        entry.followUp = null;
        controller.abort(new Error("Indexing superseded"));
      },
    };
    const budget = settings.sourceBudgetMs;
    const limit = settings.maxConcurrentIndexing;
    acquireIndexSlot(source.name, controller.signal, limit)
      .then(() => {
        // One line per pass, on stderr with the other diagnostics. In the
        // desktop app these land in ~/Library/Logs/ContextCake/engine.log,
        // which is what makes "which source was the engine reading when it
        // died" answerable after the fact.
        console.error(`[index] ${source.name}: pass ${entry.passes} start${refreshing ? " (refresh)" : ""}`);
        return withDeadline(
          snapshotSource(source, entry, controller.signal),
          budget,
          `Indexing took longer than ${Math.round(budget / 1000)}s. Raise the time budget in Settings, or point this source at a smaller folder.`,
          () => controller.abort(new Error("Indexing timed out")),
        ).finally(() => releaseIndexSlot(limit));
      })
      .then((snap) => {
        if (indexes.get(entry.key) !== entry) return; // superseded by a newer config
        entry.snap = snap;
        entry.status = "ready";
        entry.phase = "ready";
        // A pass resolving is not proof the source was actually reachable —
        // sources/github.mjs (and any adapter with health()) warn-and-continue
        // on an API failure, returning [] rather than throwing, so the promise
        // above still fulfills against a down repo. Only stamp our own record
        // of success when the adapter's health() agrees the underlying read
        // worked; a source with no health() of its own (okf-local, files) has
        // no such signal to defer to, so it stamps unconditionally as before.
        const health = typeof source.health === "function" ? source.health() : null;
        if (health) entry.lastHealth = health;
        if (!health || health.ok !== false) entry.lastSuccessAt = new Date().toISOString();
        console.error(`[index] ${source.name}: pass ${entry.passes} done in ${Date.now() - entry.startedAt}ms — ${snap.ids.length} concepts`);
      })
      .catch((err) => {
        if (indexes.get(entry.key) !== entry) return;
        entry.status = "error";
        entry.phase = "error";
        entry.error = err.message;
        console.error(`[index] ${source.name}: pass ${entry.passes} failed after ${Date.now() - entry.startedAt}ms — ${err.message}`);
      })
      .finally(() => {
        entry.running = false;
        entry.refreshing = false;
        entry.finishedAt = Date.now();
        // Whatever changed on disk while this pass ran is not in the snapshot
        // it just produced, so exactly one more pass is owed — after a failure
        // too, where the change may well be the fix.
        if (indexes.get(entry.key) === entry && entry.dirty) {
          entry.dirty = false;
          scheduleFollowUp(entry);
        }
        scheduleAutomaticRules();
      });
    return entry;
  }

  /**
   * How long an entry must go untouched before the follow-up pass it owes
   * actually runs.
   *
   * Without a gate, a source under sustained editing chains passes forever:
   * every pass is dirtied before it finishes, so it starts another, and each
   * one is a full re-walk and re-read of every document in the layer. A user
   * typing in an open vault got a pegged core and continuous disk I/O for as
   * long as they kept typing — measurably: a 3,000-note vault under a 300ms
   * rewrite of one real .md never settled in 25 seconds.
   *
   * The interval is the last pass's own duration, floored and capped. That
   * bounds re-index work to roughly half the wall clock under ANY churn rate,
   * without guessing an editor's autosave cadence: a big vault (seconds per
   * pass) waits seconds, a small one (tens of milliseconds) waits the floor and
   * still feels immediate. The floor is comfortably above the watcher's own
   * 250ms debounce so the two do not fight.
   */
  const FOLLOW_UP_MIN_QUIET_MS = 1000;
  const FOLLOW_UP_MAX_QUIET_MS = 15000;
  function followUpQuietMs(entry) {
    const lastPassMs = (entry.finishedAt ?? Date.now()) - entry.startedAt;
    return Math.min(FOLLOW_UP_MAX_QUIET_MS, Math.max(FOLLOW_UP_MIN_QUIET_MS, lastPassMs));
  }

  // Arm (or re-arm) the follow-up. Every further invalidation pushes the window
  // back, so a burst of edits costs one extra pass once it ends rather than one
  // pass per edit while it continues.
  function scheduleFollowUp(entry) {
    clearTimeout(entry.followUp);
    const quiet = followUpQuietMs(entry);
    entry.followUp = setTimeout(() => {
      entry.followUp = null;
      restartIndex(entry);
    }, quiet);
    entry.followUp.unref?.();
  }

  // The follow-up pass a coalesced invalidation asked for. The adapter is
  // re-resolved from the current source set rather than reused: a rebuild may
  // have replaced it while the finished job ran, and deferClose kills the old
  // set's MCP children fifteen seconds later.
  function restartIndex(entry) {
    if (closed) return;
    let open;
    try { open = openSources(); } catch { return; } // manifest unreadable — nothing to refresh
    const key = entry.key; // openSources may have adopted this entry under a new one
    if (indexes.get(key) !== entry) return; // dropped or superseded while we looked
    const i = open.keys.indexOf(key);
    if (i === -1) return; // the layer this index belonged to is gone
    indexes.set(key, startIndex(open.sources[i], key, open.settings, {
      validity: open.validities[i],
      previousSnap: entry.snap,
      previousSuccessAt: entry.lastSuccessAt,
      previousHealth: entry.lastHealth,
      passes: entry.passes + 1,
    }));
  }

  /**
   * Wait (up to `ms`) for every source to finish indexing. Requests never call
   * this by default — it exists for clients that explicitly ask (`?wait=`) and
   * for tests that need a settled graph to assert on.
   *
   * Settled means no pass running and none owed, not `status !== "indexing"`:
   * a background refresh reports `ready` throughout, and a caller that asks to
   * wait is asking for the answer AFTER the change it just made, not for
   * whatever was current before it.
   */
  async function awaitIndexes(ms) {
    const deadline = Date.now() + Math.max(0, ms);
    for (;;) {
      const { entries } = ensureIndexes();
      if (!entries.some((e) => e.entry.running || e.entry.followUp)) return;
      if (Date.now() >= deadline) return;
      await sleep(25);
    }
  }

  // How long a client asked us to wait for indexing before answering. Bounded
  // by the source budget so `?wait=` can never become a new way to hang.
  function waitParam(url) {
    const raw = Number(url.searchParams.get("wait"));
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    const { settings } = openSources();
    return Math.min(raw, settings.sourceBudgetMs);
  }

  /**
   * Re-read one layer's sources because its content changed on disk.
   *
   * The index is a snapshot, so without this a saved edit would never reach
   * /api/graph or /api/resolve-all: the manifest is untouched, so the index
   * key is unchanged and the stale entry would be reused forever. Serving the
   * previous snapshot meanwhile keeps reads answering during the re-read.
   *
   * `layerName` null re-indexes every layer (a section write can touch several).
   *
   * An invalidation that lands mid-index does NOT cancel the running pass: it
   * marks the entry dirty and the job owes one follow-up when it lands. A
   * cancel-and-restart is fine for a single save but catastrophic under a
   * source that writes continuously — an open Obsidian vault rewrites its
   * app-state file every few hundred milliseconds, which is shorter than any
   * real index takes, so the job restarted forever and the source never
   * reached ready. Filtering the watcher (see onChange) keeps that particular
   * churn out; coalescing is what makes a restart storm impossible rather than
   * merely unlikely, for the genuine edits a filter must let through.
   *
   * Three states, and only the last of them starts work now: a pass is running
   * (coalesce into it), a follow-up is already waiting out its quiet period
   * (push the window back — this is what keeps sustained editing from chaining
   * full re-reads), or the entry is idle (refresh it immediately, so a single
   * save lands promptly).
   */
  function invalidateIndex(layerName = null) {
    if (closed) return;
    let open;
    try { open = openSources(); } catch { return; } // manifest unreadable — nothing to refresh
    open.sources.forEach((source, i) => {
      if (layerName !== null && source.name !== layerName) return;
      const key = open.keys[i];
      const previous = indexes.get(key);
      if (previous?.running) {
        previous.dirty = true;
        return;
      }
      if (previous?.followUp) {
        scheduleFollowUp(previous);
        return;
      }
      indexes.set(key, startIndex(source, key, open.settings, {
        validity: open.validities[i],
        previousSnap: previous?.snap ?? null,
        previousSuccessAt: previous?.lastSuccessAt ?? null,
        previousHealth: previous?.lastHealth ?? null,
        passes: (previous?.passes ?? 0) + 1,
      }));
    });
  }

  // Disk-backed layers can also change from outside the app — someone edits a
  // note in Obsidian or pulls a repo. Watch each layer root and re-index on
  // change, debounced so a burst of writes costs one pass. Recursive watching
  // is supported on macOS, Windows and (since Node 20.13) Linux, so nested
  // events reach us on every platform the app ships to; the non-recursive
  // fallback below is for a host that cannot give us a recursive watch at all
  // — inotify exhaustion is the realistic way in — and it says so out loud,
  // because in that state an edit inside a subfolder is silently never noticed.
  // Best effort either way: every write through this service invalidates
  // explicitly (above), so the watcher is a convenience, never the only path to
  // freshness.
  const watchers = new Map(); // root -> { watcher, timer }
  const WATCH_DEBOUNCE_MS = 250;

  function syncWatchers() {
    // Keyed by root alone. The layer NAME is resolved when an event fires, not
    // captured here: a watcher installed before a rename would otherwise keep
    // invalidating a name that no longer matches any source, and edits to a
    // renamed layer would stop reaching the index entirely.
    const roots = new Set();
    for (const [, { root }] of layerRootMap(openSources().manifest, MANIFEST_DIR)) roots.add(root);
    for (const [root, state] of watchers) {
      if (roots.has(root)) continue;
      clearTimeout(state.timer);
      try { state.watcher.close(); } catch { /* already gone */ }
      watchers.delete(root);
    }
    for (const root of roots) {
      if (watchers.has(root)) continue;
      let watcher;
      // onChange is async and must never reject into the watcher: an unhandled
      // rejection here would take the whole service down over one fs event.
      const notify = (_event, filename) => { onChange(root, filename).catch(() => {}); };
      try {
        watcher = fs.watch(root, { recursive: true, persistent: false }, notify);
      } catch (err) {
        try {
          watcher = fs.watch(root, { persistent: false }, notify);
          console.error(`[service watcher] ${root}: recursive watching unavailable (${err.message}) — edits in subfolders will not refresh this layer until it is re-read`);
        } catch {
          continue; // unwatchable (missing, permissions, descriptor limits) — reads still work
        }
      }
      watcher.on("error", () => {});
      watchers.set(root, { watcher, timer: null });
    }
  }

  // Which layer currently reads this root, per the manifest as it stands now.
  function layerAtRoot(root) {
    let manifest;
    try { manifest = openSources().manifest; } catch { return null; }
    for (const [name, entry] of layerRootMap(manifest, MANIFEST_DIR)) {
      if (entry.root === root) return { name, kind: entry.kind };
    }
    return null;
  }

  async function onChange(root, filename) {
    if (!watchers.has(root)) return;
    if (isSkippedPath(filename)) return;
    const layer = layerAtRoot(root);
    if (!layer) return; // no source reads this root any more; syncWatchers drops the watcher
    if (!(await isIndexableFile(root, filename, layer.kind))) return;
    // Re-read after the await: the watcher can be dropped (source removed,
    // service closed) while the filesystem is answering.
    const state = watchers.get(root);
    if (!state) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const current = layerAtRoot(root);
      if (current) invalidateIndex(current.name);
    }, WATCH_DEBOUNCE_MS);
    state.timer.unref?.();
  }

  function closeWatchers() {
    for (const [, state] of watchers) {
      clearTimeout(state.timer);
      try { state.watcher.close(); } catch { /* already gone */ }
    }
    watchers.clear();
  }

  function indexProgress(entry) {
    return {
      status: entry.status,
      phase: entry.phase,
      loaded: entry.loaded,
      total: entry.total,
      elapsedMs: (entry.finishedAt ?? Date.now()) - entry.startedAt,
      // Additive, and orthogonal to `status`: this source is serving a good
      // snapshot AND re-reading in the background. A client that ignores it
      // sees exactly what it saw before — a ready source — which is the point.
      refreshing: entry.refreshing === true,
      // How many passes this entry has run, carried across refreshes. Cheap to
      // report and the only way to see a re-index storm from outside.
      passes: entry.passes ?? 1,
    };
  }

  /**
   * One observation of one source, taken at a single instant.
   *
   * Every field a payload reports about a source, and every field the
   * generation counter is computed from, has to be read here rather than off
   * the live entry — because /api/graph awaits a resolve in the middle of
   * building its payload, and index state moves during that await. Reading the
   * rows before it and the generation after it shipped a payload from time T
   * stamped with a generation from T+D: the client stored that number, the next
   * /api/status computed the same one, and the refetch that would have shown
   * the source that landed mid-build never happened. The source sat at zero
   * concepts until something else moved.
   */
  function pinEntry({ source, entry }) {
    const currentHealth = typeof source.health === "function" ? source.health() : null;
    const healthObserved = currentHealth?.lastErrorAt != null || currentHealth?.lastSuccessAt != null;
    return {
      source, // the adapter, which is stable; the live `entry` is deliberately absent
      snap: entry.snap,
      status: entry.status === "ready" ? "ok" : entry.status,
      error: entry.error,
      progress: indexProgress(entry),
      health: healthObserved ? currentHealth : entry.lastHealth ?? currentHealth,
      // The index's own record of the last successful pass, kept for sources
      // with no health() of their own (okf-local, files): without it a local
      // layer's lastSuccessAt read null forever, even after every index since
      // boot succeeded, because health (the field graph/status prefer first)
      // never exists for those adapters.
      lastSuccessAt: entry.lastSuccessAt,
    };
  }

  // ---- request dispatch ------------------------------------------------------

  async function handleRequest(req, res) {
    if (closed) return false;
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
    } catch {
      json(res, 400, { error: "Bad request URL" }); // unparseable Host/target — nothing to route on
      return true;
    }
    const p = url.pathname;
    const isApi = p === "/api" || p.startsWith("/api/");
    const isConsole = CONSOLE_DIR !== null && (p === "/console" || p.startsWith("/console/"));
    if (!isApi && !isConsole) return false;
    try {
      // DNS-rebinding + CSRF guard on anything state-changing, before routing.
      if (guardMutatingRequest(req, res)) return true;

      if (isConsole) { serveConsole(p, res); return true; }

      // Bearer auth: when a token is configured it gates EVERY /api/* request,
      // reads and unknown paths included, so extra routes a host mounts behind
      // this check are never reachable without the token. token: null (the
      // playground's local same-origin workbench) skips the gate.
      if (token !== null && !bearerMatches(req.headers.authorization, token)) {
        res.setHeader("www-authenticate", "Bearer");
        json(res, 401, { error: "Unauthorized" });
        return true;
      }

      if (p === "/api/graph") { json(res, 200, await buildGraph(waitParam(url))); return true; }
      if (p === "/api/status") { json(res, 200, statusApi()); return true; }
      if (p === "/api/resolve") { json(res, 200, await resolveOne(url.searchParams.get("concept"))); return true; }
      if (p === "/api/resolve-all") { json(res, 200, await resolveAllApi(waitParam(url))); return true; }
      if (p === "/api/search") { json(res, 200, await searchApi(url, waitParam(url))); return true; }
      if (p === "/api/discrepancies" && req.method === "GET") {
        json(res, 200, await discrepanciesApi(waitParam(url)));
        return true;
      }
      if (p === "/api/discrepancies" && req.method === "PATCH") {
        if (!allowMutations) { json(res, 405, { error: "Mutations are disabled on this service" }); return true; }
        const id = url.searchParams.get("id");
        if (!id) throw httpError(400, "Provide ?id=<discrepancy-id>");
        const body = parseJson(await readBody(req));
        try {
          const priority = await withManifestLockAsync(MANIFEST, () => discrepancyPriorityStore.set(id, body.priority));
          json(res, 200, { id, priority });
        } catch (error) { throw httpError(400, error.message); }
        return true;
      }
      if (p === "/api/discrepancy-decisions" && req.method === "POST") {
        if (!allowMutations) { json(res, 405, { error: "Mutations are disabled on this service" }); return true; }
        const rawBody = await readBody(req);
        json(res, 200, await withManifestLockAsync(MANIFEST, () => decideDiscrepancyApi(rawBody)));
        return true;
      }
      if (p === "/api/discrepancy-rules") {
        if (req.method === "GET") { json(res, 200, await discrepancyRulesApi()); return true; }
        if (req.method === "POST") {
          if (!allowMutations) { json(res, 405, { error: "Mutations are disabled on this service" }); return true; }
          const body = parseJson(await readBody(req));
          const rule = await withManifestLockAsync(MANIFEST, async () => {
            // Re-evaluate evidence inside the same lock used by decisions so a
            // reversal cannot race approval after the preview was shown.
            const available = await discrepancyRulesApi();
            const suggestion = available.suggestions.find((item) => item.id === body.suggestionId);
            if (!suggestion) throw httpError(409, "That rule suggestion is no longer supported by three consistent decisions");
            return discrepancyRuleStore.create(suggestion);
          });
          json(res, 200, { rule });
          return true;
        }
        if (req.method === "PATCH") {
          if (!allowMutations) { json(res, 405, { error: "Mutations are disabled on this service" }); return true; }
          const id = url.searchParams.get("id");
          if (!id) throw httpError(400, "Provide ?id=<rule-id>");
          const body = parseJson(await readBody(req));
          try { json(res, 200, { rule: await withManifestLockAsync(MANIFEST, () => patchDiscrepancyRule(id, body)) }); }
          catch (error) { throw httpError(error.status ?? 400, error.message); }
          return true;
        }
      }
      if (p === "/api/discrepancy-rules/promote" && req.method === "POST") {
        if (!allowMutations) { json(res, 405, { error: "Mutations are disabled on this service" }); return true; }
        json(res, 200, await promoteDiscrepancyRule(parseJson(await readBody(req))));
        return true;
      }
      if (p === "/api/conflict-resolutions") {
        if (req.method === "GET") { json(res, 200, { resolutions: await conflictResolutionLog.list() }); return true; }
        if (req.method === "POST") {
          if (!allowMutations) { json(res, 405, { error: "Mutations are disabled on this service" }); return true; }
          const rawBody = await readBody(req);
          json(res, 200, await withManifestLockAsync(MANIFEST, () => resolveConflictApi(rawBody)));
          return true;
        }
      }
      if (p === "/api/settings") {
        if (req.method === "GET") { json(res, 200, getSettingsApi()); return true; }
        if (req.method === "PATCH" || req.method === "PUT") {
          if (!allowMutations) { json(res, 405, { error: "Mutations are disabled on this service" }); return true; }
          json(res, 200, patchSettingsApi(await readBody(req)));
          return true;
        }
      }
      if (p === "/api/active-source" && req.method === "POST") {
        // A scheduling hint, not a mutation: which layer the client currently
        // has on screen, so it claims the next free indexing slot instead of
        // waiting behind sources the user isn't looking at. Never persisted,
        // never gated by allowMutations — nothing here touches the manifest.
        const body = parseJson(await readBody(req));
        setActiveSource(typeof body?.name === "string" ? body.name : null);
        json(res, 200, { ok: true });
        return true;
      }
      if (p === "/api/files") { json(res, 200, await listFilesApi(fileRoots(), walkLimits())); return true; }
      if (p === "/api/file") {
        if (req.method === "PUT" || req.method === "POST") {
          if (!allowMutations) { json(res, 405, { error: "Mutations are disabled on this service" }); return true; }
          const out = await writeFileApi(await readBody(req), fileRoots());
          // The edited file IS layer content, and the manifest did not change,
          // so the index would otherwise keep serving the pre-edit snapshot.
          invalidateIndex(out.layer ?? null);
          json(res, 200, out);
          return true;
        }
        json(res, 200, await readFileApi(url.searchParams.get("path"), fileRoots()));
        return true;
      }
      if (p === "/api/file/raw") { serveRawApi(url.searchParams.get("path"), fileRoots(), res); return true; }
      if (p === "/api/section" && (req.method === "PUT" || req.method === "POST")) {
        if (!allowMutations) { json(res, 405, { error: "Mutations are disabled on this service" }); return true; }
        const out = await writeSectionApi(await readBody(req), fileRoots());
        invalidateIndex(); // a section write can touch several layers at once
        json(res, 200, out);
        return true;
      }
      if (p === "/api/sources" && (req.method === "POST" || req.method === "DELETE" || req.method === "PATCH")) {
        if (!allowMutations) { json(res, 405, { error: "Mutations are disabled on this service" }); return true; }
        if (req.method === "POST") { json(res, 200, await addSourceApi(await readBody(req))); return true; }
        if (req.method === "DELETE") { json(res, 200, removeSourceApi(url.searchParams.getAll("name"))); return true; }
        json(res, 200, await patchSourceApi(await readBody(req)));
        return true;
      }
      if (p === "/api/sources/sync" && req.method === "POST") {
        if (!allowMutations) { json(res, 405, { error: "Mutations are disabled on this service" }); return true; }
        json(res, 200, await syncSourceApi(url.searchParams.get("name")));
        return true;
      }
      return false; // an /api/* route this service doesn't own (e.g. the playground's editor endpoints)
    } catch (err) {
      json(res, err.status ?? 500, { error: err.message, ...(err.detail ?? {}) });
      return true;
    }
  }

  // ---- read API ---------------------------------------------------------------

  // Everything the canvas needs in one shot: the source topology + a concept
  // index annotated with which layers contribute and how many sections conflict.
  async function buildGraph(waitMs = 0) {
    if (waitMs > 0) await awaitIndexes(waitMs);
    const { manifest, entries } = ensureIndexes();
    const layerMeta = new Map((manifest.layers ?? []).map((l) => [l.name, l]));

    // Answer from whatever is indexed right now. A source that is still
    // working reports its progress; one that failed reports why. Neither
    // blocks this response.
    const perSource = entries.map(pinEntry);

    // Read before the await below, from the same instant as the rows, so the
    // number a client stores names the payload it actually received. A source
    // that lands during the resolve therefore moves the generation on the very
    // next status poll instead of arriving already accounted for.
    const generationAtPin = bumpGeneration(perSource);

    // Resolve over every source that produced a snapshot, from the snapshot,
    // so nothing is read twice and one slow or bad source can't blank the
    // index. A source that listed but reports itself degraded (see below)
    // still has a snapshot and stays in: it is serving cached or partial
    // content, which is the whole point of warn-and-continue. Only a source
    // that couldn't be read at all — or hasn't been read yet — drops out.
    const contributing = perSource.filter((p) => p.snap);
    const { concepts, resolvedTokens, latestPerSource } = await resolvedIndex(contributing);

    const sourcesOut = perSource.map(({ source: s, snap, status, error, progress, health, lastSuccessAt }) => {
      const meta = layerMeta.get(s.name) ?? {};
      const kind = s.quarantinedKind ?? meta.source ?? "okf-local";
      // `health` was read with the rest of this row (see pinEntry): whether the
      // listing threw is not evidence a remote source is healthy — remote
      // adapters answer [] instead of throwing precisely so one down repo can't
      // fail a resolve. So an unreachable GitHub layer lists cleanly with zero
      // concepts — the same row an empty repo produces. health() is the
      // adapter's own account of whether its last request actually worked, and
      // it is the only thing that tells those two rows apart.
      //
      // Scope matters: an "index" failure means the whole repo is unreachable
      // — everything this source would contribute is stale or missing. A
      // "content" failure means exactly one file didn't read; every other
      // concept in this source is fine (that one already falls through the
      // cascade on its own, the existing warn-and-continue behavior), so it
      // must not paint the whole row as down.
      //
      // Index state and adapter health are orthogonal: the index says whether
      // WE have read the source yet, health says whether the source itself is
      // answering. Only a source we finished reading can be called degraded.
      const degraded = status === "ok" && health?.ok === false && health.lastErrorScope === "index";
      // Which credential this source names and whether it actually got one.
      // The alias is a name, never a secret, and the secret is deliberately
      // dropped on the floor here — this object is an HTTP response body.
      // "host-mismatch" is the interesting state: the layer asked for a token
      // that exists but is bound elsewhere, which is a withheld credential
      // rather than a missing one, and reads as a silent empty layer unless
      // it's said out loud.
      let auth = { alias: null, state: "anonymous" };
      try {
        const { alias, state } = resolveTokenState(meta, tokenState.tokens);
        auth = { alias, state };
      } catch { /* a malformed auth already failed manifest validation */ }
      const warningMessages = sourceWarnings(snap);
      return {
        name: s.name,
        level: s.level,
        kind,
        authAlias: auth.alias,
        authState: auth.state,
        location: kind === "mcp" ? [meta.command, ...(meta.args ?? [])].join(" ") : meta.path,
        origin: meta.origin ?? null, // e.g. a github repo a clone came from
        live: meta.live === true, // the team's live capture layer, if this is it
        conceptCount: snap?.ids.length ?? 0,
        tokens: snap?.tokens ?? 0,
        latestUpdated: latestPerSource.get(s.name) ?? null,
        // Four states, because there are four: still being read; served
        // cleanly; served, but the source behind it is failing, so what you see
        // may be stale or partial; and failed to be read at all, so it
        // contributed nothing.
        status: degraded ? "degraded" : status,
        error: degraded ? health.lastError : error ?? null,
        // This row is a manifest entry that failed validation, not a source
        // that failed to read: there is nothing behind it to retry, and the
        // only action that helps is removing it. Says so out loud because the
        // two are indistinguishable from `status: "error"` alone.
        quarantined: s.quarantined === true,
        // Orthogonal to status, on purpose: this source read successfully and
        // is serving what it read — it just isn't serving everything it was
        // pointed at. The count drives a badge; the messages are capped so one
        // pathological folder cannot turn a graph response into a log file.
        warnings: warningMessages.length,
        warningMessages: warningMessages.slice(0, 10),
        indexing: progress,
        // Dotfiles/dot-dirs skipped by the walk — a count, not a listing.
        skippedHidden: snap?.hidden ?? 0,
        // Enough for "last synced X, failed Y ago" without a second request.
        // lastErrorAt is null on sources that keep no health of their own
        // (local bundles, MCP children) — there is nothing to have failed.
        // lastSuccessAt prefers health()'s own record, but openSources()
        // builds a fresh adapter on every manifest change, so a source that
        // hasn't issued a request on THIS instance yet (its index entry was
        // adopted, not re-read) reports null from health() even though it is
        // serving a perfectly good snapshot. The entry's own lastSuccessAt is
        // the fallback for exactly that case, and it is trustworthy now that
        // startIndex only stamps it when health() (if the adapter has one)
        // agreed the pass was a real success — never for a warn-and-continue
        // that resolved by returning [] against an unreachable repo.
        lastErrorAt: health?.lastErrorAt ?? null,
        lastSuccessAt: health?.lastSuccessAt ?? lastSuccessAt ?? null,
      };
    });

    // Summed off the snapshots, which already counted every document they read.
    // Nothing here recomputes a token.
    const sourceTokens = sourcesOut.reduce((n, s) => n + s.tokens, 0);
    const pending = perSource.filter((p) => p.progress.status === "indexing").map((p) => p.source.name);
    return {
      manifest: { path: MANIFEST },
      tokenizer: TOKENIZER,
      // True while any source is still being read. Clients render what they
      // have and poll — this is never a reason to show a blocking spinner.
      indexing: pending.length > 0,
      indexingSources: pending,
      // The same counter GET /api/status reports, so a client that polls the
      // cheap route can tell whether the payload it already holds is current.
      // Pinned above, with the rows — recomputing it here would name a state
      // this payload does not contain.
      generation: generationAtPin,
      totals: { sourceTokens, resolvedTokens, concepts: concepts.length, sources: sourcesOut.length },
      sources: sourcesOut,
      concepts,
    };
  }

  /**
   * The O(corpus) half of /api/graph: the per-concept rows, the resolved token
   * total, and each source's most recent `updated`. Memoized on the identity of
   * the snapshots it reads.
   *
   * The key is recomputed from live state on every call rather than being
   * cleared by an invalidation event. That is the safety property: there is no
   * trigger to forget. A snapshot object is immutable once assigned and carries
   * a unique generation, so every way the answer can change — an index landing,
   * a re-index after a file edit or a settings change, a source added, removed,
   * renamed or re-levelled — produces a different key here on the very next
   * request.
   *
   * The cheap half of the payload (progress, health, warnings, token totals) is
   * rebuilt per request, so a `loaded` counter ticking through an index does not
   * throw this away.
   */
  async function resolvedIndex(contributing) {
    const key = contributingKey(contributing);
    if (!graphMemo || graphMemo.key !== key) {
      // Shared by every caller that arrives during a cold build: the console
      // polls this route while indexing, and a second request must join the
      // build in flight rather than start a duplicate of it. Cleared on
      // rejection so one failure cannot pin a poisoned entry.
      let promise;
      promise = buildResolvedIndex(contributing).catch((err) => {
        if (graphMemo?.promise === promise) graphMemo = null;
        throw err;
      });
      graphMemo = { key, promise };
    }
    return graphMemo.promise;
  }

  async function buildResolvedIndex(contributing) {
    const healthy = contributing.map((p) => snapshotView(p.source, p.snap));
    const allIds = [...new Set(contributing.flatMap((p) => p.snap.ids))].sort();
    const snapByLayer = new Map(contributing.map((p) => [p.source.name, p.snap]));

    const concepts = [];
    const latestPerSource = new Map(); // source name -> latest `updated`
    // Rebuilt rather than mutated, so concepts that no longer exist age out
    // instead of accumulating for the life of the process.
    const nextTokens = new Map();
    let resolvedTokens = 0;
    let sinceYield = 0;
    for (const id of allIds) {
      if (++sinceYield % YIELD_EVERY === 0) await yieldNow();
      let resolved = null;
      try { resolved = await resolveConcept(id, healthy); } catch { continue; }
      if (!resolved) continue;
      const conflictCount = resolved.sections.reduce((n, sec) => n + (sec.conflicts?.length ? 1 : 0), 0);
      const tokens = conceptTokenCount(id, resolved, snapByLayer, nextTokens);
      resolvedTokens += tokens;
      for (const c of resolved.contributors) {
        const prev = latestPerSource.get(c.layer);
        if (c.updated && (!prev || c.updated > prev)) latestPerSource.set(c.layer, c.updated);
      }
      concepts.push({
        id,
        type: resolved.frontmatter.type ?? "concept",
        title: resolved.frontmatter.title ?? id,
        contributors: resolved.contributors.map((c) => c.layer),
        winner: resolved.contributors[0]?.layer ?? null,
        conflictCount,
        tokens,
      });
    }
    conceptTokens = nextTokens;
    return { concepts, resolvedTokens, latestPerSource };
  }

  // Exact token count for one resolved concept, without re-encoding text the
  // engine has already encoded.
  //
  // The single-contributor case — the overwhelming majority in any real vault —
  // is answered straight from the index: snapshotSource counted that concept
  // through the same merge, so the number is identical, not an approximation.
  // Anything genuinely merged across layers falls back to a cache keyed by the
  // precedence and generation of its contributors, so a re-index of ONE layer
  // only re-encodes the concepts that layer actually touches. Layer names are
  // deliberately absent from the key: a rename changes the graph rows but not a
  // single token of merged text.
  function conceptTokenCount(id, resolved, snapByLayer, nextTokens) {
    if (resolved.contributors.length === 1) {
      const only = snapByLayer.get(resolved.contributors[0].layer)?.tokensById?.get(id);
      if (only !== undefined) return only;
    }
    const sig = resolved.contributors
      .map((c) => `${c.level}#${snapByLayer.get(c.layer)?.gen ?? "?"}`)
      .join("|");
    const hit = conceptTokens.get(id);
    const tokens = hit && hit.sig === sig ? hit.tokens : countTokens(conceptText(resolved));
    nextTokens.set(id, { sig, tokens });
    return tokens;
  }

  /**
   * Everything a /api/graph payload would show, reduced to one string, behind a
   * counter that only moves when that string does.
   *
   * Deliberately excluded: `indexing.elapsedMs`, which is a clock rather than
   * state — a generation that changed every millisecond through an index would
   * defeat the purpose of a cheap poll. Deliberately included: the manifest
   * stamp, which covers every presentation field a layer contributes (location,
   * origin, live, auth alias) without enumerating them, and the credential
   * epoch, which changes no layer JSON at all.
   *
   * Takes pinned observations (pinEntry), never live entries: the counter has
   * to describe the same instant its caller's payload describes.
   */
  function bumpGeneration(pinned) {
    const parts = [manifestStamp(), `t${tokenState.epoch}`];
    for (const { source, snap, progress, error, health } of pinned) {
      parts.push([
        source.name, source.level, snap?.gen ?? 0,
        progress.status, progress.phase, progress.loaded, progress.total ?? "",
        progress.refreshing ? "refreshing" : "",
        error ?? "",
        health ? `${health.ok}:${health.lastErrorAt ?? ""}:${health.lastSuccessAt ?? ""}` : "",
      ].join("~"));
    }
    const sig = parts.join("|");
    if (sig !== generationSig) {
      generationSig = sig;
      generation += 1;
    }
    return generation;
  }

  /**
   * The cheap status route. O(sources) by construction: it reads index progress
   * and adapter health, and never touches a concept, a resolve, or a tokenizer.
   *
   * It exists because index progress used to live on /api/graph alone, which is
   * why the console ended up polling the most expensive route in the engine
   * every 900ms. `generation` is the contract that replaces that: poll here,
   * refetch the heavy payloads only when the number moves.
   */
  function statusApi() {
    const { manifest, entries } = ensureIndexes();
    const layerMeta = new Map((manifest.layers ?? []).map((l) => [l.name, l]));
    const pinned = entries.map(pinEntry);
    const sources = pinned.map(({ source, snap, status, error, progress, health }) => {
      // Same four states, and the same degraded rule, as /api/graph — a client
      // that renders from this route must not disagree with one that renders
      // from that one.
      const degraded = status === "ok" && health?.ok === false && health.lastErrorScope === "index";
      return {
        name: source.name,
        level: source.level,
        kind: source.quarantinedKind ?? layerMeta.get(source.name)?.source ?? "okf-local",
        quarantined: source.quarantined === true, // same meaning as /api/graph's
        status: degraded ? "degraded" : status,
        phase: progress.phase,
        loaded: progress.loaded,
        total: progress.total,
        conceptCount: snap?.ids.length ?? 0,
        // Same additive signal /api/graph carries: serving a snapshot AND
        // re-reading behind it. Never a reason to show a source as unready.
        refreshing: progress.refreshing,
        error: degraded ? health.lastError : error ?? null,
        // Dotfiles/dot-dirs are still skipped silently — this only makes the
        // count visible, never what is inside them. Additive, and already
        // computed by the walk, so it costs nothing on this cheap route.
        skippedHidden: snap?.hidden ?? 0,
      };
    });
    // A source with nothing to serve yet. A source refreshing behind a good
    // snapshot is deliberately NOT here: it has an answer, so a client has
    // nothing to wait for and no reason to hold a spinner up in front of it.
    const pending = pinned.filter((p) => p.progress.status === "indexing").map((p) => p.source.name);
    const memory = memorySnapshot();
    return {
      generation: bumpGeneration(pinned),
      indexing: pending.length > 0,
      indexingSources: pending,
      sources,
      // "normal" | "elevated" | "critical" — see memory-pressure.mjs. A host
      // embedding this engine (the desktop app's utility process, in
      // particular) can use this to throttle its own polling or show a
      // banner without adding its own watermark logic.
      memory: memory.level,
      // The raw numbers behind the level, additive: how much live heap this
      // engine holds against the V8 ceiling it would actually die at. The
      // desktop app cannot raise that ceiling (Electron ignores utilityProcess
      // heap flags — see memory-pressure.mjs), so watching it is the tool.
      memoryDetail: {
        heapUsedBytes: memory.heapUsedBytes,
        heapLimitBytes: memory.heapLimitBytes,
        liveBytes: memory.liveBytes,
        totalBytes: memory.totalBytes,
      },
    };
  }

  // Single-concept resolve reads live sources (not the index): it touches at
  // most one file per layer, so it stays fast even mid-index and always
  // reflects an edit made a moment ago in the file editor.
  async function resolveOne(conceptId) {
    if (!conceptId) throw httpError(400, "Provide ?concept=<id>");
    const { sources } = openSources();
    const resolved = await resolveConcept(conceptId, sources);
    if (!resolved) throw httpError(404, `Concept not found in any source: ${conceptId}`);
    decorateResolvedDispositions(resolved, await conflictResolutionLog.list());
    return resolved;
  }

  // Unlike resolveOne, this reads the background index rather than live
  // sources: a naive per-request implementation re-walked every layer's disk
  // (or MCP graph) and rebuilt a BM25 index over the whole corpus on every
  // keystroke the console debounced through here — the same shape of cost the
  // engine already refuses to pay per request for /api/graph and countTokens.
  // search.mjs is still the only ranking module the retrieval eval scores, so
  // this route never reimplements any part of it: it hands searchConcepts an
  // adapter-shaped view over already-loaded snapshot concepts (searchSnapshotView)
  // instead of the live sources array, which is the one substitution that
  // keeps the ranking byte-identical while removing the disk/MCP reads.
  async function searchApi(url, waitMs = 0) {
    const query = url.searchParams.get("q");
    if (typeof query !== "string" || !query.trim()) throw httpError(400, "Provide ?q=<query>");
    let limit = 10;
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null) {
      const n = Number(rawLimit);
      if (!Number.isFinite(n) || n <= 0) throw httpError(400, "limit must be a positive number");
      limit = Math.min(Math.floor(n), 50);
    }
    if (waitMs > 0) await awaitIndexes(waitMs);
    // Answer from whatever is indexed right now, same as buildGraph: a source
    // still on its first pass has no snapshot yet and simply contributes
    // nothing, rather than failing the request or blocking on it. This route
    // has no rows to carry that signal on, so it says so directly, with the
    // same fields and meaning /api/graph and /api/resolve-all use — otherwise
    // a search box on a big vault reads "no results" indistinguishably from a
    // genuinely empty vault for the whole first index.
    const { entries } = ensureIndexes();
    const pinned = entries.map(pinEntry);
    const contributing = pinned.filter((p) => p.snap);
    const pending = pinned.filter((p) => p.progress.status === "indexing").map((p) => p.source.name);
    const indexing = pending.length > 0;
    // A query with no searchable token (all punctuation, e.g. "!!!") is a
    // search that legitimately finds nothing — searchConcepts throws on it
    // instead, because the MCP tools it also backs treat that as caller
    // misuse. A search box gets the same honest empty answer any other
    // no-match query gets, not a 500.
    if (tokenizeQuery(query).length === 0) return { hits: [], indexing, indexingSources: pending };
    const key = contributingKey(contributing);
    if (!searchMemo || searchMemo.key !== key) searchMemo = { key, hits: new Map() };
    const cacheKey = `${query}\u0000${limit}`;
    let promise = searchMemo.hits.get(cacheKey);
    if (!promise) {
      const views = contributing.map((p) => searchSnapshotView(p.source, p.snap));
      promise = searchConcepts(views, { query, limit }).catch((err) => {
        if (searchMemo?.hits.get(cacheKey) === promise) searchMemo.hits.delete(cacheKey);
        throw err;
      });
      // A safety valve against unbounded growth under sustained distinct
      // queries against unchanged content — not expected in normal debounced
      // typing (repeats dominate), but nothing here ever evicts on its own.
      if (searchMemo.hits.size >= SEARCH_MEMO_CAP) searchMemo.hits.clear();
      searchMemo.hits.set(cacheKey, promise);
    }
    const hits = await promise;
    return { hits, indexing, indexingSources: pending };
  }

  function decorateResolvedDispositions(resolved, decisions) {
    for (const section of resolved.sections) {
      if (!section.conflicts?.length) continue;
      const id = `section_content::${resolved.id}::${section.key}`;
      const latest = decisions.filter((row) => row.discrepancyId === id || row.conflictId === `${resolved.id}::${section.key}`).at(-1);
      const current = [
        { source: section.sourceLayer, fingerprint: createHash("sha256").update(section.content).digest("hex") },
        ...section.conflicts.map((item) => ({ source: item.layer, fingerprint: createHash("sha256").update(item.content).digest("hex") })),
      ].map((item) => `${item.source}:${item.fingerprint}`).sort();
      const recorded = (latest?.contributorFingerprints ?? []).map((item) => `${item.source}:${item.fingerprint}`).sort();
      const unchanged = recorded.length === current.length && recorded.every((value, index) => value === current[index]);
      section.discrepancy = {
        id,
        status: latest?.action === "acknowledge" && unchanged ? "acknowledged" : latest ? "reopened" : "needs_review",
        ...(latest?.id ? { decisionId: latest.id } : {}),
        ...(latest?.reasonCode ? { reasonCode: latest.reasonCode } : {}),
      };
    }
  }

  /**
   * Apply one conflict choice across every contributing local layer, then keep
   * the original choices in the append-only decision log. The server derives
   * choices from current resolver output (or a prior record for "change
   * decision") so clients cannot smuggle arbitrary file content into this API.
   */
  async function resolveConflictApi(rawBody) {
    const body = parseJson(rawBody);
    const { conceptId, sectionKey, selectedLayer, method, resolutionId } = body;
    if (![conceptId, sectionKey, selectedLayer].every((value) => typeof value === "string" && value)) {
      throw httpError(400, "Provide conceptId, sectionKey, and selectedLayer");
    }
    if (method !== "automatic" && method !== "manual") {
      throw httpError(400, "method must be automatic or manual");
    }

    const conflictId = `${conceptId}::${sectionKey}`;
    let contributions;
    let expectedContent;
    let title;
    let sectionHeading;
    let supersedes;
    let currentDiscrepancy = null;

    if (resolutionId !== undefined) {
      if (typeof resolutionId !== "string" || !resolutionId) throw httpError(400, "resolutionId must be a non-empty string");
      const prior = await conflictResolutionLog.find(resolutionId);
      if (!prior || prior.conflictId !== conflictId) throw httpError(404, "That saved conflict decision was not found");
      contributions = prior.contributions;
      expectedContent = Object.fromEntries(contributions.map((item) => [item.layer, prior.chosen.content]));
      title = prior.title;
      sectionHeading = prior.sectionHeading;
      supersedes = prior.id;
    } else {
      const resolved = await resolveOne(conceptId);
      const section = resolved.sections.find((item) => item.key === sectionKey);
      if (!section) throw httpError(404, `Section not found: ${sectionKey}`);
      if (!section.conflicts?.length) throw httpError(409, "This section no longer has a conflict. Reload before resolving it.");
      const levels = new Map(resolved.contributors.map((item) => [item.layer, item.level]));
      contributions = [
        { layer: section.sourceLayer, level: levels.get(section.sourceLayer), content: section.content, updated: section.sourceUpdated },
        ...section.conflicts.map((item) => ({ layer: item.layer, level: levels.get(item.layer), content: item.content, updated: item.updated })),
      ];
      expectedContent = Object.fromEntries(contributions.map((item) => [item.layer, item.content]));
      title = resolved.frontmatter?.title ?? conceptId;
      sectionHeading = section.heading;
      currentDiscrepancy = buildDiscrepancies([resolved], {
        decisions: await conflictResolutionLog.list(), rules: await effectiveDiscrepancyRules(),
        coverageComplete: false, sourceHealth: statusApi().sources,
      }).discrepancies.find((item) => item.id === `section_content::${conceptId}::${sectionKey}`) ?? null;
    }

    const chosen = contributions.find((item) => item.layer === selectedLayer);
    if (!chosen) throw httpError(400, `The ${selectedLayer} layer is not one of this conflict's choices`);
    const safeReason = trivialConflictReason(contributions.map((item) => item.content));
    if (method === "automatic") {
      if (resolutionId !== undefined) throw httpError(400, "Past decisions must be changed manually");
      if (!safeReason) throw httpError(409, "This conflict changes meaning and needs your judgment. Nothing was changed.");
      if (selectedLayer !== contributions[0].layer) {
        throw httpError(400, "Automatic resolution must keep the answer already in use");
      }
    }

    // New open-conflict requests are a compatibility adapter over the v2
    // discrepancy engine. This preserves the route and response envelope while
    // gaining revision verification, recoverable writes, and schema-v2 history.
    if (resolutionId === undefined) {
      const discrepancyId = `section_content::${conceptId}::${sectionKey}`;
      const discrepancy = currentDiscrepancy;
      if (!discrepancy) throw httpError(409, "This conflict changed while it was being resolved. Reload before trying again.");
      const result = await applyDiscrepancyDecision(discrepancy, {
        discrepancyId, revision: discrepancy.revision, action: "choose_contribution", selectedSource: selectedLayer,
      }, { methodOverride: method, reasonOverride: method === "automatic" ? safeReason : undefined });
      return { ok: true, resolution: result.decision, written: result.written };
    }

    const transactionId = randomUUID();
    const staged = await stageSectionTransaction(JSON.stringify({
      conceptId,
      sectionKey,
      layers: contributions.map((item) => item.layer),
      content: chosen.content,
      expectedContent,
      requireAll: true,
    }), fileRoots(), transactionId);
    await conflictResolutionLog.prepare();
    await discrepancyTransactionJournal.append({
      id: transactionId, state: "prepared", preparedAt: new Date().toISOString(),
      targets: staged.targets.map((target) => ({ path: target.path, staged: target.staged, backup: target.backup })),
    });
    const record = {
      schemaVersion: 2, id: randomUUID(), discrepancyId: `section_content::${conceptId}::${sectionKey}`,
      conflictId,
      conceptId,
      title: String(title),
      sectionKey,
      sectionHeading,
      contributions,
      chosen,
      method,
      reason: method === "automatic" ? safeReason : `You chose the ${selectedLayer} answer.`,
      actor: "local-user",
      decidedAt: new Date().toISOString(),
      discrepancyKind: "section_content", revision: `legacy-change:${supersedes}`,
      action: "choose_contribution", transactionId, transactionState: "committed",
      contributorFingerprints: contributions.map((item) => ({ source: item.layer, fingerprint: createHash("sha256").update(item.content).digest("hex") })),
      writtenTargets: staged.targets.map((target) => ({ layer: target.layer, path: target.path })),
      learningPattern: null, ruleAction: null,
      ...(supersedes ? { supersedes } : {}),
    };
    try {
      const written = await staged.commit();
      const saved = await conflictResolutionLog.append(record);
      await discrepancyTransactionJournal.append({ id: transactionId, state: "committed", committedAt: new Date().toISOString() });
      await staged.cleanup();
      invalidateIndex();
      return { ok: true, resolution: saved, written };
    } catch (error) {
      try {
        await staged.rollback();
        await discrepancyTransactionJournal.append({ id: transactionId, state: "rolled_back", rolledBackAt: new Date().toISOString(), error: error.message });
        await staged.cleanup();
        throw httpError(409, `Nothing was changed. ${error.message}`);
      } catch (rollbackError) {
        if (rollbackError.status === 409) throw rollbackError;
        await discrepancyTransactionJournal.append({ id: transactionId, state: "recovery_required", failedAt: new Date().toISOString(), error: `${error.message}; rollback failed: ${rollbackError.message}` });
        throw httpError(500, `A write could not be rolled back automatically. Recovery is required: ${rollbackError.message}`);
      }
    }
  }

  // Resolve every indexed concept in one pass. The console's initial load calls
  // this instead of one /api/resolve per concept. Per-concept failures are
  // reported alongside the successes, never fatal; sources still indexing are
  // named so the client knows the answer is partial and can poll.
  async function resolveAllApi(waitMs = 0) {
    if (waitMs > 0) await awaitIndexes(waitMs);
    const { entries } = ensureIndexes();
    // Pinned for the same reason /api/graph pins: the loop below spans many
    // event-loop turns, and `indexingSources` has to name the state these
    // concepts were resolved from, not whatever landed while it ran.
    const pinned = entries.map(pinEntry);
    const healthy = pinned.filter((p) => p.snap).map((p) => snapshotView(p.source, p.snap));
    const allIds = [...new Set(pinned.flatMap((p) => p.snap?.ids ?? []))].sort();
    const concepts = [];
    const errors = [];
    let sinceYield = 0;
    for (const id of allIds) {
      if (++sinceYield % YIELD_EVERY === 0) await yieldNow();
      try {
        const resolved = await resolveConcept(id, healthy);
        if (resolved) concepts.push(resolved);
        else errors.push({ concept: id, error: "not found in any healthy source" });
      } catch (err) {
        errors.push({ concept: id, error: err.message });
      }
    }
    const decisions = await conflictResolutionLog.list();
    for (const concept of concepts) decorateResolvedDispositions(concept, decisions);
    const pending = pinned.filter((p) => p.progress.status === "indexing").map((p) => p.source.name);
    return { concepts, errors, indexing: pending.length > 0, indexingSources: pending };
  }

  async function discrepanciesApi(waitMs = 0) {
    const resolved = await resolveAllApi(waitMs);
    const status = statusApi();
    const decisions = await conflictResolutionLog.list();
    const [rules, priorities] = await Promise.all([effectiveDiscrepancyRules(), discrepancyPriorityStore.list()]);
    const coverageComplete = !resolved.indexing
      && status.sources.every((source) => source.status !== "error" && source.status !== "degraded" && source.status !== "indexing");
    return {
      ...buildDiscrepancies(resolved.concepts, {
        decisions, rules, priorities, coverageComplete, sourceHealth: status.sources,
      }),
      indexing: resolved.indexing,
      indexingSources: resolved.indexingSources,
      errors: resolved.errors,
      generation: status.generation,
    };
  }

  async function discrepancyRulesApi() {
    const rules = await effectiveDiscrepancyRules();
    const decisions = await conflictResolutionLog.list();
    return { rules, suggestions: suggestDiscrepancyRules(decisions, rules) };
  }

  function liveRuleFile() {
    const selected = openSources().manifest.layers ?? [];
    const live = resolveLiveLayer(selected, MANIFEST_DIR);
    return live ? { ...live, relative: ".contextcake/discrepancy-rules.json", file: path.join(live.root, ".contextcake", "discrepancy-rules.json") } : null;
  }

  async function teamDiscrepancyRules() {
    const live = liveRuleFile();
    if (!live) return [];
    try { return parseRuleDocument(await fsp.readFile(live.file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw httpError(409, `Team discrepancy rules are unreadable: ${error.message}`); }
  }

  async function effectiveDiscrepancyRules() {
    const [local, team] = await Promise.all([discrepancyRuleStore.list(), teamDiscrepancyRules()]);
    const localById = new Map(local.map((rule) => [rule.id, rule]));
    return [
      ...team.map((rule) => localById.get(rule.id) ?? rule),
      ...local.filter((rule) => !team.some((shared) => shared.id === rule.id)),
    ];
  }

  async function patchDiscrepancyRule(id, body) {
    try { return await discrepancyRuleStore.patch(id, body); }
    catch (error) {
      if (error.status !== 404) throw error;
      const team = (await teamDiscrepancyRules()).find((rule) => rule.id === id);
      if (!team) throw error;
      // Enabling a promoted rule automatically is deliberately a per-profile,
      // local decision. The shared file itself remains recommendation-only.
      return discrepancyRuleStore.setLocalOverride(team, body);
    }
  }

  async function promoteDiscrepancyRule(body) {
    const rule = (await discrepancyRuleStore.list()).find((item) => item.id === body.id);
    if (!rule) throw httpError(404, "Local discrepancy rule not found");
    const live = liveRuleFile();
    if (!live) throw httpError(409, "This profile has no writable live team layer");
    const preview = {
      id: rule.id, scope: "team", mode: "recommend", enabled: true,
      match: rule.match, action: rule.action, evidenceDecisionIds: rule.evidenceDecisionIds,
      createdAt: rule.createdAt, promotedAt: new Date().toISOString(),
    };
    if (body.confirm !== true) return { requiresConfirmation: true, preview, target: `${live.name}/${live.relative}` };
    let previous = null;
    try { previous = await fsp.readFile(live.file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const current = previous ? parseRuleDocument(previous.toString("utf8")) : [];
    const next = [...current.filter((item) => item.id !== preview.id), preview];
    const nextText = serializeRuleDocument(next);
    await commitPathsWithMutation(live.root, [live.relative], `chore: promote discrepancy rule ${rule.id}`, {
      mutate: async () => {
        await fsp.mkdir(path.dirname(live.file), { recursive: true });
        await fsp.writeFile(live.file, nextText, { encoding: "utf8", mode: 0o600 });
      },
      rollback: async () => {
        if (previous) await fsp.writeFile(live.file, previous);
        else await fsp.unlink(live.file).catch(() => {});
      },
      author: live.profileName,
    });
    const pushed = await pushGit(live.root);
    return { promoted: true, rule: preview, pushed: pushed.pushed === true, queued: pushed.queued === true };
  }

  function scheduleAutomaticRules() {
    if (!allowMutations || closed || automaticTimer) return;
    automaticTimer = setTimeout(() => {
      automaticTimer = null;
      automaticTail = automaticTail.then(runAutomaticRules).catch((error) => {
        console.error(`contextcake: automatic discrepancy rules failed: ${error.message}`);
      });
    }, 50);
    automaticTimer.unref?.();
  }

  async function runAutomaticRules() {
    const { entries } = ensureIndexes();
    if (entries.some(({ entry }) => entry.running || entry.followUp || entry.status !== "ready")) return;
    const payload = await discrepanciesApi(0);
    if (!payload.coverageComplete) return;
    const decisions = await conflictResolutionLog.list();
    for (const discrepancy of payload.discrepancies) {
      if (discrepancy.status !== "auto_ready") continue;
      const matches = discrepancy.matchingRules.filter((rule) => rule.mode === "automatic");
      if (matches.length !== 1) continue;
      const rule = matches[0];
      if (decisions.some((row) => row.discrepancyId === discrepancy.id && row.revision === discrepancy.revision
        && row.method === "automatic" && ["committed", "blocked", "not_required"].includes(row.transactionState))) continue;
      const sourceHealthy = discrepancy.sourceHealth.every((health) => health && health.status === "ok");
      const allWritable = discrepancy.contributions.every((item) => fileRoots().has(item.source));
      if (!sourceHealthy || (rule.action.type === "prefer_source" && !allWritable)) continue;
      const request = rule.action.type === "prefer_source"
        ? { discrepancyId: discrepancy.id, revision: discrepancy.revision, action: "choose_contribution", selectedSource: rule.action.source, ruleId: rule.id }
        : { discrepancyId: discrepancy.id, revision: discrepancy.revision, action: "acknowledge", reasonCode: rule.action.reasonCode, ruleId: rule.id };
      await withManifestLockAsync(MANIFEST, async () => {
        // Rule state can change while this job waits for the manifest lock.
        // Re-read everything under the lock so disabling a rule, introducing
        // an ambiguity, or changing a source generation always wins over a
        // previously scheduled action.
        const currentPayload = await discrepanciesApi(15_000);
        if (!currentPayload.coverageComplete || currentPayload.indexing) return;
        const current = currentPayload.discrepancies.find((item) => item.id === discrepancy.id);
        if (!current || current.revision !== discrepancy.revision || current.status !== "auto_ready" || current.ruleConflict) return;
        const currentMatches = current.matchingRules.filter((item) => item.mode === "automatic");
        if (currentMatches.length !== 1 || currentMatches[0].id !== rule.id
          || JSON.stringify(currentMatches[0].action) !== JSON.stringify(rule.action)) return;
        if (!current.sourceHealth.every((health) => health && health.status === "ok")) return;
        if (rule.action.type === "prefer_source" && !current.contributions.every((item) => fileRoots().has(item.source))) return;
        try {
          await applyDiscrepancyDecision(current, request, { methodOverride: "automatic" });
        } catch (error) {
          // The failure record participates in the same serialization boundary
          // as successful decisions. Otherwise a manual decision can commit
          // after this lock is released but before `blocked` is appended,
          // leaving the failed automatic attempt as the misleading latest
          // disposition for this revision.
          await conflictResolutionLog.append({
            schemaVersion: 2, id: randomUUID(), discrepancyId: discrepancy.id,
            discrepancyKind: discrepancy.originalKind ?? discrepancy.kind, revision: discrepancy.revision,
            action: request.action, method: "automatic", actor: "local-user", ruleId: rule.id,
            transactionState: "blocked", reason: error.message, decidedAt: new Date().toISOString(),
            contributorFingerprints: discrepancy.contributions.map((item) => ({ source: item.source, fingerprint: item.fingerprint })),
            contributions: discrepancy.contributions.map((item) => ({ layer: item.source, level: item.level, content: item.value, updated: item.updated })),
          });
        }
      });
      return;
    }
  }

  async function ensureDiscrepancyRecovery() {
    if (!discrepancyRecovery) {
      const roots = [...fileRoots().values()].map((entry) => entry.root);
      discrepancyRecovery = conflictResolutionLog.list().then((decisions) => discrepancyTransactionJournal.recover(
        roots,
        decisions.filter((row) => row.transactionState === "committed").map((row) => row.transactionId).filter(Boolean),
      )).catch((error) => {
        discrepancyRecovery = null;
        throw error;
      });
    }
    return discrepancyRecovery;
  }

  async function decideDiscrepancyApi(rawBody, { methodOverride = null, reasonOverride = null } = {}) {
    await ensureDiscrepancyRecovery();
    const body = parseJson(rawBody);
    const { discrepancyId, action, selectedSource, content, reasonCode, note, ruleId } = body;
    if (ruleId !== undefined && methodOverride !== "automatic") {
      throw httpError(400, "Rule authority is reserved for approved background actions");
    }
    if (typeof discrepancyId !== "string" || !discrepancyId) throw httpError(400, "Provide discrepancyId");
    if (!["choose_contribution", "compose", "acknowledge"].includes(action)) throw httpError(400, "Unsupported discrepancy action");
    // A file watcher may have invalidated the index between the review GET and
    // this mutation. Decisions must re-resolve against a settled generation;
    // treating an in-flight empty snapshot as "no longer open" is both
    // misleading and can make a valid current-revision decision impossible.
    const payload = await discrepanciesApi(15_000);
    if (!payload.coverageComplete || payload.indexing) {
      throw httpError(409, "Sources are still indexing. Wait for settled coverage before deciding.");
    }
    const discrepancy = payload.discrepancies.find((item) => item.id === discrepancyId);
    if (!discrepancy) throw httpError(409, "This discrepancy is no longer open. Reload before deciding it.");
    if (body.revision !== undefined && body.revision !== discrepancy.revision) {
      throw httpError(409, "This discrepancy changed after you opened it. Reload before deciding it.");
    }
    return applyDiscrepancyDecision(discrepancy, body, { methodOverride, reasonOverride });
  }

  async function applyDiscrepancyDecision(discrepancy, body, { methodOverride = null, reasonOverride = null } = {}) {
    await ensureDiscrepancyRecovery();
    const { action, selectedSource, content, reasonCode, note, ruleId } = body;
    if (ruleId !== undefined && methodOverride !== "automatic") {
      throw httpError(400, "Rule authority is reserved for approved background actions");
    }
    if (!discrepancy || body.revision !== discrepancy.revision) {
      throw httpError(409, "This discrepancy changed after you opened it. Reload before deciding it.");
    }
    // target_missing is broken-link-shaped: acknowledging why a link target
    // will never resolve (the concept was retired, renamed elsewhere, etc.)
    // needs a reason distinct from a genuine scoped disagreement.
    const allowedReasons = new Set(["different_scopes", "temporary_migration", "source_specific_authority", "target_missing", "other"]);
    if (action === "acknowledge" && !allowedReasons.has(reasonCode)) throw httpError(400, "Choose why this scoped difference should remain");
    const chosen = action === "choose_contribution"
      ? discrepancy.contributions.find((item) => item.source === selectedSource)
      : null;
    if (action === "choose_contribution" && !chosen) throw httpError(400, "Choose one of this discrepancy's contributing sources");
    if (action === "compose" && typeof content !== "string") throw httpError(400, "Provide reconciled content");

    const transactionId = randomUUID();
    const now = new Date().toISOString();
    const originalKind = discrepancy.originalKind ?? discrepancy.kind;
    const previousDecision = discrepancy.history?.at(-1) ?? null;
    const decision = {
      schemaVersion: 2,
      id: randomUUID(), discrepancyId: discrepancy.id,
      ...(discrepancy.legacyId ? { conflictId: discrepancy.legacyId } : {}),
      conceptId: discrepancy.conceptId, title: discrepancy.conceptTitle,
      discrepancyKind: originalKind, sectionKey: originalKind === "section_content" ? discrepancy.key : undefined,
      sectionHeading: discrepancy.label, fieldKey: originalKind === "frontmatter_value" ? discrepancy.key : undefined,
      revision: discrepancy.revision, action,
      conceptType: discrepancy.conceptType, owner: discrepancy.owner, priority: discrepancy.priority,
      contributions: discrepancy.contributions.map((item) => ({ layer: item.source, level: item.level, content: item.value, updated: item.updated })),
      contributorFingerprints: discrepancy.contributions.map((item) => ({ source: item.source, fingerprint: item.fingerprint })),
      chosen: chosen ? { layer: chosen.source, level: chosen.level, content: chosen.value, updated: chosen.updated } : null,
      method: methodOverride ?? "manual", actor: "local-user", decidedAt: now,
      reason: reasonOverride ?? (action === "acknowledge" ? reasonCode : action === "compose" ? "You wrote a reconciled answer." : `You chose the ${selectedSource} answer.`),
      ...(reasonCode ? { reasonCode } : {}), ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}),
      ...(ruleId ? { ruleId } : {}), transactionId,
      ...(previousDecision ? { supersedes: previousDecision.id, supersededDecisionId: previousDecision.id } : {}),
      ...(action === "compose" ? { reconciledContent: content } : {}),
      learningPattern: {
        kind: originalKind, conceptType: discrepancy.conceptType, key: discrepancy.key,
        sources: discrepancy.contributions.map((item) => item.source).sort(),
        // A broken link's identity IS the missing target — unlike section_content/
        // frontmatter_value, where the same key across many concepts of a type is a
        // meaningful pattern, generalizing a broken-link rule across targets would
        // auto-acknowledge a future, unrelated dangling link (e.g. a typo) that was
        // never reviewed. Scope broken_link evidence to the exact target.
        ...(originalKind === "broken_link" ? { target: discrepancy.target } : {}),
      },
      ruleAction: action === "choose_contribution"
        ? { type: "prefer_source", source: selectedSource }
        : action === "acknowledge" ? { type: "acknowledge", reasonCode } : null,
    };

    if (action === "acknowledge") {
      decision.transactionState = "not_required";
      decision.writtenTargets = [];
      return { ok: true, decision: await conflictResolutionLog.append(decision), written: [] };
    }
    if (originalKind === "broken_link") throw httpError(409, "Open the source file to repair this link, or acknowledge the scoped difference.");
    // renderScalar's scalar branch would rewrite a YAML list OR map as a
    // quoted string (a plain object stringifies to "[object Object]" through
    // the same String(value) call an array would otherwise skip) — silently
    // downgrading the field's type in every writable layer. Compose only ever
    // produces a string, so a structured-value field has no safe reconciled
    // answer to write.
    if (originalKind === "frontmatter_value" && action === "compose"
      && discrepancy.contributions.some((item) => typeof item.value === "object" && item.value !== null)) {
      throw httpError(400, "This field holds a structured value (list or map); compose isn't available for it — use \"Use this answer everywhere\" or edit the file directly.");
    }

    const value = action === "compose" ? content : chosen.value;
    const writableSources = discrepancy.contributions.map((item) => item.source).filter((source) => fileRoots().has(source));
    if (writableSources.length === 0) throw httpError(409, "None of this discrepancy's contributors is locally writable. Open the source files to resolve it.");
    let staged;
    if (originalKind === "frontmatter_value") {
      staged = await stageFrontmatterTransaction(JSON.stringify({
        conceptId: discrepancy.conceptId, key: discrepancy.key,
        layers: writableSources, value,
        expectedValues: Object.fromEntries(discrepancy.contributions.map((item) => [item.source, item.value])),
      }), fileRoots(), transactionId);
    } else {
      staged = await stageSectionTransaction(JSON.stringify({
        conceptId: discrepancy.conceptId, sectionKey: discrepancy.key,
        layers: writableSources, content: value,
        expectedContent: Object.fromEntries(discrepancy.contributions.map((item) => [item.source, item.value])), requireAll: true,
      }), fileRoots(), transactionId);
    }
    const journalTargets = staged.targets.map((target) => ({ path: target.path, staged: target.staged, backup: target.backup }));
    await discrepancyTransactionJournal.append({ id: transactionId, state: "prepared", preparedAt: now, targets: journalTargets });
    try {
      const written = await staged.commit();
      decision.transactionState = "committed";
      decision.writtenTargets = staged.targets.map((target) => ({ layer: target.layer, path: target.path }));
      const saved = await conflictResolutionLog.append(decision);
      await discrepancyTransactionJournal.append({ id: transactionId, state: "committed", committedAt: new Date().toISOString() });
      await staged.cleanup();
      invalidateIndex();
      return { ok: true, decision: saved, written };
    } catch (error) {
      if (error.code !== "RecoveryRequired") {
        try {
          await staged.rollback();
          await discrepancyTransactionJournal.append({ id: transactionId, state: "rolled_back", rolledBackAt: new Date().toISOString(), error: error.message });
          await staged.cleanup();
          throw httpError(409, `Nothing was changed. ${error.message}`);
        } catch (rollbackError) {
          if (rollbackError.status === 409) throw rollbackError;
          await discrepancyTransactionJournal.append({ id: transactionId, state: "recovery_required", failedAt: new Date().toISOString(), error: `${error.message}; rollback failed: ${rollbackError.message}` });
          throw httpError(500, `A write could not be rolled back automatically. Recovery is required: ${rollbackError.message}`);
        }
      }
      await discrepancyTransactionJournal.append({ id: transactionId, state: "recovery_required", failedAt: new Date().toISOString(), error: error.message });
      throw httpError(500, `A write could not be rolled back automatically. Recovery is required: ${error.message}`);
    }
  }

  // ---- settings ---------------------------------------------------------------

  function getSettingsApi() {
    return settingsView(openSources());
  }

  function patchSettingsApi(rawBody) {
    const body = parseJson(rawBody);
    patchSettings(MANIFEST, body.settings ?? body);
    // New limits change how sources are read, so their indexes are stale: the
    // settings are part of the index key, so reload() rebuilds them.
    reload();
    return { ok: true, ...getSettingsApi() };
  }

  // ---- layer files -------------------------------------------------------------

  function fileRoots() {
    return layerRootMap(openSources().manifest, MANIFEST_DIR);
  }

  function walkLimits() {
    return walkLimitsFrom(openSources().settings);
  }

  // ---- source configuration (manifest CRUD + GitHub clone) -------------------
  //
  // Parsing shims over control/sources.mjs — validation, probes, mutation, and
  // clone lifecycle live there so the CLI runs the identical operations.

  async function addSourceApi(rawBody) {
    const result = await sourceOps.addSource(parseJson(rawBody));
    reload();
    return result;
  }

  // The one repair route (see control/sources.mjs removeSources for the
  // full contract: repair-tolerant read, strict write, all-or-nothing 409).
  function removeSourceApi(names) {
    const result = sourceOps.removeSources(names);
    reload();
    return result;
  }

  async function patchSourceApi(rawBody) {
    const result = await sourceOps.patchSource(parseJson(rawBody));
    reload();
    return result;
  }

  async function syncSourceApi(name) {
    if (!name) throw httpError(400, "Provide ?name=");
    const { manifest, sources } = openSources();
    const layer = (manifest.layers ?? []).find((l) => l.name === name);
    if (!layer) throw httpError(404, `No source named "${name}"`);
    if (layer.source === "github") {
      const source = sources.find((candidate) => candidate.name === name);
      if (!source || typeof source.sync !== "function") {
        throw httpError(400, `"${name}" does not support Sync`);
      }
      const lastSynced = await source.sync();
      // sync() invalidates both the outer cache and the adapter's internal
      // index. Refresh now so a successful API response means the remote index
      // has actually bypassed TTL rather than merely being marked dirty.
      const concepts = (await source.listConceptIds()).length;
      // Remote adapters swallow API failures on purpose — one unreachable repo
      // must never fail a resolve — which makes an outage look exactly like an
      // empty repo from out here: no throw, no concepts. Everywhere else that's
      // the right trade; here it isn't, because the user asked about this one
      // repo and is owed the answer. health() is the out-of-band channel for it,
      // and sync() cleared it first, so what it reports belongs to this sync.
      const health = typeof source.health === "function" ? source.health() : null;
      const detail = {
        synced: name,
        concepts,
        lastSynced: source.lastSynced ?? lastSynced ?? null, // when this attempt ran
        lastSuccessAt: health?.lastSuccessAt ?? null, // when the index last actually loaded
        lastError: health?.lastError ?? null,
        lastErrorAt: health?.lastErrorAt ?? null,
      };
      if (health && !health.ok) {
        throw httpError(502, `Sync failed: ${health.lastError}`, { ...detail, ok: false });
      }
      return { ok: true, ...detail };
    }
    if (!layer.origin) throw httpError(400, `"${name}" is not a git-backed source`);
    const { url, slug } = normalizeRepo(layer.origin);
    await sourceOps.gitCloneOrPull(url, path.join(CACHE_DIR, slug), layer.ref ?? null);
    reload();
    return { ok: true, synced: name };
  }

  // Which stored credential, if any, may be offered to a given clone URL.
  // Host-bound like every other use of these secrets: a token connected for
  // github.com is never handed to a remote on another host, so a manifest that
  // names a credential and an origin it chose cannot combine them.
  function gitCredentialsForUrl(url) {
    let host;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return []; // ssh uses the agent, not us
      host = parsed.host.toLowerCase();
    } catch {
      return [];
    }
    const secrets = [];
    for (const entry of Object.values(tokenState.tokens)) {
      if (!entry || typeof entry !== "object" || !entry.secret) continue;
      if (String(entry.gitHost ?? "").toLowerCase() === host && !secrets.includes(entry.secret)) {
        secrets.push(entry.secret);
      }
    }
    return secrets;
  }

  // ---- console static mount ---------------------------------------------------

  // Serve the built console under /console/. SPA fallback: any path without a file
  // extension (a client-side route) resolves to index.html. Containment is the
  // same assertInsideRoot guard as the file APIs — one canonical implementation.
  function serveConsole(pathname, res) {
    let rel = pathname.replace(/^\/console\/?/, "");
    if (rel === "" || !path.extname(rel)) rel = "index.html"; // SPA route → shell
    const filePath = path.join(CONSOLE_DIR, rel);
    const real = assertInsideRoot(filePath, CONSOLE_DIR, "Forbidden");
    fs.readFile(real, (err, data) => {
      if (err) {
        // Missing client route (no extension already rewritten) shouldn't 404;
        // a genuinely missing asset does.
        if (rel !== "index.html") return json(res, 404, { error: "Not found" });
        return json(res, 404, { error: "Console build not found — run `npm run build:live` in apps/console/" });
      }
      res.writeHead(200, { "content-type": MIME[path.extname(real)] ?? "application/octet-stream" });
      res.end(data);
    });
  }

  // Recovery is a startup responsibility, not something deferred until a user
  // happens to open the Discrepancy Center. Failure remains visible through
  // the journal and is retried before any later decision.
  queueMicrotask(() => ensureDiscrepancyRecovery().catch((error) => {
    console.error(`contextcake: discrepancy transaction recovery requires attention: ${error.message}`);
  }));

  return { handleRequest, close, getSources, reload, setTokens };
}
