#!/usr/bin/env node

// ContextCake Playground — a thin, dependency-free HTTP shell over the real
// cascade engine. It does NOT reimplement resolution: the read API, the sources
// CRUD, and the /console/ mount live in packages/core/src/service.mjs
// (createEngineService), the same embeddable service a desktop shell mounts.
// This file wraps that service with the playground's own surface: the file
// explorer/editor APIs, the merge resolver's section writes, and the workbench
// static UI. The browser UI is just another reader of the engine's output.
//
// Usage:
//   node apps/playground/server.mjs [--manifest apps/playground/manifest.json] [--port 8790]
//
// Sources are rebuilt whenever the manifest changes (and OKF bundles are read
// from disk on every request), so you can edit the demo markdown and see the
// cascade change on refresh. Only serves static files inside apps/playground/.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  createEngineService,
  guardMutatingRequest,
  assertInsideRoot,
  readBody,
  httpError,
  json,
  MIME,
} from "../../packages/core/src/service.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const MANIFEST = path.resolve(args.manifest ?? path.join(HERE, "manifest.json"));
const MANIFEST_DIR = path.dirname(MANIFEST);
const PORT = Number(args.port ?? 8790);
// Optional: serve a built ContextCake Console (its dist/) under /console/, so the
// console can run in live mode against this server's same-origin /api/* surface.
const CONSOLE_DIR = args.console ? path.resolve(args.console) : null;

// The engine service owns /api/graph, /api/resolve, /api/resolve-all, the
// sources CRUD, and the /console/ mount. token: null — the workbench is a
// local same-origin UI; the loopback-Host + CSRF guards are its protection.
const service = createEngineService({
  manifestPath: MANIFEST,
  consoleDist: CONSOLE_DIR,
  token: null,
  allowMutations: true,
});

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
  try {
    if (await service.handleRequest(req, res)) return;

    // Same mutating-request guard the service applies to its own routes — the
    // editor endpoints below write real files, so they get the same protection
    // (loopback Host + same-origin), and so does everything else that mutates.
    if (guardMutatingRequest(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/files") return json(res, 200, listFiles());
    if (url.pathname === "/api/file") {
      if (req.method === "PUT" || req.method === "POST") return json(res, 200, writeFileApi(await readBody(req)));
      return json(res, 200, readFileApi(url.searchParams.get("path")));
    }
    if (url.pathname === "/api/file/raw") return serveRaw(url.searchParams.get("path"), res);
    if (url.pathname === "/api/section" && (req.method === "PUT" || req.method === "POST")) {
      return json(res, 200, writeSectionApi(await readBody(req)));
    }
    // Only reached when the server was started without --console (a mounted
    // console is served by the engine service above).
    if (url.pathname === "/console" || url.pathname.startsWith("/console/")) {
      return consoleNotMounted(res);
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
    `  open:     http://127.0.0.1:${PORT}/\n` +
    (CONSOLE_DIR ? `  console:  http://127.0.0.1:${PORT}/console/  (live)\n` : ""),
  );
});

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
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
  assertInsideRoot(abs, root, "Path escapes its layer root");
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
  const isFence = (l) => /^\s{0,3}(```|~~~)/.test(l);
  const isHeading = (l) => /^#{1,6}\s+/.test(l);

  // Heading detection must ignore `#` lines inside fenced code blocks
  // (e.g. a `# comment` in a bash snippet), or the section boundary is wrong
  // and the write corrupts the file.
  let start = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (isFence(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(/^#{1,6}\s+(.+?)\s*$/);
    if (m && headingKey(m[1]) === key) { start = i; break; }
  }
  if (start === -1) return { text, replaced: false };

  let end = lines.length;
  inFence = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isFence(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && isHeading(lines[i])) { end = i; break; }
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
      if (dirent.isSymbolicLink()) continue; // don't traverse/list out of the root
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) stack.push(full);
      else if (dirent.isFile()) out.push(full);
    }
  }
  return out.sort();
}

function toPosix(v) { return v.split(path.sep).join("/"); }

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

// /console/ requested but the server was started without --console: explain how
// to get Explore instead of dumping a raw JSON 404 as the whole page.
function consoleNotMounted(res) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ContextCake · Explore is not mounted</title>
<style>
  body { margin:0; display:grid; place-items:center; min-height:100vh; background:#10110f; color:#f3efe6;
         font:14px/1.55 "Bricolage Grotesque", system-ui, sans-serif; }
  main { max-width:34rem; padding:2rem; }
  h1 { font-size:1.15rem; margin:0 0 0.6rem; }
  p { color:#c9c4b4; margin:0.4rem 0; }
  code { font-family:"JetBrains Mono", ui-monospace, monospace; font-size:0.9em; background:#1a1b17;
         border:1px solid rgba(235,226,207,0.14); border-radius:6px; padding:0.15rem 0.4rem; }
  a { color:#8dc3a8; }
</style></head><body><main>
  <h1>Explore (the console) isn't mounted on this server</h1>
  <p>This playground was started without the console. To run both modes from one origin:</p>
  <p><code>npm run console:live</code></p>
  <p>That builds the console and restarts this server with <code>--console apps/console/dist</code>.</p>
  <p><a href="/">&larr; Back to Configure</a></p>
</main></body></html>`;
  res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

// ---- helpers ---------------------------------------------------------------

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) { parsed[arg.slice(2)] = argv[i + 1]; i += 1; }
  }
  return parsed;
}
