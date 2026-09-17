// `contextcake source` (control-plane spec §5.4, §5.12). Each command runs the
// operation POST/PATCH/DELETE /api/sources runs, so the parity tests drive
// both adapters over identical fixtures and compare the operation results
// (design §10).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { manifestRevisionOf } from "../src/cli/context.mjs";
import { createEngineService } from "../src/service.mjs";
import { cliHome, runContextcake, writeManifest } from "./helpers/cli-harness.mjs";

const MOCK_MCP = fileURLToPath(new URL("../../../examples/mock-mcp-source/server.mjs", import.meta.url));

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function layersOf(manifest, profile = "default") {
  return manifest.profiles ? manifest.profiles[profile].layers : manifest.layers;
}

async function folder(home, name, docs = { "a.md": "# A\n\nHello.\n" }) {
  const dir = path.join(home.dir, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, body] of Object.entries(docs)) await fs.writeFile(path.join(dir, file), body);
  return dir;
}

async function v2Home(t, profiles = {}) {
  const home = await cliHome(t);
  await writeManifest(home, { profiles: { default: { label: "Default", layers: [] }, ...profiles } });
  return home;
}

async function startService(t, manifestPath) {
  const service = createEngineService({ manifestPath });
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
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
}

test("source add, list, and show work on a manifest init created", async (t) => {
  const home = await cliHome(t);
  assert.equal((await runContextcake(["init"], home)).exitCode, 0);
  const notes = await folder(home, "notes");

  const added = await runContextcake(["source", "add", "notes", "--path", notes, "--json"], home);
  assert.equal(added.exitCode, 0, added.stdout);
  assert.deepEqual(added.json.data, { ok: true, added: "notes", level: 1, indexing: true, hasDocuments: true, scanComplete: true });
  assert.equal(added.json.context.profileId, "default");
  assert.equal(added.json.context.manifestRevision, manifestRevisionOf(await readJson(home.manifestPath)));
  assert.ok(!Object.hasOwn(added.json, "coverage"), "a mutation reports no coverage");
  assert.deepEqual(layersOf(await readJson(home.manifestPath)), [{ name: "notes", level: 1, path: notes, source: "files" }]);

  // A relative folder is relative to where the command runs.
  await folder(home, "docs");
  const relative = await runContextcake(["source", "add", "docs", "--kind", "okf-local", "--path", "docs", "--level", "2", "--json"], home);
  assert.equal(relative.exitCode, 0, relative.stdout);
  assert.equal(layersOf(await readJson(home.manifestPath))[1].path, path.join(home.dir, "docs"));

  const listed = await runContextcake(["source", "list", "--json"], home);
  assert.equal(listed.exitCode, 0);
  assert.deepEqual(listed.json.data.sources.map((row) => [row.rank, row.name, row.kind, row.level]), [[1, "docs", "okf-local", 2], [2, "notes", "files", 1]]);
  assert.deepEqual(listed.json.data.quarantined, []);
  assert.deepEqual(listed.json.data.pending, []);

  const shown = await runContextcake(["source", "show", "notes", "--json"], home);
  assert.equal(shown.json.data.state, "active");
  assert.equal(shown.json.data.source.resolvedPath, notes);
  const missing = await runContextcake(["source", "show", "nope", "--json"], home);
  assert.equal(missing.exitCode, 3);
  assert.equal(missing.json.error.code, "SOURCE_NOT_FOUND");
});

