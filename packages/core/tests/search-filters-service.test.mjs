import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createEngineService } from '../src/service.mjs';

const doc = (title, type, body) => `---\ntitle: ${title}\ntype: ${type}\n---\n\n## Body {#body}\n\n${body}\n`;

test('HTTP source/type filters recover hits below the global top-k and use distinct memo entries', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-search-filters-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const layers = ['personal', 'specs'].map((name, i) => ({ name, level: 3 - i, path: path.join(root, name) }));
  await Promise.all(layers.map(layer => fsp.mkdir(layer.path)));
  await Promise.all(Array.from({ length: 25 }, (_, i) => fsp.writeFile(path.join(layers[0].path, `top-${i}.md`), doc('Build and test', 'note', 'build and test'))));
  await fsp.writeFile(path.join(layers[1].path, 'buried.md'), doc('Long guide', 'spec', `build and test ${'other '.repeat(100)}`));
  const manifestPath = path.join(root, 'layers.json');
  await fsp.writeFile(manifestPath, JSON.stringify({ layers }));
  const service = createEngineService({ manifestPath });
  const server = http.createServer(async (req, res) => {
    if (await service.handleRequest(req, res)) return;
    res.writeHead(404); res.end();
  });
  t.after(async () => {
    service.close(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const search = async (params = {}) => {
    const url = new URL(`http://127.0.0.1:${server.address().port}/api/search`);
    url.search = new URLSearchParams({ q: 'build and test', limit: '20', wait: '15000', ...params });
    const response = await fetch(url);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.indexing, false);
    assert.deepEqual(body.indexingSources, []);
    return body.hits;
  };
  // linksTo is rank-WITHIN-THIS-CALL-dependent by design (top 3 of whatever
  // the filter selected): 'buried' sits far below rank 3 in the unfiltered
  // 26-hit answer but is the ONLY hit — rank 0 — once a filter narrows to
  // it, so it legitimately gains linksTo there. Strip it before comparing a
  // filtered answer against a slice of the unfiltered one.
  const withoutLinksTo = hits => hits.map(({ linksTo, ...hit }) => hit);
  const global = await search();
  assert.equal(global.length, 20);
  assert.equal(global.some(hit => hit.id === 'buried'), false);
  const full = await search({ limit: '50' });
  const expected = full.filter(hit => hit.id === 'buried');
  assert.equal(expected.length, 1);
  assert.deepEqual(withoutLinksTo(await search({ source: 'specs' })), withoutLinksTo(expected));
  assert.deepEqual(withoutLinksTo(await search({ type: 'spec' })), withoutLinksTo(expected));
  assert.deepEqual(withoutLinksTo(await search({ source: 'specs', type: 'spec' })), withoutLinksTo(expected));
  assert.deepEqual(await search({ source: 'specs', type: 'note' }), []);
  assert.deepEqual(await search({ source: 'missing' }), []);
  assert.deepEqual(await search({ type: 'missing' }), []);
  assert.deepEqual(await search({ source: 'personal' }), global);
  assert.deepEqual(await search(), global, 'filter cache entries must not replace the unfiltered answer');
  assert.deepEqual(withoutLinksTo(await search({ source: 'specs' })), withoutLinksTo(expected), 'repeat scoped searches use their own retained answer');
});

test('/api/diagnostics carries a retrieval summary and a search event records its phase', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-search-diag-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const layerPath = path.join(root, 'personal');
  await fsp.mkdir(layerPath);
  await fsp.writeFile(path.join(layerPath, 'note.md'), doc('Build and test', 'note', 'build and test'));
  const manifestPath = path.join(root, 'layers.json');
  await fsp.writeFile(manifestPath, JSON.stringify({ layers: [{ name: 'personal', level: 3, path: layerPath }] }));
  const service = createEngineService({ manifestPath });
  const server = http.createServer(async (req, res) => {
    if (await service.handleRequest(req, res)) return;
    res.writeHead(404); res.end();
  });
  t.after(async () => {
    service.close(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const searchUrl = new URL(`${base}/api/search`);
  searchUrl.search = new URLSearchParams({ q: 'build and test', wait: '15000' });
  const searchResponse = await fetch(searchUrl);
  const searchBody = await searchResponse.json();
  assert.equal(searchResponse.status, 200, JSON.stringify(searchBody));
  // The response contract is unchanged: no `diag` leaks into the client body.
  assert.equal('diag' in searchBody, false);

  const diagBody = await (await fetch(`${base}/api/diagnostics`)).json();
  assert.ok(diagBody.retrieval, 'retrieval object is present');
  assert.ok(['sqlite', 'memory'].includes(diagBody.retrieval.backend));
  assert.equal(typeof diagBody.retrieval.persisted, 'boolean');
  assert.ok(diagBody.retrieval.index === null || typeof diagBody.retrieval.index === 'object');
  assert.ok(diagBody.retrieval.searches);
  assert.ok(diagBody.retrieval.searches.cold + diagBody.retrieval.searches.warm >= 1);

  const searchEvent = diagBody.operations.find(op => op.operation === 'search');
  assert.ok(searchEvent, 'a search event was recorded');
  assert.ok(['cold', 'warm'].includes(searchEvent.phase));
  assert.ok(['sqlite', 'memory'].includes(searchEvent.backend));
});
