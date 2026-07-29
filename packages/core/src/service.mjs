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
import { createHash, timingSafeEqual } from "node:crypto";
import { buildSources } from "./sources/index.mjs";
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

// ---- the service -------------------------------------------------------------

export function createEngineService({
  manifestPath,          // required: path to manifest.json (may not exist yet)
  consoleDist = null,    // optional: dir of a built console app to serve at /console/
  token = null,          // optional: when set, every /api/* request must carry
                         //   Authorization: Bearer <token> — else 401
  allowMutations = true, // when false, mutating /api routes return 405
} = {}) {
  if (!manifestPath) throw new Error("createEngineService: manifestPath is required");
  const MANIFEST = path.resolve(manifestPath);
  const MANIFEST_DIR = path.dirname(MANIFEST);
  const CONSOLE_DIR = consoleDist ? path.resolve(consoleDist) : null;
  // Git-backed sources clone next to the manifest that declares them.
  const CACHE_DIR = path.join(MANIFEST_DIR, ".cache", "repos");

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
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  }

  function writeManifest(manifest) {
    fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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
    const manifest = readManifest(); // throws while the manifest is missing/invalid
    const settings = resolveSettings(manifest);
    const layers = manifest.layers ?? [];
    const next = {
      stamp,
      manifest,
      settings,
      sources: buildSources(manifest, MANIFEST_DIR),
      // Identity of a source's *configuration* (plus the settings that govern
      // indexing), so an unrelated manifest edit doesn't discard a finished index.
      keys: layers.map((l) => `${JSON.stringify(l)}::${JSON.stringify(settings)}`),
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
      return {
        name: s.name,
        level: s.level,
        kind,
        location: kind === "mcp" ? [meta.command, ...(meta.args ?? [])].join(" ") : meta.path,
        origin: meta.origin ?? null, // e.g. a github repo a clone came from
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
    const manifest = readManifest();
    const next = { ...(manifest.settings ?? {}) };
    for (const key of Object.keys(body.settings ?? body)) {
      if (clean[key] === undefined) delete next[key]; // null = reset to default
      else next[key] = clean[key];
    }
    if (Object.keys(next).length === 0) delete manifest.settings;
    else manifest.settings = next;
    writeManifest(manifest);
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
    const manifest = readManifest();
    manifest.layers = manifest.layers ?? [];
    if (manifest.layers.some((l) => l.name === name)) throw httpError(409, `A source named "${name}" already exists`);
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

    manifest.layers.push(layer);
    // A synced source whose machine-local path/command was scrubbed waits in
    // pendingSources. Configuring that source locally promotes it to a runnable
    // layer without leaving a duplicate metadata-only record behind.
    if (Array.isArray(manifest.pendingSources)) {
      manifest.pendingSources = manifest.pendingSources.filter((pending) => pending?.name !== name);
      if (manifest.pendingSources.length === 0) {
        delete manifest.pendingSources;
        delete manifest.pendingSourcesOwnerUserId;
      }
    }
    writeManifest(manifest);
    reload(); // starts this source's background index
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

  // Add-time MCP validation: spawn the command and require an answer to
  // tools/list (bounded by the adapter's own timeouts) before the manifest is
  // written. A wrong command fails the form in seconds; the old behavior was a
  // silently-empty source.
  async function probeMcp({ name, level, command, args }) {
    const probe = createMcpSource({ name, level, command, args });
    try {
      await probe.probe();
    } catch (err) {
      throw httpError(400, `The MCP server did not respond (${err.message}). Check the command and try again.`);
    } finally {
      probe.close();
    }
  }

  function removeSourceApi(name) {
    if (!name) throw httpError(400, "Provide ?name=");
    const manifest = readManifest();
    const before = (manifest.layers ?? []).length;
    const pendingBefore = (manifest.pendingSources ?? []).length;
    manifest.layers = (manifest.layers ?? []).filter((l) => l.name !== name);
    if (Array.isArray(manifest.pendingSources)) {
      manifest.pendingSources = manifest.pendingSources.filter((pending) => pending?.name !== name);
      if (manifest.pendingSources.length === 0) {
        delete manifest.pendingSources;
        delete manifest.pendingSourcesOwnerUserId;
      }
    }
    if (manifest.layers.length === before && (manifest.pendingSources ?? []).length === pendingBefore) {
      throw httpError(404, `No source named "${name}"`);
    }
    writeManifest(manifest);
    reload();
    return { ok: true, removed: name };
  }

  function patchSourceApi(rawBody) {
    const b = parseJson(rawBody);
    const manifest = readManifest();
    const layer = (manifest.layers ?? []).find((l) => l.name === b.name);
    if (!layer) throw httpError(404, `No source named "${b.name}"`);
    if (b.level !== undefined && Number.isFinite(+b.level)) layer.level = +b.level;
    if (b.newName && b.newName !== b.name) {
      if (!/^[a-zA-Z0-9 _-]{1,40}$/.test(b.newName)) throw httpError(400, "Invalid new name");
      if (manifest.layers.some((l) => l.name === b.newName)) throw httpError(409, "Name already exists");
      layer.name = b.newName;
    }
    writeManifest(manifest);
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

  async function gitCloneOrPull(url, dir, ref) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    try {
      if (fs.existsSync(path.join(dir, ".git"))) {
        await execFileP("git", ["-C", dir, "pull", "--ff-only"], { timeout: 60000 });
      } else {
        const args = ["clone", "--depth", "1"];
        if (ref) args.push("--branch", ref);
        args.push(url, dir);
        await execFileP("git", args, { timeout: 120000 });
      }
    } catch (err) {
      const detail = String(err.stderr || err.message || "").trim().split("\n").pop();
      throw httpError(502, `git failed: ${detail}`);
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

  return { handleRequest, close, getSources, reload };
}