test("source add refuses bad input with typed codes and leaves the manifest alone", async (t) => {
  const home = await v2Home(t);
  const notes = await folder(home, "notes");
  const before = await fs.readFile(home.manifestPath, "utf8");

  const cases = [
    [["source", "add", "x", "--json"], 2, "INVALID_INPUT"],
    [["source", "add", "x", "--path", notes, "--subdir", "a", "--json"], 2, "INVALID_INPUT"],
    [["source", "add", "x", "--kind", "svn", "--path", notes, "--json"], 2, "KIND_UNKNOWN"],
    [["source", "add", "bad/name", "--path", notes, "--json"], 2, "NAME_INVALID"],
    [["source", "add", "x", "--path", path.join(home.dir, "missing"), "--json"], 3, "FOLDER_NOT_FOUND"],
    [["source", "add", "x", "--path", notes, "--level", "1", "--position", "1", "--json"], 2, "LEVEL_AND_POSITION"],
    [["source", "add", "x", "--kind", "github", "--repo", "not a repo", "--json"], 2, "REPO_INVALID"],
    [["source", "add", "x", "--command", process.execPath, "--json", "--", MOCK_MCP], 5, "MCP_TRUST_REQUIRED"],
    [["source", "add", "x", "--path", notes, "--expect-revision", `sha256:${"0".repeat(64)}`, "--json"], 4, "STALE_REVISION"],
  ];
  for (const [argv, exitCode, code] of cases) {
    const result = await runContextcake(argv, home);
    assert.equal(result.exitCode, exitCode, `${argv.join(" ")}: ${result.stdout}`);
    assert.equal(result.json.error.code, code, argv.join(" "));
    // Every code a command answers with is in its help contract.
    const help = await runContextcake(["help", "--json"], home);
    const described = help.json.data.commands.find((command) => command.id === "source.add");
    assert.ok(described.errors.some((entry) => entry.code === code && entry.exitCode === exitCode), `${code} missing from source.add errors`);
  }
  const mcpRefusal = await runContextcake(["source", "add", "x", "--command", process.execPath, "--json", "--", MOCK_MCP], home);
  assert.ok(mcpRefusal.json.warnings.some((warning) => warning.code === "MCP_SOURCE_RUNS_COMMAND"));
  assert.equal(await fs.readFile(home.manifestPath, "utf8"), before);

  assert.equal((await runContextcake(["source", "add", "x", "--path", notes], home)).exitCode, 0);
  const again = await runContextcake(["source", "add", "x", "--path", notes, "--json"], home);
  assert.equal(again.exitCode, 4);
  assert.equal(again.json.error.code, "SOURCE_EXISTS");

  const missingManifest = await cliHome(t);
  const uninitialized = await runContextcake(["source", "add", "x", "--path", notes, "--json"], missingManifest);
  assert.equal(uninitialized.exitCode, 3);
  assert.equal(uninitialized.json.error.code, "MANIFEST_NOT_FOUND");
});

test("an mcp source keeps the add-time probe and warns that it runs a command", async (t) => {
  const home = await v2Home(t);
  const added = await runContextcake(["source", "add", "graph", "--command", process.execPath, "--trusted", "--level", "2", "--json", "--", MOCK_MCP], home);
  assert.equal(added.exitCode, 0, added.stdout);
  const warning = added.json.warnings.find((entry) => entry.code === "MCP_SOURCE_RUNS_COMMAND");
  assert.deepEqual(warning.details, { command: process.execPath, args: [MOCK_MCP] });
  assert.deepEqual(layersOf(await readJson(home.manifestPath)), [{ name: "graph", level: 2, source: "mcp", command: process.execPath, args: [MOCK_MCP] }]);

  // A command that is not an MCP server fails the probe and writes nothing.
  const wrong = await runContextcake(["source", "add", "wrong", "--command", process.execPath, "--trusted", "--json", "--", "-e", "setTimeout(() => {}, 1)"], home);
  assert.equal(wrong.json.ok, false);
  assert.ok(["MCP_UNREACHABLE", "MCP_CONTRACT"].includes(wrong.json.error.code), wrong.stdout);
  assert.equal(layersOf(await readJson(home.manifestPath)).length, 1);

  // `test` spawns the child, reads it, and closes it: the command returns.
  const tested = await runContextcake(["source", "test", "--json"], home);
  assert.equal(tested.exitCode, 0, tested.stdout);
  assert.equal(tested.json.data.sources[0].ok, true);
  assert.equal(tested.json.data.sources[0].concepts, 2);
  assert.deepEqual(tested.json.coverage, { complete: true, degraded: [] });
});

