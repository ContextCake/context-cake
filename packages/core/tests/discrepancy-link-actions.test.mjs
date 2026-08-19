// The broken-link fix actions — rewrite_link, unlink, create_stub — over a
// real in-process service (control/discrepancies.mjs applyLinkDecision, the
// create-mode staging in layer-files.mjs, and the recovery of a created
// target in conflict-resolutions.mjs). Two layers: `team` (effective) and
// `company` (a dissenting copy of one section) so the tests can show that a
// rewrite touches exactly the effective contributor's file and nothing else.

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEngineService } from "../src/service.mjs";

const SETUP_TEAM = [
  "---", "type: guide", "title: Setup", "owner: Platform", "---", "", "# Setup", "",
  "## Steps {#steps}", "",
  "First read [[Guides/Deploy]] and [Postgres](old/postgres.md), then [[runbooks/gone|the old runbook]].", "",
  "## Notes {#notes}", "",
  "Also see [[Guides/Deploy#anchor]] for details.", "",
].join("\n");
const SETUP_COMPANY = SETUP_TEAM.replace("First read", "Company copy: first read");
const DB_TEAM = "---\ntype: decision\ntitle: Database\n---\n\n# Database\n\n## Choice {#choice}\n\nPostgres. Policy in [[decisions/queue-policy]]; playbook in [[playbooks/incident]]; never [[../outside]].\n";
const doc = (title, type = "note") => `---\ntype: ${type}\ntitle: ${title}\n---\n\n# ${title}\n\n## Body {#body}\n\n${title}.\n`;

async function fixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-link-actions-"));
  const team = path.join(dir, "team");
  const company = path.join(dir, "company");
  await fsp.mkdir(path.join(team, "guides"), { recursive: true });
  await fsp.mkdir(path.join(team, "runbooks"), { recursive: true });
  await fsp.mkdir(path.join(team, "decisions"), { recursive: true });
  await fsp.mkdir(path.join(company, "guides"), { recursive: true });
  await fsp.writeFile(path.join(team, "guides", "setup.md"), SETUP_TEAM);
  await fsp.writeFile(path.join(company, "guides", "setup.md"), SETUP_COMPANY);
  await fsp.writeFile(path.join(team, "guides", "deploy.md"), doc("Deploy", "guide"));
  await fsp.writeFile(path.join(team, "runbooks", "postgres.md"), doc("Postgres", "runbook"));
  await fsp.writeFile(path.join(team, "decisions", "db.md"), DB_TEAM);
  const manifestPath = path.join(dir, "manifest.json");
  await fsp.writeFile(manifestPath, JSON.stringify({ layers: [
    { name: "team", level: 2, path: team },
    { name: "company", level: 0, path: company },
  ] }));
  const host = await start(manifestPath);
  return {
    dir, team, company, manifestPath, ...host,
    cleanup: async () => { await host.stop(); await fsp.rm(dir, { recursive: true, force: true }); },
  };
}

async function start(manifestPath) {
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
  const stop = () => new Promise((resolve) => { svc.close(); server.close(() => resolve()); });
  return { svc, get, post, stop };
}

// The open broken_link record for (conceptId, sectionKey, target), from a settled projection.
async function link(get, conceptId, key, target) {
  const set = await get("/api/discrepancies?wait=15000");
  assert.equal(set.body.coverageComplete, true, "coverage settled");
  return set.body.discrepancies.find((item) => item.kind === "broken_link" && item.conceptId === conceptId && item.key === key && item.target === target) ?? null;
}
const decide = (post, body) => post("/api/discrepancy-decisions", body);

