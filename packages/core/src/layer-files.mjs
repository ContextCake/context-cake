// Layer file APIs: browse and edit the actual files behind a layer.
//
// These used to live in apps/playground/server.mjs, which meant the desktop
// app — the place people are most likely to want to edit a note — had no way
// to see its own context files. They belong to the engine service so every
// host gets them, and so the containment guard has exactly one implementation.
//
//   GET  /api/files                 → { layers: [{ layer, kind, root, fileCount, files[] }] }
//   GET  /api/file?path=<l>/<rel>   → { path, layer, rel, ext, kind, editable, text? }
//   GET  /api/file/raw?path=…       → the bytes (images/PDF preview)
//   PUT  /api/file                  → { path, text } overwrite an existing text file
//   PUT  /api/section               → write one resolved section across layers
//
// Every path is resolved against its layer root and checked with
// assertInsideRoot, so "<layer>/../../etc/passwd" and symlinks that point out
// of the root are both refused. Writes only ever overwrite files that already
// exist — this API never creates or deletes.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { assertInsideRoot, httpError, json, parseJson, MIME } from "./http-util.mjs";
import { defaultWalkLimits } from "./sources/okf-local.mjs";

// Files the editor treats as editable text. SVG is text AND image: editable as
// source, previewable as an image.
const TEXT_EXT = new Set([".md", ".markdown", ".mdx", ".txt", ".json", ".mjs", ".js", ".ts", ".jsx", ".tsx", ".css", ".html", ".htm", ".yml", ".yaml", ".svg", ".sh", ".csv", ".xml", ".toml", ".ini", ".conf"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg"]);
// Rendered as markdown by the console's Files view; everything else is raw text.
const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdx"]);
const MAX_EDITABLE_BYTES = 2_000_000;

export function fileKind(ext) {
  if (ext === ".pdf") return "pdf";
  if (ext === ".svg") return "svg"; // editable text with an image preview
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

/**
 * layer name -> { root, kind } for every layer that owns files on disk. Both
 * okf-local bundles and plain markdown folders qualify; mcp layers own no
 * files and are absent (the playground's version only listed okf-local, so
 * markdown-folder sources were invisible in the editor).
 */
export function layerRootMap(manifest, manifestDir) {
  const map = new Map();
  for (const layer of manifest?.layers ?? []) {
    const kind = layer.source ?? "okf-local";
    if ((kind === "okf-local" || kind === "files") && layer.path) {
      map.set(layer.name, { root: path.resolve(manifestDir, layer.path), kind });
    }
  }
  return map;
}

/**
 * Resolve an API path ("<layer>/<rel>") to an absolute path, refusing anything
 * that escapes the layer's root. This is the trust boundary for read AND write.
 */
export function resolveLayerFile(apiPath, roots) {
  if (!apiPath) throw httpError(400, "Provide ?path=<layer>/<relative>");
  const norm = String(apiPath).replace(/\\/g, "/").replace(/^\/+/, "");
  const slash = norm.indexOf("/");
  const layer = slash === -1 ? norm : norm.slice(0, slash);
  const rel = slash === -1 ? "" : norm.slice(slash + 1);
  const entry = roots.get(layer);
  if (!entry) throw httpError(404, `Unknown layer: ${layer}`);
  const abs = path.resolve(entry.root, rel);
  assertInsideRoot(abs, entry.root, "Path escapes its layer root");
  return { abs, layer, rel, root: entry.root, ext: path.extname(abs).toLowerCase() };
}

// Bounded, async, symlink-skipping walk for the file tree. Unlike walkDocs
// (which only wants documents) this lists every file so the editor can show a
// real folder, but it honors the same user-configured scan cap so pointing a
// layer at something enormous degrades instead of hanging.
async function walkAll(root, limits) {
  const { maxFiles, maxEntries } = { ...defaultWalkLimits(), ...(limits ?? {}) };
  const out = [];
  let scanned = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let dirents;
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      if (++scanned > maxEntries) { truncated = true; break; }
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) stack.push(full);
      else if (dirent.isFile()) {
        out.push(full);
        if (out.length >= maxFiles) { truncated = true; break; }
      }
    }
    if (truncated) break;
  }
  return { files: out.sort(), truncated };
}

