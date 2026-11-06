import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createFileOperations } from "../src/control/files.mjs";
import { createDiscrepancyTransactionJournal } from "../src/conflict-resolutions.mjs";
import { commitPathsWithMutation, push, withRepoLock } from "../src/sources/git-core.mjs";
import { createEngineService } from "../src/service.mjs";

test("atomic editor saves keep external writes visible under Linux's recursive watcher", () => {
  const helper = fileURLToPath(new URL("./helpers/atomic-editor-watch.mjs", import.meta.url));
  const output = execFileSync(process.execPath, ["--expose-internals", helper], { encoding: "utf8", timeout: 30_000 });
  assert.match(output, /atomic editor watcher regression passed/);
});

async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-editor-live-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const remote = path.join(dir, "remote.git");
  const live = path.join(dir, "live");
  const personal = path.join(dir, "personal");
  const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  await fs.mkdir(live);
  await fs.mkdir(personal);
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  git(live, "init", "--quiet", "--initial-branch=main");
  git(live, "config", "user.name", "Editor Fixture");
  git(live, "config", "user.email", "editor@example.invalid");
  const text = "## Choice {#choice}\n\nOriginal.\n";
  for (const name of ["note.md", "extra.mdx", "sibling.md"]) await fs.writeFile(path.join(live, name), text);
  await fs.writeFile(path.join(personal, "note.md"), text);
  git(live, "add", "--", "note.md", "extra.mdx", "sibling.md");
  git(live, "commit", "--quiet", "-m", "seed");
  git(live, "remote", "add", "origin", remote);
  git(live, "push", "--quiet", "-u", "origin", "main");
  const manifestPath = path.join(dir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({ layers: [
    { name: "team", level: 2, path: live, live: true, git: {} },
    { name: "alias", level: 1, path: live, source: "files" },
    { name: "personal", level: 3, path: personal },
  ] }));
  const journal = createDiscrepancyTransactionJournal(manifestPath);
  const ops = createFileOperations({ manifestPath, transactionJournal: journal,
    git: {
      commitPathsWithMutation: (root, paths, message, options) => commitPathsWithMutation(root, paths, message, { ...options, lockRetryMs: 1, lockRetries: 10 }),
      push: async (root) => {
        await assert.rejects(fs.stat(`${manifestPath}.lock`), { code: "ENOENT" }, "push is outside the manifest lease");
        return push(root);
      },
      ...overrides,
    },
  });
  const save = (body) => ops.writeFile(JSON.stringify({ path: "team/note.md", force: true, text: "Updated.\n", ...body }));
  return { dir, live, personal, remote, manifestPath, ops, save, journal, git, text };
}

test("editor commits only its actual target and preserves staged/dirty siblings", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.live, "sibling.md"), "staged sibling\n");
  f.git(f.live, "add", "--", "sibling.md");
  await fs.writeFile(path.join(f.live, "sibling.md"), "working sibling\n");
  const out = await f.save();
  assert.equal(out.git.committed, true);
  assert.equal(out.git.pushed, true);
  assert.deepEqual(out.git.paths, ["note.md"]);
  assert.equal(f.git(f.live, "show", "--name-only", "--format=", "HEAD").trim(), "note.md");
  assert.equal(f.git(f.live, "show", ":sibling.md"), "staged sibling\n");
  assert.equal(await fs.readFile(path.join(f.live, "sibling.md"), "utf8"), "working sibling\n");
  const head = f.git(f.live, "rev-parse", "HEAD");
  const clean = await f.save();
  assert.equal(clean.git.committed, false);
  assert.equal(f.git(f.live, "rev-parse", "HEAD"), head, "clean saves do not mint empty commits");
  assert.deepEqual((await fs.readdir(f.live)).filter((name) => name.includes(".contextcake-")), []);
});

test("an alias into the live repository gets the same lock and exact extension commit", async (t) => {
  const f = await fixture(t);
  const out = await f.ops.writeSection(JSON.stringify({ conceptId: "extra", sectionKey: "choice", layers: ["alias"], content: "Rewritten.", requireAll: true }));
  assert.deepEqual(out.written, ["alias"]);
  assert.deepEqual(out.git.paths, ["extra.mdx"]);
  assert.equal(f.git(f.live, "show", "--name-only", "--format=", "HEAD").trim(), "extra.mdx");
  assert.match(await fs.readFile(path.join(f.live, "extra.mdx"), "utf8"), /Rewritten/);
});

test("a held live lock refuses file and multi-layer section edits without staging or changing bytes", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.live, ".contextcake.lock"), JSON.stringify({ pid: process.pid, ts: Date.now(), token: "held" }));
  await assert.rejects(f.save(), (error) => error.status === 409 && error.code === "LIVE_LAYER_BUSY");
  await assert.rejects(f.ops.writeSection(JSON.stringify({ conceptId: "note", sectionKey: "choice", layers: ["personal", "alias"], content: "Refused." })), (error) => error.code === "LIVE_LAYER_BUSY");
  assert.equal(await fs.readFile(path.join(f.live, "note.md"), "utf8"), f.text);
  assert.equal(await fs.readFile(path.join(f.personal, "note.md"), "utf8"), f.text);
  assert.deepEqual(await f.journal.list(), [], "no prepared transaction for a refused lock");
  assert.equal((await fs.readdir(f.live)).some((name) => name.includes(".contextcake-")), false);
});

