#!/usr/bin/env node

// ContextCake Playground — a thin, dependency-free HTTP shell over the real
// cascade engine. It does NOT reimplement resolution: the read API, the sources
// CRUD, the settings API, the layer file explorer/editor APIs, the section
// writes, and the /console/ mount all live in packages/core/src/service.mjs
// (createEngineService), the same embeddable service a desktop shell mounts.
// This file adds only the workbench's static UI on top. The browser UI is just
// another reader of the engine's output.
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
import { createEngineService, json, MIME } from "../../packages/core/src/service.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const MANIFEST = path.resolve(args.manifest ?? path.join(HERE, "manifest.json"));
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

const server = http.createServer(async (req, res) => {
  try {
    // The service owns every /api/* route the workbench uses — including the
    // file explorer/editor and section writes, which used to be duplicated
    // here. It applies its own loopback-Host + CSRF guard before any write.
    if (await service.handleRequest(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host}`);
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
