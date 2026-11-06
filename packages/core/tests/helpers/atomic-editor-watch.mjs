// Exercise the exact JS recursive watcher Linux uses, on every CI OS.
// The native parent watches still use real fs.watch and real filesystem events.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createEngineService } from "../../src/service.mjs";

const { FSWatcher, kFSWatchStart } = createRequire(import.meta.url)("internal/fs/recursive_watch");
const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "cc-atomic-editor-watch-")));
const notes = path.join(root, "notes");
const parent = path.join(notes, "nested");
const file = path.join(parent, "meeting.md");
const manifestPath = path.join(root, "manifest.json");
await fsp.mkdir(parent, { recursive: true });
await fsp.writeFile(file, "# Meeting\n\nShip on Friday.\n");
await fsp.writeFile(manifestPath, JSON.stringify({ layers: [{ name: "notes", level: 3, path: notes, source: "files" }] }));
const watch = fs.watch;
const native = [];
fs.watch = (target, options, listener) => {
  if (options?.recursive) {
    const watcher = new FSWatcher(options);
    watcher.on("change", listener);
    watcher[kFSWatchStart](target);
    return watcher;
  }
  const watcher = watch(target, options, listener);
  const entry = { target, closed: false };
  native.push(entry);
  const close = watcher.close.bind(watcher);
  watcher.close = () => { entry.closed = true; close(); };
  return watcher;
};
const service = createEngineService({ manifestPath });
const server = http.createServer(async (req, res) => {
  if (await service.handleRequest(req, res)) return;
  res.writeHead(404); res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function waitForText(text) {
  const deadline = Date.now() + 10_000;
  do {
    const result = await (await fetch(`${base}/api/resolve-all?wait=1000`)).text();
    if (result.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`indexed reads never reached ${text}`);
}
try {
  await waitForText("Friday");
  const before = native.filter((entry) => entry.target === parent).length;
  const response = await fetch(`${base}/api/file`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "notes/nested/meeting.md", force: true, text: "# Meeting\n\nShip on Monday.\n" }) });
  assert.equal(response.status, 200, await response.text());
  await waitForText("Monday");
  await fsp.writeFile(file, "# Meeting\n\nShip on Wednesday.\n");
  await waitForText("Wednesday");
  assert.equal(native.filter((entry) => entry.target === parent).length, before + 1, "the edited parent gets its own native watch");
  const second = await fetch(`${base}/api/file`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "notes/nested/meeting.md", force: true, text: "# Meeting\n\nShip on Thursday.\n" }) });
  assert.equal(second.status, 200, await second.text());
  assert.equal(native.filter((entry) => entry.target === parent).length, before + 1, "repeated saves reuse the parent watch");
  service.close();
  assert.ok(native.every((entry) => entry.closed), "service close releases all recursive and supplemental native watches");
  console.log("atomic editor watcher regression passed");
} finally {
  service.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.watch = watch;
  await fsp.rm(root, { recursive: true, force: true });
}
