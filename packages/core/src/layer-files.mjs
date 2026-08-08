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
//   PUT  /api/file                  → { path, text, modified } overwrite an existing text file
//                                      (modified required unless force: true)
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
import { defaultWalkLimits, MAX_DOC_BYTES } from "./sources/okf-local.mjs";
import { FILES_EXTENSIONS } from "./sources/files.mjs";

// Files the editor treats as editable text. SVG is text AND image: editable as
// source, previewable as an image.
const TEXT_EXT = new Set([".md", ".markdown", ".mdx", ".txt", ".json", ".mjs", ".js", ".ts", ".jsx", ".tsx", ".css", ".html", ".htm", ".yml", ".yaml", ".svg", ".sh", ".csv", ".xml", ".toml", ".ini", ".conf"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg"]);
// Rendered as markdown by the console's Files view; everything else is raw text.
const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdx"]);
// One number, deliberately: a document the indexer refuses to read is one the
// cascade will never serve, so letting the editor open and save it would be a
// lie about what saving accomplishes.
const MAX_EDITABLE_BYTES = MAX_DOC_BYTES;
const MAX_PREVIEW_BYTES = 25_000_000;

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
  const guardedAbs = assertInsideRoot(abs, entry.root, "Path escapes its layer root");
  return { abs: guardedAbs, layer, rel, root: entry.root, ext: path.extname(abs).toLowerCase() };
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
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // The layer ROOT failing to read is a different fact from an ordinary
      // subdirectory vanishing mid-walk — same distinction okf-local's
      // walkDocs draws for the indexer. Losing the root means there is
      // nothing left behind this layer at all, not the empty-folder answer a
      // deleted folder used to get, indistinguishable from one that was
      // simply never populated.
      if (dir === root && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        throw new Error(`Layer folder no longer exists: ${root}`);
      }
      continue;
    }
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
    try {
      const { files, truncated } = await walkAll(root, limits);
      layers.push({
        layer,
        kind,
        root,
        fileCount: files.length,
        truncated,
        // Additive, and null on the common path: a layer whose folder is
        // genuinely empty (or a subfolder that merely vanished mid-walk, which
        // walkAll already skips over) is not an error and says so.
        error: null,
        files: files.map((abs) => {
          const rel = toPosix(path.relative(root, abs));
          const ext = path.extname(abs).toLowerCase();
          return { path: `${layer}/${rel}`, name: path.basename(abs), rel, ext, kind: fileKind(ext), markdown: MARKDOWN_EXT.has(ext) };
        }),
      });
    } catch (err) {
      // Read around, never crash the whole listing: one layer whose folder
      // moved or was deleted must not blank every other layer's files. The row
      // still appears — with `error` set and `fileCount: 0` — rather than
      // silently taking on the empty-folder shape a genuinely empty layer
      // reports, which used to read as "add a note and it appears here" for a
      // folder that no longer exists.
      layers.push({ layer, kind, root, fileCount: 0, truncated: false, error: err.message, files: [] });
    }
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
  if (!IMAGE_EXT.has(ext) && ext !== ".pdf") {
    throw httpError(415, "Raw preview is only available for images and PDFs");
  }
  fs.stat(abs, (statErr, stat) => {
    if (statErr || !stat.isFile()) return json(res, 404, { error: "Not found" });
    if (stat.size > MAX_PREVIEW_BYTES) {
      return json(res, 413, { error: `Preview is limited to ${Math.round(MAX_PREVIEW_BYTES / 1_000_000)} MB` });
    }
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-length": stat.size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      ...(ext === ".svg" ? { "content-disposition": 'attachment; filename="contextcake-preview.svg"' } : {}),
    });
    if (stat.size === 0) return res.end();
    // Bound the stream to the size we approved above even if another process
    // grows the file between stat and open.
    const stream = fs.createReadStream(abs, { end: stat.size - 1 });
    stream.on("error", () => { if (!res.writableEnded) res.destroy(); });
    stream.pipe(res);
  });
}

