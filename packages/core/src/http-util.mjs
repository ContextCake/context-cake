// Shared HTTP internals for the engine service, its file APIs, and the
// playground wrapper. Extracted from service.mjs so modules that need the
// guards (layer-files.mjs) don't have to import the service and create a
// cycle. service.mjs re-exports everything here, so existing importers
// (apps/playground/server.mjs) keep working unchanged.

import fs from "node:fs";
import path from "node:path";

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
    let rejected = false;
    req.on("data", (c) => {
      if (rejected) return;
      data += c;
      if (data.length > 5_000_000) {
        rejected = true;
        data = "";
        reject(httpError(413, "Body too large"));
      }
    });
    req.on("end", () => { if (!rejected) resolve(data); });
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
 * files (the layer file APIs, the /console/ static mount). Two checks: lexical
 * prefix on the resolved path, then symlink defense — the lexical check trusts
 * the path text, but a symlink inside the root could still point outside it,
 * so compare realpaths (of the existing target, or of the parent dir for a
 * not-yet-existing file). Returns the realpath'd target.
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

export function parseJson(raw) {
  try { return JSON.parse(raw || "{}"); } catch { throw httpError(400, "Body must be JSON"); }
}
