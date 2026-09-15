#!/usr/bin/env node
// A disposable failure/recovery walkthrough over the real HTTP engine.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createEngineService } from '../../packages/core/src/service.mjs';
import { createTelemetry } from '../../apps/desktop/src/observability/telemetry.mjs';
const configAt = process.argv.indexOf('--telemetry-config');
const telemetry =
  configAt >= 0
    ? createTelemetry({ configPath: process.argv[configAt + 1] })
    : null;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-diagnostics-demo-'));
const source = path.join(root, 'source'),
  hidden = path.join(root, 'offline');
await fs.mkdir(source);
await fs.writeFile(
  path.join(source, 'database.md'),
  '# Database\n\nUse PostgreSQL for the example service.\n',
);
await fs.writeFile(
  path.join(source, 'deploy.md'),
  '# Deploy\n\nVerify the database migration before deploying.\n',
);
const manifestPath = path.join(root, 'manifest.json');
await fs.writeFile(
  manifestPath,
  JSON.stringify({
    layers: [{ name: 'example', level: 1, source: 'files', path: source }],
  }),
);
const service = createEngineService({
  manifestPath,
  telemetryStatus: () => telemetry?.status() ?? null,
});
const server = http.createServer(async (req, res) => {
  if (!(await service.handleRequest(req, res))) {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const request = async (route, body) => {
  const r = await fetch(
    origin + route,
    body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  assert.equal(r.status, 200);
  return r.json();
};
const steps = [];
async function snapshot(label) {
  await request('/api/graph?wait=5000');
  const report = await request('/api/diagnostics');
  steps.push({
    label,
    health: report.health.sources.map((s) => ({
      status: s.status,
      loaded: s.loaded,
    })),
    operations: report.operations,
  });
  return report;
}
try {
  await request('/api/search?q=database&wait=5000');
  await snapshot('initial search');
  await fs.writeFile(
    path.join(source, 'database.md'),
    '# Database\n\nUse PostgreSQL. Retain a rollback snapshot.\n',
  );
  await request('/api/indexing/reindex', { name: 'example' });
  const edited = await snapshot('one document edited');
  assert.ok(
    edited.operations.some(
      (o) =>
        o.operation === 'index' &&
        o.documentsRead === 1 &&
        o.documentsReused === 1,
    ),
    'one edit must read one document and reuse one',
  );
  await fs.rename(source, hidden);
  await request('/api/indexing/reindex', { name: 'example' });
  const failed = await snapshot('source unavailable');
  assert.ok(
    failed.health.sources.some((s) => !['ok', 'ready'].includes(s.status)),
    'native status must show source failure',
  );
  await fs.rename(hidden, source);
  await request('/api/indexing/reindex', { name: 'example' });
  const recovered = await snapshot('source restored');
  assert.ok(
    recovered.health.sources.every((s) => ['ok', 'ready'].includes(s.status)),
    'source must recover',
  );
  await request('/api/search?q=rollback&wait=5000');
  await telemetry?.flush();
  console.log(
    JSON.stringify(
      {
        temporaryFixture: true,
        steps,
        telemetry: telemetry?.status() ?? 'disabled',
      },
      null,
      2,
    ),
  );
} finally {
  telemetry?.close();
  service.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
