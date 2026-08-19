import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageSectionTransaction, stageFrontmatterTransaction, stageFileCreationTransaction } from "../src/layer-files.mjs";
import { createDiscrepancyTransactionJournal } from "../src/conflict-resolutions.mjs";
import { createEngineService } from "../src/service.mjs";

const document = (value) => `---\ntype: decision\ntitle: Database\n---\n\n# Database\n\n## Choice {#choice}\n\n${value}\n`;

async function fixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-discrepancy-tx-"));
  const roots = new Map();
  for (const [name, value] of [["team", "Postgres"], ["company", "MySQL"]]) {
    const root = path.join(dir, name);
    await fsp.mkdir(root);
    await fsp.writeFile(path.join(root, "database.md"), document(value), { mode: 0o644 });
    roots.set(name, { root, kind: "okf-local" });
  }
  return { dir, roots };
}

test("a failure at every replacement position restores the full original write set", async (t) => {
  for (const failAt of [0, 1]) {
    await t.test(`replacement ${failAt + 1}`, async () => {
      const { dir, roots } = await fixture();
      try {
        const original = await Promise.all([...roots.values()].map(({ root }) => fsp.readFile(path.join(root, "database.md"), "utf8")));
        const staged = await stageSectionTransaction(JSON.stringify({
          conceptId: "database", sectionKey: "choice", layers: ["team", "company"],
          content: "SQLite", expectedContent: { team: "Postgres", company: "MySQL" }, requireAll: true,
        }), roots, `failure-${failAt}`, { beforeReplace(index) { if (index === failAt) throw new Error("injected replacement failure"); } });
        await assert.rejects(staged.commit(), /injected replacement failure/);
        const after = await Promise.all([...roots.values()].map(({ root }) => fsp.readFile(path.join(root, "database.md"), "utf8")));
        assert.deepEqual(after, original);
        await staged.cleanup();
      } finally { await fsp.rm(dir, { recursive: true, force: true }); }
    });
  }
});

