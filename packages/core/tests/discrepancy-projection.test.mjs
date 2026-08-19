// The projection memo behind /api/discrepancies (control/discrepancies.mjs):
// one build per (corpus, source health, sidecar) change, shared by the list,
// compact, summary, and detail routes and by the decision guard. Two halves:
// the operations against a stubbed corpus (what the memo keys on, and that a
// hit hands back the same objects), then a real in-process service over a
// temp vault (what the routes answer, and that a decision moves the memo).

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDiscrepancyOperations } from "../src/control/discrepancies.mjs";
import { createConflictResolutionLog, createDiscrepancyTransactionJournal } from "../src/conflict-resolutions.mjs";
import { createDiscrepancyRuleStore } from "../src/discrepancy-rules.mjs";
import { createDiscrepancyPriorityStore } from "../src/discrepancy-priorities.mjs";
import { createEngineService } from "../src/service.mjs";

const OKF = (title, choice, extra = "") => `---\ntype: decision\ntitle: ${title}\nowner: Platform\n---\n\n# ${title}\n\n## Choice {#choice}\n\n${choice}${extra}\n`;

// ---- the memo, against a stubbed corpus ----------------------------------------

async function opsFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-projection-ops-"));
  const manifestPath = path.join(dir, "manifest.json");
  await fsp.writeFile(manifestPath, JSON.stringify({ layers: [] }));
  const long = "y".repeat(500);
  const concepts = [{
    id: "decisions/db",
    contributors: [{ layer: "team", level: 2 }, { layer: "company", level: 0 }],
    frontmatter: { title: "Database", type: "decision", owner: "Platform" }, frontmatterConflicts: [],
    sections: [{ key: "choice", heading: "## Choice {#choice}", content: `Use Postgres. ${long} See [[Runbooks/Postgres]] and [[gone/forever]].`,
      sourceLayer: "team", sourceUpdated: "2026-08-01", conflicts: [{ layer: "company", updated: "2026-07-01", content: "Use MySQL." }] }],
  }, { id: "runbooks/postgres", contributors: [{ layer: "team", level: 2 }], frontmatter: { title: "Postgres", type: "runbook" }, frontmatterConflicts: [], sections: [] }];
  const state = { corpusKey: "k1", resolves: 0, corpusCalls: 0, sources: [{ name: "team", status: "ok", error: null }, { name: "company", status: "ok", error: null }], generation: 1 };
  const ops = createDiscrepancyOperations({
    manifestPath,
    fileRoots: () => new Map(),
    selectedLayers: () => [],
    resolutionLog: createConflictResolutionLog(manifestPath),
    transactionJournal: createDiscrepancyTransactionJournal(manifestPath),
    ruleStore: createDiscrepancyRuleStore(manifestPath),
    priorityStore: createDiscrepancyPriorityStore(manifestPath),
    corpus: async () => {
      state.corpusCalls += 1;
      return {
        corpusKey: state.corpusKey,
        status: { generation: state.generation, indexing: false, indexingSources: [], sources: state.sources },
        resolved: async () => { state.resolves += 1; return { concepts, errors: [] }; },
      };
    },
  });
  return { dir, ops, state, cleanup: () => { ops.close(); return fsp.rm(dir, { recursive: true, force: true }); } };
}

test("two projections over unchanged inputs share one build and the same record objects", async () => {
  const { ops, state, cleanup } = await opsFixture();
  try {
    const first = await ops.project();
    const second = await ops.project();
    assert.equal(state.resolves, 1, "the corpus was resolved once");
    assert.equal(state.corpusCalls, 2, "but the key was re-derived on every call");
    assert.equal(first.discrepancies, second.discrepancies);
    assert.equal(first.revision, second.revision);
    assert.equal(first.summary(), second.summary(), "the summary is memoized on the build");
    assert.deepEqual(first.discrepancies.map((item) => item.kind).sort(), ["broken_link", "broken_link", "section_content"]);
    assert.equal(first.byId.get("section_content::decisions/db::choice").status, "needs_review");
    assert.equal(first.conceptIds.has("runbooks/postgres"), true);
  } finally { await cleanup(); }
});

