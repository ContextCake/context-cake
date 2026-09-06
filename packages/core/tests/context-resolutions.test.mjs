import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyContextResolutions, contextManifestFingerprint, createContextResolutionStore } from '../src/context-resolutions.mjs';
import { createContextResolutionOperations } from '../src/control/context-resolutions.mjs';
import { buildDiscrepancies } from '../src/discrepancies.mjs';

const concept = () => ({
  id: 'decisions/database', frontmatter: { type: 'decision' }, frontmatterConflicts: [],
  contributors: [{ layer: 'personal', level: 3 }, { layer: 'team', level: 2 }],
  sections: [{ key: 'choice', heading: 'Choice', content: 'Use SQLite for this project.', sourceLayer: 'personal', sourceUpdated: '2026-08-01',
    conflicts: [{ layer: 'team', content: 'Use Postgres in production.', updated: '2026-08-02' }] },
  { key: 'unrelated', heading: 'Other', content: 'Keep this byte-for-byte.', sourceLayer: 'personal', conflicts: [] }],
});

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-resolutions-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'layers.json');
  const state = { manifest: { layers: [{ name: 'personal', level: 3 }, { name: 'team', level: 2 }] }, resolved: concept(),
    live: null, complete: true, indexing: false, errors: [], rules: [], liveHook: null };
  await fsp.writeFile(manifestPath, JSON.stringify(state.manifest));
  const originalFile = path.join(root, 'source.md');
  await fsp.writeFile(originalFile, 'Original source, no generated modifications.\n');
  const store = createContextResolutionStore(manifestPath);
  const project = async () => {
    const p = buildDiscrepancies([state.resolved], { coverageComplete: state.complete, rules: state.rules });
    return { ...p, indexing: state.indexing, errors: state.errors, byId: new Map(p.discrepancies.map(row => [row.id, row])) };
  };
  const ops = createContextResolutionOperations({ ...options, store, project, manifest: () => state.manifest,
    readLiveResolved: async () => { await state.liveHook?.(); return state.live ?? state.resolved; } });
  const body = async () => ({ conceptId: state.resolved.id, key: 'choice', selectedSource: 'team',
    revision: (await project()).byId.get('section_content::decisions/database::choice').revision });
  const apply = async (options = {}) => applyContextResolutions(state.resolved, await store.read(), {
    manifestFingerprint: contextManifestFingerprint(state.manifest), ...options,
  });
  return { root, manifestPath, state, store, ops, body, apply, originalFile };
}

test('exact policy selects an existing contribution, preserves dissent and sources, and exposes provenance', async t => {
  const f = await fixture(t);
  const original = structuredClone(f.state.resolved);
  const enabled = await f.ops.enable(await f.body());
  const result = await f.apply();
  assert.equal(result.sections[0].content, 'Use Postgres in production.');
  assert.equal(result.sections[0].sourceLayer, 'team');
  assert.deepEqual(result.sections[0].conflicts, [{ layer: 'personal', content: 'Use SQLite for this project.', updated: '2026-08-01' }]);
  assert.equal(result.sections[0].contextResolution.status, 'applied');
  assert.equal(result.sections[0].contextResolution.decisionId, enabled.decision.id);
  assert.deepEqual(result.sections[1], original.sections[1]);
  assert.deepEqual(f.state.resolved, original);
  assert.equal(await fsp.readFile(f.originalFile, 'utf8'), 'Original source, no generated modifications.\n');
  assert.equal((await f.ops.run())[0].unchanged, true);
  assert.equal((await f.store.read()).decisions.length, 1);
});

test('profile isolation, exact scope, changed authority and incomplete coverage deactivate outcomes', async t => {
  const f = await fixture(t);
  await f.ops.enable(await f.body());
  assert.equal((await f.apply({ profileId: 'other' })).sections[0].contextResolution.status, 'stale');
  const other = createContextResolutionStore(f.manifestPath, { profileId: 'other' });
  assert.deepEqual((await other.read()).decisions, []);
  assert.throws(() => createContextResolutionStore(f.manifestPath, { profileId: '../other' }));
  assert.equal((await f.apply({ coverageComplete: false })).sections[0].content, f.state.resolved.sections[0].content);
  f.state.manifest.layers[1].level = 4;
  assert.equal((await f.apply()).sections[0].contextResolution.status, 'stale');
  assert.equal((await f.ops.run())[0].unchanged, true);
  const saved = await f.store.read();
  saved.policies[0].conceptId = 'other/project';
  const result = applyContextResolutions(f.state.resolved, saved, { manifestFingerprint: saved.decisions[0].manifestFingerprint });
  assert.equal(result.sections[0].contextResolution.status, 'stale');
});

test('changed source content or authored dates become stale immediately, then fresh exact policy runs autonomously', async t => {
  const f = await fixture(t);
  await f.ops.enable(await f.body());
  f.state.resolved.sections[0].conflicts[0].content = 'Use Postgres 17 in production only.';
  assert.equal((await f.apply()).sections[0].contextResolution.status, 'stale');
  const refreshed = await f.ops.run();
  assert.equal(refreshed.length, 1);
  assert.ok(refreshed[0].decision);
  assert.equal((await f.apply()).sections[0].content, 'Use Postgres 17 in production only.');
  f.state.resolved.sections[0].conflicts[0].updated = '2026-09-01';
  assert.equal((await f.apply()).sections[0].contextResolution.status, 'stale');
  assert.equal((await f.store.read()).decisions.length, 2);
});

