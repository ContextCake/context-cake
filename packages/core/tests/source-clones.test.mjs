// Managed clones and credentials through the source operations: what prune
// may delete, where a token may be sent, and the HTTP adapter's clone, sync,
// and refusal answers (control-plane spec §5.12, design §10). Clones come from
// local bare repositories reached through url.insteadOf; nothing touches the
// network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { createSourceOperations } from "../src/control/sources.mjs";
import { createEngineService } from "../src/service.mjs";
import { cliHome, runContextcake, writeManifest } from "./helpers/cli-harness.mjs";

const GIT_ENV_KEYS = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_GLOBAL"];
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@localhost"];
// Shaped like a GitHub token so the redactor and validators treat it as one;
// assembled at runtime so no token-shaped literal sits in the repository.
const FAKE_TOKEN = ["ghp", "notARealTokenButShapedLikeOne1234"].join("_");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function layersOf(manifest) {
  return manifest.profiles ? manifest.profiles.default.layers : manifest.layers;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function restoreEnvAfter(t, keys) {
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// A v2 home whose https://example.test/team/<repo> URLs clone from local bare
// repositories.
async function gitHome(t, repos) {
  const home = await cliHome(t);
  await writeManifest(home, { profiles: { default: { label: "Default", layers: [] } } });
  const remotes = path.join(home.dir, "remotes");
  for (const repo of repos) {
    const bare = path.join(remotes, "team", `${repo}.git`);
    const work = path.join(home.dir, "work", repo);
    await fs.mkdir(path.dirname(bare), { recursive: true });
    git(home.dir, "init", "--bare", "--initial-branch=main", bare);
    git(home.dir, "clone", bare, work);
    await fs.writeFile(path.join(work, "a.md"), `# ${repo}\n\nFrom the remote.\n`);
    await fs.writeFile(path.join(work, ".gitignore"), "*.log\n");
    git(work, "add", "a.md", ".gitignore");
    git(work, ...IDENTITY, "commit", "-m", "a");
    git(work, "push", "origin", "HEAD:main");
  }
  restoreEnvAfter(t, GIT_ENV_KEYS);
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://example.test/",
  });
  const cacheDir = path.join(home.config, ".cache", "repos");
  return {
    ...home,
    remotes,
    cacheDir,
    url: (repo) => `https://example.test/team/${repo}`,
    cloneDir: (repo) => path.join(cacheDir, `example.test__team__${repo}`),
  };
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function startService(t, manifestPath) {
  const service = createEngineService({ manifestPath });
  t.after(() => service.close());
  const base = await listen(t, async (req, res) => {
    if (await service.handleRequest(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  return async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
}

test("prune keeps every clone that holds work git would otherwise hide", async (t) => {
  const cases = ["ignored", "excluded", "untracked", "reflog", "merging", "assumed", "clean"];
  const home = await gitHome(t, cases);
  for (const repo of cases) {
    const added = await runContextcake(["source", "add", repo, "--kind", "git", "--repo", home.url(repo), "--json"], home);
    assert.equal(added.exitCode, 0, added.stdout);
  }
  const removed = await runContextcake(["source", "remove", ...cases, "--json"], home);
  assert.equal(removed.json.data.retainedClones.length, cases.length);

  const dir = home.cloneDir;
  await fs.writeFile(path.join(dir("ignored"), "notes.log"), "matched by the repo's .gitignore\n");
  await fs.mkdir(path.join(dir("excluded"), ".git", "info"), { recursive: true });
  await fs.writeFile(path.join(dir("excluded"), ".git", "info", "exclude"), "private.md\n");
  await fs.writeFile(path.join(dir("excluded"), "private.md"), "matched by info/exclude\n");
  // A global setting that hides untracked files from a plain `git status`.
  const globalConfig = path.join(home.dir, "global.gitconfig");
  await fs.writeFile(globalConfig, "[status]\n\tshowUntrackedFiles = no\n");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  await fs.writeFile(path.join(dir("untracked"), "draft.md"), "untracked\n");
  git(dir("reflog"), ...IDENTITY, "commit", "--allow-empty", "-m", "local only");
  git(dir("reflog"), "reset", "--hard", "origin/main");
  await fs.writeFile(path.join(dir("merging"), ".git", "MERGE_HEAD"), `${git(dir("merging"), "rev-parse", "HEAD").trim()}\n`);
  await fs.writeFile(path.join(dir("assumed"), "a.md"), "# edited, then hidden\n");
  git(dir("assumed"), "update-index", "--assume-unchanged", "a.md");

  const pruned = await runContextcake(["source", "prune", "--confirm", "--json"], home);
  assert.equal(pruned.exitCode, 0, pruned.stdout);
  const reasons = Object.fromEntries(pruned.json.data.kept.map((entry) => [path.basename(entry.dir).replace("example.test__team__", ""), entry.reason]));
  assert.deepEqual(reasons, { ignored: "dirty", excluded: "dirty", untracked: "dirty", reflog: "unpushed", merging: "in-progress", assumed: "dirty" });
  assert.deepEqual(pruned.json.data.removed, [{ dir: dir("clean") }]);
  for (const repo of cases.slice(0, -1)) assert.ok(await exists(path.join(dir(repo), ".git")), `${repo} must survive`);
  assert.equal(await exists(dir("clean")), false);
  assert.deepEqual(await fs.readdir(path.join(home.cacheDir, ".trash")), [], "nothing is left in the trash folder");
});

test("a pending GitHub source never gets a token for a host nobody confirmed", async (t) => {
  const seen = [];
  const attacker = await listen(t, (req, res) => {
    seen.push(req.headers.authorization ?? null);
    res.writeHead(404);
    res.end("{}");
  });
  const home = await cliHome(t);
  // What settings sync delivers: auth scrubbed, apiBase not.
  await writeManifest(home, {
    profiles: {
      default: {
        label: "Default",
        layers: [],
        pendingSources: [{ name: "gh", source: "github", repo: "team/notes", level: 1, apiBase: attacker, auth: { __scrubbed: "secret" } }],
      },
    },
  });
  const env = { CC_TEST_TOKEN: FAKE_TOKEN };
  restoreEnvAfter(t, ["CC_TEST_TOKEN"]);
  process.env.CC_TEST_TOKEN = FAKE_TOKEN;
  const before = await fs.readFile(home.manifestPath, "utf8");

  const listed = await runContextcake(["source", "pending-list", "--json"], home, { env });
  assert.equal(listed.json.data[0].apiBase, attacker, "the address a token would go to is always shown");

  const silent = await runContextcake(["source", "pending-configure", "gh", "--token-env", "CC_TEST_TOKEN", "--json"], home, { env });
  assert.equal(silent.exitCode, 5, silent.stdout);
  assert.equal(silent.json.error.code, "API_BASE_UNCONFIRMED");
  assert.equal(silent.json.error.details.apiBase, attacker);

  const wrong = await runContextcake(["source", "pending-configure", "gh", "--token-env", "CC_TEST_TOKEN", "--api-base", "https://api.github.com", "--json"], home, { env });
  assert.equal(wrong.exitCode, 5, wrong.stdout);
  assert.equal(wrong.json.error.code, "API_BASE_UNCONFIRMED");
  assert.equal(await fs.readFile(home.manifestPath, "utf8"), before, "a refusal writes nothing");
  assert.deepEqual(seen, [], "nothing was sent to the host");

  const confirmed = await runContextcake(["source", "pending-configure", "gh", "--token-env", "CC_TEST_TOKEN", "--api-base", `${attacker}/`, "--json"], home, { env });
  assert.equal(confirmed.exitCode, 0, confirmed.stdout);
  assert.deepEqual(layersOf(await readJson(home.manifestPath))[0].auth, { tokenEnv: "CC_TEST_TOKEN" });
});

test("a scrub marker nested inside a pending source still counts as missing", async (t) => {
  const home = await cliHome(t);
  const notes = path.join(home.dir, "notes");
  await fs.mkdir(notes);
  await writeManifest(home, {
    profiles: { default: { label: "Default", layers: [], pendingSources: [{ name: "n", source: "files", level: 1, path: { __scrubbed: "path" }, cache: { ttlSeconds: 60, dir: { __scrubbed: "path" } } }] } },
  });
  const listed = await runContextcake(["source", "pending-list", "--json"], home);
  assert.deepEqual(listed.json.data[0].missing.map((entry) => entry.field), ["path", "cache.dir"]);
  const configured = await runContextcake(["source", "pending-configure", "n", "--path", notes, "--json"], home);
  assert.equal(configured.exitCode, 2, configured.stdout);
  assert.equal(configured.json.error.code, "PENDING_INCOMPLETE");
  assert.deepEqual(configured.json.error.details.missing, [{ field: "cache.dir", reason: "path" }]);
});

test("the add-time probe sends a token to an overridden probe host only when a test opts in", async (t) => {
  const seen = [];
  const probe = await listen(t, (req, res) => {
    seen.push(req.headers.authorization ?? null);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const home = await cliHome(t);
  await writeManifest(home, { profiles: { default: { label: "Default", layers: [] } } });
  restoreEnvAfter(t, ["CONTEXTCAKE_GITHUB_PROBE_BASE", "CONTEXTCAKE_GITHUB_PROBE_SEND_TOKEN"]);
  process.env.CONTEXTCAKE_GITHUB_PROBE_BASE = probe;
  delete process.env.CONTEXTCAKE_GITHUB_PROBE_SEND_TOKEN;
  const env = { CC_TEST_TOKEN: FAKE_TOKEN };
  const first = await runContextcake(["source", "add", "one", "--repo", "team/notes", "--token-env", "CC_TEST_TOKEN", "--json"], home, { env });
  assert.equal(first.exitCode, 0, first.stdout);
  process.env.CONTEXTCAKE_GITHUB_PROBE_SEND_TOKEN = "1";
  const second = await runContextcake(["source", "add", "two", "--repo", "team/notes", "--token-env", "CC_TEST_TOKEN", "--json"], home, { env });
  assert.equal(second.exitCode, 0, second.stdout);
  assert.deepEqual(seen, [null, `Bearer ${FAKE_TOKEN}`]);
});

test("sync and add refuse a clone slot that holds someone else's folder or repository", async (t) => {
  const home = await gitHome(t, ["notes", "other"]);
  const request = await startService(t, home.manifestPath);
  const slot = home.cloneDir("notes");
  await fs.mkdir(slot, { recursive: true });
  await fs.writeFile(path.join(slot, "keep.md"), "not a clone\n");
  const manifest = await readJson(home.manifestPath);
  manifest.profiles.default.layers.push({ name: "team", level: 1, path: path.relative(home.config, slot), origin: `${home.url("notes")}.git`, ref: null });
  await writeManifest(home, manifest);

  const cliSync = await runContextcake(["source", "sync", "team", "--json"], home);
  assert.equal(cliSync.exitCode, 4, cliSync.stdout);
  assert.equal(cliSync.json.error.code, "CLONE_DIR_OCCUPIED");
  const httpSync = await request("POST", "/api/sources/sync?name=team");
  assert.equal(httpSync.status, 409, JSON.stringify(httpSync.body));
  assert.equal(httpSync.body.code, "CLONE_DIR_OCCUPIED");
  const httpAdd = await request("POST", "/api/sources", { name: "again", kind: "github", repo: home.url("notes") });
  assert.equal(httpAdd.status, 409, JSON.stringify(httpAdd.body));
  assert.equal(httpAdd.body.code, "CLONE_DIR_OCCUPIED");
  assert.equal(await fs.readFile(path.join(slot, "keep.md"), "utf8"), "not a clone\n", "the folder is never deleted");

  // A real clone of a different repository in the slot is refused too.
  await fs.rm(slot, { recursive: true });
  git(home.dir, "clone", `file://${path.join(home.remotes, "team", "other.git")}`, slot);
  const foreign = await runContextcake(["source", "add", "notes", "--kind", "git", "--repo", home.url("notes"), "--json"], home);
  assert.equal(foreign.exitCode, 4, foreign.stdout);
  assert.equal(foreign.json.error.code, "CLONE_DIR_OCCUPIED");
  assert.equal(foreign.json.error.details.expected, `${home.url("notes")}.git`);
});

test("the HTTP service stages a clone on add, syncs it, and deletes it on remove", async (t) => {
  const home = await gitHome(t, ["notes"]);
  const request = await startService(t, home.manifestPath);
  const added = await request("POST", "/api/sources", { name: "team", kind: "github", repo: home.url("notes") });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.hasDocuments, true);
  assert.ok(await exists(path.join(home.cloneDir("notes"), "a.md")));
  assert.deepEqual(await fs.readdir(path.join(home.cacheDir, ".staging")), []);

  const synced = await request("POST", "/api/sources/sync?name=team");
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.deepEqual(synced.body, { ok: true, synced: "team" });

  const removed = await request("DELETE", "/api/sources?name=team");
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.retainedClones, undefined, "the app does not keep clones");
  assert.equal(await exists(home.cloneDir("notes")), false);
  assert.deepEqual(await fs.readdir(path.join(home.cacheDir, ".trash")), []);
});

test("a failed GitHub sync answers SYNC_FAILED with its health over HTTP and the CLI", async (t) => {
  const failing = await listen(t, (_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"message":"down"}');
  });
  const home = await cliHome(t);
  await writeManifest(home, { profiles: { default: { label: "Default", layers: [{ name: "gr", level: 1, source: "github", repo: "team/notes", apiBase: failing }] } } });
  const request = await startService(t, home.manifestPath);

  const viaHttp = await request("POST", "/api/sources/sync?name=gr");
  assert.equal(viaHttp.status, 502, JSON.stringify(viaHttp.body));
  assert.equal(viaHttp.body.code, "SYNC_FAILED");
  assert.equal(viaHttp.body.ok, false);
  assert.equal(viaHttp.body.synced, "gr");
  assert.equal(typeof viaHttp.body.lastError, "string");

  const viaCli = await runContextcake(["source", "sync", "gr", "--json"], home);
  assert.equal(viaCli.exitCode, 6, viaCli.stdout);
  assert.equal(viaCli.json.error.code, "SYNC_FAILED");
  assert.equal(viaCli.json.error.message, viaHttp.body.error);
  const { error: _error, code: _code, ...detail } = viaHttp.body;
  assert.deepEqual(Object.keys(viaCli.json.error.details).sort(), Object.keys(detail).sort());
});

test("two adds past every pre-check race to the lock; the loser's staged clone is removed", async (t) => {
  const home = await gitHome(t, ["notes"]);
  // Each add runs its pre-checks synchronously and first yields at the clone,
  // so starting both in one tick puts both past every pre-check, both into a
  // staged clone, before either can reach the lock.
  let clones = 0;
  const ops = createSourceOperations({ manifestPath: home.manifestPath, gitCredentialsForUrl: () => { clones += 1; return []; } });
  const body = { name: "team", kind: "github", repo: home.url("notes") };
  const settled = await Promise.allSettled([ops.addSource(body), ops.addSource(body)]);
  assert.equal(clones, 2, "both adds cloned into staging");
  const lost = settled.filter((result) => result.status === "rejected");
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.code, "SOURCE_EXISTS");
  assert.deepEqual(await fs.readdir(path.join(home.cacheDir, ".staging")), [], "the losing staged clone is gone");
  assert.equal(layersOf(await readJson(home.manifestPath)).length, 1);
});

test("an add that reuses a clone refuses when the clone disappears before the lock", async (t) => {
  const home = await gitHome(t, ["notes"]);
  const ops = createSourceOperations({ manifestPath: home.manifestPath });
  await ops.addSource({ name: "first", kind: "github", repo: home.url("notes") });
  const before = await fs.readFile(home.manifestPath, "utf8");
  // The last step before the lock is the abort check; a prune landing exactly
  // there is what the under-lock re-check exists for.
  const controller = new AbortController();
  controller.signal.throwIfAborted = () => execFileSync("rm", ["-rf", home.cloneDir("notes")]);
  await assert.rejects(
    ops.addSource({ name: "second", kind: "github", repo: home.url("notes") }, { signal: controller.signal }),
    (error) => error.code === "CLONE_MISSING" && error.status === 409,
  );
  assert.equal(await fs.readFile(home.manifestPath, "utf8"), before);
});
