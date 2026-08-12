// The engine, running in its own Electron utilityProcess.
//
// This file is NOT the main process. It is forked by service-host.mjs and runs
// a plain Node.js environment with `process.parentPort` as its only channel
// home — no `electron` module, no BrowserWindow, no UI thread to block.
//
// That isolation is the point. The engine reads folders, parses markdown, runs
// a BPE tokenizer and spawns foreign MCP servers; all of that used to share an
// event loop with the window. Any of it going slow was a frozen app. Here the
// worst case is a slow answer over HTTP.
//
// Protocol with the parent:
//   child → parent  { type: 'ready', origin, token }
//                   { type: 'boot-error', message }
//                   { type: 'ack', id }
//   parent → child  { type: 'reload', id }
//                   { type: 'tokens', id, tokens }
//                   { type: 'close' }
//
// The bearer token is generated HERE and handed up the message port rather
// than passed down in argv — process arguments are readable by any local user
// via `ps`, and the token is what keeps them out of the API.
//
// Source credentials travel the same way, in the opposite direction: the main
// process owns the Keychain and posts an alias -> {secret, host} map down this
// port. Same reasoning, same guarantee — never argv, never the child's env.

import http from 'node:http'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const [manifestPath, serviceModule, consoleDist] = process.argv.slice(2)

function post(message) {
  try { process.parentPort.postMessage(message) } catch { /* parent already gone */ }
}

async function start() {
  // Test seam (CI + agents): prove the app fails fast with a clean exit when
  // the engine can't boot, instead of hanging with no window. Real failures
  // (port bind, bad packaged path, unwritable config) take the same path.
  if (process.env.CC_FORCE_BOOT_FAIL === '1') {
    throw new Error('CC_FORCE_BOOT_FAIL: simulated engine boot failure')
  }
  if (!manifestPath || !serviceModule) {
    throw new Error('engine-process: manifestPath and serviceModule arguments are required')
  }

  const { createEngineService } = await import(pathToFileURL(serviceModule).href)
  const token = crypto.randomBytes(32).toString('hex')
  const service = createEngineService({
    manifestPath,
    consoleDist: consoleDist || null,
    token,
  })

  const server = http.createServer((req, res) => {
    Promise.resolve(service.handleRequest(req, res))
      .then((handled) => {
        if (!handled && !res.writableEnded) {
          res.statusCode = 404
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'not found' }))
        }
      })
      .catch((err) => {
        console.error('[engine-service]', err)
        if (!res.headersSent) res.statusCode = 500
        if (!res.writableEnded) res.end()
      })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const { port } = server.address()

  process.parentPort.on('message', (event) => {
    const message = event?.data
    if (!message || typeof message !== 'object') return
    if (message.type === 'reload') {
      try { service.reload() } catch (err) { console.error('[engine-service] reload failed', err) }
      post({ type: 'ack', id: message.id })
      return
    }
    if (message.type === 'tokens') {
      // Errors here must not quote the payload: it is the credentials.
      try { service.setTokens(message.tokens ?? {}) } catch { console.error('[engine-service] applying credentials failed') }
      post({ type: 'ack', id: message.id })
      return
    }
    if (message.type === 'quarantine') {
      // Source names a crash-loop breaker decided to skip (see main.mjs's
      // handleEngineCrash). Travels the message port like everything else —
      // never argv, where layer names would be `ps`-visible.
      try { service.setIndexQuarantine(message.sources ?? []) } catch (err) { console.error('[engine-service] quarantine failed', err) }
      post({ type: 'ack', id: message.id })
      return
    }
    if (message.type === 'close') {
      try { service.close() } catch { /* already down */ }
      server.close()
      process.exit(0)
    }
  })

  post({ type: 'ready', origin: `http://127.0.0.1:${port}`, token })

  // Test seam (engine-crash smoke): a post-boot death on a timer, so the
  // app's bounded-restart path can be driven for real. Exit code 87 keeps the
  // simulated death recognizable in breadcrumbs and logs. With
  // CC_FORCE_ENGINE_EXIT_LIMIT + a state file, only the first N generations
  // die — which is how the smoke gets a surviving engine to assert the
  // quarantine against.
  const forcedExitMs = Number(process.env.CC_FORCE_ENGINE_EXIT_AFTER_READY)
  if (Number.isFinite(forcedExitMs) && forcedExitMs > 0) {
    let shouldDie = true
    const limit = Number(process.env.CC_FORCE_ENGINE_EXIT_LIMIT)
    const stateFile = process.env.CC_FORCE_ENGINE_EXIT_STATE
    if (Number.isFinite(limit) && stateFile) {
      const { readFileSync, writeFileSync } = await import('node:fs')
      let deaths = 0
      try { deaths = Number(JSON.parse(readFileSync(stateFile, 'utf8')).deaths) || 0 } catch { /* first generation */ }
      shouldDie = deaths < limit
      if (shouldDie) writeFileSync(stateFile, JSON.stringify({ deaths: deaths + 1 }))
    }
    if (shouldDie) setTimeout(() => process.exit(87), forcedExitMs)
  }
}

start().catch((err) => {
  // Report before exiting so the parent can name the real cause in its dialog
  // instead of only "the engine exited".
  post({ type: 'boot-error', message: (err && err.stack) || String(err) })
  // Give the message a tick to flush, then fail loudly.
  setTimeout(() => process.exit(1), 50)
})
