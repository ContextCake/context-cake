// Batch decisions (control/discrepancies.mjs decideBatch) and the automatic
// rules job rebuilt on top of them: one lock, one projection, per-item
// transactions, continue-on-error, dry run, one push. The operations run over
// real files (the link actions read and write them) with a stubbed git so the
// live-layer commit and push counts can be asserted exactly, and a corpus the
// fixture rebuilds from disk on every resolve — the same shape the service's
// index would hand over.

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDiscrepancyOperations, BATCH_LIMIT } from "../src/control/discrepancies.mjs";
import { createConflictResolutionLog, createDiscrepancyTransactionJournal } from "../src/conflict-resolutions.mjs";
import { createDiscrepancyRuleStore } from "../src/discrepancy-rules.mjs";
import { createDiscrepancyPriorityStore } from "../src/discrepancy-priorities.mjs";
import { readLayerSection } from "../src/layer-files.mjs";
import { withManifestLockAsync } from "../src/manifest.mjs";
import { parseConcept } from "../src/sources/okf-local.mjs";
import { mergeConcepts } from "../src/resolver.mjs";

const doc = (title, body, type = "decision") => `---\ntype: ${type}\ntitle: ${title}\n---\n\n# ${title}\n\n## Choice {#choice}\n\n${body}\n`;
const note = (title, body) => `---\ntype: note\ntitle: ${title}\n---\n\n# ${title}\n\n## Body {#body}\n\n${body}\n`;

async function walkMd(root, rel = "") {
  const out = [];
  for (const entry of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walkMd(root, next));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push({ id: next.slice(0, -3), text: await fsp.readFile(path.join(root, next), "utf8") });
  }
  return out;
}

// The resolved corpus the projection reads, rebuilt from disk: what the
// service's background index would produce for these two layers.
async function corpusFromDisk(layers) {
  const byId = new Map();
  for (const layer of layers) {
    for (const { id, text } of await walkMd(layer.root)) {
      const parsed = parseConcept(text);
      const list = byId.get(id) ?? [];
      list.push({ layer: layer.name, level: layer.level, updated: parsed.frontmatter.updated ?? null, frontmatter: parsed.frontmatter, sections: parsed.sections });
      byId.set(id, list);
    }
  }
  return [...byId.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, contributors]) => {
    const sorted = [...contributors].sort((a, b) => b.level - a.level);
    const merged = mergeConcepts(sorted);
    return {
      id, contributors: sorted.map((c) => ({ layer: c.layer, level: c.level, updated: c.updated })),
      frontmatter: merged.frontmatter, frontmatterConflicts: merged.frontmatterConflicts ?? [], sections: merged.sections,
    };
  });
}