test("stale-editor validation runs after waiting for the repository lock", async (t) => {
  let waiting;
  const waitingPromise = new Promise((resolve) => { waiting = resolve; });
  const f = await fixture(t, { commitPathsWithMutation: (root, paths, message, options) => {
    waiting();
    return commitPathsWithMutation(root, paths, message, { ...options, lockRetryMs: 1, lockRetries: 1000 });
  } });
  const file = path.join(f.live, "note.md");
  const modified = (await fs.stat(file)).mtime.toISOString();
  let release;
  let held;
  const heldPromise = new Promise((resolve) => { held = resolve; });
  const holder = withRepoLock(f.live, "fixture", async () => { held(); await new Promise((resolve) => { release = resolve; }); });
  await heldPromise;
  const saving = f.save({ force: false, modified });
  // Attach the rejection handler immediately; it is expected after release.
  const refused = assert.rejects(saving, (error) => error.status === 409 && /changed on disk/.test(error.message));
  await waitingPromise;
  await fs.writeFile(file, "Concurrent decision.\n");
  await fs.utimes(file, new Date(), new Date(Date.now() + 1000));
  release();
  await holder;
  await refused;
  assert.equal(await fs.readFile(file, "utf8"), "Concurrent decision.\n");
  assert.deepEqual(await f.journal.list(), []);
});

test("a failed live commit rolls back all section contributors and preserves index state", async (t) => {
  const f = await fixture(t);
  const index = f.git(f.live, "ls-files", "--stage", "-z");
  await fs.writeFile(path.join(f.live, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(f.ops.writeSection(JSON.stringify({ conceptId: "note", sectionKey: "choice", layers: ["personal", "team"], content: "Must roll back." })), (error) => error.code === "GitError");
  assert.equal(await fs.readFile(path.join(f.live, "note.md"), "utf8"), f.text);
  assert.equal(await fs.readFile(path.join(f.personal, "note.md"), "utf8"), f.text);
  assert.equal(f.git(f.live, "ls-files", "--stage", "-z"), index);
  assert.equal((await f.journal.list()).at(-1).state, "rolled_back");
  for (const root of [f.live, f.personal]) assert.equal((await fs.readdir(root)).some((name) => name.includes(".contextcake-")), false);
});

test("offline editor commits queue a push that ordinary sync can later deliver", async (t) => {
  const f = await fixture(t);
  f.git(f.live, "remote", "set-url", "origin", path.join(f.dir, "offline.git"));
  const out = await f.save();
  assert.equal(out.git.committed, true);
  assert.equal(out.git.queued, true);
  assert.equal((await f.journal.list()).at(-1).state, "committed");
  f.git(f.live, "remote", "set-url", "origin", f.remote);
  assert.equal((await push(f.live)).pushed, true);
  assert.equal(f.git(f.remote, "show", "HEAD:note.md"), "Updated.\n");
});

for (const apiPath of ['/team/note.md', 'team\\note.md', ['team/note.md']]) {
  test(`alternate editor path ${JSON.stringify(apiPath)} cannot bypass the live lock`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.live, '.contextcake.lock'), JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'held' }));
    await assert.rejects(f.save({ path: apiPath }), (error) => error.code === 'LIVE_LAYER_BUSY');
    assert.equal(await fs.readFile(path.join(f.live, 'note.md'), 'utf8'), f.text);
    assert.deepEqual(await f.journal.list(), []);
  });
}

for (const layer of ['/team', '\\team', ['team']]) {
  test(`section layer ${JSON.stringify(layer)} cannot normalize into an unlocked live write`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.live, '.contextcake.lock'), JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'held' }));
    await assert.rejects(f.ops.writeSection(JSON.stringify({ conceptId: 'note', sectionKey: 'choice', layers: [layer], content: 'Refused.', requireAll: true })), (error) => error.status === 409);
    assert.equal(await fs.readFile(path.join(f.live, 'note.md'), 'utf8'), f.text);
  });
}

test('a second host waits for an active prepared editor transaction before startup recovery', async (t) => {
  const f = await fixture(t);
  let prepared;
  const preparedPromise = new Promise((resolve) => { prepared = resolve; });
  let resume;
  const resumePromise = new Promise((resolve) => { resume = resolve; });
  const append = f.journal.append;
  f.journal.append = async (record) => {
    await append(record);
    if (record.state === 'prepared') { prepared(); await resumePromise; }
  };
  const saving = f.save();
  await preparedPromise;
  let progress;
  const progressPromise = new Promise((resolve) => { progress = resolve; });
  let journalRead;
  const journalReadPromise = new Promise((resolve) => { journalRead = resolve; });
  const mkdir = syncFs.mkdirSync;
  t.mock.method(syncFs, 'mkdirSync', (target, ...args) => {
    if (target === `${f.manifestPath}.lock`) progress('lease');
    return mkdir(target, ...args);
  });
  const read = fs.readFile;
  t.mock.method(fs, 'readFile', async (target, ...args) => {
    const value = await read(target, ...args);
    if (target === f.journal.file) { progress('journal'); journalRead(); }
    return value;
  });
  const service = createEngineService({ manifestPath: f.manifestPath });
  try {
    // Deterministic barrier: the old startup path reads the prepared journal
    // first; the safe path first attempts the manifest lease held by the save.
    assert.equal(await progressPromise, 'lease');
  } finally {
    resume();
    await saving;
    await journalReadPromise;
    service.close();
  }
  assert.equal(await fs.readFile(path.join(f.live, 'note.md'), 'utf8'), 'Updated.\n');
  assert.equal(f.git(f.live, 'show', 'HEAD:note.md'), 'Updated.\n');
  assert.equal((await f.journal.list()).some((row) => row.state === 'rolled_back'), false);
});
