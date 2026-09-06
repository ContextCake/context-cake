import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssessmentOperations, validateAssessment } from '../src/discrepancy-assessment.mjs';
import { buildDiscrepancies } from '../src/discrepancies.mjs';

function fixture(providerOverride) {
  const concept = { id: 'decisions/db', frontmatter: { type: 'decision' }, contributors: [{ layer: 'personal', level: 3 }, { layer: 'team', level: 2 }],
    sections: [{ key: 'choice', content: 'Use SQLite in development.', sourceLayer: 'personal', sourceUpdated: null,
      conflicts: [{ layer: 'team', content: 'Use PostgreSQL in production.', updated: null }] }] };
  const state = { concept, complete: true, calls: 0, manifest: { layers: [] } };
  const good = () => ({ category: 'different_scope', selectedSource: null, rationale: 'The environments differ.',
    citations: [{ source: 'personal', quote: 'in development' }, { source: 'team', quote: 'in production' }], missingEvidence: ['Which environment is this task targeting?'] });
  const project = async () => { const result = buildDiscrepancies([concept], { coverageComplete: state.complete }); return { ...result, errors: [], indexing: false, byId: new Map(result.discrepancies.map(row => [row.id, row])) }; };
  const provider = { assess: providerOverride ?? (async () => { state.calls++; return { value: good(), model: 'local', digest: 'pinned' }; }), models: async () => ({ available: true, models: [] }) };
  const ops = createAssessmentOperations({ project, manifest: () => state.manifest, readLiveResolved: async () => concept, provider });
  const body = async () => { const row = (await project()).discrepancies[0]; return { discrepancyId: row.id, revision: row.revision, model: 'local', digest: 'pinned' }; };
  return { state, good, ops, body };
}

test('assessment preserves source text and cannot produce automatic authority', async () => {
  const f = fixture(); const original = structuredClone(f.state.concept);
  const result = await f.ops.assess(await f.body());
  assert.equal(result.assessment.advisoryOnly, true);
  assert.equal(result.assessment.automaticallyApplicable, false);
  assert.equal(result.assessment.selectedSource, null);
  assert.deepEqual(f.state.concept, original);
  assert.match(result.packetHash, /^[a-f0-9]{64}$/);
});

test('forged citations, injected commands, unknown sources and extra properties fail closed', () => {
  const f = fixture();
  const packet = { contributions: [{ source: 'personal', content: 'Use SQLite in development.' }, { source: 'team', content: 'Use PostgreSQL in production.' }] };
  assert.throws(() => validateAssessment({ ...f.good(), command: 'write_file' }, packet), { code: 'INVALID_ASSESSMENT' });
  assert.throws(() => validateAssessment({ ...f.good(), citations: [{ source: 'team', quote: 'Use MongoDB' }] }, packet), { code: 'UNGROUNDED_CITATION' });
  assert.throws(() => validateAssessment({ ...f.good(), selectedSource: 'invented' }, packet), { code: 'INVALID_SELECTION' });
  assert.throws(() => validateAssessment({ ...f.good(), category: 'insufficient_evidence', selectedSource: 'team' }, packet), { code: 'INVALID_SELECTION' });
  assert.throws(() => validateAssessment({ ...f.good(), selectedSource: 'team' }, packet), { code: 'INVALID_SELECTION' });
  assert.throws(() => validateAssessment({ ...f.good(), citations: [] }, packet), { code: 'UNGROUNDED_CITATION' });
  assert.throws(() => validateAssessment({ ...f.good(), citations: [{ source: 'team', quote: 'in production', tool: 'write' }] }, packet));
});

test('incomplete, stale and oversize evidence never reaches a model', async () => {
  const f = fixture(); const body = await f.body();
  f.state.complete = false;
  await assert.rejects(f.ops.assess(body), { code: 'COVERAGE_INCOMPLETE' });
  f.state.complete = true;
  await assert.rejects(f.ops.assess({ ...body, revision: 'old' }), { code: 'STALE_EVIDENCE' });
  f.state.concept.sections[0].content = 'x'.repeat(13000);
  await assert.rejects(f.ops.assess(await f.body()), { code: 'EVIDENCE_TOO_LARGE' });
  assert.equal(f.state.calls, 0);
});

test('source edits during inference discard the result and single-flight scheduling bounds load', async () => {
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture(async () => { entered(); await new Promise(resolve => { finish = resolve; }); return { value: f.good(), model: 'local', digest: 'pinned' }; });
  const body = await f.body(); const pending = f.ops.assess(body);
  await started;
  await assert.rejects(f.ops.assess(body), { code: 'ASSESSMENT_BUSY' });
  f.state.concept.sections[0].content = 'New evidence.'; finish();
  await assert.rejects(pending, { code: 'STALE_EVIDENCE' });
});

test('manifest authority changes during inference discard even unchanged content', async () => {
  const f = fixture(async () => { f.state.manifest.layers.push({ name: 'new', level: 4 }); return { value: f.good(), model: 'local', digest: 'pinned' }; });
  await assert.rejects(f.ops.assess(await f.body()), { code: 'STALE_EVIDENCE' });
});