test("source test exits 6 on a source it cannot read and still reports every source", async (t) => {
  const home = await v2Home(t);
  const good = await folder(home, "good");
  const gone = await folder(home, "gone");
  assert.equal((await runContextcake(["source", "add", "good", "--path", good], home)).exitCode, 0);
  assert.equal((await runContextcake(["source", "add", "gone", "--path", gone], home)).exitCode, 0);
  await fs.rm(gone, { recursive: true });

  const tested = await runContextcake(["source", "test", "--json"], home);
  assert.equal(tested.exitCode, 6, tested.stdout);
  assert.equal(tested.json.error.code, "INCOMPLETE_COVERAGE");
  assert.deepEqual(tested.json.error.details.coverage.degraded.map((entry) => entry.source), ["gone"]);
  assert.deepEqual(tested.json.error.details.sources.map((row) => [row.name, row.ok]), [["good", true], ["gone", false]]);

  const one = await runContextcake(["source", "test", "good", "--json"], home);
  assert.equal(one.exitCode, 0);
  assert.equal(one.json.data.sources.length, 1);
  const unknown = await runContextcake(["source", "test", "nope", "--json"], home);
  assert.equal(unknown.exitCode, 3);
  assert.equal(unknown.json.error.code, "SOURCE_NOT_FOUND");
});

test("sources are scoped to the selected profile", async (t) => {
  const home = await v2Home(t, { work: { label: "Work", layers: [] } });
  const notes = await folder(home, "notes");
  const added = await runContextcake(["source", "add", "notes", "--path", notes, "--profile", "work", "--json"], home);
  assert.equal(added.exitCode, 0, added.stdout);
  assert.equal(added.json.context.profileId, "work");
  const manifest = await readJson(home.manifestPath);
  assert.equal(layersOf(manifest, "work").length, 1);
  assert.equal(layersOf(manifest, "default").length, 0);

  assert.deepEqual((await runContextcake(["source", "list", "--json"], home)).json.data.sources, []);
  assert.equal((await runContextcake(["source", "list", "--profile", "work", "--json"], home)).json.data.sources.length, 1);

  // Mutations by name never reach into another profile.
  const elsewhere = await runContextcake(["source", "level", "notes", "5", "--json"], home);
  assert.equal(elsewhere.exitCode, 3);
  assert.equal(elsewhere.json.error.code, "SOURCE_NOT_FOUND");
  assert.equal((await runContextcake(["source", "level", "notes", "5", "--profile", "work"], home)).exitCode, 0);
  assert.equal(layersOf(await readJson(home.manifestPath), "work")[0].level, 5);

  const unknown = await runContextcake(["source", "list", "--profile", "nope", "--json"], home);
  assert.equal(unknown.exitCode, 3);
  assert.equal(unknown.json.error.code, "PROFILE_NOT_FOUND");
});

test("level, update, reorder, and remove match the HTTP service on the same fixture", async (t) => {
  // Two homes with the same layout: the CLI drives one, HTTP the other.
  const cliSide = await v2Home(t);
  const httpSide = await v2Home(t);
  const request = await startService(t, httpSide.manifestPath);
  const steps = [];
  for (const home of [cliSide, httpSide]) {
    for (const name of ["a", "b", "c"]) await folder(home, name);
    await folder(home, "moved");
  }
  const at = (home, name) => path.join(home.dir, name);

  const compare = async (label, argv, method, route, body) => {
    const viaCli = await runContextcake([...argv, "--json"], cliSide);
    const viaHttp = await request(method, route, typeof body === "function" ? body(httpSide) : body);
    assert.equal(viaCli.exitCode, 0, `${label}: ${viaCli.stdout}`);
    assert.equal(viaHttp.status, 200, `${label}: ${JSON.stringify(viaHttp.body)}`);
    assert.deepEqual(viaCli.json.data, viaHttp.body, label);
    steps.push(label);
  };
  await compare("add a", ["source", "add", "a", "--path", at(cliSide, "a"), "--level", "3"], "POST", "/api/sources", (home) => ({ name: "a", kind: "files", path: at(home, "a"), level: 3 }));
  await compare("add b", ["source", "add", "b", "--path", at(cliSide, "b"), "--kind", "okf-local", "--level", "2"], "POST", "/api/sources", (home) => ({ name: "b", kind: "local", path: at(home, "b"), level: 2 }));
  await compare("add c at position 1", ["source", "add", "c", "--path", at(cliSide, "c"), "--position", "1"], "POST", "/api/sources", (home) => ({ name: "c", kind: "files", path: at(home, "c"), position: 1 }));
  await compare("level", ["source", "level", "b", "7"], "PATCH", "/api/sources", { name: "b", level: 7 });
  await compare("update path + rename", ["source", "update", "a", "--path", at(cliSide, "moved"), "--rename", "a2"], "PATCH", "/api/sources", (home) => ({ name: "a", path: at(home, "moved"), newName: "a2" }));
  await compare("reorder", ["source", "reorder", "a2", "c", "b"], "PUT", "/api/sources/order", { order: ["a2", "c", "b"] });
  await compare("remove", ["source", "remove", "c"], "DELETE", "/api/sources?name=c");

  const strip = (manifest) => layersOf(manifest).map(({ path: _path, ...layer }) => layer);
  assert.deepEqual(strip(await readJson(cliSide.manifestPath)), strip(await readJson(httpSide.manifestPath)));

  // Refusals carry the same code both ways.
  const cliOrder = await runContextcake(["source", "reorder", "a2", "--json"], cliSide);
  const httpOrder = await request("PUT", "/api/sources/order", { order: ["a2"] });
  assert.equal(cliOrder.exitCode, 2);
  assert.equal(cliOrder.json.error.code, httpOrder.body.code);
  assert.equal(cliOrder.json.error.message, httpOrder.body.error);
  assert.deepEqual(cliOrder.json.error.details, { unknown: [], missing: ["b"], duplicate: [] });

  const cliSync = await runContextcake(["source", "sync", "b", "--json"], cliSide);
  const httpSync = await request("POST", "/api/sources/sync?name=b");
  assert.equal(httpSync.status, 400);
  assert.equal(cliSync.exitCode, 2);
  assert.equal(cliSync.json.error.code, "SYNC_UNSUPPORTED");
  assert.equal(httpSync.body.code, "SYNC_UNSUPPORTED");
  assert.equal(cliSync.json.error.message, httpSync.body.error);
});

