import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import {
  createTelemetry,
  localEndpoint,
} from '../src/observability/telemetry.mjs'
import { createLocalGrafana, IMAGE } from '../src/observability/stack.mjs'
import { grafanaLocation } from '../src/observability/locations.mjs'
const event = {
  operation: 'search',
  outcome: 'ok',
  role: 'mcp',
  at: Date.now(),
  durationMs: 5,
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  instanceId: 'c'.repeat(16),
  query: 'secret prompt',
}
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-observe-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}
test('only explicit loopback OTLP destinations are accepted', () => {
  for (const x of [
    'https://example.com',
    'http://127.0.0.1:12@evil.com',
    'http://localhost:4318',
    'http://127.0.0.1:4318/path',
    'http://127.0.0.1:4318?x=y',
  ])
    assert.equal(localEndpoint(x), null)
  assert.equal(localEndpoint('http://127.0.0.1:4318'), 'http://127.0.0.1:4318')
})
test('open-in-browser accepts fixed views and never a renderer-supplied destination', () => {
  const url = grafanaLocation('http://127.0.0.1:3000', {
    traceId: 'a'.repeat(32),
    range: 'now-1h',
    theme: 'dark',
  })
  assert.ok(url.includes('/d/contextcake-trace/trace?var-traceId='))
  assert.ok(url.includes('theme=dark'))
  for (const options of [
    { traceId: 'https://evil.test' },
    { range: 'now&redirect=evil' },
    { theme: 'other' },
  ])
    assert.throws(() => grafanaLocation('http://127.0.0.1:3000', options))
  assert.throws(() => grafanaLocation('https://evil.test'))
})
test('OTLP batches are bounded, content-free and report delivery failures', async (t) => {
  const dir = await temp(t),
    configPath = path.join(dir, 'local-observability.json')
  await fs.writeFile(
    configPath,
    JSON.stringify({ enabled: true, endpoint: 'http://127.0.0.1:4318' }),
  )
  const bodies = []
  const telemetry = createTelemetry({
    configPath,
    capacity: 2,
    fetcher: async (url, options) => {
      bodies.push([url, JSON.parse(options.body)])
      return { ok: true, json: async () => ({}) }
    },
  })
  t.after(() => telemetry.close())
  for (let i = 0; i < 5; i++)
    channel('contextcake.diagnostics.v1').publish(event)
  assert.equal(telemetry.status().queued, 2)
  assert.equal(telemetry.status().dropped, 3)
  await telemetry.flush()
  assert.equal(telemetry.status().sent, 2)
  assert.equal(bodies.length, 3)
  for (const metric of bodies[2][1].resourceMetrics[0].scopeMetrics[0].metrics)
    assert.ok(
      (metric.sum ?? metric.gauge ?? metric.histogram).dataPoints.length > 0,
    )
  assert.ok(!JSON.stringify(bodies).includes('secret prompt'))
  assert.ok(bodies[0][1].resourceSpans[0].scopeSpans[0].spans[0].traceId)
})
test('disabled configuration never makes a network request', async (t) => {
  const dir = await temp(t)
  let requests = 0
  const telemetry = createTelemetry({
    configPath: path.join(dir, 'absent'),
    fetcher: async () => {
      requests++
    },
  })
  t.after(() => telemetry.close())
  channel('contextcake.diagnostics.v1').publish(event)
  await telemetry.flush()
  assert.equal(requests, 0)
  assert.equal(telemetry.status().state, 'disabled')
})
test('history clearing resets exporter totals and trace evidence, ordinary restart preserves them', async (t) => {
  const directory = await temp(t),
    configPath = path.join(directory, 'config')
  const configure = (generation, endpoint = 'http://127.0.0.1:4318') =>
    fs.writeFile(
      configPath,
      JSON.stringify({
        enabled: true,
        endpoint,
        historyGeneration: generation,
      }),
    )
  const payloads = []
  const telemetry = createTelemetry({
    configPath,
    fetcher: async (url, options) => {
      payloads.push([url, JSON.parse(options.body)])
      return { ok: true, json: async () => ({}) }
    },
  })
  t.after(() => telemetry.close())
  await configure(0)
  channel('contextcake.diagnostics.v1').publish(event)
  await telemetry.flush()
  assert.deepEqual(telemetry.status().exportedTraceIds, [event.traceId])
  await configure(0, null)
  await telemetry.flush()
  await configure(0)
  await telemetry.flush()
  assert.deepEqual(telemetry.status().exportedTraceIds, [event.traceId])
  channel('contextcake.diagnostics.v1').publish(event)
  await configure(1, null)
  await telemetry.flush()
  assert.equal(telemetry.status().historyGeneration, 1)
  assert.deepEqual(telemetry.status().exportedTraceIds, [])
  assert.equal(telemetry.status().queued, 0)
  await configure(1)
  await telemetry.flush()
  const metrics = payloads.filter(([url]) => url.endsWith('/metrics')).at(-1)[1]
    .resourceMetrics[0].scopeMetrics[0].metrics
  assert.ok(!metrics.some((metric) => metric.name === 'contextcake.operations'))
  const fresh = { ...event, traceId: 'd'.repeat(32) }
  channel('contextcake.diagnostics.v1').publish(fresh)
  await telemetry.flush()
  assert.deepEqual(telemetry.status().exportedTraceIds, [fresh.traceId])
})
test('an exporter first observing a cleared history retains only post-clear startup events', async (t) => {
  const directory = await temp(t),
    configPath = path.join(directory, 'config'),
    clearedAt = Date.now()
  await fs.writeFile(
    configPath,
    JSON.stringify({
      enabled: true,
      endpoint: 'http://127.0.0.1:4318',
      historyGeneration: 1,
      historyClearedAt: clearedAt,
    }),
  )
  const telemetry = createTelemetry({
    configPath,
    fetcher: async () => ({ ok: true, json: async () => ({}) }),
  })
  t.after(() => telemetry.close())
  channel('contextcake.diagnostics.v1').publish({ ...event, at: clearedAt - 1 })
  channel('contextcake.diagnostics.v1').publish({
    ...event,
    at: clearedAt + 1,
    traceId: 'e'.repeat(32),
  })
  await telemetry.flush()
  assert.deepEqual(telemetry.status().exportedTraceIds, ['e'.repeat(32)])
  assert.equal(telemetry.status().sent, 1)
  assert.equal(telemetry.status().dropped, 1)
})
test('failed collector responses drop a bounded batch and preserve the caller', async (t) => {
  const dir = await temp(t),
    configPath = path.join(dir, 'config')
  await fs.writeFile(
    configPath,
    JSON.stringify({ enabled: true, endpoint: 'http://127.0.0.1:4318' }),
  )
  const telemetry = createTelemetry({
    configPath,
    fetcher: async () => {
      throw new Error('secret')
    },
  })
  t.after(() => telemetry.close())
  channel('contextcake.diagnostics.v1').publish(event)
  await telemetry.flush()
  assert.equal(telemetry.status().state, 'unavailable')
  assert.equal(telemetry.status().queued, 0)
})
test('disabled stack does nothing and stopped Docker does not trigger installation', async (t) => {
  const directory = await temp(t)
  let calls = []
  const stack = createLocalGrafana({
    directory,
    run: async (args) => {
      calls.push(args)
      throw new Error('stopped')
    },
  })
  await stack.load()
  await stack.start()
  assert.equal(calls.length, 0)
  await stack.start({ enable: true })
  assert.equal(stack.status().state, 'docker-stopped')
  assert.equal(calls.length, 1)
})
test('a foreign container cannot be adopted, stopped or erased', async (t) => {
  const directory = await temp(t)
  const calls = []
  const run = async (args) => {
    calls.push(args)
    if (args[0] === 'info') return '1'
    if (args[0] === 'ps') return 'foreign'
    if (args[0] === 'inspect')
      return JSON.stringify([
        { Config: { Image: IMAGE, Labels: {} }, State: { Running: true } },
      ])
    throw Error('unexpected')
  }
  const stack = createLocalGrafana({ directory, run })
  await stack.start({ enable: true })
  assert.equal(stack.status().failure, 'OWNERSHIP_MISMATCH')
  await stack.clear()
  assert.ok(!calls.some((a) => ['stop', 'rm'].includes(a[0])))
})

