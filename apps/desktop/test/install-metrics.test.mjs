import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  INSTALL_METRIC_MARKER,
  installMetricAsset,
  installMetricUrl,
  reportFirstLaunch,
} from '../src/main/install-metrics.mjs'

test('each platform build counts against its own release asset', () => {
  // The names mirror scripts/release-platforms.mjs; the root release test
  // checks every table row against installMetricAsset.
  assert.equal(installMetricAsset({ platform: 'darwin', arch: 'arm64' }), 'install-ping-mac-arm64.txt')
  assert.equal(installMetricAsset({ platform: 'darwin', arch: 'x64' }), 'install-ping-mac-x64.txt')
  assert.equal(installMetricAsset({ platform: 'win32', arch: 'x64' }), null)
  assert.equal(
    installMetricUrl('0.4.0', 'install-ping-mac-x64.txt'),
    'https://github.com/ContextCake/context-cake/releases/download/app-v0.4.0/install-ping-mac-x64.txt',
  )
  assert.throws(() => installMetricUrl('0.4.0', '../SHA256SUMS'), /Invalid install metric asset/)
})

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
    platform: 'darwin',
    arch: 'x64',
    fetchImpl,
    now: () => new Date('2026-08-03T12:00:00.000Z'),
  }), { status: 'reported' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, installMetricUrl('0.4.0', 'install-ping-mac-x64.txt'))
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
  assert.throws(() => installMetricUrl('../not-a-version', 'install-ping-mac-arm64.txt'), /Invalid ContextCake version/)
})

test('a platform with no release row never reports', async () => {
  assert.deepEqual(await reportFirstLaunch({
    isPackaged: true,
    version: '0.4.0',
    configDir: '/unused',
    metricsEnabled: true,
    platform: 'win32',
    arch: 'x64',
    fetchImpl: () => assert.fail('fetch must not run'),
  }), { status: 'unsupported' })
})

test('overlapping triggers coalesce into one download', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-install-metric-'))
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }))
  let finish
  let requests = 0
  const fetchImpl = () => {
    requests += 1
    return new Promise((resolve) => { finish = resolve })
  }
  const options = {
    isPackaged: true,
    version: '0.4.0',
    configDir,
    metricsEnabled: true,
    fetchImpl,
  }

  const first = reportFirstLaunch(options)
  const second = reportFirstLaunch(options)
  assert.equal(requests, 1)
  finish({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) })
  assert.deepEqual(await Promise.all([first, second]), [{ status: 'reported' }, { status: 'reported' }])
  assert.equal(requests, 1)
})

test('opting out cancels an in-flight download without writing a marker', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-install-metric-'))
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }))
  const controller = new AbortController()
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })

  const pending = reportFirstLaunch({
    isPackaged: true,
    version: '0.4.0',
    configDir,
    metricsEnabled: true,
    fetchImpl,
    signal: controller.signal,
  })
  controller.abort()

  assert.deepEqual(await pending, { status: 'cancelled' })
  assert.equal(fs.existsSync(path.join(configDir, INSTALL_METRIC_MARKER)), false)
})
