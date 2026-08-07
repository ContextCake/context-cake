import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageSectionTransaction } from "../src/layer-files.mjs";
import { createDiscrepancyTransactionJournal } from "../src/conflict-resolutions.mjs";

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
