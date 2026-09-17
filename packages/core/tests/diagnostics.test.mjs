import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics, safeEvent } from '../src/diagnostics.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('diagnostics drop arbitrary content, fields and unknown operations', () => {
  assert.equal(safeEvent({ operation: 'password' }), null);
  const e = safeEvent({
    operation: 'search',
    outcome: 'secret',
    query: 'sensitive',
    durationMs: NaN,
    error: 'ghp_secret',
    traceId: 'bad',
  });
  assert.deepEqual(Object.keys(e).sort(), [
    'at',
    'durationMs',
    'operation',
    'outcome',
    'role',
  ]);
  assert.equal(e.outcome, 'error');
});
test('retrieval counts, phase and backend are bounded, enum-validated and absent when unset', () => {
  const withRetrieval = safeEvent({
    operation: 'search',
    outcome: 'ok',
    phase: 'cold',
    backend: 'sqlite',
    candidateCount: 12,
    storeSyncMs: 3.5,
    decodedRecords: 7,
  });
  assert.equal(withRetrieval.phase, 'cold');
  assert.equal(withRetrieval.backend, 'sqlite');
  assert.equal(withRetrieval.candidateCount, 12);
  assert.equal(withRetrieval.storeSyncMs, 3.5);
  assert.equal(withRetrieval.decodedRecords, 7);
  // phase is meaningful only on a search event.
  const readWithPhase = safeEvent({ operation: 'read', outcome: 'ok', phase: 'cold' });
  assert.equal(readWithPhase.phase, undefined);
  // unknown enum values are dropped, not passed through.
  const bogus = safeEvent({
    operation: 'search', outcome: 'ok', phase: 'lukewarm', backend: 'postgres',
    candidateCount: -1, storeSyncMs: 'slow', decodedRecords: NaN,
  });
  assert.equal(bogus.phase, undefined);
  assert.equal(bogus.backend, undefined);
  assert.equal(bogus.candidateCount, undefined);
  assert.equal(bogus.storeSyncMs, undefined);
  assert.equal(bogus.decodedRecords, undefined);
  // absent entirely when not provided.
  const bare = safeEvent({ operation: 'search', outcome: 'ok' });
  assert.deepEqual(Object.keys(bare).sort(), ['at', 'durationMs', 'operation', 'outcome', 'role']);
});
test('observations are bounded and empty percentiles stay unknown', async () => {
  const d = createDiagnostics({ limit: 3 });
  assert.equal(d.snapshot().medianMs, null);
  for (let i = 0; i < 5; i++) await d.measure('search', async () => []);
  assert.equal(d.snapshot().operations.length, 3);
  assert.equal(d.snapshot().sampleCount, 3);
  assert.equal(d.snapshot().p95Ms, null);
});
test('instrumentation preserves return values, errors and policy status', async () => {
  const d = createDiagnostics();
  const result = { sections: [{ contextResolution: { status: 'applied' } }] };
  assert.equal(await d.measure('read', async () => result), result);
  const err = new Error('private text');
  await assert.rejects(
    d.measure('search', async () => {
      throw err;
    }),
    (e) => e === err,
  );
  assert.equal(d.snapshot().errors, 1);
  assert.equal(d.snapshot().sampleCount, 2);
  assert.ok(!JSON.stringify(d.snapshot()).includes('private text'));
});
test('measure() annotate() merges safeEvent-filtered fields, two-arg form still works', async () => {
  const d = createDiagnostics();
  // Two-argument form (no options) must keep working unchanged.
  await d.measure('read', async () => ({ ok: true }));
  assert.equal(d.snapshot().operations[0].operation, 'read');

  const annotated = await d.measure(
    'search',
    async () => ({ hits: [1, 2] }),
    { annotate: (result) => ({ phase: 'cold', backend: 'sqlite', candidateCount: result.hits.length, unknownField: 'x' }) },
  );
  assert.deepEqual(annotated, { hits: [1, 2] });
  const [event] = d.snapshot().operations;
  assert.equal(event.phase, 'cold');
  assert.equal(event.backend, 'sqlite');
  assert.equal(event.candidateCount, 2);
  assert.equal('unknownField' in event, false);

  // An annotation must never override identity/timing fields record() owns.
  const before = d.snapshot().operations[0].at;
  await d.measure('search', async () => ({}), {
    annotate: () => ({ operation: 'read', outcome: 'error', at: 1, durationMs: 999999, role: 'mcp' }),
  });
  const latest = d.snapshot().operations[0];
  assert.equal(latest.operation, 'search');
  assert.equal(latest.outcome, 'ok');
  assert.notEqual(latest.at, 1);
  assert.ok(latest.durationMs < 999999);
  assert.notEqual(latest.role, 'mcp');
  void before;

  // annotate() is skipped on the error path — no fields are merged in.
  await assert.rejects(
    d.measure('search', async () => { throw new Error('boom'); }, { annotate: () => ({ phase: 'cold' }) }),
  );
  const errored = d.snapshot().operations[0];
  assert.equal(errored.outcome, 'error');
  assert.equal(errored.phase, undefined);
});
test('snapshot() reports a bounded retrieval summary from recorded search events', async () => {
  const d = createDiagnostics({ limit: 10 });
  assert.deepEqual(d.snapshot().retrieval, {
    searches: { cold: 0, warm: 0, medianColdMs: null, medianWarmMs: null },
    lastSearch: null,
  });
  const annotate = (phase, extra = {}) => () => ({ phase, backend: 'sqlite', ...extra });
  await d.measure('search', async () => ({}), { annotate: annotate('cold', { candidateCount: 5, storeSyncMs: 2, documentsRead: 3, documentsReused: 1 }) });
  await d.measure('search', async () => ({}), { annotate: annotate('warm', { candidateCount: 5 }) });
  await d.measure('search', async () => ({}), { annotate: annotate('warm', { candidateCount: 5 }) });
  await d.measure('read', async () => ({}));
  const snap = d.snapshot();
  assert.equal(snap.retrieval.searches.cold, 1);
  assert.equal(snap.retrieval.searches.warm, 2);
  assert.ok(snap.retrieval.searches.medianColdMs !== null);
  assert.ok(snap.retrieval.searches.medianWarmMs !== null);
  assert.equal(snap.retrieval.lastSearch.phase, 'warm');
  assert.equal(snap.retrieval.lastSearch.candidateCount, 5);
  assert.equal(typeof snap.retrieval.lastSearch.at, 'number');
});
// The doctor checks themselves are covered by cli-doctor.test.mjs. What stays
// here is the probe entry the Mac app's launcher imports: run bare, it reports
// that nothing was checked, as one JSON line.
test('the doctor observability probe prints one JSON line', () => {
  const entry = fileURLToPath(new URL('../src/doctor.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, 'not-checked');
  assert.equal(result.stdout.trim().split('\n').length, 1);
});