async function fixture(opsOptions = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-batch-"));
  const team = path.join(dir, "team");
  const company = path.join(dir, "company");
  for (const sub of ["decisions", "runbooks", "notes"]) await fsp.mkdir(path.join(team, sub), { recursive: true });
  await fsp.mkdir(path.join(company, "decisions"), { recursive: true });
  await fsp.writeFile(path.join(team, "decisions", "db.md"), doc("Database", "Use Postgres. See [[Runbooks/Postgres]] and [[old/cache]]."));
  await fsp.writeFile(path.join(team, "decisions", "queue.md"), doc("Queue", "Use SQS."));
  await fsp.writeFile(path.join(company, "decisions", "queue.md"), doc("Queue", "Use RabbitMQ."));
  await fsp.writeFile(path.join(team, "decisions", "search.md"), doc("Search", "Use Elastic."));
  await fsp.writeFile(path.join(company, "decisions", "search.md"), doc("Search", "Use Solr."));
  await fsp.writeFile(path.join(team, "decisions", "cache.md"), doc("Cache", "Use Redis."));
  await fsp.writeFile(path.join(company, "decisions", "cache.md"), doc("Cache", "Use Memcached."));
  await fsp.writeFile(path.join(team, "runbooks", "postgres.md"), doc("Postgres", "Run it.", "runbook"));
  await fsp.writeFile(path.join(team, "runbooks", "cache.md"), doc("Cache runbook", "Flush it.", "runbook"));
  for (const name of ["a", "b", "c"]) await fsp.writeFile(path.join(team, "notes", `${name}.md`), note(`Note ${name}`, `Links [[old/cache]].`));
  await fsp.writeFile(path.join(team, "notes", "d.md"), note("Note d", "Links [[old/gone]]."));

  const manifestPath = path.join(dir, "manifest.json");
  const layers = [
    { name: "team-live", level: 2, path: team, live: true, git: { pullTtlSeconds: 3600, retentionDays: 14, profileName: "Fixture Team" } },
    { name: "company", level: 0, path: company },
  ];
  await fsp.writeFile(manifestPath, JSON.stringify({ layers }));
  const roots = new Map([["team-live", { root: team, kind: "okf-local" }], ["company", { root: company, kind: "okf-local" }]]);
  const gitCalls = { commits: [], pushes: [] };
  const git = {
    commitPathsWithMutation: async (root, paths, message, { mutate }) => { await mutate(); gitCalls.commits.push({ root, paths, message }); return { committed: true }; },
    push: async (root) => { gitCalls.pushes.push(root); return { pushed: true }; },
  };
  const state = { resolves: 0, indexing: false, written: 0 };
  const resolutionLog = createConflictResolutionLog(manifestPath);
  const ruleStore = createDiscrepancyRuleStore(manifestPath);
  const ops = createDiscrepancyOperations({
    manifestPath,
    fileRoots: () => roots,
    selectedLayers: () => layers,
    resolutionLog,
    transactionJournal: createDiscrepancyTransactionJournal(manifestPath),
    ruleStore,
    priorityStore: createDiscrepancyPriorityStore(manifestPath),
    corpus: async () => ({
      corpusKey: "k1",
      status: { generation: 1, indexing: state.indexing, indexingSources: [], sources: [{ name: "team-live", status: "ok", error: null }, { name: "company", status: "ok", error: null }] },
      resolved: async () => { state.resolves += 1; return { concepts: await corpusFromDisk([{ name: "team-live", level: 2, root: team }, { name: "company", level: 0, root: company }]), errors: [] }; },
    }),
    readLiveSection: (args) => readLayerSection(roots, args),
    onWritten: () => { state.written += 1; },
    git,
    ...opsOptions,
  });
  const record = async (predicate) => (await ops.project()).discrepancies.find(predicate);
  const section = (conceptId) => record((item) => item.originalKind === "section_content" && item.conceptId === conceptId && item.status !== "resolved");
  const link = (conceptId, target) => record((item) => item.kind === "broken_link" && item.conceptId === conceptId && item.target === target);
  const read = (layer, rel) => fsp.readFile(path.join(layer === "team-live" ? team : company, rel), "utf8");
  return {
    dir, team, company, manifestPath, roots, ops, state, git, gitCalls, resolutionLog, ruleStore, section, link, read,
    cleanup: async () => { ops.close(); await fsp.rm(dir, { recursive: true, force: true }); },
  };
}

test("a mixed batch: per-item results in order, the good ones committed, one push, counts, suggestions", async () => {
  const f = await fixture();
  try {
    const queue = await f.section("decisions/queue");
    const search = await f.section("decisions/search");
    const cache = await f.section("decisions/cache");
    const db = await f.link("decisions/db", "Runbooks/Postgres");
    assert.ok(queue && search && cache && db, "fixture projected the four records");
    assert.equal(db.bestCandidate.id, "runbooks/postgres");
    const companyBefore = await f.read("company", "decisions/queue.md");
    const out = await f.ops.decideBatch({ decisions: [
      { discrepancyId: queue.id, revision: queue.revision, action: "acknowledge", reasonCode: "different_scopes" },
      { discrepancyId: search.id, revision: search.revision, action: "acknowledge", reasonCode: "different_scopes" },
      { discrepancyId: db.id, revision: db.revision, action: "rewrite_link", newTarget: "runbooks/postgres" },
      { discrepancyId: cache.id, revision: "stale", action: "acknowledge", reasonCode: "other" },
      { discrepancyId: "broken_link::nope::x::y", revision: "whatever", action: "unlink" },
    ] });
    assert.equal(out.ok, false);
    assert.equal(out.applied, 3);
    assert.equal(out.failed, 2);
    assert.equal(out.dryRun, false);
    assert.deepEqual(out.results.map((r) => [r.discrepancyId, r.ok, r.status ?? 200, r.code ?? null]), [
      [queue.id, true, 200, null], [search.id, true, 200, null], [db.id, true, 200, null],
      [cache.id, false, 409, "STALE"], ["broken_link::nope::x::y", false, 409, "NOT_OPEN"],
    ]);
    assert.equal(out.results[0].decision.action, "acknowledge");
    assert.equal(out.results[0].decision.transactionState, "not_required");
    assert.deepEqual(out.results[0].written, []);
    assert.equal(out.results[2].decision.action, "rewrite_link");
    assert.deepEqual(out.results[2].written, ["team-live"]);
    assert.equal(out.results[2].git.committed, true);
    assert.equal(out.results[2].git.pushed, false, "no per-item push");
    assert.match(out.results[3].error, /changed after you opened it/);
    assert.match(out.results[4].error, /no longer open/);
    // The live layer: one commit for the one content change, exactly one push, once told.
    assert.deepEqual(out.git, { layer: "team-live", commits: 1, pushed: true, queued: false });
    assert.equal(f.gitCalls.commits.length, 1);
    assert.deepEqual(f.gitCalls.commits[0].paths, ["decisions/db.md"]);
    assert.equal(f.gitCalls.commits[0].message, "chore(contextcake): resolve broken_link decisions/db#choice (rewrite_link)");
    assert.equal(f.gitCalls.pushes.length, 1, "exactly one push attempt for the whole batch");
    assert.equal(f.state.written, 1, "the host was told once");
    assert.match(await f.read("team-live", "decisions/db.md"), /See \[\[runbooks\/postgres\]\] and \[\[old\/cache\]\]\./);
    assert.equal(await f.read("company", "decisions/queue.md"), companyBefore);
    assert.equal((await f.resolutionLog.list()).length, 3, "three decisions, in the log");
    assert.equal(Array.isArray(out.suggestions), true);
    // The projection moved: the acknowledged rows read as such, the rewritten link is gone.
    const after = await f.ops.project();
    assert.equal(after.byId.get(queue.id).status, "acknowledged");
    assert.equal(after.byId.get(search.id).status, "acknowledged");
    assert.equal(after.byId.get(cache.id).status, "needs_review");
    assert.equal(after.byId.get(db.id).status, "resolved");
  } finally { await f.cleanup(); }
});

