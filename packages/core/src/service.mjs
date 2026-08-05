// ContextCake engine HTTP service — the embeddable half of the playground
// server. createEngineService() wraps the cascade engine (sources + resolver)
// in a framework-free request handler a host mounts inside its own node:http
// server: the read API (/api/graph, /api/resolve, /api/resolve-all), the
// sources CRUD (/api/sources, /api/sources/sync), and an optional static mount
// for a built console app under /console/. Dependency-free — plain Node
// built-ins, like the rest of packages/core.
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
import { buildSources, resolveTokenState } from "./sources/index.mjs";
import { probeDocs } from "./sources/okf-local.mjs";
import { FILES_EXTENSIONS } from "./sources/files.mjs";
import { createMcpSource } from "./sources/mcp.mjs";
import { resolveConcept } from "./resolver.mjs";
import { countTokens, conceptText, warmTokenizer, TOKENIZER } from "./tokenize.mjs";
import { resolveSettings, walkLimitsFrom, validateSettingsPatch, settingsCatalog } from "./settings.mjs";
import {
  assertInsideRoot, guardMutatingRequest, httpError, json, MIME, parseJson, readBody,
} from "./http-util.mjs";
import {
  layerRootMap, listFilesApi, readFileApi, serveRawApi, writeFileApi, writeSectionApi,
} from "./layer-files.mjs";
import { createConflictResolutionLog, trivialConflictReason } from "./conflict-resolutions.mjs";
import {
  classifyManifest,
  getManifestProfileLayers,
  mutateContextManifest,
  readContextManifest,
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
  const ids = typeof source.listConceptIds === "function" ? await source.listConceptIds() : [];
  throwIfAborted();
  entry.phase = "loading";
  entry.total = ids.length;
  const concepts = new Map();
  let tokens = 0;
  let n = 0;
  for (const id of ids) {
    throwIfAborted();
    const concept = await source.loadConcept(id);
    throwIfAborted();
    concepts.set(id, concept);
    tokens += countTokens(conceptText(concept));
    if (++n % YIELD_EVERY === 0) {
      entry.loaded = n;
      await yieldNow();
    }
  }
  entry.loaded = n;
  return { ids, concepts, tokens };
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
    const stored = readManifest(); // throws while the manifest is missing/invalid
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
    const next = {
      stamp,
      manifest,
      settings,
      sources: buildSources(manifest, MANIFEST_DIR, { tokens: tokenState.tokens }),
      // Identity of a source's *configuration* (plus the settings that govern
      // indexing, plus the credential epoch for layers that actually name a
      // credential). A token that arrives after an anonymous GitHub index must
      // invalidate that index, but connecting an account must not rescan every
      // local folder and MCP graph in the cascade.
      keys: layers.map((l) => `${JSON.stringify(l)}::${JSON.stringify(settings)}::t${l.source === "github" && l.auth ? tokenState.epoch : 0}`),
    };
    const prev = cache;
    cache = next;
    deferClose(prev);
    pruneIndexes(next.keys);
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
    if (prev) for (const s of prev.sources) s.close?.();
  }

  // ---- background index ------------------------------------------------------

  function pruneIndexes(keys) {
    const live = new Set(keys);
    for (const key of [...indexes.keys()]) {
      if (live.has(key)) continue;
      indexes.get(key)?.cancel?.();
      indexes.delete(key);
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
        entry = startIndex(source, key, open.settings);
        indexes.set(key, entry);
      }
      return { source, key, entry, layer: (open.manifest.layers ?? [])[i] ?? {} };
    });
    return { ...open, entries };
  }

  // `previousSnap` keeps the last good answer readable while a re-index runs,
  // so a file edit refreshes the cascade without the UI blinking to empty.
  function startIndex(source, key, settings, previousSnap = null) {
    const controller = new AbortController();
    const entry = {
      status: "indexing",
      phase: "queued",
      loaded: 0,
      total: null,
      snap: previousSnap,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      cancel: () => controller.abort(new Error("Indexing superseded")),
    };
    const budget = settings.sourceBudgetMs;
    withDeadline(
      snapshotSource(source, entry, controller.signal),
      budget,
      `Indexing took longer than ${Math.round(budget / 1000)}s. Raise the time budget in Settings, or point this source at a smaller folder.`,
      () => controller.abort(new Error("Indexing timed out")),
    )
      .then((snap) => {
        if (indexes.get(key) !== entry) return; // superseded by a newer config
        entry.snap = snap;
        entry.status = "ready";
        entry.phase = "ready";
      })
      .catch((err) => {
        if (indexes.get(key) !== entry) return;
        entry.status = "error";
        entry.phase = "error";
        entry.error = err.message;
      })
      .finally(() => { entry.finishedAt = Date.now(); });
    return entry;
  }

  /**
   * Wait (up to `ms`) for every source to finish indexing. Requests never call
   * this by default — it exists for clients that explicitly ask (`?wait=`) and
   * for tests that need a settled graph to assert on.
   */
  async function awaitIndexes(ms) {
    const deadline = Date.now() + Math.max(0, ms);
    for (;;) {
      const { entries } = ensureIndexes();
      if (!entries.some((e) => e.entry.status === "indexing")) return;
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
   */
  function invalidateIndex(layerName = null) {
    if (closed) return;
    let open;
    try { open = openSources(); } catch { return; } // manifest unreadable — nothing to refresh
    open.sources.forEach((source, i) => {
      if (layerName !== null && source.name !== layerName) return;
      const key = open.keys[i];
      const previous = indexes.get(key);
      previous?.cancel?.();
      indexes.set(key, startIndex(source, key, open.settings, previous?.snap ?? null));
    });
  }

  // Disk-backed layers can also change from outside the app — someone edits a
  // note in Obsidian or pulls a repo. Watch each layer root and re-index on
  // change, debounced so a burst of writes costs one pass. Best effort by
  // design: recursive watching is supported on macOS and Windows but not
  // Linux, where only top-level changes are seen. Every write through this
  // service invalidates explicitly (above), so the watcher is a convenience,
  // never the only path to freshness.
  const watchers = new Map(); // root -> { watcher, timer }
  const WATCH_DEBOUNCE_MS = 250;

  function syncWatchers() {
    const roots = new Map(); // root -> layer name
    for (const [name, { root }] of layerRootMap(openSources().manifest, MANIFEST_DIR)) {
      roots.set(root, name);
    }
    for (const [root, state] of watchers) {
      if (roots.has(root)) continue;
      clearTimeout(state.timer);
      try { state.watcher.close(); } catch { /* already gone */ }
      watchers.delete(root);
    }
    for (const [root, name] of roots) {
      if (watchers.has(root)) continue;
      let watcher;
      try {
        watcher = fs.watch(root, { recursive: true, persistent: false }, () => onChange(root, name));
      } catch {
        try {
          watcher = fs.watch(root, { persistent: false }, () => onChange(root, name));
        } catch {
          continue; // unwatchable (missing, permissions, descriptor limits) — reads still work
        }
      }
      watcher.on("error", () => {});
      watchers.set(root, { watcher, timer: null });
    }
  }

  function onChange(root, layerName) {
    const state = watchers.get(root);
    if (!state) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => invalidateIndex(layerName), WATCH_DEBOUNCE_MS);
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
        if (req.method === "DELETE") { json(res, 200, removeSourceApi(url.searchParams.get("name"))); return true; }
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
    const perSource = entries.map(({ source, entry }) => ({
      source,
      entry,
      snap: entry.snap,
      status: entry.status === "ready" ? "ok" : entry.status,
      error: entry.error,
    }));

    // Resolve over every source that produced a snapshot, from the snapshot,
    // so nothing is read twice and one slow or bad source can't blank the
    // index. A source that listed but reports itself degraded (see below)
    // still has a snapshot and stays in: it is serving cached or partial
    // content, which is the whole point of warn-and-continue. Only a source
    // that couldn't be read at all — or hasn't been read yet — drops out.
    const healthy = perSource.filter((p) => p.snap).map((p) => snapshotView(p.source, p.snap));
    const allIds = [...new Set(perSource.flatMap((p) => p.snap?.ids ?? []))].sort();

    const concepts = [];
    const latestPerSource = new Map(); // source name -> latest `updated`
    let resolvedTokens = 0;
    let sinceYield = 0;
    for (const id of allIds) {
      if (++sinceYield % YIELD_EVERY === 0) await yieldNow();
      let resolved = null;
      try { resolved = await resolveConcept(id, healthy); } catch { continue; }
      if (!resolved) continue;
      const conflictCount = resolved.sections.reduce((n, sec) => n + (sec.conflicts?.length ? 1 : 0), 0);
      const tokens = countTokens(conceptText(resolved));
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

    const sourcesOut = perSource.map(({ source: s, entry, snap, status, error }) => {
      const meta = layerMeta.get(s.name) ?? {};
      const kind = meta.source ?? "okf-local";
      // Whether the listing threw is not evidence a remote source is healthy:
      // remote adapters answer [] instead of throwing precisely so one down
      // repo can't fail a resolve. So an unreachable GitHub layer lists cleanly
      // with zero concepts — the same row an empty repo produces. health() is
      // the adapter's own account of whether its last request actually worked,
      // and it is the only thing that tells those two rows apart.
      const health = typeof s.health === "function" ? s.health() : null;
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
        indexing: indexProgress(entry),
        // Enough for "last synced X, failed Y ago" without a second request.
        // Null on sources that keep no health (local bundles, MCP children).
        lastErrorAt: health?.lastErrorAt ?? null,
        lastSuccessAt: health?.lastSuccessAt ?? null,
      };
    });

    const sourceTokens = sourcesOut.reduce((n, s) => n + s.tokens, 0);
    const pending = perSource.filter((p) => p.entry.status === "indexing").map((p) => p.source.name);
    return {
      manifest: { path: MANIFEST },
      tokenizer: TOKENIZER,
      // True while any source is still being read. Clients render what they
      // have and poll — this is never a reason to show a blocking spinner.
      indexing: pending.length > 0,
      indexingSources: pending,
      totals: { sourceTokens, resolvedTokens, concepts: concepts.length, sources: sourcesOut.length },
      sources: sourcesOut,
      concepts,
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
    const healthy = entries.filter((e) => e.entry.snap).map((e) => snapshotView(e.source, e.entry.snap));
    const allIds = [...new Set(entries.flatMap((e) => e.entry.snap?.ids ?? []))].sort();
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
    const pending = entries.filter((e) => e.entry.status === "indexing").map((e) => e.source.name);
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
    mutateContextManifest(MANIFEST, (manifest) => {
      const next = { ...(manifest.settings ?? {}) };
      for (const key of Object.keys(body.settings ?? body)) {
        if (clean[key] === undefined) delete next[key]; // null = reset to default
        else next[key] = clean[key];
      }
      if (Object.keys(next).length === 0) delete manifest.settings;
      else manifest.settings = next;
    }, { allowMissing: false, allowTransitional: true });
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
    try {
      return await withDeadline(probeDocs(abs, extensions), 5_000, "probe timed out");
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

  function removeSourceApi(name) {
    if (!name) throw httpError(400, "Provide ?name=");
    let removed = null;
    let survivors = [];
    mutateContextManifest(MANIFEST, (manifest) => {
      const layers = getManifestProfileLayers(manifest);
      const before = layers.length;
      const container = defaultProfileContainer(manifest);
      const pendingBefore = container.pendingSources?.length ?? 0;
      removed = layers.find((layer) => layer.name === name) ?? null;
      const retained = layers.filter((layer) => layer.name !== name);
      layers.splice(0, layers.length, ...retained);
      removePendingSource(container, name);
      if (layers.length === before && (container.pendingSources?.length ?? 0) === pendingBefore) {
        throw httpError(404, `No source named "${name}"`);
      }
      survivors = allManifestLayers(manifest); // every profile — a shared clone must survive
    }, { allowMissing: false, allowTransitional: true });
    cleanupCloneDir(removed, survivors);
    reload();
    return { ok: true, removed: name };
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
