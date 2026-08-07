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
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { buildSourcesQuarantined, createErrorSource, resolveTokenState } from "./sources/index.mjs";
import { probeDocs, MAX_DOC_BYTES } from "./sources/okf-local.mjs";
import { FILES_EXTENSIONS } from "./sources/files.mjs";
import { createMcpSource } from "./sources/mcp.mjs";
import { mergeConcepts, resolveConcept } from "./resolver.mjs";
import { countTokens, conceptText, warmTokenizer, TOKENIZER } from "./tokenize.mjs";
import { resolveSettings, walkLimitsFrom, validateSettingsPatch, settingsCatalog } from "./settings.mjs";
import {
  assertInsideRoot, guardMutatingRequest, httpError, json, MIME, parseJson, readBody,
} from "./http-util.mjs";
import {
  layerRootMap, listFilesApi, readFileApi, serveRawApi, writeFileApi, writeSectionApi,
} from "./layer-files.mjs";
import { createConflictResolutionLog, trivialConflictReason } from "./conflict-resolutions.mjs";
import { indexEntryKeys, layerIdentity } from "./index-keys.mjs";
import {
  classifyManifest,
  getManifestProfileLayers,
  mutateContextManifest,
  readContextManifest,
  readContextManifestQuarantined,
  repairContextManifest,
  stableJson,
  withManifestLockAsync,
} from "./manifest.mjs";

// Re-exported so hosts (apps/playground/server.mjs) keep importing the shared
// HTTP internals from the service, wherever they are actually defined.
export { assertInsideRoot, guardMutatingRequest, httpError, json, MIME, readBody };

const execFileP = promisify(execFile);

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