test("stopOnError applies up to the first failure and skips the rest; validation failures count too", async () => {
  const f = await fixture();
  try {
    const queue = await f.section("decisions/queue");
    const cache = await f.section("decisions/cache");
    const db = await f.link("decisions/db", "Runbooks/Postgres");
    const before = await f.read("team-live", "decisions/db.md");
    const out = await f.ops.decideBatch({ stopOnError: true, decisions: [
      { discrepancyId: queue.id, revision: queue.revision, action: "acknowledge", reasonCode: "different_scopes" },
      { discrepancyId: cache.id, revision: "stale", action: "acknowledge", reasonCode: "other" },
      { discrepancyId: db.id, revision: db.revision, action: "rewrite_link", newTarget: "runbooks/postgres" },
    ] });
    assert.deepEqual(out.results.map((r) => [r.ok, r.code ?? null]), [[true, null], [false, "STALE"], [false, "SKIPPED"]]);
    assert.equal(out.applied, 1);
    assert.equal(out.failed, 1, "the stale item failed");
    assert.equal(out.notAttempted, 1, "the skipped item was never attempted — it is not a failure");
    assert.equal(out.ok, false);
    assert.match(out.results[2].error, /stopOnError/);
    assert.equal(await f.read("team-live", "decisions/db.md"), before, "the skipped rewrite wrote nothing");
    assert.equal(f.gitCalls.pushes.length, 0);
    assert.equal((await f.resolutionLog.list()).length, 1);
    // A malformed item is a per-item 400, and with stopOnError it stops the rest.
    const bad = await f.ops.decideBatch({ stopOnError: true, decisions: [
      { discrepancyId: db.id, revision: db.revision, action: "teleport" },
      { discrepancyId: db.id, revision: db.revision, action: "rewrite_link", newTarget: "runbooks/postgres" },
    ] });
    assert.deepEqual(bad.results.map((r) => [r.status, r.code]), [[400, "ACTION_INVALID"], [409, "SKIPPED"]]);
    // Without stopOnError the same second item is a DUPLICATE (same id twice), and both fail.
    const dup = await f.ops.decideBatch({ decisions: [
      { discrepancyId: db.id, revision: db.revision, action: "teleport" },
      { discrepancyId: db.id, revision: db.revision, action: "rewrite_link", newTarget: "runbooks/postgres" },
    ] });
    assert.deepEqual(dup.results.map((r) => [r.status, r.code]), [[400, "ACTION_INVALID"], [400, "DUPLICATE"]]);
    assert.equal(await f.read("team-live", "decisions/db.md"), before);
    // Parameter checks that need no disk read run BEFORE anything is applied:
    // with stopOnError, a first item whose rewrite target does not exist stops
    // the batch and the (valid) acknowledgement behind it is never applied.
    const search = await f.section("decisions/search");
    const gone = await f.link("notes/d", "old/gone");
    const logBefore = (await f.resolutionLog.list()).length;
    const early = await f.ops.decideBatch({ stopOnError: true, decisions: [
      { discrepancyId: db.id, revision: db.revision, action: "rewrite_link", newTarget: "runbooks/nowhere" },
      { discrepancyId: search.id, revision: search.revision, action: "acknowledge", reasonCode: "different_scopes" },
    ] });
    assert.deepEqual(early.results.map((r) => [r.status, r.code]), [[409, "LINK_TARGET_MISSING"], [409, "SKIPPED"]]);
    assert.equal((await f.resolutionLog.list()).length, logBefore, "nothing was applied");
    for (const [body, code] of [
      [{ discrepancyId: search.id, revision: search.revision, action: "acknowledge" }, "REASON_REQUIRED"],
      [{ discrepancyId: search.id, revision: search.revision, action: "choose_contribution", selectedSource: "nope" }, "SOURCE_INVALID"],
      [{ discrepancyId: search.id, revision: search.revision, action: "compose" }, "CONTENT_REQUIRED"],
      [{ discrepancyId: search.id, revision: search.revision, action: "rewrite_link", newTarget: "runbooks/postgres" }, "ACTION_INVALID"],
      [{ discrepancyId: db.id, revision: db.revision, action: "choose_contribution", selectedSource: "team-live" }, "BROKEN_LINK_NOT_WRITABLE"],
      [{ discrepancyId: db.id, revision: db.revision, action: "create_stub" }, "LAYER_REQUIRED"],
      [{ discrepancyId: db.id, revision: db.revision, action: "create_stub", layer: "nope" }, "SOURCE_NOT_WRITABLE"],
      [{ discrepancyId: gone.id, revision: gone.revision, action: "create_stub", layer: "team-live", type: "bad type" }, "STUB_TYPE_INVALID"],
      // `Runbooks/Postgres` would land in the existing `runbooks/` on a
      // case-insensitive filesystem — a different concept than the link names.
      ...(await fsp.stat(path.join(f.team, "RUNBOOKS")).then(() => true, () => false)
        ? [[{ discrepancyId: db.id, revision: db.revision, action: "create_stub", layer: "team-live" }, "TARGET_CASE_CONFLICT"]] : []),
      [{ discrepancyId: db.id, revision: db.revision, action: "rewrite_link", newTarget: "../x" }, "NEW_TARGET_INVALID"],
    ]) {
      const res = await f.ops.decideBatch({ decisions: [body] });
      assert.equal(res.results[0].code, code, JSON.stringify(res.results[0]));
    }
  } finally { await f.cleanup(); }
});