test("rewrite_link rewrites the effective contributor's section only, records the decision, and the link resolves after the refresh", async () => {
  const f = await fixture();
  try {
    const teamBefore = await fsp.readFile(path.join(f.team, "guides", "setup.md"), "utf8");
    const companyBefore = await fsp.readFile(path.join(f.company, "guides", "setup.md"), "utf8");
    const steps = await link(f.get, "guides/setup", "steps", "Guides/Deploy");
    assert.ok(steps, "the case-slipped link is a broken_link on the effective (team) section");
    assert.equal(steps.effectiveSource, "team");
    assert.equal(steps.bestCandidate?.id, "guides/deploy");
    assert.equal(steps.candidates[0].reason, "case");

    const out = await decide(f.post, { discrepancyId: steps.id, revision: steps.revision, action: "rewrite_link", newTarget: steps.bestCandidate.id });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.ok, true);
    assert.deepEqual(out.body.written, ["team"]);
    const d = out.body.decision;
    assert.equal(d.action, "rewrite_link");
    assert.equal(d.discrepancyKind, "broken_link");
    assert.equal(d.sectionKey, "steps");
    assert.equal(d.linkTarget, "Guides/Deploy");
    assert.equal(d.newTarget, "guides/deploy");
    assert.deepEqual(d.ruleAction, { type: "rewrite_link", newTarget: "guides/deploy" });
    assert.equal(d.reason, "You pointed the link at guides/deploy.");
    assert.equal(d.transactionState, "committed");
    assert.equal(d.method, "manual");
    assert.deepEqual(d.learningPattern, { kind: "broken_link", conceptType: "guide", key: "steps", sources: ["team"], target: "Guides/Deploy" });
    assert.equal(d.writtenTargets.length, 1);
    assert.equal(d.writtenTargets[0].layer, "team");
    assert.equal(d.chosen, null);

    // Only the effective file changed, and only that link in that section.
    const teamAfter = await fsp.readFile(path.join(f.team, "guides", "setup.md"), "utf8");
    assert.notEqual(teamAfter, teamBefore);
    assert.match(teamAfter, /First read \[\[guides\/deploy\]\] and \[Postgres\]\(old\/postgres\.md\), then \[\[runbooks\/gone\|the old runbook\]\]\./);
    assert.match(teamAfter, /Also see \[\[Guides\/Deploy#anchor\]\] for details\./, "the other section's link is untouched");
    assert.equal(await fsp.readFile(path.join(f.company, "guides", "setup.md"), "utf8"), companyBefore, "the dissenting copy is byte-identical");
    for (const name of await fsp.readdir(path.join(f.team, "guides"))) assert.doesNotMatch(name, /contextcake-/, "no staged/backup leftovers");

    // After the refresh the record is gone, a resolved row remains, and the notes-section link is still open.
    const after = await f.get("/api/discrepancies?fields=compact&wait=15000");
    assert.equal(after.body.coverageComplete, true);
    assert.equal(after.body.discrepancies.some((item) => item.id === steps.id && item.status !== "resolved"), false, "the open record is gone");
    const resolved = after.body.discrepancies.find((item) => item.id === steps.id);
    assert.ok(resolved, "a resolved row keeps the audit trail");
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.target, "Guides/Deploy");
    assert.equal(resolved.effectiveValue, "guides/deploy");
    assert.equal(resolved.latestDecision.action, "rewrite_link");
    assert.ok(await link(f.get, "guides/setup", "notes", "Guides/Deploy"), "the notes-section link is a separate, still-open record");
    assert.equal(after.body.summary.topTargets.find((row) => row.target === "Guides/Deploy").count, 2);
  } finally { await f.cleanup(); }
});

test("sequential rewrites into one section both succeed; a rewrite to a missing or invalid target changes no bytes", async () => {
  const f = await fixture();
  try {
    const setupPath = path.join(f.team, "guides", "setup.md");
    const first = await link(f.get, "guides/setup", "steps", "Guides/Deploy");
    const second = await link(f.get, "guides/setup", "steps", "old/postgres");
    assert.ok(first && second);
    assert.equal(second.bestCandidate?.id, "runbooks/postgres");
    assert.equal(second.bestCandidate.reason, "moved");

    // Refusals first: nothing changes on disk.
    const before = await fsp.readFile(setupPath, "utf8");
    const missing = await decide(f.post, { discrepancyId: second.id, revision: second.revision, action: "rewrite_link", newTarget: "runbooks/nowhere" });
    assert.equal(missing.status, 409);
    assert.match(missing.body.error, /does not exist in the selected sources/);
    const invalid = await decide(f.post, { discrepancyId: second.id, revision: second.revision, action: "rewrite_link", newTarget: "../escape" });
    assert.equal(invalid.status, 400);
    const absent = await decide(f.post, { discrepancyId: second.id, revision: second.revision, action: "rewrite_link" });
    assert.equal(absent.status, 400);
    assert.match(absent.body.error, /newTarget/);
    assert.equal(await fsp.readFile(setupPath, "utf8"), before, "refusals wrote nothing");

    // Two rewrites into the same section, one after the other, WITHOUT reloading
    // between them: the second is decided against the same projection revision
    // (a broken link's revision fingerprints its target, not the section text)
    // and reads the section live, so it sees the first edit.
    const a = await decide(f.post, { discrepancyId: first.id, revision: first.revision, action: "rewrite_link", newTarget: "guides/deploy" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await decide(f.post, { discrepancyId: second.id, revision: second.revision, action: "rewrite_link", newTarget: "runbooks/postgres" });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const text = await fsp.readFile(setupPath, "utf8");
    assert.match(text, /First read \[\[guides\/deploy\]\] and \[Postgres\]\(runbooks\/postgres\.md\), then \[\[runbooks\/gone\|the old runbook\]\]\./, "both rewrites landed; `.md` was preserved");
    // Deciding the same link again is refused: it is no longer open.
    const again = await decide(f.post, { discrepancyId: second.id, revision: second.revision, action: "rewrite_link", newTarget: "runbooks/postgres" });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /no longer|Reload/);
  } finally { await f.cleanup(); }
});

test("unlink turns the link into its alias, and neither unlink nor create_stub is learnable", async () => {
  const f = await fixture();
  try {
    const gone = await link(f.get, "guides/setup", "steps", "runbooks/gone");
    assert.ok(gone);
    assert.deepEqual(gone.candidates, []);
    const out = await decide(f.post, { discrepancyId: gone.id, revision: gone.revision, action: "unlink" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.decision.action, "unlink");
    assert.equal(out.body.decision.ruleAction, null);
    assert.equal(out.body.decision.reason, "You removed the link to runbooks/gone.");
    assert.equal(out.body.decision.linkTarget, "runbooks/gone");
    const text = await fsp.readFile(path.join(f.team, "guides", "setup.md"), "utf8");
    assert.match(text, /then the old runbook\./, "the wikilink alias survives as plain text");
    assert.doesNotMatch(text, /runbooks\/gone/);
    const after = await f.get("/api/discrepancies?wait=15000");
    assert.equal(after.body.discrepancies.some((item) => item.id === gone.id && item.status !== "resolved"), false);
    // No suggestion is ever mined from unlink decisions.
    const rules = await f.get("/api/discrepancy-rules");
    assert.deepEqual(rules.body.suggestions, []);
  } finally { await f.cleanup(); }
});

test("create_stub creates the missing concept exclusively (new subfolder too), refuses an occupied path and a traversal target, and the link resolves after the refresh", async () => {
  const f = await fixture();
  try {
    const policy = await link(f.get, "decisions/db", "choice", "decisions/queue-policy");
    const incident = await link(f.get, "decisions/db", "choice", "playbooks/incident");
    const outside = await link(f.get, "decisions/db", "choice", "../outside");
    assert.ok(policy && incident && outside);

    // A traversal target cannot name a file.
    const bad = await decide(f.post, { discrepancyId: outside.id, revision: outside.revision, action: "create_stub", layer: "team" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /cannot name a concept file/);
    await assert.rejects(fsp.stat(path.join(f.dir, "outside.md")), { code: "ENOENT" });
    // Missing / non-writable layer.
    assert.equal((await decide(f.post, { discrepancyId: policy.id, revision: policy.revision, action: "create_stub" })).status, 400);
    assert.equal((await decide(f.post, { discrepancyId: policy.id, revision: policy.revision, action: "create_stub", layer: "nope" })).status, 409);
    // Something already at the path (a dangling symlink the indexer skips) → 409, nothing written through it.
    const stubPath = path.join(f.team, "decisions", "queue-policy.md");
    await fsp.symlink(path.join(f.dir, "does-not-exist.md"), stubPath);
    const occupied = await decide(f.post, { discrepancyId: policy.id, revision: policy.revision, action: "create_stub", layer: "team" });
    assert.equal(occupied.status, 409, JSON.stringify(occupied.body));
    assert.match(occupied.body.error, /already exists/);
    await fsp.unlink(stubPath);
    await assert.rejects(fsp.stat(path.join(f.dir, "does-not-exist.md")), { code: "ENOENT" });

    // Create it, with a title and type; the file is exclusive and minimal OKF.
    const out = await decide(f.post, { discrepancyId: policy.id, revision: policy.revision, action: "create_stub", layer: "team", title: "Queue policy", type: "decision" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const d = out.body.decision;
    assert.equal(d.action, "create_stub");
    assert.deepEqual(d.createdTargets, [{ layer: "team", conceptId: "decisions/queue-policy", path: "decisions/queue-policy.md" }]);
    assert.equal(d.ruleAction, null);
    assert.equal(d.reason, "You created decisions/queue-policy in team.");
    assert.equal(d.writtenTargets[0].created, true);
    const text = await fsp.readFile(stubPath, "utf8");
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(text, `---\ntype: decision\ntitle: Queue policy\nupdated: ${today}\n---\n\n# Queue policy\n\nCreated from ContextCake to satisfy a link from decisions/db.\n`);
    // A stub in a folder that does not exist yet: the folder is created, the title is humanized, the type defaults to note.
    const out2 = await decide(f.post, { discrepancyId: incident.id, revision: incident.revision, action: "create_stub", layer: "team" });
    assert.equal(out2.status, 200, JSON.stringify(out2.body));
    const text2 = await fsp.readFile(path.join(f.team, "playbooks", "incident.md"), "utf8");
    assert.match(text2, /^---\ntype: note\ntitle: Incident\nupdated: \d{4}-\d{2}-\d{2}\n---\n\n# Incident\n\nCreated from ContextCake to satisfy a link from decisions\/db\.\n$/);
    for (const name of await fsp.readdir(path.join(f.team, "decisions"))) assert.doesNotMatch(name, /contextcake-/);

    // After the refresh both concepts exist, both discrepancies are gone.
    const after = await f.get("/api/discrepancies?wait=15000");
    assert.equal(after.body.coverageComplete, true);
    for (const id of [policy.id, incident.id]) {
      assert.equal(after.body.discrepancies.some((item) => item.id === id && item.status !== "resolved"), false, `${id} still open`);
    }
    const resolved = await f.get("/api/resolve?concept=decisions/queue-policy");
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.frontmatter.title, "Queue policy");
    assert.equal(resolved.body.frontmatter.type, "decision");
    const graph = await f.get("/api/graph?wait=15000");
    assert.equal(graph.body.sources.find((s) => s.name === "team").conceptCount, 6, "two concepts were added to the team layer");
    // Invalid title/type shapes are refused before anything is staged.
    const other = await link(f.get, "decisions/db", "choice", "../outside");
    assert.equal((await decide(f.post, { discrepancyId: other.id, revision: other.revision, action: "create_stub", layer: "team", type: "not valid!" })).status, 400);
  } finally { await f.cleanup(); }
});

test("the kind gate: choose/compose on a broken link is 409 with the exact message; link actions on a section conflict are 400", async () => {
  const f = await fixture();
  try {
    const set = await f.get("/api/discrepancies?wait=15000");
    const broken = set.body.discrepancies.find((item) => item.kind === "broken_link" && item.target === "Guides/Deploy" && item.key === "steps");
    const section = set.body.discrepancies.find((item) => item.originalKind === "section_content" && item.conceptId === "guides/setup");
    assert.ok(broken && section, "fixture projects both kinds");
    const choose = await decide(f.post, { discrepancyId: broken.id, revision: broken.revision, action: "choose_contribution", selectedSource: "team" });
    assert.equal(choose.status, 409);
    assert.equal(choose.body.error, "A broken link has no alternative answer to choose or compose. Rewrite the link, remove it, create the missing concept, or acknowledge.");
    const compose = await decide(f.post, { discrepancyId: broken.id, revision: broken.revision, action: "compose", content: "x" });
    assert.equal(compose.status, 409);
    assert.equal(compose.body.error, choose.body.error);
    for (const body of [
      { action: "rewrite_link", newTarget: "guides/deploy" }, { action: "unlink" }, { action: "create_stub", layer: "team" },
    ]) {
      const res = await decide(f.post, { discrepancyId: section.id, revision: section.revision, ...body });
      assert.equal(res.status, 400, `${body.action} on a section conflict`);
      assert.match(res.body.error, /applies only to a broken link/);
    }
    // Acknowledge still works on a broken link, and unknown actions are still 400.
    assert.equal((await decide(f.post, { discrepancyId: broken.id, revision: broken.revision, action: "acknowledge", reasonCode: "target_missing" })).status, 200);
    assert.equal((await decide(f.post, { discrepancyId: broken.id, revision: broken.revision, action: "delete_link" })).status, 400);
    const team = await fsp.readFile(path.join(f.team, "guides", "setup.md"), "utf8");
    assert.equal(team, SETUP_TEAM, "no refusal touched the file");
  } finally { await f.cleanup(); }
});

test("startup recovery removes a created stub left by a crash before the decision was appended", async () => {
  const f = await fixture();
  try {
    // Simulate: the create-mode transaction placed the file, then the process died
    // before the decision append — the journal says `prepared`, the log has nothing.
    await f.stop();
    const teamReal = await fsp.realpath(f.team);
    const target = path.join(teamReal, "decisions", "queue-policy.md");
    const staged = `${target}.contextcake-tx-crash-0.new`;
    await fsp.writeFile(staged, "# Queue policy\n");
    await fsp.writeFile(target, "# Queue policy\n");
    const journal = path.join(f.dir, ".contextcake", "profiles", "default", "discrepancy-transactions.ndjson");
    await fsp.mkdir(path.dirname(journal), { recursive: true });
    await fsp.appendFile(journal, `${JSON.stringify({ id: "tx-crash", state: "prepared", preparedAt: "2026-01-01T00:00:00.000Z", targets: [{ path: target, staged, backup: null, created: true }] })}\n`);
    const again = await start(f.manifestPath);
    try {
      let lines = [];
      for (let i = 0; i < 100; i += 1) {
        lines = (await fsp.readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        if (lines.some((row) => row.id === "tx-crash" && row.state === "rolled_back")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(lines.some((row) => row.id === "tx-crash" && row.state === "rolled_back"), `journal: ${JSON.stringify(lines)}`);
      await assert.rejects(fsp.stat(target), { code: "ENOENT" }, "the crashed stub was removed");
      await assert.rejects(fsp.stat(staged), { code: "ENOENT" }, "the staged copy was removed");
      // The link is open again and can be decided normally.
      const policy = await link(again.get, "decisions/db", "choice", "decisions/queue-policy");
      assert.ok(policy);
      const out = await again.post("/api/discrepancy-decisions", { discrepancyId: policy.id, revision: policy.revision, action: "create_stub", layer: "team" });
      assert.equal(out.status, 200, JSON.stringify(out.body));
    } finally { await again.stop(); }
  } finally { await f.cleanup(); }
});