export async function writeFileApi(rawBody, roots) {
  const body = parseJson(rawBody);
  const { abs, ext, layer, path: apiPath } = { ...resolveLayerFile(body.path, roots), path: body.path };
  if (!TEXT_EXT.has(ext)) throw httpError(415, `Not an editable text file: ${ext || "(no ext)"}`);
  if (typeof body.text !== "string") throw httpError(400, "Provide text: string");
  if (Buffer.byteLength(body.text) > MAX_EDITABLE_BYTES) throw httpError(413, "File is too large to save from the editor");
  let stat;
  try { stat = await fsp.stat(abs); } catch { throw httpError(404, `Refusing to create new files: ${apiPath}`); }
  if (!stat.isFile()) throw httpError(400, `Not a file: ${apiPath}`);
  // `modified` used to be optional, which meant a client that forgot to send
  // it silently skipped the stale-editor check below and overwrote whatever
  // changed on disk since it last read the file. It is required now — the
  // caller must either name the version it read (from GET /api/file) or say
  // out loud that it means to overwrite regardless.
  if (body.force !== true) {
    if (body.modified === undefined) {
      throw httpError(400, `Provide modified: the file's last-read modified timestamp (from GET /api/file), or force: true to overwrite deliberately.`);
    }
    if (body.modified !== stat.mtime.toISOString()) {
      throw httpError(409, `This file changed on disk after you opened it. Reopen ${apiPath} and merge your edit.`);
    }
  }
  await fsp.writeFile(abs, body.text, "utf8");
  const after = await fsp.stat(abs);
  return { ok: true, path: apiPath, layer, bytes: Buffer.byteLength(body.text), modified: after.mtime.toISOString() };
}

/**
 * Merge resolution: write a resolved section body into every layer that
 * defines it, so those layers agree and the conflict clears. Same sandbox
 * (layer roots) and text-only rules as writeFileApi.
 *
 * `modified` ({ [layer]: mtime ISO }) is the same stale-editor guard writeFileApi
 * has, per target file: every write target is staged and stat'd BEFORE anything
 * is written, and one mismatch fails the whole request with 409 — writing only
 * the layers that still matched would "resolve" the conflict into a new,
 * partial disagreement. Omitting a layer (or the map) skips its check, which is
 * also the compatibility path for older clients.
 */
export async function prepareSectionWrites(rawBody, roots) {
  const body = parseJson(rawBody);
  const { conceptId, sectionKey, layers, content } = body;
  if (typeof conceptId !== "string" || typeof sectionKey !== "string" || typeof content !== "string") {
    throw httpError(400, "Provide conceptId, sectionKey, content (strings)");
  }
  if (!Array.isArray(layers) || !layers.length) throw httpError(400, "Provide layers: string[]");
  const modified = body.modified ?? {};
  const expectedContent = body.expectedContent ?? {};
  if (typeof modified !== "object" || Array.isArray(modified)) {
    throw httpError(400, "modified must map layer name -> mtime ISO string");
  }
  if (typeof expectedContent !== "object" || Array.isArray(expectedContent)) {
    throw httpError(400, "expectedContent must map layer name -> section text");
  }

  const today = new Date().toISOString().slice(0, 10);
  const writes = [];
  const skipped = [];
  for (const layer of layers) {
    let target = null;
    let stat = null;
    try {
      const root = roots.get(layer);
      const extensions = root?.kind === "files" ? FILES_EXTENSIONS : [".md"];
      for (const ext of extensions) {
        const candidate = resolveLayerFile(`${layer}/${conceptId}${ext}`, roots);
        try { stat = await fsp.stat(candidate.abs); } catch { stat = null; }
        if (stat?.isFile()) { target = candidate; break; }
      }
    } catch (err) { skipped.push({ layer, reason: err.message }); continue; }
    if (!target || !stat?.isFile()) { skipped.push({ layer, reason: "no such concept file" }); continue; }
    // Same cap the read and write routes enforce, checked BEFORE the read.
    // Without it this route would happily pull a 30MB document into memory and
    // write back the section-replaced result — a file the indexer refuses to
    // read, and so a document the cascade never served, silently rewritten
    // down to the few lines the merge editor thought it was editing. A skip
    // would be worse than a refusal here: resolving a conflict into every
    // layer except the big one just mints a new partial disagreement.
    if (stat.size > MAX_EDITABLE_BYTES) {
      throw httpError(413, `File is too large to save from the editor: ${layer}/${conceptId}${target.ext}`);
    }
    const originalText = await fsp.readFile(target.abs, "utf8");
    const currentContent = readSectionBody(originalText, sectionKey, { plainText: target.ext === ".txt" });
    const { text, replaced } = target.ext === ".txt"
      ? replacePlainTextBody(originalText, sectionKey, content)
      : replaceSection(originalText, sectionKey, content, { refreshUpdatedTo: today });
    if (!replaced) { skipped.push({ layer, reason: `section "${sectionKey}" not found` }); continue; }
    writes.push({ layer, abs: target.abs, text, currentContent, mtime: stat.mtime.toISOString(), mode: stat.mode });
  }
  if (body.requireAll === true && skipped.length > 0) {
    throw httpError(409, `Nothing was changed. ${skipped.map((item) => `${item.layer}: ${item.reason}`).join("; ")}`);
  }
  for (const write of writes) {
    const expectedMtime = modified[write.layer];
    if (expectedMtime !== undefined && expectedMtime !== write.mtime) {
      throw httpError(409, `${write.layer}/${conceptId}.md changed on disk after you loaded this conflict. Reload and merge again — nothing was written.`);
    }
    const expectedSection = expectedContent[write.layer];
    if (expectedSection !== undefined && expectedSection !== write.currentContent) {
      throw httpError(409, `${write.layer}/${conceptId}.md changed after this conflict was loaded. Reload it before resolving — nothing was written.`);
    }
  }
  return { body, writes, skipped };
}