test("the time budget stops a batch after its first attempt with BATCH_TIME_BUDGET (not attempted, not failed); dry runs are exempt", async () => {
  const f = await fixture({ batchTimeBudgetMs: 0 });
  try {
    const queue = await f.section("decisions/queue");
    const search = await f.section("decisions/search");
    const cache = await f.section("decisions/cache");
    const decisions = [queue, search, cache].map((item) => ({ discrepancyId: item.id, revision: item.revision, action: "acknowledge", reasonCode: "different_scopes" }));
    const dry = await f.ops.decideBatch({ dryRun: true, decisions });
    assert.equal(dry.applied, 3, "a dry run is not budgeted");
    const out = await f.ops.decideBatch({ decisions });
    assert.deepEqual(out.results.map((r) => [r.ok, r.code ?? null]), [[true, null], [false, "BATCH_TIME_BUDGET"], [false, "BATCH_TIME_BUDGET"]]);
    assert.equal(out.applied, 1, "at least one item is always attempted");
    assert.equal(out.failed, 0);
    assert.equal(out.notAttempted, 2);
    assert.equal(out.ok, false);
    assert.match(out.results[1].error, /Resubmit/);
    assert.equal((await f.resolutionLog.list()).length, 1);
    // Resubmitting the remainder finishes the job.
    const again = await f.ops.decideBatch({ decisions: decisions.slice(1) });
    assert.equal(again.applied, 1);
    assert.equal(again.notAttempted, 1);
  } finally { await f.cleanup(); }
});

