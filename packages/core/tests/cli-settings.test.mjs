// `contextcake settings` (control-plane spec §5.5): the catalog and the
// manifest > environment > default precedence GET/PATCH /api/settings use.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { manifestRevisionOf } from "../src/cli/context.mjs";
import { SETTING_KEYS } from "../src/settings.mjs";
import { createEngineService } from "../src/service.mjs";
import { cliHome, runContextcake, writeManifest } from "./helpers/cli-harness.mjs";

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function v2Home(t, extra = {}) {
  const home = await cliHome(t);
  await writeManifest(home, { profiles: { default: { label: "Default", layers: [] } }, ...extra });
  return home;
}

test("settings list, get, set, and reset follow manifest > env > default", async (t) => {
  const home = await v2Home(t);
  const env = "CONTEXTCAKE_MAX_CONCURRENT_INDEXING";
  const saved = process.env[env];
  t.after(() => {
    if (saved === undefined) delete process.env[env];
    else process.env[env] = saved;
  });
  delete process.env[env];

  const listed = await runContextcake(["settings", "list", "--json"], home);
  assert.equal(listed.exitCode, 0, listed.stdout);
  assert.deepEqual(Object.keys(listed.json.data.settings), SETTING_KEYS);
  assert.deepEqual(new Set(Object.values(listed.json.data.origins)), new Set(["default"]));
  assert.ok(listed.json.data.catalog.every((entry) => typeof entry.env === "string"));

  process.env[env] = "3";
  const fromEnv = await runContextcake(["settings", "get", "maxConcurrentIndexing", "--json"], home);
  assert.deepEqual(
    { value: fromEnv.json.data.value, origin: fromEnv.json.data.origin, stored: fromEnv.json.data.stored, env: fromEnv.json.data.env },
    { value: 3, origin: "env", stored: null, env },
  );

  const set = await runContextcake(["settings", "set", "maxConcurrentIndexing", "6", "--json"], home);
  assert.equal(set.exitCode, 0, set.stdout);
  assert.equal(set.json.data.value, 6);
  assert.equal(set.json.data.origin, "manifest", "the manifest wins over the environment");
  assert.deepEqual((await readJson(home.manifestPath)).settings, { maxConcurrentIndexing: 6 });
  assert.equal(set.json.context.manifestRevision, manifestRevisionOf(await readJson(home.manifestPath)));

  const reset = await runContextcake(["settings", "reset", "maxConcurrentIndexing", "--json"], home);
  assert.equal(reset.exitCode, 0, reset.stdout);
  assert.equal(reset.json.data.settings.maxConcurrentIndexing, 3);
  assert.equal(reset.json.data.origins.maxConcurrentIndexing, "env");
  assert.equal((await readJson(home.manifestPath)).settings, undefined);

  assert.equal((await runContextcake(["settings", "set", "maxDocFiles", "500"], home)).exitCode, 0);
  const all = await runContextcake(["settings", "reset", "--all", "--json"], home);
  assert.equal(all.exitCode, 0);
  assert.equal((await readJson(home.manifestPath)).settings, undefined);
});

test("settings refuse unknown keys, out-of-range values, and stale revisions", async (t) => {
  const home = await v2Home(t);
  const before = await fs.readFile(home.manifestPath, "utf8");
  for (const [argv, exitCode, code] of [
    [["settings", "get", "nope"], 2, "SETTINGS_INVALID"],
    [["settings", "set", "nope", "1"], 2, "SETTINGS_INVALID"],
    [["settings", "set", "maxDocFiles", "1"], 2, "SETTINGS_INVALID"],
    [["settings", "set", "maxDocFiles", "lots"], 2, "SETTINGS_INVALID"],
    [["settings", "reset"], 2, "INVALID_INPUT"],
    [["settings", "set", "maxDocFiles", "500", "--expect-revision", `sha256:${"0".repeat(64)}`], 4, "STALE_REVISION"],
  ]) {
    const result = await runContextcake([...argv, "--json"], home);
    assert.equal(result.exitCode, exitCode, `${argv.join(" ")}: ${result.stdout}`);
    assert.equal(result.json.error.code, code, argv.join(" "));
  }
  assert.equal(await fs.readFile(home.manifestPath, "utf8"), before);
});

test("settings answer what GET and PATCH /api/settings answer", async (t) => {
  const cliSide = await v2Home(t);
  const httpSide = await v2Home(t);
  const service = createEngineService({ manifestPath: httpSide.manifestPath });
  const server = http.createServer(async (req, res) => {
    if (await service.handleRequest(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/settings`;

  const patched = await (await fetch(base, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxDocFiles: 700 }) })).json();
  const set = await runContextcake(["settings", "set", "maxDocFiles", "700", "--json"], cliSide);
  assert.equal(set.exitCode, 0);
  const { ok, ...httpView } = patched;
  assert.equal(ok, true);
  const listed = await runContextcake(["settings", "list", "--json"], cliSide);
  assert.deepEqual(listed.json.data, httpView);
  assert.deepEqual(listed.json.data, await (await fetch(base)).json());
  assert.deepEqual(await readJson(cliSide.manifestPath), await readJson(httpSide.manifestPath));

  const refused = await (await fetch(base, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxDocFiles: 1 }) })).json();
  const cliRefused = await runContextcake(["settings", "set", "maxDocFiles", "1", "--json"], cliSide);
  assert.equal(cliRefused.json.error.code, refused.code);
  assert.equal(cliRefused.json.error.message, refused.error);
});

test("settings still read with an invalid source, and refuse to write around it", async (t) => {
  const home = await v2Home(t);
  const manifest = await readJson(home.manifestPath);
  manifest.profiles.default.layers.push({ name: "broken", level: "abc", source: "files", path: home.dir });
  await writeManifest(home, manifest);
  const listed = await runContextcake(["settings", "list", "--json"], home);
  assert.equal(listed.exitCode, 0, listed.stdout);
  const set = await runContextcake(["settings", "set", "maxDocFiles", "500", "--json"], home);
  assert.equal(set.exitCode, 7, set.stdout);
  assert.equal(set.json.error.code, "MANIFEST_INVALID");
});
