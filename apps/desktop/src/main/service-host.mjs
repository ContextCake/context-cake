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
import { createAckChannel } from './ack-channel.mjs'
import { enginePaths, manifestPath, configDir } from './paths.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

// Boot is a fork, an HTTP listen on loopback and one message — fast. This
// ceiling only exists so a wedged child can never leave the app windowless
// and silent; it fails to the same clean fatal dialog as any other boot error.
const BOOT_TIMEOUT_MS = 20_000
// How long a message-port round trip may take before the caller is told it did
// not happen. Reload and setTokens are both a synchronous field assignment in
// the child, so this is a wedge detector, not a work budget.
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
 * @param {{
 *   onCrash?: (err: Error) => void,
 *   onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer | string) => void,
 * }} [options] `onCrash` fires only for an exit the app did not ask for; the
 *   app cannot work without the engine, so the caller treats it as fatal.
 *   `onOutput` receives every engine stdout/stderr chunk (the caller tees it
 *   into the engine log); the chunks are ALSO forwarded to this process's own
 *   stdio, so `npm run dev` in a terminal loses nothing.
 */
export async function startEngineService({ onCrash, onOutput } = {}) {
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
      // Piped, not inherited: for a Finder-launched .app "inherit" is
      // /dev/null, which is why an engine death used to leave no artifact at
      // all. The forwarding below keeps terminal visibility for `npm run dev`
      // while the onOutput tee gives the log file the same bytes.
      stdio: 'pipe',
      // Names the process in Activity Monitor, so a user looking at CPU can
      // tell the engine apart from the window.
      serviceName: 'ContextCake Engine',
    },
  )
  for (const streamName of ['stdout', 'stderr']) {
    child[streamName]?.on('data', (chunk) => {
      try { process[streamName].write(chunk) } catch { /* dead pipe — main.mjs swallows these too */ }
      try { onOutput?.(streamName, chunk) } catch { /* the log must never hurt the engine */ }
    })
  }

  let settled = false // boot resolved or rejected — the promise is done either way
  let started = false // boot SUCCEEDED — only then is an exit a crash
  let closing = false
  const acks = createAckChannel({
    post: (message) => child.postMessage(message),
    timeoutMs: RELOAD_TIMEOUT_MS,
  })

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

        resolve({
          origin: message.origin,
          token: message.token,
          /**
           * Re-read the manifest in the engine.
           *
           * Resolves to `{acked: true}` only when the engine actually answered.
           * A deadline that expires resolves to `{acked: false, reason}` — it
           * never rejects (callers on the settings-pull path don't await it,
           * and an unhandled rejection here is a main-process crash dialog) and
           * it never claims success. Treat a false ack as a live symptom: the
           * engine is still serving the pre-reload manifest, if it is serving
           * anything at all.
           */
          reload() {
            return acks.send({ type: 'reload' })
          },
          /**
           * Hand the engine the credentials for remote sources. Travels the
           * message port for the same reason the bearer token comes back up
           * it — argv and env are readable by any process running as this
           * user, and this payload is the secrets themselves.
           *
           * Same `{acked}` contract as reload(): an unacknowledged send means
           * private layers are reading anonymously.
           */
          sendTokens(tokens) {
            return acks.send({ type: 'tokens', tokens: tokens ?? {} })
          },
          /**
           * Tell the engine which sources a crash-loop breaker decided to
           * skip (service.mjs setIndexQuarantine). Message port, not argv —
           * layer names in argv are `ps`-visible. Same `{acked}` contract as
           * reload()/sendTokens().
           */
          sendQuarantine(names) {
            return acks.send({ type: 'quarantine', sources: names ?? [] })
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
            acks.close('closing')
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
      if (message.type === 'ack') acks.settle(message.id)
    })

    child.on('exit', (code) => {
      // Anything still owed is owed by a process that no longer exists. Say so
      // rather than letting the caller time out and blame a wedge.
      acks.close(closing ? 'closing' : 'exit')
      if (started) {
        // A crash after boot: an exit the app did not ask for. Nothing here
        // knows WHY the child died, so this only reports; main.mjs's
        // handleEngineCrash owns the response (bounded restart + quarantine —
        // the loop this callback's older fatal-only contract feared is now
        // impossible by construction there). The raw exit code rides along so
        // the breadcrumb can record it.
        if (!closing) onCrash?.(new Error(`The ContextCake engine stopped unexpectedly (code ${code}).`), { code })
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