test("a rewrite whose link vanished from the live section is LINK_GONE, and an unwritable effective layer is SOURCE_NOT_WRITABLE — nothing written", async () => {
  const f = await fixture();
  try {
    const db = await f.link("decisions/db", "Runbooks/Postgres");
    // The section on disk changed underneath the projection (the fixture's
    // corpus key is fixed, so the projection still shows the link).
    const original = await f.read("team-live", "decisions/db.md");
    await fsp.writeFile(path.join(f.team, "decisions", "db.md"), original.replace("[[Runbooks/Postgres]]", "[[runbooks/postgres]]"));
    const gone = await f.ops.decideBatch({ decisions: [{ discrepancyId: db.id, revision: db.revision, action: "rewrite_link", newTarget: "runbooks/postgres" }] });
    assert.deepEqual(gone.results.map((r) => [r.status, r.code]), [[409, "LINK_GONE"]]);
    assert.match(gone.results[0].error, /no longer in decisions\/db#choice/);
    await fsp.writeFile(path.join(f.team, "decisions", "db.md"), original);
    // The effective layer stops being writable (a remote layer, say).
    const teamRoot = f.roots.get("team-live");
    f.roots.delete("team-live");
    const unwritable = await f.ops.decideBatch({ decisions: [{ discrepancyId: db.id, revision: db.revision, action: "rewrite_link", newTarget: "runbooks/postgres" }] });
    assert.deepEqual(unwritable.results.map((r) => [r.status, r.code]), [[409, "SOURCE_NOT_WRITABLE"]]);
    assert.match(unwritable.results[0].error, /team-live.*not locally writable/);
    f.roots.set("team-live", teamRoot);
    assert.equal(await f.read("team-live", "decisions/db.md"), original);
    assert.deepEqual(await f.resolutionLog.list(), []);
    assert.equal(f.gitCalls.commits.length, 0);
  } finally { await f.cleanup(); }
});

test("dryRun runs every pre-check and lists wouldWrite without touching a file, the log, or git", async () => {
  const f = await fixture();
  try {
    const queue = await f.section("decisions/queue");
    const cache = await f.section("decisions/cache");
    const db = await f.link("decisions/db", "Runbooks/Postgres");
    const gone = await f.link("notes/d", "old/gone");
    const before = await f.read("team-live", "decisions/db.md");
    const out = await f.ops.decideBatch({ dryRun: true, decisions: [
      { discrepancyId: queue.id, revision: queue.revision, action: "acknowledge", reasonCode: "different_scopes" },
      { discrepancyId: db.id, revision: db.revision, action: "rewrite_link", newTarget: "runbooks/postgres" },
      { discrepancyId: gone.id, revision: gone.revision, action: "create_stub", layer: "team-live" },
      { discrepancyId: cache.id, revision: cache.revision, action: "choose_contribution", selectedSource: "team-live" },
      { discrepancyId: cache.id, revision: "stale", action: "acknowledge", reasonCode: "other" },
      { discrepancyId: db.id, revision: db.revision, action: "rewrite_link", newTarget: "runbooks/nowhere" },
    ] });
    assert.equal(out.dryRun, true);
    assert.equal(out.applied, 4);
    assert.equal(out.failed, 2);
    const teamReal = await fsp.realpath(f.team);
    const companyReal = await fsp.realpath(f.company);
    assert.deepEqual(out.results[0], { discrepancyId: queue.id, ok: true, wouldWrite: [] });
    assert.deepEqual(out.results[1].wouldWrite, [{ layer: "team-live", path: path.join(teamReal, "decisions", "db.md") }]);
    assert.deepEqual(out.results[2].wouldWrite, [{ layer: "team-live", path: path.join(teamReal, "old", "gone.md"), created: true }]);
    assert.deepEqual(out.results[3].wouldWrite.map((w) => [w.layer, w.path]).sort(), [["company", path.join(companyReal, "decisions", "cache.md")], ["team-live", path.join(teamReal, "decisions", "cache.md")]]);
    assert.equal(out.results[4].code, "DUPLICATE");
    assert.equal(out.results[5].code, "DUPLICATE");
    // A dry run still names the real refusals per item.
    const refused = await f.ops.decideBatch({ dryRun: true, decisions: [
      { discrepancyId: db.id, revision: db.revision, action: "rewrite_link", newTarget: "runbooks/nowhere" },
      { discrepancyId: cache.id, revision: "stale", action: "acknowledge", reasonCode: "other" },
    ] });
    assert.deepEqual(refused.results.map((r) => [r.status, r.code]), [[409, "LINK_TARGET_MISSING"], [409, "STALE"]]);
    // Nothing happened.
    assert.equal(await f.read("team-live", "decisions/db.md"), before);
    await assert.rejects(fsp.stat(path.join(f.team, "old")), { code: "ENOENT" }, "no folder was created for the probed stub");
    assert.deepEqual(await f.resolutionLog.list(), []);
    assert.equal(f.gitCalls.commits.length + f.gitCalls.pushes.length, 0);
    assert.equal(f.state.written, 0);
    assert.equal(out.git, undefined);
    for (const name of await fsp.readdir(path.join(f.team, "decisions"))) assert.doesNotMatch(name, /contextcake-/);
  } finally { await f.cleanup(); }
});

test("the batch envelope is validated as a whole: size, shape, and settled coverage", async () => {
  const f = await fixture();
  try {
    const item = { discrepancyId: "x", revision: "y", action: "acknowledge", reasonCode: "other" };
    await assert.rejects(f.ops.decideBatch({ decisions: Array.from({ length: BATCH_LIMIT + 1 }, () => item) }), { code: "BATCH_TOO_LARGE", status: 413 });
    assert.equal(BATCH_LIMIT, 500);
    await assert.rejects(f.ops.decideBatch({ decisions: [] }), { code: "DECISIONS_REQUIRED", status: 400 });
    await assert.rejects(f.ops.decideBatch({ decisions: "nope" }), { code: "DECISIONS_REQUIRED", status: 400 });
    await assert.rejects(f.ops.decideBatch(null), { code: "DECISIONS_REQUIRED", status: 400 });
    // A settled projection is required for the whole batch — nothing per item.
    const queue = await f.section("decisions/queue");
    f.state.indexing = true;
    await assert.rejects(f.ops.decideBatch({ decisions: [{ discrepancyId: queue.id, revision: queue.revision, action: "acknowledge", reasonCode: "other" }] }), { code: "COVERAGE_INCOMPLETE", status: 409 });
    f.state.indexing = false;
    assert.deepEqual(await f.resolutionLog.list(), []);
    // A non-object item is a per-item 400 with no id.
    const out = await f.ops.decideBatch({ decisions: ["nope", null] });
    assert.deepEqual(out.results.map((r) => [r.discrepancyId, r.status, r.code]), [[null, 400, "ACTION_INVALID"], [null, 400, "ACTION_INVALID"]]);
  } finally { await f.cleanup(); }
});

test("two rewrites into one section in one batch both land: two commits, one push", async () => {
  const f = await fixture();
  try {
    const first = await f.link("decisions/db", "Runbooks/Postgres");
    const second = await f.link("decisions/db", "old/cache");
    assert.ok(first && second);
    // Two concepts share the basename, so the engine offers both and no best.
    assert.deepEqual(second.candidates.map((c) => c.id).sort(), ["decisions/cache", "runbooks/cache"]);
    assert.equal(second.bestCandidate, null);
    const out = await f.ops.decideBatch({ decisions: [
      { discrepancyId: first.id, revision: first.revision, action: "rewrite_link", newTarget: "runbooks/postgres" },
      { discrepancyId: second.id, revision: second.revision, action: "rewrite_link", newTarget: "runbooks/cache" },
    ] });
    assert.equal(out.ok, true, JSON.stringify(out.results));
    assert.equal(out.applied, 2);
    assert.match(await f.read("team-live", "decisions/db.md"), /See \[\[runbooks\/postgres\]\] and \[\[runbooks\/cache\]\]\./);
    assert.deepEqual(out.git, { layer: "team-live", commits: 2, pushed: true, queued: false });
    assert.equal(f.gitCalls.commits.length, 2);
    assert.equal(f.gitCalls.pushes.length, 1);
    assert.equal(f.state.written, 1);
    const after = await f.ops.project();
    assert.equal(after.discrepancies.filter((item) => item.conceptId === "decisions/db" && item.kind === "broken_link" && item.status !== "resolved").length, 0);
    // The suggestion miner saw two rewrites of the same section pattern; three would suggest a rule.
    assert.equal(out.suggestions.length, 0);
  } finally { await f.cleanup(); }
});

test("automatic rules apply as one batch under one lock: one projection build, every match rewritten, a missing destination blocks with a record", async () => {
  const f = await fixture();
  try {
    await f.ruleStore.create({
      match: { kind: "broken_link", conceptType: "*", key: "*", sources: ["team-live"], target: "old/cache" },
      action: { type: "rewrite_link", newTarget: "runbooks/cache" }, evidenceDecisionIds: [],
    });
    await f.ruleStore.create({
      match: { kind: "broken_link", conceptType: "note", key: "body", sources: ["team-live"], target: "old/gone" },
      action: { type: "rewrite_link", newTarget: "runbooks/nowhere" }, evidenceDecisionIds: [],
    });
    const rules = await f.ruleStore.list();
    for (const rule of rules) await f.ruleStore.patch(rule.id, { mode: "automatic" });
    const before = await f.ops.project();
    const eligible = before.discrepancies.filter((item) => item.status === "auto_ready");
    assert.equal(eligible.length, 5, "four old/cache links and one old/gone link are auto_ready");
    const resolvesBefore = f.state.resolves;
    await f.ops.runAutomaticRules();
    assert.equal(f.state.resolves, resolvesBefore, "the run answered from the projection already built (one build, shared by the job and its batch)");
    // Every old/cache link was rewritten, in one pass, with one push.
    for (const name of ["a", "b", "c"]) assert.match(await f.read("team-live", `notes/${name}.md`), /Links \[\[runbooks\/cache\]\]\./);
    assert.match(await f.read("team-live", "decisions/db.md"), /and \[\[runbooks\/cache\]\]\./);
    assert.equal(f.gitCalls.commits.length, 4);
    assert.equal(f.gitCalls.pushes.length, 1, "one push for the whole automatic pass");
    assert.equal(f.state.written, 1);
    const log = await f.resolutionLog.list();
    const applied = log.filter((row) => row.transactionState === "committed");
    assert.equal(applied.length, 4);
    for (const row of applied) {
      assert.equal(row.method, "automatic");
      assert.equal(row.action, "rewrite_link");
      assert.equal(row.newTarget, "runbooks/cache");
      assert.equal(row.ruleId, rules[0].id);
    }
    // The rule whose destination does not exist blocked — recorded, never a silent acknowledgement.
    const blocked = log.filter((row) => row.transactionState === "blocked");
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].method, "automatic");
    assert.equal(blocked[0].ruleId, rules[1].id);
    assert.match(blocked[0].reason, /does not exist in the selected sources/);
    assert.match(await f.read("team-live", "notes/d.md"), /\[\[old\/gone\]\]/, "the blocked link is untouched");
    assert.equal(log.some((row) => row.action === "acknowledge"), false);
    // A second run has nothing left to do: the blocked revision is not retried, the others are resolved.
    const commitsBefore = f.gitCalls.commits.length;
    await f.ops.runAutomaticRules();
    assert.equal(f.gitCalls.commits.length, commitsBefore);
    assert.equal((await f.resolutionLog.list()).length, log.length);
    const after = await f.ops.project();
    assert.equal(after.discrepancies.filter((item) => item.kind === "broken_link" && item.target === "old/cache" && item.status !== "resolved").length, 0);
    // The blocked link is still open (its rule still matches, so it still reads
    // auto_ready) and its history carries the blocked attempt — which is what
    // keeps the job from retrying that revision.
    const stillOpen = after.byId.get(eligible.find((item) => item.target === "old/gone").id);
    assert.equal(stillOpen.status, "auto_ready");
    assert.equal(stillOpen.history.at(-1).transactionState, "blocked");
  } finally { await f.cleanup(); }
});