test("the memo misses when the corpus key, a source's health, or the sidecar changes — and never on generation alone", async () => {
  const { ops, state, cleanup } = await opsFixture();
  try {
    const base = await ops.project();
    state.generation = 7;
    const sameContent = await ops.project();
    assert.equal(state.resolves, 1, "generation is not part of the key");
    assert.equal(sameContent.generation, 7, "but the live generation is reported");
    assert.equal(sameContent.revision, base.revision);

    state.corpusKey = "k2";
    const afterCorpus = await ops.project();
    assert.equal(state.resolves, 2);
    assert.notEqual(afterCorpus.revision, base.revision);

    state.sources = [{ name: "team", status: "ok", error: null }, { name: "company", status: "degraded", error: "offline" }];
    const afterHealth = await ops.project();
    assert.equal(state.resolves, 3);
    assert.equal(afterHealth.coverageComplete, false);
    assert.equal(afterHealth.byId.get("section_content::decisions/db::choice").sourceHealth[1].status, "degraded");
    state.sources = [{ name: "team", status: "ok", error: null }, { name: "company", status: "ok", error: null }];
    await ops.project();
    assert.equal(state.resolves, 4);

    // A priority write is a sidecar change: the same corpus re-projects and the
    // new priority is on the record.
    await ops.setPriority("section_content::decisions/db::choice", "high");
    const afterPriority = await ops.project();
    assert.equal(state.resolves, 5);
    assert.equal(afterPriority.byId.get("section_content::decisions/db::choice").priority, "high");
    // An acknowledgement (a decision-log append) likewise.
    const decided = await ops.decide({ discrepancyId: "section_content::decisions/db::choice", revision: afterPriority.byId.get("section_content::decisions/db::choice").revision, action: "acknowledge", reasonCode: "different_scopes" });
    assert.equal(decided.decision.transactionState, "not_required");
    const afterDecision = await ops.project();
    assert.equal(afterDecision.byId.get("section_content::decisions/db::choice").status, "acknowledged");
    assert.equal(afterDecision.byId.get("section_content::decisions/db::choice").history.length, 1);
    // A write the host performs itself is announced through noteWrite.
    const before = state.resolves;
    ops.noteWrite();
    await ops.project();
    assert.equal(state.resolves, before + 1);
  } finally { await cleanup(); }
});

test("query, summary, and detail answer from the same projection with matching projectionRevision", async () => {
  const { ops, cleanup } = await opsFixture();
  try {
    const q = await ops.query(0, { fields: "compact" });
    const s = await ops.summary();
    const d = await ops.detail(0, "section_content::decisions/db::choice");
    assert.equal(q.projectionRevision, s.projectionRevision);
    assert.equal(q.projectionRevision, d.projectionRevision);
    assert.deepEqual(q.summary, s.summary);
    assert.equal(q.total, 3);
    assert.equal(q.filtered, 3);
    assert.equal(q.offset, 0);
    assert.equal(q.limit, null);
    for (const row of q.discrepancies) {
      assert.equal(row.compact, true);
      for (const c of row.contributions) assert.equal(c.value.length <= 240, true);
    }
    assert.equal(d.discrepancy.contributions[0].value.length > 240, true, "detail is the full record");
    assert.equal(Array.isArray(d.discrepancy.history), true);
    assert.equal((await ops.detail(0, "nope")).discrepancy, null);
    // Filters and paging.
    const links = await ops.query(0, { kind: "broken_link", limit: "1", offset: "1" });
    assert.equal(links.filtered, 2);
    assert.equal(links.discrepancies.length, 1);
    assert.equal(links.limit, 1);
    assert.equal(links.offset, 1);
    assert.equal(links.discrepancies[0].compact, undefined, "full fields unless asked");
    assert.equal((await ops.query(0, { limit: "999999" })).limit, 5000, "limit is clamped");
    await assert.rejects(ops.query(0, { limit: "-1" }), { code: "LIMIT_INVALID", status: 400 });
    await assert.rejects(ops.query(0, { offset: "x" }), { code: "OFFSET_INVALID", status: 400 });
    await assert.rejects(ops.query(0, { fields: "tiny" }), { code: "FIELDS_INVALID", status: 400 });
    // The bare list keeps its exact envelope.
    assert.deepEqual(Object.keys(await ops.list()), ["discrepancies", "coverageComplete", "indexing", "indexingSources", "errors", "generation"]);
  } finally { await cleanup(); }
});

// ---- the routes, over a real service ------------------------------------------------

