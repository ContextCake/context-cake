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
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, timingSafeEqual } from "node:crypto";
import { buildSources } from "./sources/index.mjs";
import { resolveConcept } from "./resolver.mjs";
import { countTokens, conceptText, TOKENIZER } from "./tokenize.mjs";

const execFileP = promisify(execFile);

// ---- shared HTTP internals (also used by the playground wrapper) ------------

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5_000_000) reject(httpError(413, "Body too large")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Guard for state-changing requests, shared by the service routes and the
 * playground's editor endpoints. No-op for non-mutating methods. Returns true
 * if it wrote a 403 (caller must stop), false to proceed.
 */
export function guardMutatingRequest(req, res) {
  if (!MUTATING.has(req.method)) return false;
  // DNS-rebinding defense: a rebound domain can make a remote page's request
  // look same-origin, so the Host must be a loopback name (we bind 127.0.0.1).
  const hostname = (req.headers.host || "").replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(hostname)) { json(res, 403, { error: "Untrusted Host header" }); return true; }
  // CSRF: block cross-origin state-changing requests (add MCP source = command
  // spawn, git clone, file/section write). Same-origin and non-browser callers
  // (curl/tests send neither header) are allowed.
  const site = req.headers["sec-fetch-site"];
  const origin = req.headers.origin;
  let blocked = false;
  if (site !== undefined) blocked = site !== "same-origin" && site !== "none";
  else if (origin !== undefined) {
    try { blocked = new URL(origin).host !== req.headers.host; } catch { blocked = true; }
  }
  if (blocked) { json(res, 403, { error: "Cross-origin request blocked" }); return true; }
  return false;
}

/**
 * The canonical containment guard, shared by every path that serves or writes
 * files (the playground's layer file APIs, the /console/ static mount). Two
 * checks: lexical prefix on the resolved path, then symlink defense — the
 * lexical check trusts the path text, but a symlink inside the root could
 * still point outside it, so compare realpaths (of the existing target, or of
 * the parent dir for a not-yet-existing file). Returns the realpath'd target.
 */
export function assertInsideRoot(abs, root, message) {
  if (abs !== root && !abs.startsWith(root + path.sep)) throw httpError(403, message);
  const realRoot = safeRealpath(root);
  const realAbs = fs.existsSync(abs)
    ? safeRealpath(abs)
    : path.join(safeRealpath(path.dirname(abs)), path.basename(abs));
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) throw httpError(403, message);
  return realAbs;
}

