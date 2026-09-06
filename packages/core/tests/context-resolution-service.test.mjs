import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createEngineService } from '../src/service.mjs';
import { createDiscrepancyRuleStore } from '../src/discrepancy-rules.mjs';

const doc = content => `---\ntype: decision\ntitle: Database\nupdated: 2026-09-01\n---\n\n# Database\n\n## Choice {#choice}\n\n${content}\n\n## Unrelated {#other}\n\nKeep this original text.\n`;

async function host(manifestPath, options = {}) {
  const svc = createEngineService({ manifestPath, token: null, ...options });
  const server = http.createServer(async (req, res) => {
    if (await svc.handleRequest(req, res)) return;
    res.writeHead(404); res.end();
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
  catch (error) { svc.close(); throw error; }
  const request = async (route, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  let stopped = false;
  return { svc, request, stop: async () => {
    if (stopped) return; stopped = true; svc.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}
async function fixture(t, { missing = false, partial = false, ...options } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-context-resolution-service-'));
  const layers = [];
  const paths = {};
  for (const [name, level, content] of [['personal', 3, 'Use SQLite.'], ['team', 2, 'Use Postgres in production.']]) {
    const folder = path.join(root, name);
    await fsp.mkdir(path.join(folder, 'decisions'), { recursive: true });
    paths[name] = path.join(folder, 'decisions', 'database.md');
    await fsp.writeFile(paths[name], doc(content));
    layers.push({ name, level, path: folder });
  }
  if (missing) layers.push({ name: 'missing', level: 0, path: path.join(root, 'missing') });
  if (partial) await Promise.all(Array.from({ length: 101 }, (_, i) => fsp.writeFile(path.join(root, 'team', 'decisions', `z-${i}.md`), doc(`Extra document ${i}.`))));
  const manifestPath = path.join(root, 'layers.json');
  await fsp.writeFile(manifestPath, JSON.stringify({ layers, ...(partial ? { settings: { maxDocFiles: 100 } } : {}) }));
  let runtime;
  try { runtime = await host(manifestPath, options); }
  catch (error) { await fsp.rm(root, { recursive: true, force: true }); throw error; }
  t.after(async () => { await runtime.stop(); await fsp.rm(root, { recursive: true, force: true }); });
  const discrepancy = async () => {
    const response = await runtime.request('/api/discrepancies?wait=15000');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.discrepancies.find(row => row.conceptId === 'decisions/database' && row.key === 'choice');
  };
  const enable = async () => {
    const row = await discrepancy();
    assert.ok(row);
    return runtime.request('/api/context-resolutions', 'POST', { conceptId: row.conceptId, key: row.key, selectedSource: 'team', revision: row.revision });
  };
  return { ...runtime, root, paths, manifestPath, discrepancy, enable };
}
const choice = value => value.sections.find(row => row.key === 'choice');

test('a remote content failure disables overlays in single, aggregate and history reads while its old index remains ready', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let failContent = false;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.github.com') return originalFetch(input, options);
    if (url.pathname.includes('/contents/')) return failContent
      ? new Response('Forbidden', { status: 403 }) : new Response(doc('Use Postgres in production.'));
    if (url.pathname.endsWith('/commits')) return new Response(JSON.stringify([{ commit: { author: { date: '2026-09-01T00:00:00Z' } } }]));
    if (url.pathname.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [{ type: 'blob', path: 'README.md', size: 300 }] }));
    return new Response(JSON.stringify({ default_branch: 'main' }));
  };
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-context-resolution-remote-health-'));
  const folder = path.join(root, 'personal');
  await fsp.mkdir(path.join(folder, 'owner', 'repo'), { recursive: true });
  await fsp.writeFile(path.join(folder, 'owner', 'repo', 'README.md'), doc('Use SQLite.'));
  const manifestPath = path.join(root, 'layers.json');
  await fsp.writeFile(manifestPath, JSON.stringify({ layers: [
    { name: 'personal', source: 'files', level: 3, path: folder },
    { name: 'team', source: 'github', level: 1, repo: 'owner/repo', paths: ['README.md'] },
  ] }));
  const runtime = await host(manifestPath);
  t.after(async () => { await runtime.stop(); await fsp.rm(root, { force: true, recursive: true }); });
  const rows = await runtime.request('/api/discrepancies?wait=15000');
  const row = rows.body.discrepancies.find(item => item.kind === 'section_content' && item.key === 'choice');
  assert.ok(row);
  const enabled = await runtime.request('/api/context-resolutions', 'POST', {
    conceptId: row.conceptId, key: row.key, selectedSource: 'team', revision: row.revision,
  });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(choice((await runtime.request('/api/resolve?concept=owner/repo/README')).body).contextResolution.status, 'applied');
  failContent = true;
  const single = await runtime.request('/api/resolve?concept=owner/repo/README');
  assert.equal(choice(single.body).contextResolution.status, 'stale');
  const status = await runtime.request('/api/status');
  const remote = status.body.sources.find(source => source.name === 'team');
  assert.equal(remote.status, 'ok', 'a single failed content read must not erase the ready source index');
  assert.equal(remote.evidenceHealthy, false);
  const aggregate = await runtime.request('/api/resolve-all');
  assert.equal(choice(aggregate.body.concepts.find(item => item.id === row.conceptId)).contextResolution.status, 'stale');
  const history = await runtime.request('/api/context-resolutions');
  assert.equal(history.body.decisions.at(-1).currentStatus, 'stale');
  const discrepancies = await runtime.request('/api/discrepancies');
  assert.equal(discrepancies.body.coverageComplete, false);
  failContent = false;
  assert.equal(choice((await runtime.request('/api/resolve?concept=owner/repo/README')).body).contextResolution.status, 'applied');
});

test('HTTP policies select without editing files; single/aggregate reads agree and Undo restores base', async t => {
  const f = await fixture(t);
  const before = await Promise.all(Object.values(f.paths).map(file => fsp.readFile(file, 'utf8')));
  const beforeStatus = await f.request('/api/status');
  const enabled = await f.enable();
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const single = await f.request('/api/resolve?concept=decisions/database');
  const all = await f.request('/api/resolve-all?wait=15000');
  assert.equal(single.status, 200, JSON.stringify(single.body));
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(choice(single.body).sourceLayer, 'team');
  assert.equal(choice(single.body).contextResolution.status, 'applied');
  const selectedView = await f.request('/api/context-resolutions');
  assert.equal(selectedView.body.decisions.at(-1).currentStatus, 'applied');
  assert.ok((await f.request('/api/status')).body.generation > beforeStatus.body.generation);
  assert.deepEqual(choice(all.body.concepts.find(row => row.id === 'decisions/database')), choice(single.body));
  assert.deepEqual(await Promise.all(Object.values(f.paths).map(file => fsp.readFile(file, 'utf8'))), before);
  const undone = await f.request('/api/context-resolutions', 'DELETE', { decisionId: enabled.body.decision.id });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  const reverted = await f.request('/api/resolve?concept=decisions/database');
  assert.equal(choice(reverted.body).sourceLayer, 'personal');
  assert.equal(choice(reverted.body).contextResolution.status, 'undone');
  assert.equal((await f.request('/api/context-resolutions')).body.decisions.at(-1).currentStatus, 'undone');
});

test('live source drift cannot serve an old decision as current', async t => {
  const f = await fixture(t);
  const enabled = await f.enable();
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  await fsp.writeFile(f.paths.team, doc('Use Postgres 17 only for production.'));
  const result = await f.request('/api/resolve?concept=decisions/database');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const section = choice(result.body);
  // If indexing/automatic work already caught up, a NEW decision may apply;
  // the old evidence must never be represented as a current selection.
  if (section.contextResolution.status === 'applied') {
    assert.notEqual(section.contextResolution.decisionId, enabled.body.decision.id);
    assert.match(section.content, /Postgres 17/);
  } else {
    assert.equal(section.contextResolution.status, 'stale');
    assert.equal(section.sourceLayer, 'personal');
  }
});

test('incomplete source coverage blocks enablement even when two healthy sources disagree', async t => {
  const f = await fixture(t, { missing: true });
  const enabled = await f.enable();
  assert.equal(enabled.status, 409, JSON.stringify(enabled.body));
  assert.equal(enabled.body.code, 'COVERAGE_INCOMPLETE');
  const history = await f.request('/api/context-resolutions');
  assert.deepEqual(history.body.policies, []);
});

test('read-only hosts refuse policy changes and competing legacy authority deactivates saved reads', async t => {
  const f = await fixture(t);
  const enabled = await f.enable();
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  await f.stop();
  const store = createDiscrepancyRuleStore(f.manifestPath);
  const rule = await store.create({ match: { kind: 'section_content', conceptType: 'decision', key: 'choice', sources: ['personal', 'team'] },
    action: { type: 'prefer_source', source: 'personal' } });
  await store.patch(rule.id, { mode: 'automatic' });
  const readonly = await host(f.manifestPath, { allowMutations: false });
  t.after(() => readonly.stop());
  await readonly.request('/api/discrepancies?wait=15000');
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const result = await readonly.request('/api/context-resolutions', method, { policyId: enabled.body.policy.id, decisionId: enabled.body.decision.id });
    assert.equal(result.status, 405);
  }
  const single = await readonly.request('/api/resolve?concept=decisions/database');
  assert.equal(single.status, 200, JSON.stringify(single.body));
  assert.equal(choice(single.body).sourceLayer, 'personal');
  assert.equal(choice(single.body).contextResolution.status, 'stale');
  const aggregate = await readonly.request('/api/resolve-all?wait=15000');
  assert.equal(choice(aggregate.body.concepts[0]).contextResolution.status, 'stale');
});


test('a successfully indexed but truncated source cannot authorize an automatic policy', async t => {
  const f = await fixture(t, { partial: true });
  const enabled = await f.enable();
  assert.equal(enabled.status, 409, JSON.stringify(enabled.body));
  assert.equal(enabled.body.code, 'COVERAGE_INCOMPLETE');
  const status = await f.request('/api/status');
  assert.ok(status.body.sources.find(row => row.name === 'team').warnings > 0);
});
