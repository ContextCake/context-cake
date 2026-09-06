import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveConcept } from "../src/resolver.mjs";
import { buildSources } from "../src/sources/index.mjs";
import { sectionEvidence, contextManifestFingerprint, createContextResolutionStore } from "../src/context-resolutions.mjs";
import { createDiscrepancyRuleStore } from "../src/discrepancy-rules.mjs";

test("MCP applies a recorded source-preserving decision; Undo, edits, policies and manifest changes reopen it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cc-overlay-mcp-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  for (const dir of ["personal", "team"]) await mkdir(path.join(root, dir));
  const personalText = "# Database\n\n## Engine\n\nUse MySQL.\n";
  const teamText = "# Database\n\n## Engine\n\nUse Postgres.\n";
  const personalFile = path.join(root, "personal/database.md");
  const teamFile = path.join(root, "team/database.md");
  await writeFile(personalFile, personalText); await writeFile(teamFile, teamText);
  const manifest = { settings: { maxDocFiles: 100 }, layers: [
    { name: "personal", source: "files", path: "personal", level: 3 },
    { name: "team", source: "files", path: "team", level: 1 },
  ] };
  const manifestPath = path.join(root, "layers.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const raw = await resolveConcept("database", buildSources(manifest, root));
  const evidence = sectionEvidence(raw, "engine");
  assert.ok(evidence);
  const store = createContextResolutionStore(manifestPath);
  const fingerprint = contextManifestFingerprint(manifest);
  await store.update(state => {
    state.policies.push({ id: "p", version: 1, enabled: true, manifestFingerprint: fingerprint, conceptId: "database", key: "engine", selectedSource: "team" });
    state.decisions.push({ id: "d", conceptId: "database", key: "engine", profileId: "default",
      policyId: "p", policyVersion: 1, manifestFingerprint: fingerprint, method: "exact_policy", createdAt: new Date().toISOString(),
      evidenceFingerprint: evidence.fingerprint, selectedSource: "team" });
  });
  const child = spawn(process.execPath, ["mcp-server.mjs", "--manifest", manifestPath], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  lines.on("line", line => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
  async function read() {
    const result = await Promise.race([new Promise(resolve => {
      const id = ++sequence; pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read_file", arguments: { concept_id: "database" } } }) + "\n");
    }), sleep(3000, null, { ref: false }).then(() => { throw new Error(stderr || "MCP timeout"); })]);
    assert.equal(result.error, undefined, JSON.stringify(result));
    return JSON.parse(result.result.content[0].text);
  }
  const applied = await read();
  const engine = value => value.sections.find(section => section.key === "engine");
  assert.equal(engine(applied).sourceLayer, "team");
  assert.equal(engine(applied).contextResolution.status, "applied");
  assert.equal(engine(applied).conflicts[0].layer, "personal");
  assert.match(applied.markdown, /resolution applied/);
  assert.equal(await readFile(personalFile, "utf8"), personalText);
  assert.equal(await readFile(teamFile, "utf8"), teamText);
  await store.update(state => { state.decisions[0].undoneAt = new Date().toISOString(); });
  assert.equal(engine(await read()).sourceLayer, "personal");
  await store.update(state => { delete state.decisions[0].undoneAt; state.policies[0].enabled = false; });
  assert.equal(engine(await read()).contextResolution.status, "stale");
  await store.update(state => { state.policies[0].enabled = true; });
  const rules = createDiscrepancyRuleStore(manifestPath);
  const rule = await rules.create({ match: { kind: "section_content", conceptType: "document", key: "engine", sources: ["personal", "team"] },
    action: { type: "acknowledge", reasonCode: "other" }, evidenceDecisionIds: [] });
  assert.equal(engine(await read()).contextResolution.status, "applied", "one recommendation does not compete with an enabled exact policy");
  await rules.patch(rule.id, { mode: "automatic" });
  assert.equal(engine(await read()).contextResolution.status, "stale", "legacy rules block independently selected overlays");
  await rules.patch(rule.id, { enabled: false });
  assert.equal(engine(await read()).contextResolution.status, "applied");
  const extras = Array.from({ length: 100 }, (_, i) => path.join(root, "personal", `extra-${i}.md`));
  await Promise.all(extras.map(file => writeFile(file, "# Extra\n\nAn unrelated document.")));
  assert.equal(engine(await read()).contextResolution.status, "stale", "a healthy capped source cannot establish complete coverage");
  await Promise.all(extras.map(file => rm(file)));
  assert.equal(engine(await read()).contextResolution.status, "applied");
  await writeFile(teamFile, "# Database\n\n## Engine\n\nUse SQLite instead.\n");
  assert.equal(engine(await read()).contextResolution.status, "stale");
  await writeFile(teamFile, teamText);
  const unrelatedProfile = { ...manifest, profiles: { unrelated: { label: "Unrelated", layers: [] } } };
  await writeFile(manifestPath, JSON.stringify(unrelatedProfile));
  assert.equal(engine(await read()).contextResolution.status, "applied", "an inactive profile edit cannot invalidate the selected source binding");
  await writeFile(manifestPath, JSON.stringify({ ...unrelatedProfile, settings: { maxDocFiles: 1000 } }));
  assert.equal(engine(await read()).contextResolution.status, "stale");
  child.stdin.end();
  await new Promise(resolve => child.once("exit", resolve));
});