function safeRealpath(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

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

function parseJson(raw) {
  try { return JSON.parse(raw || "{}"); } catch { throw httpError(400, "Body must be JSON"); }
}

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
  // playground's edit-and-refresh semantics: okf-local adapters read from disk
  // on every call, so bundle edits are always live, and manifest edits (by the
  // CRUD routes or by hand) invalidate the set. Unlike the old per-request
  // rebuild it does NOT re-spawn MCP children on every request — they live
  // until the manifest changes, reload(), or close().

  let closed = false;
  let cache = null; // { stamp, manifest, sources }

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
    const next = { stamp, manifest, sources: buildSources(manifest, MANIFEST_DIR) };
    const prev = cache;
    cache = next;
    deferClose(prev);
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
    const prev = cache;
    cache = null;
    if (prev) for (const s of prev.sources) s.close?.();
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

      if (p === "/api/graph") { json(res, 200, await buildGraph()); return true; }
      if (p === "/api/resolve") { json(res, 200, await resolveOne(url.searchParams.get("concept"))); return true; }
      if (p === "/api/resolve-all") { json(res, 200, await resolveAllApi()); return true; }
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
      json(res, err.status ?? 500, { error: err.message });
      return true;
    }
  }

  // ---- read API ---------------------------------------------------------------

  // Everything the canvas needs in one shot: the source topology + a concept
  // index annotated with which layers contribute and how many sections conflict.
  async function buildGraph() {
    const { manifest, sources } = openSources();
    const layerMeta = new Map((manifest.layers ?? []).map((l) => [l.name, l]));

    // Per-source concept lists + tokens. A source that fails to list (e.g. a
    // down MCP server or a missing clone) is recorded as errored, not fatal.
    const perSource = await Promise.all(
      sources.map(async (s) => {
        try {
          const ids = typeof s.listConceptIds === "function" ? await s.listConceptIds() : [];
          let tokens = 0;
          for (const id of ids) tokens += countTokens(conceptText(await s.loadConcept(id)));
          return { source: s, ids, tokens, status: "ok", error: null };
        } catch (err) {
          return { source: s, ids: [], tokens: 0, status: "error", error: err.message };
        }
      }),
    );

    // Resolve only over healthy sources so one bad source can't blank the index.
    const healthy = perSource.filter((p) => p.status === "ok").map((p) => p.source);
    const allIds = [...new Set(perSource.flatMap((p) => p.ids))].sort();

    const concepts = [];
    const latestPerSource = new Map(); // source name -> latest `updated`
    let resolvedTokens = 0;
    for (const id of allIds) {
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

    const sourcesOut = sources.map((s) => {
      const meta = layerMeta.get(s.name) ?? {};
      const kind = meta.source ?? "okf-local";
      const ps = perSource.find((p) => p.source === s);
      return {
        name: s.name,
        level: s.level,
        kind,
        location: kind === "mcp" ? [meta.command, ...(meta.args ?? [])].join(" ") : meta.path,
        origin: meta.origin ?? null, // e.g. a github repo a clone came from
        conceptCount: ps?.ids.length ?? 0,
        tokens: ps?.tokens ?? 0,
        latestUpdated: latestPerSource.get(s.name) ?? null,
        status: ps?.status ?? "error",
        error: ps?.error ?? null,
      };
    });

    const sourceTokens = sourcesOut.reduce((n, s) => n + s.tokens, 0);
    return {
      manifest: { path: MANIFEST },
      tokenizer: TOKENIZER,
      totals: { sourceTokens, resolvedTokens, concepts: concepts.length, sources: sourcesOut.length },
      sources: sourcesOut,
      concepts,
    };
  }

  async function resolveOne(conceptId) {
    if (!conceptId) throw httpError(400, "Provide ?concept=<id>");
    const { sources } = openSources();
    const resolved = await resolveConcept(conceptId, sources);
    if (!resolved) throw httpError(404, `Concept not found in any source: ${conceptId}`);
    return resolved;
  }

  // Resolve every concept in one pass over one set of open sources. The console's
  // initial load calls this instead of one /api/resolve per concept.
  // Per-concept failures are reported alongside the successes, never fatal.
  async function resolveAllApi() {
    const { sources } = openSources();
    const perSource = await Promise.all(
      sources.map(async (s) => {
        try {
          return { ids: typeof s.listConceptIds === "function" ? await s.listConceptIds() : [], source: s, error: null };
        } catch (err) {
          return { ids: [], source: s, error: err.message };
        }
      }),
    );
    const healthy = perSource.filter((p) => !p.error).map((p) => p.source);
    const allIds = [...new Set(perSource.flatMap((p) => p.ids))].sort();
    const concepts = [];
    const errors = [];
    for (const id of allIds) {
      try {
        const resolved = await resolveConcept(id, healthy);
        if (resolved) concepts.push(resolved);
        else errors.push({ concept: id, error: "not found in any healthy source" });
      } catch (err) {
        errors.push({ concept: id, error: err.message });
      }
    }
    return { concepts, errors };
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
    if (b.kind === "local") {
      if (!b.path) throw httpError(400, "Local source needs a path");
      layer = { name, level, path: String(b.path) };
    } else if (b.kind === "mcp") {
      if (!b.command) throw httpError(400, "MCP source needs a command");
      const args = Array.isArray(b.args) ? b.args.map(String) : String(b.args ?? "").split(/\s+/).filter(Boolean);
      layer = { name, level, source: "mcp", command: String(b.command), args };
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
      layer = { name, level, path: path.relative(MANIFEST_DIR, abs), origin: url, ref: b.ref || null };
    } else {
      throw httpError(400, `Unknown source kind: ${b.kind}`);
    }

    manifest.layers.push(layer);
    writeManifest(manifest);
    reload();
    return { ok: true, added: name };
  }

  function removeSourceApi(name) {
    if (!name) throw httpError(400, "Provide ?name=");
    const manifest = readManifest();
    const before = (manifest.layers ?? []).length;
    manifest.layers = (manifest.layers ?? []).filter((l) => l.name !== name);
    if (manifest.layers.length === before) throw httpError(404, `No source named "${name}"`);
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
    const layer = (readManifest().layers ?? []).find((l) => l.name === name);
    if (!layer) throw httpError(404, `No source named "${name}"`);
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