function fakeDocker(directory, { pullFailure = false, stopped = false } = {}) {
  const id = createHash('sha256')
    .update(path.resolve(directory))
    .digest('hex')
    .slice(0, 16)
  const label = {
      'com.contextcake.observability': id,
      'com.contextcake.observability.config': '1',
    },
    calls = []
  let container = null,
    volume = false
  const run = async (args) => {
    calls.push(args)
    switch (args[0]) {
      case 'info':
        if (stopped) throw Error('offline')
        return '27'
      case 'ps':
        return container ? 'owned' : ''
      case 'pull':
        if (pullFailure) throw Error('download failed')
        return ''
      case 'inspect':
        return JSON.stringify([container])
      case 'volume':
        if (args[1] === 'ls') return volume ? 'owned' : ''
        if (args[1] === 'create') {
          volume = true
          return 'owned'
        }
        if (args[1] === 'inspect') return JSON.stringify([{ Labels: label }])
        if (args[1] === 'rm') {
          volume = false
          return ''
        }
        break
      case 'create':
        container = {
          Config: { Image: IMAGE, Labels: label },
          State: { Running: false },
          NetworkSettings: {
            Ports: {
              '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '12345' }],
              '4318/tcp': [{ HostIp: '127.0.0.1', HostPort: '12346' }],
            },
          },
        }
        return 'owned'
      case 'start':
        container.State.Running = true
        return ''
      case 'stop':
        container.State.Running = false
        return ''
      case 'rm':
        container = null
        return ''
    }
    throw Error(`Unexpected ${args[0]}`)
  }
  return {
    run,
    calls,
    crash() {
      container.State.Running = false
    },
    get volume() {
      return volume
    },
  }
}
test('concurrent startup, relaunch adoption, retained history and explicit clearing', async (t) => {
  const directory = await temp(t),
    docker = fakeDocker(directory),
    fetcher = async () => ({ ok: true })
  const stack = createLocalGrafana({ directory, run: docker.run, fetcher })
  await Promise.all([
    stack.start({ enable: true }),
    stack.start({ enable: true }),
  ])
  assert.equal(stack.status().state, 'ready')
  assert.equal(docker.calls.filter((c) => c[0] === 'create').length, 1)
  const created = docker.calls.find((c) => c[0] === 'create')
  assert.ok(created.includes('127.0.0.1::3000'))
  assert.ok(created.includes('127.0.0.1::4318'))
  assert.ok(!created.some((a) => a.includes('docker.sock')))
  const relaunched = createLocalGrafana({ directory, run: docker.run, fetcher })
  await relaunched.load()
  await relaunched.start()
  assert.equal(docker.calls.filter((c) => c[0] === 'create').length, 1)
  await relaunched.stop()
  assert.equal(docker.volume, true)
  await relaunched.start()
  docker.crash()
  await relaunched.refresh()
  assert.equal(relaunched.status().failure, 'CONTAINER_STOPPED')
  await relaunched.clear()
  assert.equal(docker.volume, false)
  assert.equal(relaunched.status().historyGeneration, 1)
  const afterClear = createLocalGrafana({ directory, run: docker.run, fetcher })
  await afterClear.load()
  assert.equal(afterClear.status().historyGeneration, 1)
})
test('download failures and slow readiness remain explicit without blocking callers', async (t) => {
  const directory = await temp(t),
    failed = fakeDocker(directory, { pullFailure: true })
  const stack = createLocalGrafana({ directory, run: failed.run })
  await stack.start({ enable: true })
  assert.equal(stack.status().state, 'failed')
  assert.ok(!failed.calls.some((c) => c[0] === 'create'))
  const slow = fakeDocker(directory),
    waiting = createLocalGrafana({
      directory,
      run: slow.run,
      fetcher: async () => ({ ok: false }),
      readyTimeoutMs: 1,
    })
  await waiting.start({ enable: true })
  assert.equal(waiting.status().failure, 'START_TIMEOUT')
  await waiting.stop()
})
for (const checkpoint of ['info', 'ps', 'image']) {
  test(`quit during ${checkpoint} inspection cannot begin a late download`, async (t) => {
    const directory = await temp(t),
      docker = fakeDocker(directory)
    let reached,
      release,
      held = false
    const entered = new Promise((resolve) => {
      reached = resolve
    })
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const stack = createLocalGrafana({
      directory,
      run: async (args, ...rest) => {
        if (!held && args[0] === checkpoint) {
          held = true
          reached()
          await gate
        }
        return docker.run(args, ...rest)
      },
    })
    const starting = stack.start({ enable: true })
    await entered
    const stopping = stack.stop()
    release()
    await Promise.all([starting, stopping])
    assert.equal(stack.status().state, 'stopped')
    assert.ok(
      !docker.calls.some((args) =>
        ['pull', 'create', 'start'].includes(args[0]),
      ),
    )
  })
}
test('quit cancels an image download and prevents a late container creation', async (t) => {
  const directory = await temp(t),
    docker = fakeDocker(directory)
  let began
  const started = new Promise((r) => (began = r))
  const run = (args, timeout, signal) =>
    args[0] === 'pull'
      ? new Promise((resolve, reject) => {
          began()
          signal.addEventListener('abort', () => reject(Error('aborted')), {
            once: true,
          })
        })
      : docker.run(args)
  const stack = createLocalGrafana({ directory, run })
  const starting = stack.start({ enable: true })
  await started
  await stack.stop()
  await starting
  assert.equal(stack.status().state, 'stopped')
  assert.ok(!docker.calls.some((c) => c[0] === 'create'))
})
test('candidateCount/storeSyncMs and phase/backend are exported as bounded, phase-tagged gauges', async (t) => {
  const directory = await temp(t),
    configPath = path.join(directory, 'config')
  await fs.writeFile(
    configPath,
    JSON.stringify({ enabled: true, endpoint: 'http://127.0.0.1:4318' }),
  )
  let metrics, spans
  const telemetry = createTelemetry({
    configPath,
    fetcher: async (url, options) => {
      if (url.endsWith('/metrics'))
        metrics = JSON.parse(options.body).resourceMetrics[0].scopeMetrics[0]
          .metrics
      if (url.endsWith('/traces'))
        spans = JSON.parse(options.body).resourceSpans[0].scopeSpans[0].spans
      return { ok: true, json: async () => ({}) }
    },
  })
  t.after(() => telemetry.close())
  channel('contextcake.diagnostics.v1').publish({
    ...event,
    phase: 'cold',
    backend: 'sqlite',
    candidateCount: 42,
    storeSyncMs: 7.5,
    decodedRecords: 3,
  })
  // A non-search event carrying a stray `phase` must not export one — the
  // core's own safeEvent() only ever attaches phase to a search event, but
  // the adapter independently allowlists at export and must not trust it.
  channel('contextcake.diagnostics.v1').publish({
    ...event,
    operation: 'read',
    phase: 'cold',
    backend: 'memory',
  })
  await telemetry.flush()
  const candidateGauge = metrics.find((m) => m.name === 'contextcake.candidateCount')
  assert.equal(candidateGauge.gauge.dataPoints.length, 1)
  assert.equal(candidateGauge.gauge.dataPoints[0].asDouble, 42)
  assert.ok(
    candidateGauge.gauge.dataPoints[0].attributes.some(
      (a) => a.key === 'phase' && a.value.stringValue === 'cold',
    ),
  )
  const syncGauge = metrics.find((m) => m.name === 'contextcake.storeSyncMs')
  assert.equal(syncGauge.gauge.dataPoints[0].asDouble, 7.5)
  const searchSpan = spans.find((s) => s.name === 'contextcake.search')
  assert.ok(
    searchSpan.attributes.some(
      (a) => a.key === 'phase' && a.value.stringValue === 'cold',
    ),
  )
  assert.ok(
    searchSpan.attributes.some(
      (a) => a.key === 'backend' && a.value.stringValue === 'sqlite',
    ),
  )
  const readSpan = spans.find((s) => s.name === 'contextcake.read')
  assert.ok(!readSpan.attributes.some((a) => a.key === 'phase'))
  assert.ok(
    readSpan.attributes.some(
      (a) => a.key === 'backend' && a.value.stringValue === 'memory',
    ),
  )
})
test('untrusted event values cannot expand metric cardinality or export secrets', async (t) => {
  const directory = await temp(t),
    configPath = path.join(directory, 'config')
  await fs.writeFile(
    configPath,
    JSON.stringify({ enabled: true, endpoint: 'http://127.0.0.1:4318' }),
  )
  const bodies = []
  const telemetry = createTelemetry({
    configPath,
    fetcher: async (url, o) => {
      bodies.push(o.body)
      return { ok: true, json: async () => ({}) }
    },
  })
  t.after(() => telemetry.close())
  for (let i = 0; i < 1000; i++)
    channel('contextcake.diagnostics.v1').publish({
      ...event,
      outcome: `secret-${i}`,
    })
  channel('contextcake.diagnostics.v1').publish({
    ...event,
    resultCount: 'secret',
    traceId: 'secret',
  })
  await telemetry.flush()
  assert.equal(telemetry.status().sent, 1)
  assert.ok(!bodies.join('').includes('secret'))
})