test('stale approval, live drift, incomplete indexing and existing automatic rules cannot enable policies', async t => {
  const f = await fixture(t);
  const body = await f.body();
  await assert.rejects(f.ops.enable({ ...body, revision: 'stale' }), { code: 'STALE_EVIDENCE' });
  await assert.rejects(f.ops.enable({ ...body, selectedSource: 'unrelated-source' }), { code: 'INVALID_SOURCE' });
  f.state.live = structuredClone(f.state.resolved);
  f.state.live.sections[0].conflicts[0].content = 'Different live content.';
  await assert.rejects(f.ops.enable(body), { code: 'STALE_EVIDENCE' });
  f.state.live = null;
  f.state.indexing = true;
  await assert.rejects(f.ops.enable(body), { code: 'COVERAGE_INCOMPLETE' });
  f.state.indexing = false;
  f.state.rules = [{ id: 'legacy', scope: 'local', enabled: true, mode: 'automatic', action: 'prefer_source', preferredSource: 'personal',
    match: { kind: 'section_content', conceptType: 'decision', key: 'choice', sources: ['personal', 'team'] } }];
  await assert.rejects(f.ops.enable(body), { code: 'NOT_ELIGIBLE' });
  assert.equal((await f.store.read()).decisions.length, 0);
});

test('pause and undo are durable, stop unattended decisions, and refuse undo across newer outcomes', async t => {
  const f = await fixture(t);
  const first = await f.ops.enable(await f.body());
  await f.ops.pause(first.policy.id);
  assert.equal((await f.apply()).sections[0].contextResolution.status, 'stale');
  assert.deepEqual(await f.ops.run(), []);
  const second = await f.ops.enable(await f.body());
  await assert.rejects(f.ops.undo(first.decision.id), { code: 'NEWER_DECISION' });
  await f.ops.undo(second.decision.id);
  assert.equal((await f.apply()).sections[0].contextResolution.status, 'undone');
  assert.equal((await f.apply()).sections[0].content, f.state.resolved.sections[0].content);
  assert.equal((await f.ops.undo(second.decision.id)).unchanged, true);
  assert.deepEqual(await f.ops.run(), []);
  const reopened = createContextResolutionStore(f.manifestPath);
  assert.ok((await reopened.read()).decisions.at(-1).undoneAt);
});

test('concurrent enable operations serialize state and preserve both history records', async t => {
  const f = await fixture(t);
  const body = await f.body();
  await Promise.all([f.ops.enable(body), f.ops.enable({ ...body, selectedSource: 'personal' })]);
  const saved = await f.store.read();
  assert.equal(saved.policies.length, 1);
  assert.equal(saved.policies[0].version, 2);
  assert.equal(saved.decisions.length, 2);
  assert.equal(saved.revision, 2);
  assert.equal((await f.apply()).sections[0].sourceLayer, saved.policies[0].selectedSource);
});


test('new legacy automatic authority immediately deactivates an existing overlay on reads', async t => {
  const f = await fixture(t);
  await f.ops.enable(await f.body());
  const result = await f.apply({ blockedKeys: new Set(['decisions/database::choice']) });
  assert.equal(result.sections[0].contextResolution.status, 'stale');
  assert.equal(result.sections[0].content, f.state.resolved.sections[0].content);
  const unrelated = await f.apply({ blockedKeys: new Set(['different/project::choice']) });
  assert.equal(unrelated.sections[0].contextResolution.status, 'applied');
});

test('manifest fingerprint agrees across HTTP and MCP selected-profile representations', () => {
  const layers = [{ name: 'team', level: 2, source: 'files', root: '/project/docs' }];
  const selected = { version: 2, layers, settings: { maxDocFiles: 100 }, profiles: { other: { layers: ['elsewhere'] } } };
  assert.equal(contextManifestFingerprint(selected), contextManifestFingerprint({ layers, settings: selected.settings }));
  assert.notEqual(contextManifestFingerprint(selected), contextManifestFingerprint({ layers: [{ ...layers[0], root: '/another/project' }], settings: selected.settings }));
  assert.notEqual(contextManifestFingerprint(selected), contextManifestFingerprint({ layers: [{ ...layers[0], level: 3 }], settings: selected.settings }));
});


test('malformed persisted policies fail closed instead of treating string booleans as authority', async t => {
  const f = await fixture(t);
  await f.ops.enable(await f.body());
  const saved = await f.store.read();
  saved.policies[0].enabled = 'false';
  await fsp.writeFile(f.store.filename, JSON.stringify(saved));
  await assert.rejects(f.ops.run(), /Invalid context resolution state/);
  await assert.rejects(f.ops.view(), /Invalid context resolution state/);
  saved.policies[0].enabled = true;
  saved.decisions[0].profileId = 'other';
  await fsp.writeFile(f.store.filename, JSON.stringify(saved));
  await assert.rejects(f.store.read(), /Invalid context resolution state/);
});

test('a manifest change during live validation aborts before writing any policy', async t => {
  const f = await fixture(t);
  const body = await f.body();
  f.state.liveHook = () => { f.state.manifest.layers[1].root = '/different/project'; };
  await assert.rejects(f.ops.enable(body), { code: 'STALE_EVIDENCE' });
  assert.deepEqual((await f.store.read()).policies, []);
});


test('validation timeout releases the lock and never records a late source response', async t => {
  const f = await fixture(t, { validationTimeoutMs: 10 });
  const body = await f.body();
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  // Keep the test alive beyond the deadline; the engine deadline is unrefed.
  const timer = setTimeout(finish, 200);
  t.after(() => clearTimeout(timer));
  f.state.liveHook = () => pending;
  await assert.rejects(f.ops.enable(body), { code: 'CONTEXTCAKE_TIMEOUT' });
  await f.store.update(state => { state.revision += 1; return {}; });
  finish();
  await new Promise(resolve => setImmediate(resolve));
  const saved = await f.store.read();
  assert.equal(saved.policies.length, 0);
  assert.equal(saved.decisions.length, 0);
});
