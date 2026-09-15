import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)
export const IMAGE =
  'grafana/otel-lgtm:0.33.0@sha256:f85f5f8fc8015e238367f6a75b48757134f1d767413ff369e18b74ebd07fcd79'
const CONFIG_VERSION = '1'
const OWNER = 'com.contextcake.observability'
const here = path.dirname(fileURLToPath(import.meta.url))
export async function docker(args, timeout = 15_000, signal) {
  let executable = '/usr/local/bin/docker'
  for (const candidate of [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
  ]) {
    try {
      await fs.access(candidate)
      executable = candidate
      break
    } catch {}
  }
  const result = await exec(
    executable,
    [
      '--host',
      `unix://${path.join(os.homedir(), '.docker/run/docker.sock')}`,
      ...args,
    ],
    {
      timeout,
      signal,
      maxBuffer: 512_000,
      env: {
        HOME: os.homedir(),
        PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
      },
    },
  )
  return result.stdout.trim()
}
export function createLocalGrafana({
  directory,
  run = docker,
  fetcher = fetch,
  readyTimeoutMs = 120_000,
  provisioningPath = path.join(here, 'provisioning'),
} = {}) {
  const id = createHash('sha256')
    .update(path.resolve(directory))
    .digest('hex')
    .slice(0, 16)
  const name = `contextcake-observability-${id}`,
    volume = `${name}-data`
  const configPath = path.join(directory, 'local-observability.json')
  let enabled = false,
    historyGeneration = 0,
    historyClearedAt = 0,
    state = 'disabled',
    origin = null,
    endpoint = null,
    failure = null,
    epoch = 0,
    pending = null,
    stopping = null,
    clearing = null,
    pulling = null,
    saves = Promise.resolve()
  const status = () => ({
    enabled,
    historyGeneration,
    state,
    origin: state === 'ready' ? origin : null,
    failure,
    experimental: true,
    restartClients: true,
  })
  function save() {
    const value = JSON.stringify({
      version: 1,
      enabled,
      historyGeneration,
      historyClearedAt,
      endpoint: state === 'ready' ? endpoint : null,
    })
    saves = saves
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        const temp = `${configPath}.tmp`
        await fs.writeFile(temp, value, { mode: 0o600 })
        await fs.rename(temp, configPath)
      })
    return saves
  }
  async function inspect() {
    // Listing distinguishes missing from an inaccessible daemon; never erase state after an arbitrary inspect error.
    const ids = await run(['ps', '-aq', '--filter', `name=^/${name}$`])
    if (!ids) return null
    const row = JSON.parse(await run(['inspect', name]))[0]
    if (row?.Config?.Labels?.[OWNER] !== id || row.Config.Image !== IMAGE)
      throw new Error('OWNERSHIP_MISMATCH')
    const bindings = Object.values(row.HostConfig?.PortBindings ?? {}).flat()
    if (bindings.some((b) => b.HostIp !== '127.0.0.1'))
      throw new Error('INVALID_BINDING')
    if (
      row.Mounts?.some(
        (m) =>
          ![
            '/data',
            '/contextcake',
            '/otel-lgtm/loki-config.yaml',
            '/otel-lgtm/tempo-config.yaml',
            '/otel-lgtm/otelcol-config.yaml',
          ].includes(m.Destination) ||
          (m.Destination !== '/data' && m.RW),
      )
    )
      throw new Error('OWNERSHIP_MISMATCH')
    if (
      row.Mounts?.some(
        (m) =>
          m.Destination === '/data' &&
          (m.Type !== 'volume' || m.Name !== volume),
      )
    )
      throw new Error('OWNERSHIP_MISMATCH')
    return row
  }
  async function load() {
    try {
      const saved = JSON.parse(await fs.readFile(configPath, 'utf8'))
      enabled = saved.version === 1 && saved.enabled === true
      historyGeneration =
        Number.isSafeInteger(saved.historyGeneration) &&
        saved.historyGeneration >= 0
          ? saved.historyGeneration
          : 0
      historyClearedAt = Number.isFinite(saved.historyClearedAt)
        ? saved.historyClearedAt
        : 0
    } catch {}
    state = enabled ? 'stopped' : 'disabled'
    failure = null
    return status()
  }
  async function start({ enable = false } = {}) {
    const requestedEpoch = epoch
    if (clearing) await clearing
    if (stopping) await stopping
    if (requestedEpoch !== epoch) return status()
    if (pending) return pending
    if (enable) enabled = true
    if (!enabled) return status()
    const ticket = ++epoch
    pending = (async () => {
      failure = null
      state = 'starting'
      try {
        await save()
        if (ticket !== epoch) return status()
        try {
          await run(['info', '--format', '{{.ServerVersion}}'])
        } catch {
          if (ticket !== epoch) return status()
          state = 'docker-stopped'
          return status()
        }
        if (ticket !== epoch) return status()
        let row = await inspect()
        if (ticket !== epoch) return status()
        if (row && row.Config.Labels[`${OWNER}.config`] !== CONFIG_VERSION) {
          if (row.State.Running) await run(['stop', '--time', '5', name])
          if (ticket !== epoch) return status()
          await run(['rm', name]) // Retain the owned volume across configuration upgrades.
          if (ticket !== epoch) return status()
          row = null
        }
        const provision = path.join(directory, 'grafana-provisioning')
        if (!row?.State.Running) {
          await fs.mkdir(provision, { recursive: true, mode: 0o700 })
          if (ticket !== epoch) return status()
          await fs.cp(provisioningPath, provision, { recursive: true })
          if (ticket !== epoch) return status()
        }
        if (!row) {
          let imageAvailable = false
          try {
            await run(['image', 'inspect', IMAGE])
            imageAvailable = true
          } catch {}
          // Stop can arrive while image inspection is pending, before there is
          // a pull controller to abort. Never begin new work for that startup.
          if (ticket !== epoch) return status()
          if (!imageAvailable) {
            state = 'downloading'
            pulling = new AbortController()
            try {
              await run(['pull', IMAGE], 600_000, pulling.signal)
            } finally {
              pulling = null
            }
          }
          if (ticket !== epoch) return status()
          state = 'starting'
          const existing = await run([
            'volume',
            'ls',
            '-q',
            '--filter',
            `name=^${volume}$`,
          ])
          if (ticket !== epoch) return status()
          if (existing) {
            const v = JSON.parse(await run(['volume', 'inspect', volume]))[0]
            if (ticket !== epoch) return status()
            if (v?.Labels?.[OWNER] !== id) throw new Error('OWNERSHIP_MISMATCH')
          } else
            await run(['volume', 'create', '--label', `${OWNER}=${id}`, volume])
          if (ticket !== epoch) return status()
          await run([
            'create',
            '--name',
            name,
            '--label',
            `${OWNER}=${id}`,
            '--label',
            `${OWNER}.config=${CONFIG_VERSION}`,
            '--cpus',
            '2',
            '--memory',
            '2g',
            '--log-opt',
            'max-size=5m',
            '--log-opt',
            'max-file=2',
            '-p',
            '127.0.0.1::3000',
            '-p',
            '127.0.0.1::4318',
            '-v',
            `${volume}:/data`,
            '-v',
            `${provision}:/contextcake:ro`,
            '-e',
            'GF_SECURITY_ALLOW_EMBEDDING=true',
            '-e',
            'GF_AUTH_ANONYMOUS_ENABLED=true',
            '-e',
            'GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer',
            '-e',
            'GF_AUTH_DISABLE_LOGIN_FORM=true',
            '-e',
            'GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION=true',
            '-e',
            'GF_USERS_ALLOW_SIGN_UP=false',
            '-e',
            'GF_NEWS_NEWS_FEED_ENABLED=false',
            '-e',
            'GF_PLUGINS_PREINSTALL_DISABLED=true',
            '-e',
            'GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/contextcake/dashboards/contextcake.json',
            '-e',
            'GF_ANALYTICS_REPORTING_ENABLED=false',
            '-e',
            'GF_ANALYTICS_CHECK_FOR_UPDATES=false',
            '-e',
            'GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false',
            '-e',
            'ENABLE_LOGS_ALL=true',
            '-e',
            'TEMPO_EXTRA_ARGS=-backend-scheduler.provider.work.compaction.block-retention=24h -backend-worker.compaction.block-retention=24h',
            '-e',
            'PYROSCOPE_EXTRA_ARGS=-usage-stats.enabled=false -retention-period=24h -self-profiling.disable-push=true',
            '-e',
            'GF_PATHS_PROVISIONING=/contextcake/grafana',
            '-e',
            'PROMETHEUS_EXTRA_ARGS=--storage.tsdb.retention.time=24h --storage.tsdb.retention.size=512MB',
            '-v',
            `${provision}/loki.yaml:/otel-lgtm/loki-config.yaml:ro`,
            '-v',
            `${provision}/tempo.yaml:/otel-lgtm/tempo-config.yaml:ro`,
            '-v',
            `${provision}/collector.yaml:/otel-lgtm/otelcol-config.yaml:ro`,
            IMAGE,
          ])
          row = await inspect()
        }
        if (ticket !== epoch) return status()
        if (!row.State.Running) await run(['start', name])
        const deadline = Date.now() + readyTimeoutMs
        while (ticket === epoch && Date.now() < deadline) {
          row = await inspect()
          if (ticket !== epoch) return status()
          if (!row?.State.Running) throw new Error('CONTAINER_STOPPED')
          const port = (key) => {
            const binding = row.NetworkSettings?.Ports?.[`${key}/tcp`]?.[0]
            if (
              binding?.HostIp !== '127.0.0.1' ||
              !/^\d+$/.test(binding.HostPort)
            )
              throw new Error('INVALID_BINDING')
            return `http://127.0.0.1:${binding.HostPort}`
          }
          origin = port(3000)
          endpoint = port(4318)
          try {
            const res = await fetcher(`${origin}/api/health`, {
              redirect: 'error',
              signal: AbortSignal.timeout(1500),
            })
            if (ticket !== epoch) return status()
            const collector = await fetcher(`${endpoint}/v1/traces`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
              redirect: 'error',
              signal: AbortSignal.timeout(1500),
            })
            if (res.ok && collector.ok && ticket === epoch) {
              state = 'ready'
              await save()
              return status()
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 500))
        }
        if (ticket === epoch) throw new Error('START_TIMEOUT')
      } catch (error) {
        if (ticket === epoch) {
          state = 'failed'
          failure = [
            'OWNERSHIP_MISMATCH',
            'INVALID_BINDING',
            'CONTAINER_STOPPED',
            'START_TIMEOUT',
          ].includes(error.message)
            ? error.message
            : 'LOCAL_STACK_FAILED'
        }
      } finally {
        if (ticket === epoch)
          await save().catch(() => {
            state = 'failed'
            failure = 'CONFIG_WRITE_FAILED'
          })
      }
      return status()
    })().finally(() => {
      pending = null
    })
    return pending
  }
  function stop() {
    if (stopping) return stopping
    const wasActive = enabled || pending || state !== 'disabled'
    ++epoch
    pulling?.abort()
    state = enabled ? 'stopped' : 'disabled'
    failure = null
    origin = null
    endpoint = null
    stopping = (async () => {
      // A full disk must not prevent shutting down the owned container. Report
      // persistence failure, but still complete the independent Docker cleanup.
      try {
        await save()
      } catch {
        failure = 'CONFIG_WRITE_FAILED'
        state = 'failed'
      }
      // Creates finish before inspection, while a potentially long pull is cancelled.
      await pending
      if (!wasActive) return status()
      try {
        await run(['info', '--format', '{{.ServerVersion}}'])
      } catch {
        return status()
      } // Docker stopped means no running container to stop.
      try {
        const row = await inspect()
        if (row?.State.Running) await run(['stop', '--time', '5', name])
      } catch {
        failure = 'STOP_FAILED'
        state = 'failed'
      }
      return status()
    })().finally(() => {
      stopping = null
    })
    return stopping
  }
  function clear() {
    if (clearing) return clearing
    clearing = (async () => {
      await stop()
      if (state === 'failed') return status()
      const row = await inspect()
      const found = await run([
        'volume',
        'ls',
        '-q',
        '--filter',
        `name=^${volume}$`,
      ])
      if (found) {
        const v = JSON.parse(await run(['volume', 'inspect', volume]))[0]
        if (v?.Labels?.[OWNER] !== id) throw new Error('OWNERSHIP_MISMATCH')
      }
      // Persist the reset before deleting storage: existing MCP exporters must
      // not refill a fresh backend with pre-clear cumulative observations.
      historyGeneration++
      historyClearedAt = Date.now()
      await save()
      if (row) await run(['rm', name])
      if (found) await run(['volume', 'rm', volume])
      return status()
    })().finally(() => {
      clearing = null
    })
    return clearing
  }
  async function refresh() {
    if (state === 'ready') {
      try {
        if (!(await inspect())?.State.Running) {
          state = 'failed'
          origin = null
          endpoint = null
          failure = 'CONTAINER_STOPPED'
          await save()
        }
      } catch {
        state = 'failed'
        failure = 'DOCKER_UNAVAILABLE'
        origin = null
        endpoint = null
        await save()
      }
    }
    return status()
  }
  return {
    status,
    refresh,
    load,
    start,
    stop,
    clear,
    async disable() {
      enabled = false
      return stop()
    },
    configPath,
  }
}
