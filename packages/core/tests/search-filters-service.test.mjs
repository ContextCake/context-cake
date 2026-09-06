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
  const global = await search();
  assert.equal(global.length, 20);
  assert.equal(global.some(hit => hit.id === 'buried'), false);
  const full = await search({ limit: '50' });
  const expected = full.filter(hit => hit.id === 'buried');
  assert.equal(expected.length, 1);
  assert.deepEqual(await search({ source: 'specs' }), expected);
  assert.deepEqual(await search({ type: 'spec' }), expected);
  assert.deepEqual(await search({ source: 'specs', type: 'spec' }), expected);
  assert.deepEqual(await search({ source: 'specs', type: 'note' }), []);
  assert.deepEqual(await search({ source: 'missing' }), []);
  assert.deepEqual(await search({ type: 'missing' }), []);
  assert.deepEqual(await search({ source: 'personal' }), global);
  assert.deepEqual(await search(), global, 'filter cache entries must not replace the unfiltered answer');
  assert.deepEqual(await search({ source: 'specs' }), expected, 'repeat scoped searches use their own retained answer');
});