export async function listFilesApi(roots, limits) {
  const layers = [];
  for (const [layer, { root, kind }] of roots) {
    const { files, truncated } = await walkAll(root, limits);
    layers.push({
      layer,
      kind,
      root,
      fileCount: files.length,
      truncated,
      files: files.map((abs) => {
        const rel = toPosix(path.relative(root, abs));
        const ext = path.extname(abs).toLowerCase();
        return { path: `${layer}/${rel}`, name: path.basename(abs), rel, ext, kind: fileKind(ext), markdown: MARKDOWN_EXT.has(ext) };
      }),
    });
  }
  return { layers };
}

export async function readFileApi(apiPath, roots) {
  const { abs, layer, rel, ext } = resolveLayerFile(apiPath, roots);
  let stat;
  try { stat = await fsp.stat(abs); } catch { throw httpError(404, `Not found: ${apiPath}`); }
  if (!stat.isFile()) throw httpError(404, `Not a file: ${apiPath}`);
  const kind = fileKind(ext);
  const editable = TEXT_EXT.has(ext) && stat.size <= MAX_EDITABLE_BYTES;
  const out = {
    path: apiPath,
    layer,
    rel,
    ext,
    kind,
    editable,
    markdown: MARKDOWN_EXT.has(ext),
    bytes: stat.size,
    modified: stat.mtime.toISOString(),
  };
  if (editable) out.text = await fsp.readFile(abs, "utf8");
  else if (TEXT_EXT.has(ext)) out.reason = `This file is ${Math.round(stat.size / 1024)} KB — too large to edit here.`;
  return out;
}

export function serveRawApi(apiPath, roots, res) {
  const { abs, ext } = resolveLayerFile(apiPath, roots);
  fs.readFile(abs, (err, data) => {
    if (err) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });
}

export async function writeFileApi(rawBody, roots) {
  const body = parseJson(rawBody);
  const { abs, ext, path: apiPath } = { ...resolveLayerFile(body.path, roots), path: body.path };
  if (!TEXT_EXT.has(ext)) throw httpError(415, `Not an editable text file: ${ext || "(no ext)"}`);
  if (typeof body.text !== "string") throw httpError(400, "Provide text: string");
  if (Buffer.byteLength(body.text) > MAX_EDITABLE_BYTES) throw httpError(413, "File is too large to save from the editor");
  let stat;
  try { stat = await fsp.stat(abs); } catch { throw httpError(404, `Refusing to create new files: ${apiPath}`); }
  if (!stat.isFile()) throw httpError(400, `Not a file: ${apiPath}`);
  await fsp.writeFile(abs, body.text, "utf8");
  const after = await fsp.stat(abs);
  return { ok: true, path: apiPath, bytes: Buffer.byteLength(body.text), modified: after.mtime.toISOString() };
}

/**
 * Merge resolution: write a resolved section body into every layer that
 * defines it, so those layers agree and the conflict clears. Same sandbox
 * (layer roots) and text-only rules as writeFileApi.
 */
export async function writeSectionApi(rawBody, roots) {
  const body = parseJson(rawBody);
  const { conceptId, sectionKey, layers, content } = body;
  if (typeof conceptId !== "string" || typeof sectionKey !== "string" || typeof content !== "string") {
    throw httpError(400, "Provide conceptId, sectionKey, content (strings)");
  }
  if (!Array.isArray(layers) || !layers.length) throw httpError(400, "Provide layers: string[]");

  const written = [];
  const skipped = [];
  for (const layer of layers) {
    let target;
    try { target = resolveLayerFile(`${layer}/${conceptId}.md`, roots); }
    catch (err) { skipped.push({ layer, reason: err.message }); continue; }
    if (target.ext !== ".md" || !fs.existsSync(target.abs)) { skipped.push({ layer, reason: "no such concept file" }); continue; }
    const { text, replaced } = replaceSection(await fsp.readFile(target.abs, "utf8"), sectionKey, content);
    if (!replaced) { skipped.push({ layer, reason: `section "${sectionKey}" not found` }); continue; }
    await fsp.writeFile(target.abs, text, "utf8");
    written.push(layer);
  }
  return { ok: true, written, skipped };
}

// Replace the body of the section identified by `key`, keeping its heading.
// Mirrors the OKF parser's key derivation ({#anchor} or normalized heading).
export function replaceSection(text, key, newBody) {
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

function toPosix(v) { return v.split(path.sep).join("/"); }