test("a stale revision refuses every source mutation, and a fresh one is accepted", async (t) => {
  const home = await v2Home(t);
  const notes = await folder(home, "notes");
  const added = await runContextcake(["source", "add", "notes", "--path", notes, "--json"], home);
  const fresh = added.json.context.manifestRevision;
  const stale = `sha256:${"f".repeat(64)}`;
  const before = await fs.readFile(home.manifestPath, "utf8");
  for (const argv of [
    ["source", "level", "notes", "4"],
    ["source", "update", "notes", "--rename", "n2"],
    ["source", "reorder", "notes"],
    ["source", "remove", "notes"],
    ["source", "pending-dismiss", "notes"],
  ]) {
    const refused = await runContextcake([...argv, "--expect-revision", stale, "--json"], home);
    assert.equal(refused.exitCode, 4, `${argv.join(" ")}: ${refused.stdout}`);
    assert.equal(refused.json.error.code, "STALE_REVISION");
  }
  assert.equal(await fs.readFile(home.manifestPath, "utf8"), before);
  const accepted = await runContextcake(["source", "level", "notes", "4", "--expect-revision", fresh, "--json"], home);
  assert.equal(accepted.exitCode, 0, accepted.stdout);
  // --timeout is refused on a write before anything runs.
  const timed = await runContextcake(["source", "level", "notes", "5", "--timeout", "5s", "--json"], home);
  assert.equal(timed.exitCode, 2);
  assert.equal(timed.json.error.code, "TIMEOUT_REFUSED");
});

test("an invalid layer is listed, blocks reorder, and is removed all-or-nothing", async (t) => {
  const home = await cliHome(t);
  const good = await folder(home, "good");
  await writeManifest(home, {
    profiles: {
      default: {
        label: "Default",
        layers: [
          { name: "good", level: 2, source: "files", path: good },
          { name: "broken", level: "abc", source: "files", path: good },
          { name: "worse", level: 1, source: "files" },
        ],
      },
    },
  });

  const listed = await runContextcake(["source", "list", "--json"], home);
  assert.equal(listed.exitCode, 0, listed.stdout);
  assert.deepEqual(listed.json.data.sources.map((row) => row.name), ["good"]);
  assert.deepEqual(listed.json.data.quarantined.map((row) => row.name), ["broken", "worse"]);
  assert.equal(listed.json.context.manifestRevision, manifestRevisionOf(await readJson(home.manifestPath)));

  const reorder = await runContextcake(["source", "reorder", "good", "--json"], home);
  assert.equal(reorder.exitCode, 4);
  assert.equal(reorder.json.error.code, "REORDER_BLOCKED");
  assert.deepEqual(reorder.json.error.details.blocking.map((entry) => entry.name), ["broken", "worse"]);

  const partial = await runContextcake(["source", "remove", "broken", "--json"], home);
  assert.equal(partial.exitCode, 4);
  assert.equal(partial.json.error.code, "REMOVE_BLOCKED");
  assert.equal(layersOf(await readJson(home.manifestPath)).length, 3);

  const tested = await runContextcake(["source", "test", "--json"], home);
  assert.equal(tested.exitCode, 6);
  assert.deepEqual(tested.json.error.details.sources.filter((row) => row.quarantined).map((row) => row.name), ["broken", "worse"]);

  const both = await runContextcake(["source", "remove", "broken", "worse", "--json"], home);
  assert.equal(both.exitCode, 0, both.stdout);
  assert.deepEqual(both.json.data.removedNames, ["broken", "worse"]);
  assert.deepEqual(layersOf(await readJson(home.manifestPath)).map((layer) => layer.name), ["good"]);
});