test("an automatic item is re-checked under the lock: a rule disabled while the job waited for the lock is not applied", async () => {
  const f = await fixture();
  try {
    const rule = await f.ruleStore.create({
      match: { kind: "broken_link", conceptType: "*", key: "*", sources: ["team-live"], target: "old/cache" },
      action: { type: "acknowledge", reasonCode: "target_missing" }, evidenceDecisionIds: [],
    });
    await f.ruleStore.patch(rule.id, { mode: "automatic" });
    // Hold the manifest lock while the job plans from the current projection
    // (four auto_ready links), disable the rule while it waits, then release:
    // the batch re-projects under the lock, the guard sees no automatic rule
    // on any item, and every item is declined silently — nothing recorded.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let lockTaken;
    const lockHeld = new Promise((resolve) => { lockTaken = resolve; });
    const holder = withManifestLockAsync(f.manifestPath, async () => { lockTaken(); await held; });
    await lockHeld;
    const resolvesBefore = f.state.resolves;
    const job = f.ops.runAutomaticRules();
    // Wait until the job has built its plan (one projection) and is parked on the lock.
    for (let i = 0; i < 200 && f.state.resolves === resolvesBefore; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.state.resolves, resolvesBefore + 1, "the job planned from one projection");
    await new Promise((r) => setTimeout(r, 60));
    await f.ruleStore.patch(rule.id, { enabled: false });
    f.ops.noteWrite();
    release();
    await holder;
    await job;
    assert.deepEqual(await f.resolutionLog.list(), [], "nothing applied, nothing recorded");
    assert.equal(f.state.resolves, resolvesBefore + 2, "the batch re-projected under the lock (the sidecar changed)");
    // Re-enable: the acknowledgements land, four in one pass, no writes, no push.
    await f.ruleStore.patch(rule.id, { enabled: true });
    f.ops.noteWrite();
    await f.ops.runAutomaticRules();
    const log = await f.resolutionLog.list();
    assert.equal(log.length, 4);
    assert.equal(log.every((row) => row.action === "acknowledge" && row.method === "automatic" && row.transactionState === "not_required"), true);
    assert.equal(f.gitCalls.pushes.length, 0);
    assert.equal(f.state.written, 0);
    // A pass that lands mid-index while the job waits is quiet: COVERAGE_INCOMPLETE is swallowed.
    f.state.indexing = true;
    f.ops.noteWrite();
    await f.ops.runAutomaticRules();
    f.state.indexing = false;
    assert.equal((await f.resolutionLog.list()).length, 4);
  } finally { await f.cleanup(); }
});