test('an unresponsive collector has bounded queues and request deadlines', async (t) => {
  const { createServer } = await import('node:http')
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const directory = await temp(t),
    configPath = path.join(directory, 'config')
  await fs.writeFile(
    configPath,
    JSON.stringify({
      enabled: true,
      endpoint: `http://127.0.0.1:${server.address().port}`,
    }),
  )
  const telemetry = createTelemetry({ configPath, capacity: 2 })
  t.after(() => telemetry.close())
  for (let i = 0; i < 10000; i++)
    channel('contextcake.diagnostics.v1').publish(event)
  assert.equal(telemetry.status().queued, 2)
  const start = performance.now()
  await telemetry.flush()
  assert.ok(performance.now() - start < 4000)
  assert.equal(telemetry.status().queued, 0)
  assert.equal(telemetry.status().dropped, 10000)
  assert.equal(telemetry.status().state, 'unavailable')
})

test('configuration write failure never prevents owned container cleanup', async (t) => {
  const directory = await temp(t),
    docker = fakeDocker(directory)
  const stack = createLocalGrafana({
    directory,
    run: docker.run,
    fetcher: async () => ({ ok: true }),
  })
  await stack.start({ enable: true })
  await fs.mkdir(`${stack.configPath}.tmp`)
  await stack.stop()
  assert.equal(stack.status().state, 'failed')
  assert.equal(stack.status().failure, 'CONFIG_WRITE_FAILED')
  assert.ok(docker.calls.some((args) => args[0] === 'stop'))
  assert.equal(docker.volume, true)
})