test("pending sources are listed, configured with what this machine supplies, and dismissed", async (t) => {
  const home = await cliHome(t);
  const notes = await folder(home, "notes");
  await writeManifest(home, {
    profiles: {
      default: {
        label: "Default",
        layers: [],
        pendingSources: [
          { name: "synced", source: "files", level: 2, path: { __scrubbed: "path" } },
          { name: "graph", source: "mcp", level: 1, command: { __scrubbed: "execution" }, args: { __scrubbed: "execution" } },
          { name: "old", source: "files", level: 1, path: { __scrubbed: "path" } },
        ],
      },
    },
  });

  const listed = await runContextcake(["source", "pending-list", "--json"], home);
  assert.equal(listed.exitCode, 0);
  assert.deepEqual(listed.json.data.map((row) => [row.name, row.missing.map((entry) => entry.field)]), [["synced", ["path"]], ["graph", ["command", "args"]], ["old", ["path"]]]);
  assert.ok(listed.json.nextActions.some((action) => action.command === "source.pending-configure"));

  const incomplete = await runContextcake(["source", "pending-configure", "synced", "--json"], home);
  assert.equal(incomplete.exitCode, 2);
  assert.equal(incomplete.json.error.code, "PENDING_INCOMPLETE");
  assert.deepEqual(incomplete.json.error.details.missing, [{ field: "path", reason: "path" }]);

  const configured = await runContextcake(["source", "pending-configure", "synced", "--path", notes, "--json"], home);
  assert.equal(configured.exitCode, 0, configured.stdout);
  assert.deepEqual(configured.json.data, { ok: true, configured: "synced", kind: "files", level: 2, hasDocuments: true, scanComplete: true });

  const untrusted = await runContextcake(["source", "pending-configure", "graph", "--command", process.execPath, "--json", "--", MOCK_MCP], home);
  assert.equal(untrusted.exitCode, 5);
  assert.equal(untrusted.json.error.code, "MCP_TRUST_REQUIRED");
  const trusted = await runContextcake(["source", "pending-configure", "graph", "--command", process.execPath, "--trusted", "--json", "--", MOCK_MCP], home);
  assert.equal(trusted.exitCode, 0, trusted.stdout);
  assert.ok(trusted.json.warnings.some((warning) => warning.code === "MCP_SOURCE_RUNS_COMMAND"));

  // dismiss only takes pending entries; a runnable source is not one.
  const notPending = await runContextcake(["source", "pending-dismiss", "synced", "--json"], home);
  assert.equal(notPending.exitCode, 3);
  assert.equal(notPending.json.error.code, "PENDING_NOT_FOUND");
  const dismissed = await runContextcake(["source", "pending-dismiss", "old", "--json"], home);
  assert.equal(dismissed.exitCode, 0, dismissed.stdout);

  const manifest = await readJson(home.manifestPath);
  assert.deepEqual(layersOf(manifest).map((layer) => layer.name), ["synced", "graph"]);
  assert.equal(manifest.profiles.default.pendingSources, undefined);
  assert.deepEqual(layersOf(manifest)[1], { name: "graph", source: "mcp", level: 1, command: process.execPath, args: [MOCK_MCP] });
});

