import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalContextAssessor } from '../src/main/context-assessor.mjs';

const model = { name: 'local:1b', digest: 'abc', size: 100, details: { quantization_level: 'Q4' } };
const json = value => new Response(JSON.stringify(value), { status: 200 });
function fixture(override = {}) {
  const calls = [];
  const provider = createLocalContextAssessor({ fetchImpl: async (url, init) => {
    calls.push({ url, init }); const route = new URL(url).pathname;
    if (override[route]) return override[route](init);
    if (route === '/api/version') return json({ version: '0.15.4' });
    if (route === '/api/tags') return json({ models: [model, { ...model, name: 'remote-cloud' }] });
    if (route === '/api/show') return json({ model_info: {}, details: model.details, capabilities: ['completion'] });
    return json({ done: true, done_reason: 'stop', message: { content: '{"category":"insufficient_evidence"}' }, prompt_eval_count: 100, eval_count: 100 });
  } });
  return { calls, provider, input: { packet: { evidence: 'untrusted' }, schema: {}, model: model.name, digest: model.digest } };
}
test('local transport pins installed model, disables redirects and tools, bounds context and idle lifetime', async () => {
  const f = fixture();
  assert.equal((await f.provider.models()).models.length, 1);
  assert.equal((await f.provider.assess(f.input)).digest, 'abc');
  assert.ok(f.calls.every(row => row.url.startsWith('http://127.0.0.1:11434/') && row.init.redirect === 'error' && row.init.signal));
  const body = JSON.parse(f.calls.find(row => row.url.endsWith('/api/chat')).init.body);
  assert.equal(body.keep_alive, '1m'); assert.equal(body.tools, undefined); assert.equal(body.options.num_ctx, 8192);
  assert.equal(body.truncate, false); assert.equal(body.shift, false);
});
test('changed digest, remote runtime model, and truncated output never yield an assessment', async () => {
  const f = fixture();
  await assert.rejects(f.provider.assess({ ...f.input, digest: 'old' }), /changed/);
  const remote = fixture({ '/api/show': () => json({ remote_host: 'https://provider.example', model_info: {} }) });
  await assert.rejects(remote.provider.assess(remote.input), /local completion/);
  const truncated = fixture({ '/api/chat': () => json({ done: true, done_reason: 'length', message: { content: '{}' } }) });
  await assert.rejects(truncated.provider.assess(truncated.input), /incomplete/);
});
test('embedding-only models are not offered for assessment', async () => {
  const f = fixture({ '/api/show': () => json({ model_info: {}, details: model.details, capabilities: ['embedding'] }) });
  assert.deepEqual((await f.provider.models()).models, []);
});
test('oversize responses stop the read', async () => {
  const f = fixture({ '/api/chat': () => json({ text: 'x'.repeat(1024 * 1024) }) });
  await assert.rejects(f.provider.assess(f.input), /size limit/);
});
test('old runtimes and context overflow fail rather than silently assessing truncated evidence', async () => {
  const old = fixture({ '/api/version': () => json({ version: '0.14.0' }) });
  await assert.rejects(old.provider.assess(old.input), /0.15.4/);
  assert.equal(old.calls.some(row => row.url.endsWith('/api/chat')), false);
  const overflow = fixture({ '/api/chat': () => new Response('{"error":"context length exceeded"}', { status: 400 }) });
  await assert.rejects(overflow.provider.assess(overflow.input), /failed \(400\)/);
});