test("the live-layer push runs after the manifest lock is released: a concurrent priority write completes while the push is pending", async () => {
  const f = await fixture();
  try {
    // A push that does not return until the test says so.
    let releasePush;
    let pushStarted;
    const pushGate = new Promise((resolve) => { releasePush = resolve; });
    const pushBegun = new Promise((resolve) => { pushStarted = resolve; });
    f.git.push = async (root) => { f.gitCalls.pushes.push(root); pushStarted(); await pushGate; return { pushed: true }; };
    const db = await f.link("decisions/db", "Runbooks/Postgres");
    const deciding = f.ops.decide({ discrepancyId: db.id, revision: db.revision, action: "rewrite_link", newTarget: "runbooks/postgres" });
    await pushBegun;
    // The push is in flight; the manifest lock must already be free.
    const priority = await Promise.race([
      f.ops.setPriority(db.id, "high").then(() => "priority-done"),
      new Promise((resolve) => setTimeout(() => resolve("priority-timed-out"), 3000)),
    ]);
    assert.equal(priority, "priority-done", "a lock-taking write completed while the push was pending — the push is not under the manifest lock");
    releasePush();
    const out = await deciding;
    assert.equal(out.ok, true);
    assert.deepEqual(out.git, { layer: "team-live", paths: ["decisions/db.md"], committed: true, pushed: true, queued: false }, "the marker is consumed and the push result merged");
    assert.equal(f.gitCalls.pushes.length, 1);
    // The batch takes the same path: its summary carries no marker either.
    const second = await f.link("decisions/db", "old/cache");
    f.git.push = async (root) => { f.gitCalls.pushes.push(root); return { pushed: true }; };
    const batch = await f.ops.decideBatch({ decisions: [{ discrepancyId: second.id, revision: second.revision, action: "rewrite_link", newTarget: "runbooks/cache" }] });
    assert.deepEqual(batch.git, { layer: "team-live", commits: 1, pushed: true, queued: false });
    assert.equal(batch.results[0].git.pushed, false, "per-item entries never push on their own");
    assert.equal("pushRoot" in batch.results[0].git, false);
    assert.equal(f.gitCalls.pushes.length, 2);
  } finally { await f.cleanup(); }
});