test("git clones are staged, promoted under the lock, kept on remove, and pruned only when clean", async (t) => {
  const home = await v2Home(t);
  // A local bare repository stands in for https://example.test/team/notes.
  const remotes = path.join(home.dir, "remotes");
  const work = path.join(home.dir, "work");
  await fs.mkdir(path.join(remotes, "team"), { recursive: true });
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  git(home.dir, "init", "--bare", "--initial-branch=main", path.join(remotes, "team", "notes.git"));
  git(home.dir, "clone", path.join(remotes, "team", "notes.git"), work);
  await fs.writeFile(path.join(work, "a.md"), "# A\n\nFrom the remote.\n");
  git(work, "add", "a.md");
  git(work, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "a");
  git(work, "push", "origin", "HEAD:main");

  const saved = { ...process.env };
  t.after(() => {
    for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://example.test/",
  });

  const cacheDir = path.join(home.config, ".cache", "repos");
  const cloneDir = path.join(cacheDir, "example.test__team__notes");
  const staging = path.join(cacheDir, ".staging");

  const stale = await runContextcake(["source", "add", "team", "--kind", "git", "--repo", "https://example.test/team/notes", "--expect-revision", `sha256:${"a".repeat(64)}`, "--json"], home);
  assert.equal(stale.exitCode, 4);
  await assert.rejects(fs.access(cloneDir));

  // Two adds race: both clone, the lock admits one, and the loser's staged
  // clone is removed rather than promoted.
  const addTeam = () => runContextcake(["source", "add", "team", "--kind", "git", "--repo", "https://example.test/team/notes", "--json"], home);
  const raced = await Promise.all([addTeam(), addTeam()]);
  const added = raced.find((result) => result.exitCode === 0);
  const lost = raced.find((result) => result !== added);
  assert.ok(added, raced.map((result) => result.stdout).join("\n"));
  assert.equal(lost.exitCode, 4, lost.stdout);
  assert.equal(lost.json.error.code, "SOURCE_EXISTS");
  assert.equal(added.json.data.hasDocuments, true);
  await fs.access(path.join(cloneDir, "a.md"));
  assert.deepEqual(await fs.readdir(staging), [], "nothing is left in staging");
  const layer = layersOf(await readJson(home.manifestPath))[0];
  assert.equal(layer.origin, "https://example.test/team/notes.git");
  assert.equal(path.resolve(home.config, layer.path), cloneDir);

  const synced = await runContextcake(["source", "sync", "team", "--json"], home);
  assert.equal(synced.exitCode, 0, synced.stdout);
  assert.deepEqual(synced.json.data, { ok: true, synced: "team" });

  const referenced = await runContextcake(["source", "prune", "--json"], home);
  assert.equal(referenced.exitCode, 0);
  assert.deepEqual(referenced.json.data.kept, [{ dir: cloneDir, reason: "referenced" }]);

  const removed = await runContextcake(["source", "remove", "team", "--json"], home);
  assert.equal(removed.exitCode, 0, removed.stdout);
  assert.deepEqual(removed.json.data.retainedClones, [cloneDir]);
  assert.ok(removed.json.nextActions.some((action) => action.command === "source.prune"));
  await fs.access(cloneDir);

  await fs.writeFile(path.join(cloneDir, "local.md"), "# Mine\n");
  const dirty = await runContextcake(["source", "prune", "--confirm", "--json"], home);
  assert.equal(dirty.exitCode, 0, dirty.stdout);
  assert.deepEqual(dirty.json.data.kept, [{ dir: cloneDir, reason: "dirty" }]);
  assert.deepEqual(dirty.json.data.removed, []);
  await fs.access(path.join(cloneDir, "local.md"));

  await fs.rm(path.join(cloneDir, "local.md"));
  const preview = await runContextcake(["source", "prune", "--json"], home);
  assert.equal(preview.exitCode, 4);
  assert.equal(preview.json.error.code, "CONFIRMATION_REQUIRED");
  assert.deepEqual(preview.json.error.details.removable, [{ dir: cloneDir }]);
  const pruned = await runContextcake(["source", "prune", "--confirm", "--json"], home);
  assert.equal(pruned.exitCode, 0, pruned.stdout);
  assert.deepEqual(pruned.json.data.removed, [{ dir: cloneDir }]);
  await assert.rejects(fs.access(cloneDir));
});