test("startup recovery restores prepared targets and records rolled_back", async () => {
  const { dir, roots } = await fixture();
  try {
    const journal = createDiscrepancyTransactionJournal(path.join(dir, "manifest.json"));
    const target = path.join(dir, "team", "database.md");
    const backup = `${target}.bak`;
    const staged = `${target}.new`;
    const original = await fsp.readFile(target, "utf8");
    await fsp.writeFile(backup, original);
    await fsp.writeFile(staged, document("new"));
    await fsp.writeFile(target, document("partially replaced"));
    await journal.append({ id: "tx-incomplete", state: "prepared", targets: [{ path: target, backup, staged }] });
    assert.deepEqual(await journal.recover([...roots.values()].map((entry) => entry.root)), ["tx-incomplete"]);
    assert.equal(await fsp.readFile(target, "utf8"), original);
    assert.equal((await journal.list()).at(-1).state, "rolled_back");
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test("startup recovery preserves a write confirmed by the committed decision log", async () => {
  const { dir, roots } = await fixture();
  try {
    const journal = createDiscrepancyTransactionJournal(path.join(dir, "manifest.json"));
    const target = path.join(dir, "team", "database.md");
    const backup = `${target}.bak`;
    const staged = `${target}.new`;
    await fsp.writeFile(backup, document("original"));
    await fsp.writeFile(staged, document("stale staged bytes"));
    await fsp.writeFile(target, document("committed"));
    await journal.append({ id: "tx-confirmed", state: "prepared", targets: [{ path: target, backup, staged }] });

    assert.deepEqual(await journal.recover([...roots.values()].map((entry) => entry.root), ["tx-confirmed"]), []);
    assert.equal(await fsp.readFile(target, "utf8"), document("committed"));
    await assert.rejects(fsp.stat(staged), { code: "ENOENT" });
    await assert.rejects(fsp.stat(backup), { code: "ENOENT" });
    assert.equal((await journal.list()).at(-1).state, "committed");
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test("stageSectionTransaction commit writes exactly the new content, no fragment of old content (F10)", async () => {
  const { dir, roots } = await fixture();
  try {
    const staged = await stageSectionTransaction(JSON.stringify({
      conceptId: "database", sectionKey: "choice", layers: ["team", "company"],
      content: "Use SQLite for embedded deployments.", expectedContent: { team: "Postgres", company: "MySQL" }, requireAll: true,
    }), roots, "tx-happy-path");
    await staged.commit();
    await staged.cleanup();
    for (const { root } of roots.values()) {
      const text = await fsp.readFile(path.join(root, "database.md"), "utf8");
      assert.match(text, /## Choice \{#choice\}\n\nUse SQLite for embedded deployments\.\n/);
      assert.doesNotMatch(text, /Postgres/);
      assert.doesNotMatch(text, /MySQL/);
    }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test("compose on a scalar frontmatter field replaces cleanly on disk", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-discrepancy-fm-"));
  try {
    const roots = new Map();
    for (const [name, owner] of [["team", "Platform"], ["company", "Architecture"]]) {
      const root = path.join(dir, name);
      await fsp.mkdir(root);
      await fsp.writeFile(
        path.join(root, "governed.md"),
        `---\ntype: decision\ntitle: Governed\nowner: ${owner}\n---\n\n# Governed\n\n## Pick {#pick}\n\nsame everywhere\n`,
      );
      roots.set(name, { root, kind: "okf-local" });
    }
    const staged = await stageFrontmatterTransaction(JSON.stringify({
      conceptId: "governed", key: "owner", layers: ["team", "company"], value: "Composed Owner",
      expectedValues: { team: "Platform", company: "Architecture" },
    }), roots, "tx-compose-scalar");
    await staged.commit();
    await staged.cleanup();
    for (const name of ["team", "company"]) {
      const text = await fsp.readFile(path.join(dir, name, "governed.md"), "utf8");
      assert.equal(text, `---\ntype: decision\ntitle: Governed\nowner: "Composed Owner"\n---\n\n# Governed\n\n## Pick {#pick}\n\nsame everywhere\n`);
    }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test("stageFrontmatterTransaction/replaceFrontmatterValue round-trip an array value without downgrading its type", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-discrepancy-array-rt-"));
  try {
    const root = path.join(dir, "team");
    await fsp.mkdir(root);
    await fsp.writeFile(path.join(root, "governed.md"), "---\ntype: decision\ntitle: Governed\ntags: [a, b]\n---\n\n# Governed\n\n## Pick {#pick}\n\nx\n");
    const roots = new Map([["team", { root, kind: "okf-local" }]]);
    const staged = await stageFrontmatterTransaction(JSON.stringify({
      conceptId: "governed", key: "tags", layers: ["team"], value: ["x", "y", "z"],
      expectedValues: { team: ["a", "b"] },
    }), roots, "tx-array-rt");
    await staged.commit();
    await staged.cleanup();
    const text = await fsp.readFile(path.join(root, "governed.md"), "utf8");
    assert.match(text, /^tags: \["x", "y", "z"\]$/m);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test("applyDiscrepancyDecision refuses compose on an array-typed frontmatter field with a 400 (F11)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-discrepancy-array-guard-"));
  let svc = null;
  let server = null;
  try {
    const teamDir = path.join(dir, "team");
    const companyDir = path.join(dir, "company");
    await fsp.mkdir(teamDir);
    await fsp.mkdir(companyDir);
    const doc = (tags) => `---\ntype: decision\ntitle: Governed\ntags: [${tags.join(", ")}]\n---\n\n# Governed\n\n## Pick {#pick}\n\nsame everywhere\n`;
    await fsp.writeFile(path.join(teamDir, "governed.md"), doc(["a", "b"]));
    await fsp.writeFile(path.join(companyDir, "governed.md"), doc(["c", "d"]));
    const manifestPath = path.join(dir, "manifest.json");
    await fsp.writeFile(manifestPath, JSON.stringify({
      layers: [
        { name: "team", level: 2, path: teamDir },
        { name: "company", level: 0, path: companyDir },
      ],
    }));
    svc = createEngineService({ manifestPath, token: null });
    server = http.createServer(async (req, res) => {
      if (await svc.handleRequest(req, res)) return;
      res.writeHead(404); res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const dset = await (await fetch(`${base}/api/discrepancies?wait=15000`)).json();
    const disc = dset.discrepancies.find((item) => item.originalKind === "frontmatter_value" && item.conceptId === "governed");
    assert.ok(disc, "expected a frontmatter_value discrepancy over the tags field");

    const res = await fetch(`${base}/api/discrepancy-decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ discrepancyId: disc.id, revision: disc.revision, action: "compose", content: "merged" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /list/i);

    // The refusal must be a pure guard: nothing written, files untouched.
    const teamText = await fsp.readFile(path.join(teamDir, "governed.md"), "utf8");
    assert.match(teamText, /tags: \[a, b\]/);
  } finally {
    svc?.close();
    server?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---- create-mode staging: the transaction behind "create the missing concept" ----

test("stageFileCreationTransaction creates exclusively, into a new subfolder, and rolls back by unlink", async () => {
  const { dir, roots } = await fixture();
  try {
    const teamRoot = roots.get("team").root;
    // Targets come back realpath'd (assertInsideRoot); the temp root itself
    // sits behind a symlink on macOS, so compare against its real path.
    const realTeamRoot = await fsp.realpath(teamRoot);
    const text = "---\ntype: note\ntitle: Deploy\n---\n\n# Deploy\n\nstub.\n";
    // A probe answers the would-be target and stages nothing.
    const probed = await stageFileCreationTransaction({ layer: "team", rel: "guides/deploy.md", text }, roots, "tx-probe", { probe: true });
    assert.equal(probed.probe, true);
    assert.deepEqual(probed.targets.map((t) => [t.layer, path.relative(realTeamRoot, t.path), t.staged, t.backup, t.created]), [["team", "guides/deploy.md", null, null, true]]);
    await assert.rejects(fsp.stat(path.join(teamRoot, "guides")), { code: "ENOENT" }, "a probe creates no folder");
    await assert.rejects(probed.commit(), /probed transaction/);

    // Staged: the parent folder exists, the staged file exists, the target does not, no backup.
    const staged = await stageFileCreationTransaction({ layer: "team", rel: "guides/deploy.md", text }, roots, "tx-create");
    const [target] = staged.targets;
    assert.equal(target.created, true);
    assert.equal(target.backup, null);
    assert.equal(path.relative(realTeamRoot, target.path), "guides/deploy.md");
    assert.equal(await fsp.readFile(target.staged, "utf8"), text);
    await assert.rejects(fsp.stat(target.path), { code: "ENOENT" }, "not placed until commit");
    // Rolling back an uncommitted create is a no-op on the target and never throws.
    await staged.rollback();
    await assert.rejects(fsp.stat(target.path), { code: "ENOENT" });
    // Commit places it; cleanup drops the staged copy; the bytes are exact.
    assert.deepEqual(await staged.commit(), ["team"]);
    await staged.cleanup();
    assert.equal(await fsp.readFile(target.path, "utf8"), text);
    await assert.rejects(fsp.stat(target.staged), { code: "ENOENT" });
    // Rollback AFTER commit unlinks what this transaction placed.
    await staged.rollback();
    await assert.rejects(fsp.stat(target.path), { code: "ENOENT" }, "rollback removed the created file");

    // Existing files are refused at stage time; so is a path that escapes the root.
    await fsp.writeFile(path.join(teamRoot, "existing.md"), "# Existing\n");
    await assert.rejects(stageFileCreationTransaction({ layer: "team", rel: "existing.md", text }, roots, "tx-exists"), { status: 409 });
    await assert.rejects(stageFileCreationTransaction({ layer: "team", rel: "../escape.md", text }, roots, "tx-escape"), { status: 403 });
    await assert.rejects(stageFileCreationTransaction({ layer: "nope", rel: "x.md", text }, roots, "tx-layer"), { status: 404 });
    await assert.rejects(stageFileCreationTransaction({ layer: "team", rel: "bin.png", text }, roots, "tx-ext"), { status: 415 });
    await assert.rejects(fsp.stat(path.join(dir, "escape.md")), { code: "ENOENT" });
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test("a created target that appears before commit is never overwritten, and a mixed write set restores as one", async () => {
  const { dir, roots } = await fixture();
  try {
    const teamRoot = roots.get("team").root;
    const stubText = "# Stub\n";
    const staged = await stageFileCreationTransaction({ layer: "team", rel: "stub.md", text: stubText }, roots, "tx-race");
    // Someone else creates the file between staging and commit.
    await fsp.writeFile(path.join(teamRoot, "stub.md"), "# Theirs\n");
    await assert.rejects(staged.commit(), { code: "EEXIST" });
    await staged.rollback();
    assert.equal(await fsp.readFile(path.join(teamRoot, "stub.md"), "utf8"), "# Theirs\n", "rollback did not remove a file the transaction never placed");
    await staged.cleanup();
    await assert.rejects(fsp.stat(staged.targets[0].staged), { code: "ENOENT" });
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test("startup recovery removes a created target left by a crash and skips its null backup", async () => {
  const { dir, roots } = await fixture();
  try {
    const journal = createDiscrepancyTransactionJournal(path.join(dir, "manifest.json"));
    const teamRoot = roots.get("team").root;
    await fsp.mkdir(path.join(teamRoot, "guides"));
    const target = path.join(teamRoot, "guides", "deploy.md");
    const staged = `${target}.contextcake-tx-crash-0.new`;
    await fsp.writeFile(staged, "# Deploy\n");
    await fsp.writeFile(target, "# Deploy\n"); // placed, then the process died before the decision append
    await journal.append({ id: "tx-crash-create", state: "prepared", targets: [{ path: target, staged, backup: null, created: true }] });
    assert.deepEqual(await journal.recover([...roots.values()].map((entry) => entry.root)), ["tx-crash-create"]);
    await assert.rejects(fsp.stat(target), { code: "ENOENT" }, "the created file was removed");
    await assert.rejects(fsp.stat(staged), { code: "ENOENT" }, "the staged copy was removed");
    assert.equal((await journal.list()).at(-1).state, "rolled_back");
    // A created target the decision log confirms is kept; only the staged copy goes.
    await fsp.writeFile(staged, "# Deploy\n");
    await fsp.writeFile(target, "# Deploy\n");
    await journal.append({ id: "tx-confirmed-create", state: "prepared", targets: [{ path: target, staged, backup: null, created: true }] });
    assert.deepEqual(await journal.recover([...roots.values()].map((entry) => entry.root), ["tx-confirmed-create"]), []);
    assert.equal(await fsp.readFile(target, "utf8"), "# Deploy\n");
    await assert.rejects(fsp.stat(staged), { code: "ENOENT" });
    assert.equal((await journal.list()).at(-1).state, "committed");
    // A created target whose file is already gone recovers cleanly too.
    await journal.append({ id: "tx-crash-gone", state: "prepared", targets: [{ path: path.join(teamRoot, "guides", "never.md"), staged: path.join(teamRoot, "guides", "never.md.new"), backup: null, created: true }] });
    assert.deepEqual(await journal.recover([...roots.values()].map((entry) => entry.root)), ["tx-crash-gone"]);
    // Containment still applies to created targets: a path outside every root is refused.
    await journal.append({ id: "tx-crash-outside", state: "prepared", targets: [{ path: path.join(dir, "outside.md"), staged: path.join(dir, "outside.md.new"), backup: null, created: true }] });
    await assert.rejects(journal.recover([...roots.values()].map((entry) => entry.root)), /Recovery is required for tx-crash-outside/);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test("failed startup recovery records recovery_required and rejects", async () => {
  const { dir, roots } = await fixture();
  try {
    const journal = createDiscrepancyTransactionJournal(path.join(dir, "manifest.json"));
    const target = path.join(dir, "team", "database.md");
    await journal.append({
      id: "tx-broken", state: "prepared",
      targets: [{ path: target, backup: `${target}.missing-backup`, staged: `${target}.missing-stage` }],
    });

    await assert.rejects(
      journal.recover([...roots.values()].map((entry) => entry.root)),
      /Recovery is required for tx-broken/,
    );
    assert.equal((await journal.list()).at(-1).state, "recovery_required");
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