async function serviceFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-projection-svc-"));
  const team = path.join(dir, "team");
  const company = path.join(dir, "company");
  await fsp.mkdir(team);
  await fsp.mkdir(company);
  const long = "The rollout plan names an owner per phase and a rollback trigger tied to the error budget. ".repeat(6);
  await fsp.writeFile(path.join(team, "database.md"), OKF("Database", `Use Postgres. ${long}`, " See [[Runbooks/Postgres]]."));
  await fsp.writeFile(path.join(company, "database.md"), OKF("Database", "Use MySQL."));
  await fsp.mkdir(path.join(team, "runbooks"));
  await fsp.writeFile(path.join(team, "runbooks", "postgres.md"), "---\ntype: runbook\ntitle: Postgres\n---\n\n# Postgres\n\n## Body {#body}\n\nRun it.\n");
  const manifestPath = path.join(dir, "manifest.json");
  await fsp.writeFile(manifestPath, JSON.stringify({ layers: [
    { name: "team", level: 2, path: team },
    { name: "company", level: 0, path: company },
  ] }));
  const svc = createEngineService({ manifestPath, token: null });
  const server = http.createServer(async (req, res) => {
    if (await svc.handleRequest(req, res)) return;
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (route) => { const res = await fetch(`${base}${route}`); return { status: res.status, body: await res.json() }; };
  const post = async (route, body) => {
    const res = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { dir, get, post, cleanup: async () => { svc.close(); server.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test("the routes answer compact rows, a summary, and full detail from one projection; a decision moves it", async () => {
  const { get, post, cleanup } = await serviceFixture();
  try {
    const bare = await get("/api/discrepancies?wait=15000");
    assert.equal(bare.status, 200);
    assert.deepEqual(Object.keys(bare.body), ["discrepancies", "coverageComplete", "indexing", "indexingSources", "errors", "generation"], "bare GET envelope is unchanged");
    assert.equal(bare.body.coverageComplete, true);
    const section = bare.body.discrepancies.find((item) => item.originalKind === "section_content");
    assert.ok(section, "section discrepancy projected");
    assert.equal(section.contributions[0].value.length > 240, true);
    const link = bare.body.discrepancies.find((item) => item.kind === "broken_link");
    assert.equal(link.target, "Runbooks/Postgres");
    assert.equal(link.bestCandidate.id, "runbooks/postgres");
    assert.equal(link.candidates[0].reason, "case");

    const compact = await get("/api/discrepancies?fields=compact&wait=15000");
    const summary = await get("/api/discrepancies/summary?wait=15000");
    assert.equal(compact.status, 200);
    assert.equal(summary.status, 200);
    assert.equal(compact.body.projectionRevision, summary.body.projectionRevision, "same projection");
    assert.deepEqual(compact.body.summary, summary.body.summary);
    assert.equal(compact.body.total, bare.body.discrepancies.length);
    assert.equal(compact.body.filtered, compact.body.total);
    assert.equal(compact.body.summary.byKind.section_content, 1);
    assert.equal(compact.body.summary.byKind.broken_link, 1);
    assert.equal(compact.body.summary.quickWins.brokenLinksWithBestCandidate, 1);
    assert.equal(compact.body.summary.topTargets[0].bestCandidate.id, "runbooks/postgres");
    for (const row of compact.body.discrepancies) {
      assert.equal(row.compact, true);
      assert.equal("history" in row, false);
      for (const c of row.contributions) assert.equal(c.value.length <= 240, true, `${row.id} carries a body over 240 chars`);
    }
    const compactSection = compact.body.discrepancies.find((item) => item.id === section.id);
    assert.equal(compactSection.contributions[0].truncated, true);
    assert.equal(compactSection.historyCount, 0);
    assert.equal(compactSection.revision, section.revision, "revision survives compaction");

    const detail = await get(`/api/discrepancies?id=${encodeURIComponent(section.id)}&wait=15000`);
    assert.equal(detail.status, 200);
    assert.deepEqual(Object.keys(detail.body), ["discrepancy", "generation", "projectionRevision"]);
    assert.equal(detail.body.projectionRevision, summary.body.projectionRevision);
    assert.equal(detail.body.discrepancy.contributions[0].value, section.contributions[0].value);
    assert.deepEqual(detail.body.discrepancy.history, []);
    const missing = await get("/api/discrepancies?id=nope");
    assert.equal(missing.status, 200);
    assert.equal(missing.body.discrepancy, null);

    // Filters ride the same route.
    const filtered = await get("/api/discrepancies?fields=compact&status=actionable&kind=broken_link&wait=15000");
    assert.equal(filtered.body.filtered, 1);
    assert.equal(filtered.body.total, compact.body.total);
    assert.equal(filtered.body.discrepancies[0].kind, "broken_link");
    assert.equal((await get("/api/discrepancies?limit=nope")).status, 400);

    // Acknowledge → the next GET reflects it and the projection revision moved.
    const decided = await post("/api/discrepancy-decisions", { discrepancyId: section.id, revision: section.revision, action: "acknowledge", reasonCode: "different_scopes" });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    const after = await get("/api/discrepancies?fields=compact&wait=15000");
    const afterRow = after.body.discrepancies.find((item) => item.id === section.id);
    assert.equal(afterRow.status, "acknowledged");
    assert.equal(afterRow.historyCount, 1);
    assert.equal(afterRow.latestDecision.action, "acknowledge");
    assert.equal(afterRow.latestDecision.reasonCode, "different_scopes");
    assert.notEqual(after.body.projectionRevision, compact.body.projectionRevision);
    assert.equal(after.body.summary.byStatus.acknowledged, 1);
    const afterSummary = await get("/api/discrepancies/summary");
    assert.equal(afterSummary.body.projectionRevision, after.body.projectionRevision);
    // Full detail carries the appended history.
    const afterDetail = await get(`/api/discrepancies?id=${encodeURIComponent(section.id)}`);
    assert.equal(afterDetail.body.discrepancy.history.length, 1);
    assert.equal(afterDetail.body.discrepancy.history[0].id, decided.body.decision.id);
  } finally { await cleanup(); }
});
