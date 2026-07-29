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
//                   { type: 'close' }
//
// The bearer token is generated HERE and handed up the message port rather
// than passed down in argv — process arguments are readable by any local user
// via `ps`, and the token is what keeps them out of the API.

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
    if (message.type === 'close') {
      try { service.close() } catch { /* already down */ }
      server.close()
      process.exit(0)
    }
  })

  post({ type: 'ready', origin: `http://127.0.0.1:${port}`, token })
}

start().catch((err) => {
  // Report before exiting so the parent can name the real cause in its dialog
  // instead of only "the engine exited".
  post({ type: 'boot-error', message: (err && err.stack) || String(err) })
  // Give the message a tick to flush, then fail loudly.
  setTimeout(() => process.exit(1), 50)
})
