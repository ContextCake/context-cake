#!/usr/bin/env node

// ContextCake Playground — a thin, dependency-free HTTP shell over the real
// cascade engine. It does NOT reimplement resolution: every concept is resolved
// by resolver.mjs against the sources built from a manifest, exactly like the
// CLI and the MCP server. The browser UI is just another reader of that output.
//
// Usage:
//   node playground/server.mjs [--manifest playground/manifest.json] [--port 8790]
//
// Sources are rebuilt per request so you can edit the demo OKF markdown and see
// the cascade change on refresh. Only serves static files inside playground/.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildSources } from "../sources/index.mjs";
import { resolveConcept } from "../resolver.mjs";
import { countTokens, conceptText, TOKENIZER } from "./tokenize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const MANIFEST = path.resolve(args.manifest ?? path.join(HERE, "manifest.json"));
const MANIFEST_DIR = path.dirname(MANIFEST);
const PORT = Number(args.port ?? 8790);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
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

// Files the explorer treats as editable text (CodeMirror). SVG is text AND image:
// editable as source, previewable as an image.
const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".json", ".mjs", ".js", ".ts", ".jsx", ".tsx", ".css", ".html", ".htm", ".yml", ".yaml", ".svg", ".sh", ".csv", ".xml", ".toml", ".ini", ".conf"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg"]);

function fileKind(ext) {
  if (ext === ".pdf") return "pdf";
  if (ext === ".svg") return "svg"; // editable text with an image preview
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/graph") return json(res, 200, await buildGraph());
    if (url.pathname === "/api/resolve") return json(res, 200, await resolveOne(url.searchParams.get("concept")));
    if (url.pathname === "/api/files") return json(res, 200, listFiles());
    if (url.pathname === "/api/file") {
      if (req.method === "PUT" || req.method === "POST") return json(res, 200, writeFileApi(await readBody(req)));
      return json(res, 200, readFileApi(url.searchParams.get("path")));
    }
    if (url.pathname === "/api/file/raw") return serveRaw(url.searchParams.get("path"), res);
    if (url.pathname === "/api/section" && (req.method === "PUT" || req.method === "POST")) {
      return json(res, 200, writeSectionApi(await readBody(req)));
    }
    if (url.pathname === "/api/sources") {
      if (req.method === "POST") return json(res, 200, await addSourceApi(await readBody(req)));
      if (req.method === "DELETE") return json(res, 200, removeSourceApi(url.searchParams.get("name")));
      if (req.method === "PATCH") return json(res, 200, patchSourceApi(await readBody(req)));
    }
    if (url.pathname === "/api/sources/sync" && req.method === "POST") {
      return json(res, 200, await syncSourceApi(url.searchParams.get("name")));
    }
    return serveStatic(url.pathname, res);
  } catch (err) {
    json(res, err.status ?? 500, { error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const manifest = readManifest();
  process.stdout.write(
    `ContextCake Playground\n` +
    `  manifest: ${MANIFEST}\n` +
    `  layers:   ${(manifest.layers ?? []).map((l) => `${l.name}(L${l.level})`).join("  >  ")}\n` +
    `  open:     http://127.0.0.1:${PORT}/\n`,
  );
});

// ---- API -------------------------------------------------------------------

// Build sources fresh each request so on-disk edits are reflected live.
function openSources() {
  const manifest = readManifest();
  return { manifest, sources: buildSources(manifest, MANIFEST_DIR) };
}

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
}

// Everything the canvas needs in one shot: the source topology + a concept
// index annotated with which layers contribute and how many sections conflict.
async function buildGraph() {
  const { manifest, sources } = openSources();
  try {
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
  } finally {
    for (const s of sources) s.close?.();
  }
}

async function resolveOne(conceptId) {
  if (!conceptId) throw httpError(400, "Provide ?concept=<id>");
  const { sources } = openSources();
  try {
    const resolved = await resolveConcept(conceptId, sources);
    if (!resolved) throw httpError(404, `Concept not found in any source: ${conceptId}`);
    return resolved;
  } finally {
    for (const s of sources) s.close?.();
  }
}