export async function writeSectionApi(rawBody, roots) {
  const { writes, skipped } = await prepareSectionWrites(rawBody, roots);
  // A section write into a clone-backed layer dirties .cache/repos, and a later
  // Sync's `git pull --ff-only` will surface that as a failure. Acceptable —
  // the user chose to edit their copy; don't guard it here.
  for (const write of writes) await fsp.writeFile(write.abs, write.text, "utf8");
  return { ok: true, written: writes.map((write) => write.layer), skipped };
}

/**
 * Stage a recoverable multi-file section transaction. New and original bytes
 * live beside each target so rename/copy never crosses filesystems. The caller
 * journals `targets` before commit and owns final cleanup.
 */
export async function stageSectionTransaction(rawBody, roots, transactionId, options = {}) {
  const { writes, skipped } = await prepareSectionWrites(rawBody, roots);
  return stagePreparedWrites(writes, skipped, transactionId, options);
}

export async function stageFrontmatterTransaction(rawBody, roots, transactionId) {
  const body = parseJson(rawBody);
  const { conceptId, key, layers, value } = body;
  if (typeof conceptId !== "string" || typeof key !== "string" || !Array.isArray(layers) || !layers.length) {
    throw httpError(400, "Provide conceptId, key, and layers");
  }
  if (key === "updated" || key === "override") throw httpError(400, `Frontmatter field ${key} is resolver-managed`);
  const expectedValues = body.expectedValues ?? {};
  const writes = [];
  const skipped = [];
  for (const layer of layers) {
    const root = roots.get(layer);
    if (!root) { skipped.push({ layer, reason: "source is not locally writable" }); continue; }
    let target = null;
    let stat = null;
    for (const ext of root.kind === "files" ? FILES_EXTENSIONS.filter((item) => item !== ".txt") : [".md"]) {
      const candidate = resolveLayerFile(`${layer}/${conceptId}${ext}`, roots);
      try { stat = await fsp.stat(candidate.abs); } catch { stat = null; }
      if (stat?.isFile()) { target = candidate; break; }
    }
    if (!target || !stat) { skipped.push({ layer, reason: "no writable frontmatter document" }); continue; }
    const originalText = await fsp.readFile(target.abs, "utf8");
    const currentValue = readFrontmatterValue(originalText, key);
    if (stableScalar(currentValue) !== stableScalar(expectedValues[layer])) {
      throw httpError(409, `${layer}/${conceptId}${target.ext} changed after this discrepancy loaded. Reload it before resolving — nothing was written.`);
    }
    const text = replaceFrontmatterValue(originalText, key, value);
    writes.push({ layer, abs: target.abs, text, mode: stat.mode });
  }
  if (skipped.length) throw httpError(409, `Nothing was changed. ${skipped.map((item) => `${item.layer}: ${item.reason}`).join("; ")}`);
  return stagePreparedWrites(writes, skipped, transactionId);
}

async function stagePreparedWrites(writes, skipped, transactionId, options = {}) {
  const targets = [];
  try {
    for (const [index, write] of writes.entries()) {
      const suffix = `.contextcake-${transactionId}-${index}`;
      const staged = `${write.abs}${suffix}.new`;
      const backup = `${write.abs}${suffix}.bak`;
      await fsp.writeFile(staged, write.text, { encoding: "utf8", flag: "wx", mode: write.mode & 0o777 });
      await fsp.copyFile(write.abs, backup, fs.constants.COPYFILE_EXCL);
      targets.push({ layer: write.layer, path: write.abs, staged, backup });
    }
  } catch (error) {
    await cleanupTargets(targets);
    throw error;
  }

  async function commit() {
    const changed = [];
    try {
      for (const [index, target] of targets.entries()) {
        await options.beforeReplace?.(index, target);
        await fsp.rename(target.staged, target.path);
        changed.push(target);
      }
      return changed.map((target) => target.layer);
    } catch (error) {
      try {
        for (const target of changed.reverse()) await fsp.copyFile(target.backup, target.path);
      } catch (rollbackError) {
        const combined = new Error(`${error.message}; rollback failed: ${rollbackError.message}`);
        combined.code = "RecoveryRequired";
        throw combined;
      }
      throw error;
    }
  }

  async function rollback() {
    for (const target of targets) await fsp.copyFile(target.backup, target.path);
  }

  async function cleanup() { await cleanupTargets(targets); }
  return { targets, skipped, commit, rollback, cleanup };
}