// Accept "owner/name", an https URL, or a git@ SSH URL. Reject other schemes —
// git clone otherwise supports dangerous transports (ext::, file://…).
function normalizeRepo(repo) {
  const r = repo.trim().replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return { url: `https://github.com/${r}.git`, slug: slugify(r) };
  if (/^https:\/\/[\w.-]+\/[\w./-]+$/.test(r)) return { url: `${r}.git`, slug: slugify(r.replace(/^https:\/\//, "")) };
  if (/^git@[\w.-]+:[\w./-]+$/.test(r)) return { url: `${r}.git`, slug: slugify(r.replace(/^git@/, "")) };
  throw httpError(400, "Repo must be owner/name, an https URL, or git@host:owner/name");
}

function slugify(s) { return s.replace(/[^\w.-]+/g, "__"); }

// A pasted "~/notes" reaches the manifest verbatim otherwise, and buildSources
// then resolves a literal "~" directory that doesn't exist.
function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
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

export function withDeadline(promise, ms, message, onTimeout = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* cancellation is best effort */ }
      reject(new Error(message));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

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
  const notes = { skipped: [], unreadable: [] };
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
    skipped: notes.skipped, unreadable: notes.unreadable,
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

function defaultProfileContainer(manifest) {
  return classifyManifest(manifest) === "v2" ? manifest.profiles.default : manifest;
}

function removePendingSource(container, name) {
  if (!Array.isArray(container.pendingSources)) return;
  container.pendingSources = container.pendingSources.filter((pending) => pending?.name !== name);
  if (container.pendingSources.length === 0) {
    delete container.pendingSources;
    delete container.pendingSourcesOwnerUserId;
  }
}

// ---- the service -------------------------------------------------------------

export function createEngineService({
  manifestPath,          // required: path to manifest.json (may not exist yet)
  consoleDist = null,    // optional: dir of a built console app to serve at /console/
  token = null,          // optional: when set, every /api/* request must carry
                         //   Authorization: Bearer <token> — else 401
  allowMutations = true, // when false, mutating /api routes return 405
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
  const conflictResolutionLog = createConflictResolutionLog(MANIFEST);

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

  function readManifest() {
    return readContextManifest(MANIFEST, { allowMissing: false });
  }

  // The read path's manifest, where a single malformed layer is quarantined
  // rather than fatal: validation used to throw inside every route's
  // openSources(), so one bad layer answered 500 on /api/settings and
  // /api/graph — the two screens a user needs to see the problem and fix it.
  // The quarantined layers are NOT in the manifest this returns: they cannot be
  // built, watched, or reached by the file APIs, only shown as broken rows.
  // Mutations keep using readManifest(), so nothing invalid is ever written.
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
    closeWatchers();
    const prev = cache;
    cache = null;
    for (const entry of indexes.values()) entry.cancel?.();
    indexes = new Map();
    graphMemo = null;
    conceptTokens = new Map();
    if (prev) for (const s of prev.sources) s.close?.();
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
  function startIndex(source, key, settings, { validity = null, previousSnap = null, passes = 1 } = {}) {
    const controller = new AbortController();
    const refreshing = previousSnap !== null;
    const entry = {
      key,
      status: refreshing ? "ready" : "indexing",
      phase: refreshing ? "ready" : "queued",
      loaded: 0,
      total: null,
      snap: previousSnap,
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
    withDeadline(
      snapshotSource(source, entry, controller.signal),
      budget,
      `Indexing took longer than ${Math.round(budget / 1000)}s. Raise the time budget in Settings, or point this source at a smaller folder.`,
      () => controller.abort(new Error("Indexing timed out")),
    )
      .then((snap) => {
        if (indexes.get(entry.key) !== entry) return; // superseded by a newer config
        entry.snap = snap;
        entry.status = "ready";
        entry.phase = "ready";
      })
      .catch((err) => {
        if (indexes.get(entry.key) !== entry) return;
        entry.status = "error";
        entry.phase = "error";
        entry.error = err.message;
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
    return {
      source, // the adapter, which is stable; the live `entry` is deliberately absent
      snap: entry.snap,
      status: entry.status === "ready" ? "ok" : entry.status,
      error: entry.error,
      progress: indexProgress(entry),
      health: typeof source.health === "function" ? source.health() : null,
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
        json(res, 200, patchSourceApi(await readBody(req)));
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

    const sourcesOut = perSource.map(({ source: s, snap, status, error, progress, health }) => {
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
        // Enough for "last synced X, failed Y ago" without a second request.
        // Null on sources that keep no health (local bundles, MCP children).
        lastErrorAt: health?.lastErrorAt ?? null,
        lastSuccessAt: health?.lastSuccessAt ?? null,
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
    const key = JSON.stringify(contributing.map((p) => [p.source.name, p.source.level, p.snap.gen]));
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
      };
    });
    // A source with nothing to serve yet. A source refreshing behind a good
    // snapshot is deliberately NOT here: it has an answer, so a client has
    // nothing to wait for and no reason to hold a spinner up in front of it.
    const pending = pinned.filter((p) => p.progress.status === "indexing").map((p) => p.source.name);
    return {
      generation: bumpGeneration(pinned),
      indexing: pending.length > 0,
      indexingSources: pending,
      sources,
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
    return resolved;
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

    // Prove the log location is writable before source files are touched.
    await conflictResolutionLog.prepare();
    const write = await writeSectionApi(JSON.stringify({
      conceptId,
      sectionKey,
      layers: contributions.map((item) => item.layer),
      content: chosen.content,
      expectedContent,
      requireAll: true,
    }), fileRoots());

    const record = await conflictResolutionLog.append({
      id: randomUUID(),
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
      ...(supersedes ? { supersedes } : {}),
    });
    invalidateIndex();
    return { ok: true, resolution: record, written: write.written };
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
    const pending = pinned.filter((p) => p.progress.status === "indexing").map((p) => p.source.name);
    return { concepts, errors, indexing: pending.length > 0, indexingSources: pending };
  }

  // ---- settings ---------------------------------------------------------------

  function getSettingsApi() {
    const { manifest, settings } = openSources();
    return { settings, stored: manifest.settings ?? {}, catalog: settingsCatalog() };
  }

  function patchSettingsApi(rawBody) {
    const body = parseJson(rawBody);
    let clean;
    try {
      clean = validateSettingsPatch(body.settings ?? body);
    } catch (err) {
      throw httpError(400, err.message);
    }
    try {
      mutateContextManifest(MANIFEST, (manifest) => {
        const next = { ...(manifest.settings ?? {}) };
        for (const key of Object.keys(body.settings ?? body)) {
          if (clean[key] === undefined) delete next[key]; // null = reset to default
          else next[key] = clean[key];
        }
        if (Object.keys(next).length === 0) delete manifest.settings;
        else manifest.settings = next;
      }, { allowMissing: false, allowTransitional: true });
    } catch (err) {
      // Settings deliberately stay a STRICT write — an invalid layer is not
      // this route's to tolerate, and quietly rewriting a manifest read around
      // one is how a hand-edited layer would get dropped without being asked
      // about. But answering 500 with a layer's validation error, on the
      // Settings screen, tells the user nothing about where to go. Removing
      // the bad source is the repair, and it has a screen of its own.
      if (err.status) throw err;
      throw httpError(409, `Settings were not saved: a source in your manifest is invalid, and saving would rewrite the file around it. Remove it in Sources first — ${err.message}`);
    }
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

  async function addSourceApi(rawBody) {
    const b = parseJson(rawBody);
    const name = String(b.name ?? "").trim();
    if (!/^[a-zA-Z0-9 _-]{1,40}$/.test(name)) throw httpError(400, "Name: letters/numbers/space/_/- (max 40)");
    const initialManifest = readManifest();
    if (getManifestProfileLayers(initialManifest).some((l) => l.name === name)) throw httpError(409, `A source named "${name}" already exists`);
    const level = Number.isFinite(+b.level) ? +b.level : 1;

    let layer;
    let folder = null;
    if (b.kind === "local" || b.kind === "files") {
      if (!b.path) throw httpError(400, "Local source needs a path");
      const given = expandHome(String(b.path).trim());
      folder = await probeFolder(path.resolve(MANIFEST_DIR, given), b.kind === "files" ? FILES_EXTENSIONS : [".md"]);
      layer = {
        name,
        level,
        path: given,
        ...(b.kind === "files" ? { source: "files" } : {}),
      };
    } else if (b.kind === "mcp") {
      if (!b.command) throw httpError(400, "MCP source needs a command");
      if (b.trusted !== true) {
        throw httpError(400, "Confirm that this MCP command came from a trusted source");
      }
      const args = Array.isArray(b.args) ? b.args.map(String) : String(b.args ?? "").split(/\s+/).filter(Boolean);
      const command = String(b.command);
      // Probe with the same arg resolution buildSources applies, so the check
      // exercises exactly what the layer will run.
      const probeArgs = args.map((a) => (a.startsWith("./") || a.startsWith("../") ? path.resolve(MANIFEST_DIR, a) : a));
      await probeMcp({ name, level, command, args: probeArgs });
      layer = { name, level, source: "mcp", command, args };
    } else if (b.kind === "github-rest") {
      // The "Public repo" wizard path: a REST-read layer, no clone. This form
      // deliberately writes an anonymous github layer, so auth/apiBase are
      // rejected rather than silently ignored. Private repos take the git-clone
      // kind in the wizard; authenticated REST layers remain an explicit
      // manifest feature because they must name the intended credential alias.
      if (b.auth !== undefined || b.apiBase !== undefined) {
        throw httpError(400, "A public-repo source reads anonymously — remove auth/apiBase. For private repos use the Private repo (git) option.");
      }
      const slug = String(b.repo ?? "").trim();
      const parts = slug.split("/");
      if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..")) {
        throw httpError(400, 'Repo must be "owner/name"');
      }
      if (b.paths !== undefined && (!Array.isArray(b.paths) || b.paths.some((p) => typeof p !== "string"))) {
        throw httpError(400, "paths must be an array of strings");
      }
      await probeGithubRest(slug);
      layer = {
        name,
        level,
        source: "github",
        repo: slug,
        ...(b.ref ? { ref: String(b.ref) } : {}),
        ...(Array.isArray(b.paths) && b.paths.length ? { paths: b.paths } : {}),
        cache: { ttlSeconds: 900 },
      };
    } else if (b.kind === "github") {
      const { url, slug } = normalizeRepo(String(b.repo ?? ""));
      const dir = path.join(CACHE_DIR, slug);
      await gitCloneOrPull(url, dir, b.ref ? String(b.ref) : null);
      const sub = b.subdir ? String(b.subdir).replace(/^\/+|\/+$/g, "") : "";
      // The sub-directory must stay inside the clone — otherwise this field would
      // set a new sandbox root (layer.path) pointing anywhere on disk.
      let abs = dir;
      if (sub) {
        abs = path.resolve(dir, sub);
        if (abs !== dir && !abs.startsWith(dir + path.sep)) throw httpError(400, "Sub-directory escapes the repository");
      }
      folder = await probeFolder(abs, [".md"]);
      layer = { name, level, path: path.relative(MANIFEST_DIR, abs), origin: url, ref: b.ref || null };
    } else {
      throw httpError(400, `Unknown source kind: ${b.kind}`);
    }

    mutateContextManifest(MANIFEST, (manifest) => {
      const layers = getManifestProfileLayers(manifest);
      if (layers.some((candidate) => candidate.name === name)) throw httpError(409, `A source named "${name}" already exists`);
      layers.push(layer);
      // A synced source whose machine-local path/command was scrubbed waits in
      // pendingSources. Configuring that source locally promotes it to a runnable
      // layer without leaving a duplicate metadata-only record behind.
      removePendingSource(defaultProfileContainer(manifest), name);
    }, { allowMissing: false, allowTransitional: true });
    reload();
    return {
      ok: true,
      added: name,
      indexing: true, // counts arrive via /api/graph as the index lands
      ...(folder ? { hasDocuments: folder.found, scanComplete: folder.complete } : {}),
    };
  }

  // Add-time folder validation, deliberately cheap. Only the two things the
  // user can fix on the form are errors here: the folder has to exist and be a
  // folder. Size is NOT checked — a big folder is a normal thing to add, and
  // making the user wait for a full walk before the app opens is the hang this
  // whole path exists to avoid. The shallow probe just reports whether any
  // documents were spotted, so the wizard can warn about an empty folder
  // without indexing it.
  async function probeFolder(abs, extensions) {
    let st;
    try { st = await fsp.stat(abs); } catch { throw httpError(400, `Folder not found: ${abs}`); }
    if (!st.isDirectory()) throw httpError(400, `Not a folder: ${abs}`);
    const controller = new AbortController();
    try {
      // The deadline has to reach the walk, not just the promise: without the
      // signal a probe of a slow or enormous folder answers the form in 5s and
      // then keeps scanning in the background, competing with the index the add
      // just started.
      return await withDeadline(
        probeDocs(abs, extensions, undefined, { signal: controller.signal }),
        5_000,
        "probe timed out",
        () => controller.abort(new Error("Folder probe timed out")),
      );
    } catch {
      return { found: false, scanned: 0, complete: false }; // slow disk — let the background index decide
    }
  }

  // Add-time github-rest validation: one bounded, anonymous request. A definite
  // "that repo isn't public" (404, or 403 — the shape GitHub also uses for rate
  // limits and blocked repos) fails the form with a pointer at the private-repo
  // option; anything network-shaped writes the layer anyway — the cheap-add
  // doctrine: the background index runs next and health() marks the source
  // degraded with the real error, instead of an offline laptop blocking setup.
  // The env override exists for the network-free test suite only; the manifest
  // layer this endpoint writes never carries an apiBase.
  async function probeGithubRest(slug) {
    const base = process.env.CONTEXTCAKE_GITHUB_PROBE_BASE || "https://api.github.com";
    let res;
    try {
      res = await fetch(`${base}/repos/${slug}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "contextcake",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(10_000), // mirrors the adapter's request timeout
      });
    } catch {
      return; // unreachable — fail open, the first index reports health honestly
    }
    if (res.status === 404 || res.status === 403) {
      throw httpError(400, "repo not found or not public — for private repos use the Private repo (git) option");
    }
  }

  // Add-time MCP validation: spawn the command and require an answer to
  // tools/list (bounded by the adapter's own timeouts) before the manifest is
  // written. A wrong command fails the form in seconds; the old behavior was a
  // silently-empty source. The probe also checks the answer: a server that
  // responds but lacks the two graph tools would otherwise pass the form and
  // become a permanently empty source — the exact silence the probe exists to
  // prevent.
  async function probeMcp({ name, level, command, args }) {
    const probe = createMcpSource({ name, level, command, args });
    try {
      await probe.probe();
    } catch (err) {
      if (err.code === "CONTRACT") {
        throw httpError(400, "This MCP server responded but doesn't speak the ContextCake graph contract (needs list_nodes and get_node tools).");
      }
      throw httpError(400, `The MCP server did not respond (${err.message}). Check the command and try again.`);
    } finally {
      probe.close();
    }
  }

  /**
   * The one repair route. It reads through repairContextManifest rather than
   * mutateContextManifest, so a quarantined layer — the row /api/graph shows as
   * an error — can be taken out from the app. Everything about what may be
   * WRITTEN is unchanged: repairContextManifest validates the whole manifest
   * before the file is touched.
   *
   * `?name=` may repeat, and that is not a convenience. What may be persisted
   * is a VALID manifest, so with two invalid entries present, removing either
   * one on its own is refused — the remaining one still fails validation. A
   * manifest with several bad layers would be unrepairable from the app, which
   * is the situation this whole path exists to end. Removing them in one
   * transaction is the only shape that both fixes the file and keeps the write
   * strict. The 409 below says so when a client asked for too little.
   */
  function removeSourceApi(names) {
    const wanted = [...new Set(names.filter((name) => typeof name === "string" && name))];
    if (wanted.length === 0) throw httpError(400, "Provide ?name=");
    const removed = [];
    let survivors = [];
    let blocking = [];
    try {
      repairContextManifest(MANIFEST, ({ manifest, layers, quarantined }) => {
        const container = defaultProfileContainer(manifest);
        // Quarantined rows for the profile this service reads. A layer
        // quarantined out of some OTHER profile has no row here to have been
        // clicked, and removing it is not this route's business.
        const broken = quarantined.filter((entry) => entry.profileId === "default");
        // A set, because these become splices: two names resolving to one index
        // would take a second, innocent layer with them.
        const doomed = new Set();
        for (const name of wanted) {
          const pendingBefore = container.pendingSources?.length ?? 0;
          removePendingSource(container, name);
          const droppedPending = (container.pendingSources?.length ?? 0) !== pendingBefore;
          const index = layers.findIndex((layer) => layer.name === name);
          if (index >= 0) { doomed.add(index); continue; }
          // A quarantined row is matched on the name the graph gave it, which
          // may be synthesized, and removed at the index that name was minted
          // for — see the record's `index`. Valid layers win the name first, so
          // this can never shadow a healthy row.
          const entry = broken.find((candidate) => candidate.name === name);
          if (entry) { doomed.add(entry.index); continue; }
          if (!droppedPending) throw httpError(404, `No source named "${name}"`);
        }
        // Descending, so each splice leaves the indices below it alone.
        for (const index of [...doomed].sort((a, b) => b - a)) {
          removed.push(layers[index]);
          layers.splice(index, 1);
        }
        // What the write is about to reject on, if it rejects: every invalid
        // entry the caller did NOT ask to remove.
        blocking = broken.filter((entry) => !doomed.has(entry.index));
        survivors = allManifestLayers(manifest); // every profile — a shared clone must survive
      }, { allowTransitional: true });
    } catch (err) {
      if (err.status) throw err;
      if (blocking.length > 0) {
        const listed = blocking.map((entry) => `"${entry.name}" (${entry.error})`).join("; ");
        throw httpError(409, `Nothing was removed: ${blocking.length} other source${blocking.length === 1 ? " is" : "s are"} also invalid, and the manifest cannot be saved while ${blocking.length === 1 ? "it remains" : "they remain"}. Remove ${blocking.length === 1 ? "it" : "them"} in the same request — ${listed}`);
      }
      // A manifest broken in a way no single layer explains (two layers sharing
      // a name, a malformed profiles block) is not repairable from here, and a
      // 500 would read as "the app is broken" rather than "your file is". Say
      // which, and keep the engine's own message — it names the actual defect.
      throw httpError(409, `Nothing was removed: the manifest is invalid in a way this app cannot repair. Edit ${MANIFEST} by hand — ${err.message}`);
    }
    for (const layer of removed) cleanupCloneDir(layer, survivors);
    reload();
    return { ok: true, removed: wanted[0], removedNames: wanted };
  }

  // Every layer the manifest still declares, across the legacy array and every
  // profile — the audience whose paths can keep a clone directory alive.
  function allManifestLayers(manifest) {
    const out = [...(manifest.layers ?? [])];
    for (const profile of Object.values(manifest.profiles ?? {})) out.push(...(profile.layers ?? []));
    return out;
  }

  // A wizard-cloned repo lives in app-managed disk under .cache/repos, so
  // removing its layer removes the clone — unless another layer (any profile)
  // still resolves inside that directory, e.g. two sub-directory layers over
  // one repo. Every other kind points at the user's own folder and is never
  // touched. Best effort: an undeletable orphan dir is not worth failing the
  // remove that already happened.
  function cleanupCloneDir(layer, survivors) {
    const dir = cloneDirOf(layer);
    if (!dir) return;
    const inUse = survivors.some((candidate) => {
      if (typeof candidate?.path !== "string") return false;
      const resolved = path.resolve(MANIFEST_DIR, candidate.path);
      return resolved === dir || resolved.startsWith(dir + path.sep);
    });
    if (inUse) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* orphan dir stays; the manifest entry is already gone */ }
  }

  // The clone directory a layer's origin maps to — null unless the layer is a
  // clone-backed github layer whose own path actually lives under CACHE_DIR
  // (a pack: origin, a REST layer, or a hand-retargeted path all bail out).
  function cloneDirOf(layer) {
    if (!layer || typeof layer.origin !== "string" || typeof layer.path !== "string") return null;
    let slug;
    try { ({ slug } = normalizeRepo(layer.origin)); } catch { return null; }
    const dir = path.join(CACHE_DIR, slug);
    if (!dir.startsWith(CACHE_DIR + path.sep)) return null;
    const resolved = path.resolve(MANIFEST_DIR, layer.path);
    if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
    return dir;
  }

  function patchSourceApi(rawBody) {
    const b = parseJson(rawBody);
    mutateContextManifest(MANIFEST, (manifest) => {
      const layers = getManifestProfileLayers(manifest);
      const layer = layers.find((candidate) => candidate.name === b.name);
      if (!layer) throw httpError(404, `No source named "${b.name}"`);
      if (b.level !== undefined && Number.isFinite(+b.level)) layer.level = +b.level;
      if (b.newName && b.newName !== b.name) {
        if (!/^[a-zA-Z0-9 _-]{1,40}$/.test(b.newName)) throw httpError(400, "Invalid new name");
        if (layers.some((candidate) => candidate.name === b.newName)) throw httpError(409, "Name already exists");
        layer.name = b.newName;
      }
    }, { allowMissing: false, allowTransitional: true });
    reload();
    return { ok: true };
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
    await gitCloneOrPull(url, path.join(CACHE_DIR, slug), layer.ref ?? null);
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

  // Auth failures from git are wordy and blame the wrong thing ("could not read
  // Username"). The API turns them into one flag the UI can act on, because the
  // fix is a specific action — connect an account — not a retry.
  function looksLikeAuthFailure(text) {
    return /authentication failed|could not read (username|password)|terminal prompts disabled|repository not found|403|401/i.test(text);
  }

  async function gitCloneOrPull(url, dir, ref) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const secrets = gitCredentialsForUrl(url);
    const attempts = secrets.length ? secrets : [null];
    const pulling = fs.existsSync(path.join(dir, ".git"));

    // Two things matter here beyond "the clone works".
    //
    // First, the credential must not outlive this command. Git's helper chain
    // is cumulative and normally ends at osxkeychain, so simply supplying a
    // token would have git WRITE it into the login keychain — a copy outside
    // our own store, keyed to the host, surviving uninstall and invisible to
    // the app's own disconnect. Setting credential.helper to empty first
    // clears the inherited chain; the one-shot below is then the only helper,
    // and it stores nothing.
    //
    // Second, the secret rides the child's environment rather than argv: the
    // helper *text* is visible in `ps`, the value it dereferences is not.
    // GIT_TRACE and friends are stripped for the same reason — a tracing
    // variable already in the user's shell would otherwise dump the exchange.
    let lastError = null;
    for (let i = 0; i < attempts.length; i += 1) {
      const secret = attempts[i];
      const config = [];
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^GIT_(TRACE|CURL_VERBOSE)/i.test(key)) delete env[key];
      }
      env.GIT_TERMINAL_PROMPT = "0"; // never block on an invisible prompt
      env.GIT_CONFIG_NOSYSTEM = "1"; // system config can't inject a helper either
      if (secret) {
        env.CC_GIT_TOKEN = secret;
        config.push(
          "-c", "credential.helper=",
          "-c", 'credential.helper=!f() { echo username=x-access-token; echo "password=$CC_GIT_TOKEN"; }; f',
        );
      }

      try {
        if (pulling) {
          await execFileP("git", [...config, "-C", dir, "pull", "--ff-only"], { timeout: 60000, env });
        } else {
          const args = [...config, "clone", "--depth", "1"];
          if (ref) args.push("--branch", ref);
          args.push(url, dir);
          await execFileP("git", args, { timeout: 120000, env });
        }
        return;
      } catch (err) {
        lastError = err;
        const text = String(err.stderr || err.message || "");
        const retryingAnotherAccount = looksLikeAuthFailure(text) && i < attempts.length - 1;
        // A failed or timed-out clone may leave a partial app-managed
        // directory. Remove it even after the final attempt so a later user
        // retry does not fail with "destination path already exists" instead
        // of retrying the remote.
        if (!pulling) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the git failure remains the useful error */ }
        }
        if (!retryingAnotherAccount) break;
      }
    }

    if (lastError) {
      let text = String(lastError.stderr || lastError.message || "");
      // The token should never appear in git's output, but this error string
      // reaches an HTTP response body — so make it structurally impossible
      // rather than merely unlikely.
      for (const secret of secrets) text = text.split(secret).join("[redacted]");
      const detail = text.trim().split("\n").pop();
      const needsAuth = looksLikeAuthFailure(text);
      throw httpError(502, `git failed: ${detail}`, {
        needsAuth,
        ...(needsAuth && secrets.length === 0 ? { hint: "This repository looks private. Connect a GitHub account in Settings → Connections, then try again." } : {}),
        ...(needsAuth && secrets.length > 0 ? { hint: "None of the connected GitHub accounts can access this repository. Check their access, or connect a different account." } : {}),
      });
    }
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

  return { handleRequest, close, getSources, reload, setTokens };
}
