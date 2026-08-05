// Supervises the engine, which runs in its own Electron utilityProcess
// (engine-process.mjs) rather than on the main process.
//
// Why a separate process: the engine walks folders, parses markdown, runs a
// BPE tokenizer and spawns foreign MCP servers. On the main process all of
// that competed with the UI thread, so one slow source froze the whole window
// — the setup "Resolving…" hang. Background indexing made that unlikely;
// this makes it structurally impossible.
//
// The returned handle keeps the same shape the app already used
// ({ origin, token, reload, close }), so the rest of main.mjs is unchanged.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { utilityProcess } from 'electron'
import { enginePaths, manifestPath, configDir } from './paths.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

// Boot is a fork, an HTTP listen on loopback and one message — fast. This
// ceiling only exists so a wedged child can never leave the app windowless
// and silent; it fails to the same clean fatal dialog as any other boot error.
const BOOT_TIMEOUT_MS = 20_000
const RELOAD_TIMEOUT_MS = 5_000

function ensureConfig(withManifestLock, writeContextManifest) {
  fs.mkdirSync(configDir(), { recursive: true })
  withManifestLock(manifestPath(), () => {
    if (!fs.existsSync(manifestPath())) {
      // Valid empty manifest: the console shows its first-run SetupWizard when
      // the cascade has zero sources and writes layers through /api/sources.
      writeContextManifest(manifestPath(), { layers: [] })
    }
  })
}

/**
 * Fork the engine and resolve once it is serving.
 *
 * @param {{ onCrash?: (err: Error) => void }} [options] `onCrash` fires only
 *   for an exit the app did not ask for; the app cannot work without the
 *   engine, so the caller treats it as fatal.
 */
export async function startEngineService({ onCrash } = {}) {
  const { serviceModule, consoleDist } = enginePaths()
  const manifestModule = path.join(path.dirname(serviceModule), 'manifest.mjs')
  const {
    readContextManifest,
    withManifestLock,
    writeContextManifest,
  } = await import(pathToFileURL(manifestModule).href)
  ensureConfig(withManifestLock, writeContextManifest)

  const child = utilityProcess.fork(
    path.join(here, 'engine-process.mjs'),
    [manifestPath(), serviceModule, consoleDist ?? ''],
    {
      // Engine diagnostics (an unreachable MCP source, a request handler
      // throw) stay visible in the app's own output.
      stdio: 'inherit',
      // Names the process in Activity Monitor, so a user looking at CPU can
      // tell the engine apart from the window.
      serviceName: 'ContextCake Engine',
    },
  )

  let settled = false // boot resolved or rejected — the promise is done either way
  let started = false // boot SUCCEEDED — only then is an exit a crash
  let closing = false
  let nextRequestId = 1
  const pendingAcks = new Map()

  const handle = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      closing = true
      child.kill()
      reject(new Error(`The ContextCake engine did not start within ${BOOT_TIMEOUT_MS / 1000}s.`))
    }, BOOT_TIMEOUT_MS)
    timer.unref?.()

    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    }

    child.on('message', (message) => {
      if (!message || typeof message !== 'object') return
      if (message.type === 'ready') {
        if (settled) return
        settled = true
        started = true
        clearTimeout(timer)
        const postWithAck = (payload) => {
          if (closing) return Promise.resolve()
          return new Promise((done) => {
            const id = nextRequestId++
            pendingAcks.set(id, done)
            // A missed ack must not leave a caller awaiting forever.
            const ackTimer = setTimeout(() => {
              if (pendingAcks.delete(id)) done()
            }, RELOAD_TIMEOUT_MS)
            ackTimer.unref?.()
            try {
              child.postMessage({ ...payload, id })
            } catch {
              clearTimeout(ackTimer)
              pendingAcks.delete(id)
              done()
            }
          })
        }

        resolve({
          origin: message.origin,
          token: message.token,
          /** Re-read the manifest in the engine; resolves once it acknowledges. */
          reload() {
            return postWithAck({ type: 'reload' })
          },
          /**
           * Hand the engine the credentials for remote sources. Travels the
           * message port for the same reason the bearer token comes back up
           * it — argv and env are readable by any process running as this
           * user, and this payload is the secrets themselves.
           */
          sendTokens(tokens) {
            return postWithAck({ type: 'tokens', tokens: tokens ?? {} })
          },
          mutateManifest(buildCandidate) {
            return withManifestLock(manifestPath(), () => {
              const current = readContextManifest(manifestPath(), { allowMissing: false })
              const candidate = buildCandidate(current)
              if (candidate === null) {
                return { changed: false, serialized: `${JSON.stringify(current, null, 2)}\n` }
              }
              writeContextManifest(manifestPath(), candidate, { allowTransitional: true })
              return { changed: true, serialized: `${JSON.stringify(candidate, null, 2)}\n` }
            })
          },
          close() {
            if (closing) return
            closing = true
            // Ask first so the engine can close its own sources (killing
            // spawned MCP children), then make sure it goes.
            try { child.postMessage({ type: 'close' }) } catch { /* already gone */ }
            setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 300).unref?.()
          },
        })
        return
      }
      if (message.type === 'boot-error') {
        fail(new Error(message.message || 'The ContextCake engine failed to start.'))
        return
      }
      if (message.type === 'ack') {
        const done = pendingAcks.get(message.id)
        if (done) { pendingAcks.delete(message.id); done() }
      }
    })

    child.on('exit', (code) => {
      for (const done of pendingAcks.values()) done()
      pendingAcks.clear()
      if (started) {
        // A crash after boot: the app has no cascade and no way to re-point
        // the loaded window at a new port, so the caller treats it as fatal.
        if (!closing) onCrash?.(new Error(`The ContextCake engine stopped unexpectedly (code ${code}).`))
        return
      }
      // Died during startup. A boot-error message usually arrived first and
      // names the real cause; this only fills in when it didn't, and no-ops
      // if that rejection already happened.
      fail(new Error(`The ContextCake engine exited during startup (code ${code}).`))
    })
  })

  return handle
}