async function cleanupTargets(targets) {
  await Promise.all(targets.flatMap((target) => [target.staged, target.backup].map((file) => fsp.unlink(file).catch(() => {}))));
}

function readFrontmatterValue(text, key) {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return undefined;
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match?.[1] === key) return parseScalar(match[2].trim());
  }
  return undefined;
}

function replaceFrontmatterValue(text, key, value) {
  if (!text.startsWith("---\n")) throw httpError(409, "This document has no writable frontmatter");
  const end = text.indexOf("\n---", 4);
  if (end === -1) throw httpError(409, "This document has malformed frontmatter");
  const before = text.slice(4, end).split(/\r?\n/);
  const index = before.findIndex((line) => line.startsWith(`${key}:`));
  if (index === -1) throw httpError(409, `Frontmatter field ${key} no longer exists`);
  before[index] = `${key}: ${renderScalar(value)}`;
  return `---\n${before.join("\n")}\n---${text.slice(end + 4)}`;
}

function parseScalar(value) {
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).split(",").map((part) => part.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  return value.replace(/^['"]|['"]$/g, "");
}
function renderScalar(value) {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(", ")}]`;
  return JSON.stringify(String(value));
}
function stableScalar(value) { return JSON.stringify(value); }

// Replace the body of the section identified by `key`, keeping its heading.
// Mirrors the OKF parser's key derivation ({#anchor} or normalized heading).
// `refreshUpdatedTo` (YYYY-MM-DD) rewrites an authored `updated=` attr on that
// heading to the given date — the write makes the section current, and a stale
// authored date would otherwise outrank the truth in every date comparison. A
// heading without the attr is left byte-identical: the content-date fallback
// covers undated sections, and inventing an attr would claim an authored date
// nobody wrote.
export function replaceSection(text, key, newBody, { refreshUpdatedTo = null } = {}) {
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
  const heading = refreshUpdatedTo ? refreshHeadingUpdated(lines[start], refreshUpdatedTo) : lines[start];
  const rebuilt = [
    ...lines.slice(0, start),
    heading,
    "",
    ...String(newBody).replace(/\s+$/, "").split("\n"),
    "",
    ...lines.slice(end),
  ];
  return { text: rebuilt.join(nl), replaced: true };
}

/** Return the trimmed body for a section, or null when the section is absent. */
export function readSectionBody(text, key, { plainText = false } = {}) {
  if (plainText) return key === "body" ? String(text).trim() : null;
  const lines = String(text).split(/\r?\n/);
  const isFence = (line) => /^\s{0,3}(```|~~~)/.test(line);
  let start = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (isFence(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const match = lines[i].match(/^#{1,6}\s+(.+?)\s*$/);
    if (match && headingKey(match[1]) === key) { start = i + 1; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  inFence = false;
  for (let i = start; i < lines.length; i += 1) {
    if (isFence(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && /^#{1,6}\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").trim();
}

function replacePlainTextBody(text, key, newBody) {
  if (key !== "body") return { text, replaced: false };
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  return { text: `${newBody}${text.endsWith("\n") ? nl : ""}`, replaced: true };
}

// Rewrite only the value of an `updated=` token inside the heading's first
// {...} attr group (the group the OKF parser reads), preserving its quote
// style. Anchor and every other attr stay byte-identical; a heading with no
// `updated=` token comes back untouched.
function refreshHeadingUpdated(headingLine, today) {
  return headingLine.replace(/\{[^}]*\}/, (attrs) => attrs.replace(
    /(^\{|\s)(updated=)(['"]?)[^\s'"}]*(['"]?)/,
    (m, pre, kw, open, close) => `${pre}${kw}${open}${today}${close}`,
  ));
}

function headingKey(headingText) {
  const brace = headingText.match(/\{([^}]*)\}/);
  if (brace) {
    for (const tok of brace[1].trim().split(/\s+/)) if (tok.startsWith("#")) return tok.slice(1).toLowerCase();
  }
  return headingText.replace(/\{[^}]*\}/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function toPosix(v) { return v.split(path.sep).join("/"); }