test('duration histograms represent multi-minute and maximum-budget indexes', async (t) => {
  const directory = await temp(t),
    configPath = path.join(directory, 'config')
  await fs.writeFile(
    configPath,
    JSON.stringify({ enabled: true, endpoint: 'http://127.0.0.1:4318' }),
  )
  let metrics
  const telemetry = createTelemetry({
    configPath,
    fetcher: async (url, options) => {
      if (url.endsWith('/metrics'))
        metrics = JSON.parse(options.body).resourceMetrics[0].scopeMetrics[0]
          .metrics
      return { ok: true, json: async () => ({}) }
    },
  })
  t.after(() => telemetry.close())
  channel('contextcake.diagnostics.v1').publish({
    ...event,
    operation: 'index',
    durationMs: 60000,
  })
  channel('contextcake.diagnostics.v1').publish({
    ...event,
    operation: 'index',
    durationMs: 7200000,
  })
  await telemetry.flush()
  const point = metrics.find((m) => m.name === 'contextcake.duration').histogram
    .dataPoints[0]
  assert.ok(point.explicitBounds.at(-1) > 7200000)
  assert.equal(point.bucketCounts[point.explicitBounds.indexOf(60000)], '1')
  assert.equal(point.bucketCounts[point.explicitBounds.indexOf(7200000)], '1')
  assert.equal(point.bucketCounts.at(-1), '0')
})