// ---- Source configuration (manifest CRUD + GitHub clone) ------------------

const CACHE_DIR = path.join(HERE, ".cache", "repos");
const execFileP = promisify(execFile);

function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function parseJson(raw) {
  try { return JSON.parse(raw || "{}"); } catch { throw httpError(400, "Body must be JSON"); }
}

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
    const abs = sub ? path.join(dir, sub) : dir;
    layer = { name, level, path: path.relative(MANIFEST_DIR, abs), origin: url, ref: b.ref || null };
  } else {
    throw httpError(400, `Unknown source kind: ${b.kind}`);
  }

  manifest.layers.push(layer);
  writeManifest(manifest);
  return { ok: true, added: name };
}

function removeSourceApi(name) {
  if (!name) throw httpError(400, "Provide ?name=");
  const manifest = readManifest();
  const before = (manifest.layers ?? []).length;
  manifest.layers = (manifest.layers ?? []).filter((l) => l.name !== name);
  if (manifest.layers.length === before) throw httpError(404, `No source named "${name}"`);
  writeManifest(manifest);
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
  return { ok: true };
}

async function syncSourceApi(name) {
  if (!name) throw httpError(400, "Provide ?name=");
  const layer = (readManifest().layers ?? []).find((l) => l.name === name);
  if (!layer) throw httpError(404, `No source named "${name}"`);
  if (!layer.origin) throw httpError(400, `"${name}" is not a git-backed source`);
  const { url, slug } = normalizeRepo(layer.origin);
  await gitCloneOrPull(url, path.join(CACHE_DIR, slug), layer.ref ?? null);
  return { ok: true, synced: name };
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

// ---- File explorer / editor (sandboxed to layer roots) --------------------

// name -> absolute root, for okf-local layers only (mcp layers own no files).
function layerRootMap() {
  const manifest = readManifest();
  const map = new Map();
  for (const layer of manifest.layers ?? []) {
    const kind = layer.source ?? "okf-local";
    if (kind === "okf-local" && layer.path) map.set(layer.name, path.resolve(MANIFEST_DIR, layer.path));
  }
  return map;
}

// Resolve an API path ("<layer>/<rel>") to an absolute path, refusing anything
// that escapes the layer's root. This is the trust boundary for read AND write.
function resolveFilePath(apiPath) {
  if (!apiPath) throw httpError(400, "Provide ?path=<layer>/<relative>");
  const norm = apiPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const slash = norm.indexOf("/");
  const layer = slash === -1 ? norm : norm.slice(0, slash);
  const rel = slash === -1 ? "" : norm.slice(slash + 1);
  const root = layerRootMap().get(layer);
  if (!root) throw httpError(404, `Unknown layer: ${layer}`);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw httpError(403, "Path escapes its layer root");
  return { abs, layer, rel, root, ext: path.extname(abs).toLowerCase() };
}

function listFiles() {
  const roots = layerRootMap();
  const layers = [];
  for (const [layer, root] of roots) {
    const files = walkFiles(root).map((abs) => {
      const rel = toPosix(path.relative(root, abs));
      const ext = path.extname(abs).toLowerCase();
      return { path: `${layer}/${rel}`, name: path.basename(abs), rel, ext, kind: fileKind(ext) };
    });
    layers.push({ layer, fileCount: files.length, files });
  }
  return { layers };
}

function readFileApi(apiPath) {
  const { abs, layer, rel, ext } = resolveFilePath(apiPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw httpError(404, `Not found: ${apiPath}`);
  const kind = fileKind(ext);
  const out = { path: apiPath, layer, rel, ext, kind, editable: TEXT_EXT.has(ext) };
  if (out.editable) out.text = fs.readFileSync(abs, "utf8");
  return out;
}

function serveRaw(apiPath, res) {
  const { abs, ext } = resolveFilePath(apiPath);
  fs.readFile(abs, (err, data) => {
    if (err) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });
}

function writeFileApi(rawBody) {
  let body;
  try { body = JSON.parse(rawBody || "{}"); } catch { throw httpError(400, "Body must be JSON"); }
  const { abs, ext, path: apiPath } = resolveFilePath(body.path);
  if (!TEXT_EXT.has(ext)) throw httpError(415, `Not an editable text file: ${ext || "(no ext)"}`);
  if (typeof body.text !== "string") throw httpError(400, "Provide text: string");
  if (!fs.existsSync(abs)) throw httpError(404, `Refusing to create new files: ${apiPath}`);
  fs.writeFileSync(abs, body.text, "utf8");
  return { ok: true, path: apiPath, bytes: Buffer.byteLength(body.text) };
}

// Merge resolution: write a resolved section body into every layer that defines
// it, so those layers agree and the conflict clears. This mutates real files —
// same sandbox (layer roots) and text-only rules as writeFileApi.
function writeSectionApi(rawBody) {
  let body;
  try { body = JSON.parse(rawBody || "{}"); } catch { throw httpError(400, "Body must be JSON"); }
  const { conceptId, sectionKey, layers, content } = body;
  if (typeof conceptId !== "string" || typeof sectionKey !== "string" || typeof content !== "string") {
    throw httpError(400, "Provide conceptId, sectionKey, content (strings)");
  }
  if (!Array.isArray(layers) || !layers.length) throw httpError(400, "Provide layers: string[]");

  const written = [];
  const skipped = [];
  for (const layer of layers) {
    let target;
    try { target = resolveFilePath(`${layer}/${conceptId}.md`); }
    catch (err) { skipped.push({ layer, reason: err.message }); continue; }
    if (target.ext !== ".md" || !fs.existsSync(target.abs)) { skipped.push({ layer, reason: "no such concept file" }); continue; }
    const { text, replaced } = replaceSection(fs.readFileSync(target.abs, "utf8"), sectionKey, content);
    if (!replaced) { skipped.push({ layer, reason: `section "${sectionKey}" not found` }); continue; }
    fs.writeFileSync(target.abs, text, "utf8");
    written.push(layer);
  }
  return { ok: true, written, skipped };
}

// Replace the body of the section identified by `key`, keeping its heading.
// Mirrors the OKF parser's key derivation ({#anchor} or normalized heading).
function replaceSection(text, key, newBody) {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^#{1,6}\s+(.+?)\s*$/);
    if (m && headingKey(m[1]) === key) { start = i; break; }
  }
  if (start === -1) return { text, replaced: false };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s+/.test(lines[i])) { end = i; break; }
  }
  const rebuilt = [
    ...lines.slice(0, start + 1),
    "",
    ...String(newBody).replace(/\s+$/, "").split("\n"),
    "",
    ...lines.slice(end),
  ];
  return { text: rebuilt.join(nl), replaced: true };
}

function headingKey(headingText) {
  const brace = headingText.match(/\{([^}]*)\}/);
  if (brace) {
    for (const tok of brace[1].trim().split(/\s+/)) if (tok.startsWith("#")) return tok.slice(1).toLowerCase();
  }
  return headingText.replace(/\{[^}]*\}/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) stack.push(full);
      else if (dirent.isFile()) out.push(full);
    }
  }
  return out.sort();
}

function toPosix(v) { return v.split(path.sep).join("/"); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5_000_000) reject(httpError(413, "Body too large")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---- Static ----------------------------------------------------------------

function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.join(HERE, rel);
  // Path-traversal guard: resolved file must stay inside the playground dir.
  if (!filePath.startsWith(HERE + path.sep) && filePath !== path.join(HERE, "index.html")) {
    return json(res, 403, { error: "Forbidden" });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  });
}

// ---- helpers ---------------------------------------------------------------

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) { parsed[arg.slice(2)] = argv[i + 1]; i += 1; }
  }
  return parsed;
}
