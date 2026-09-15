import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics, safeEvent } from '../src/diagnostics.mjs';
import { diagnose } from '../src/doctor.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
test('doctor distinguishes present folders, missing folders and unprobed executable sources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cc-doctor-'));
  try {
    const manifest = path.join(root, 'layers.json');
    await writeFile(
      manifest,
      JSON.stringify({
        layers: [
          { name: 'local', source: 'files', path: root, level: 2 },
          {
            name: 'missing',
            source: 'files',
            path: path.join(root, 'absent'),
            level: 1,
          },
        ],
      }),
    );
    const r = await diagnose(manifest);
    assert.equal(r.ok, false);
    assert.equal(r.data, null);
    assert.equal(r.error.code, 'UNHEALTHY_DIAGNOSTICS');
    assert.match(r.context.manifestRevision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(r.error.details.scope, 'fresh-configuration-check');
    assert.deepEqual(
      r.error.details.sources.map((s) => s.status),
      ['present', 'unavailable'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor JSON errors follow CLI exit conventions without leaking exception text', () => {
  const entry = fileURLToPath(new URL('../src/doctor.mjs', import.meta.url));
  for (const [args, exit, code] of [
    [['--json', '--manifest'], 2, 'INVALID_INPUT'],
    [['--manifest', '--json'], 2, 'INVALID_INPUT'],
    [
      [
        '--json',
        '--manifest',
        '/private/tmp/cc-doctor-no-such-manifest-secret',
      ],
      3,
      'NOT_FOUND',
    ],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, exit);
    const body = JSON.parse(result.stdout);
    assert.equal(body.error.code, code);
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.ok, false);
    assert.ok(!result.stdout.includes('no-such-manifest-secret'));
  }
});
