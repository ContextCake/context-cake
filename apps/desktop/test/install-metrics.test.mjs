import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  INSTALL_METRIC_MARKER,
  installMetricUrl,
  reportFirstLaunch,
} from '../src/main/install-metrics.mjs'

test('first packaged launch reports once and persists no identifier', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-install-metric-'))
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }))
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url, options })
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }
  }

  assert.deepEqual(await reportFirstLaunch({
    isPackaged: true,
    version: '0.4.0',
    configDir,
    metricsEnabled: true,
    fetchImpl,
    now: () => new Date('2026-08-03T12:00:00.000Z'),
  }), { status: 'reported' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, installMetricUrl('0.4.0'))
  assert.equal(requests[0].options.method, 'GET')

  const marker = fs.readFileSync(path.join(configDir, INSTALL_METRIC_MARKER), 'utf8')
  assert.deepEqual(JSON.parse(marker), {
    reportedAt: '2026-08-03T12:00:00.000Z',
    version: '0.4.0',
  })
  assert.doesNotMatch(marker, /id|token|email|path/i)

  assert.deepEqual(await reportFirstLaunch({
    isPackaged: true,
    version: '0.4.0',
    configDir,
    metricsEnabled: true,
    fetchImpl,
  }), { status: 'already-reported' })
  assert.equal(requests.length, 1)
})

test('development builds and disabled anonymous metrics never report', async () => {
  const fetchImpl = () => assert.fail('fetch must not run')
  assert.deepEqual(await reportFirstLaunch({
    isPackaged: false,
    version: '0.4.0',
    configDir: '/unused',
    fetchImpl,
  }), { status: 'development' })
  assert.deepEqual(await reportFirstLaunch({
    isPackaged: true,
    version: '0.4.0',
    configDir: '/unused',
    metricsEnabled: false,
    fetchImpl,
  }), { status: 'disabled' })
})

test('failed requests do not mark the launch as reported', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-install-metric-'))
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }))

  assert.deepEqual(await reportFirstLaunch({
    isPackaged: true,
    version: '0.4.0',
    configDir,
    metricsEnabled: true,
    fetchImpl: async () => ({ ok: false, status: 404 }),
  }), { status: 'failed', httpStatus: 404 })
  assert.equal(fs.existsSync(path.join(configDir, INSTALL_METRIC_MARKER)), false)
  assert.throws(() => installMetricUrl('../not-a-version'), /Invalid ContextCake version/)
})