test("startup recovery restores a live-layer target INSIDE the repo lock and commits the restore in the same mutation", async () => {
  const f = await fixture();
  try {
    const target = path.join(await fsp.realpath(f.team), "decisions", "queue.md");
    const original = await fsp.readFile(target, "utf8");
    const backup = `${target}.contextcake-tx-crash-0.bak`;
    const staged = `${target}.contextcake-tx-crash-0.new`;
    await fsp.writeFile(backup, original);
    await fsp.writeFile(staged, doc("Queue", "crashed write"));
    await fsp.writeFile(target, doc("Queue", "crashed write"));
    const journal = createDiscrepancyTransactionJournal(f.manifestPath);
    await journal.append({ id: "tx-crash-live", state: "prepared", preparedAt: "2026-01-01T00:00:00.000Z", targets: [{ path: target, staged, backup }] });
    // The stub git observes the bytes when the locked mutation starts and ends.
    let bytesAtMutateStart = null;
    let bytesAfterMutate = null;
    f.git.commitPathsWithMutation = async (root, paths, message, { mutate }) => {
      bytesAtMutateStart = await fsp.readFile(target, "utf8");
      await mutate();
      bytesAfterMutate = await fsp.readFile(target, "utf8");
      f.gitCalls.commits.push({ root, paths, message });
      return { committed: true };
    };
    await f.ops.ensureRecovery();
    assert.match(bytesAtMutateStart, /crashed write/, "the restore had NOT happened before the locked mutation began");
    assert.equal(bytesAfterMutate, original, "the restore happened inside the locked mutation");
    assert.equal(await fsp.readFile(target, "utf8"), original);
    assert.deepEqual(f.gitCalls.commits.map((c) => [c.paths, c.message]), [[["decisions/queue.md"], "chore(contextcake): roll back uncommitted discrepancy transaction tx-crash-live"]]);
    await assert.rejects(fsp.stat(staged), { code: "ENOENT" });
    await assert.rejects(fsp.stat(backup), { code: "ENOENT" });
    assert.equal((await journal.list()).at(-1).state, "rolled_back");
  } finally { await f.cleanup(); }
});

test("a blocked row rebuilt from the log alone is NOT_OPEN, like a resolved one", async () => {
  const f = await fixture();
  try {
    // A failed automatic attempt against a discrepancy that no longer exists:
    // the projection rebuilds it as a `blocked` row from the record.
    await f.resolutionLog.append({
      schemaVersion: 2, id: "auto-blocked", discrepancyId: "broken_link::decisions/retired::choice::old/thing",
      discrepancyKind: "broken_link", conceptId: "decisions/retired", title: "Retired", conceptType: "decision",
      sectionKey: "choice", linkTarget: "old/thing", revision: "rev-1", action: "rewrite_link", method: "automatic",
      transactionState: "blocked", reason: "boom", decidedAt: "2026-08-01T00:00:00.000Z",
      contributions: [{ layer: "team-live", level: 2, content: "old/thing", updated: null }],
    });
    f.ops.noteWrite();
    const row = (await f.ops.project()).byId.get("broken_link::decisions/retired::choice::old/thing");
    assert.equal(row?.status, "blocked");
    const out = await f.ops.decideBatch({ decisions: [{ discrepancyId: row.id, revision: row.revision, action: "acknowledge", reasonCode: "target_missing" }] });
    assert.deepEqual(out.results.map((r) => [r.status, r.code]), [[409, "NOT_OPEN"]]);
    await assert.rejects(f.ops.decide({ discrepancyId: row.id, revision: row.revision, action: "acknowledge", reasonCode: "target_missing" }), { code: "NOT_OPEN", status: 409 });
    assert.equal((await f.resolutionLog.list()).length, 1, "nothing appended");
  } finally { await f.cleanup(); }
});
