// Boots the engine HTTP service (packages/core/src/service.mjs) on a random
// loopback port with a per-launch bearer token. The renderer gets the token
// via preload; nothing off-machine can reach the service, and other local
// users can't ride the loopback without the token.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { enginePaths, manifestPath, configDir } from './paths.mjs'

function ensureConfig() {
  fs.mkdirSync(configDir(), { recursive: true })
  if (!fs.existsSync(manifestPath())) {
    // Valid empty manifest: the console shows its first-run SetupWizard when
    // the cascade has zero sources and writes layers through /api/sources.
    fs.writeFileSync(manifestPath(), JSON.stringify({ layers: [] }, null, 2) + '\n')
  }
}

export async function startEngineService() {
  ensureConfig()
  const { serviceModule, consoleDist } = enginePaths()
  const { createEngineService } = await import(pathToFileURL(serviceModule).href)

  const token = crypto.randomBytes(32).toString('hex')
  const service = createEngineService({
    manifestPath: manifestPath(),
    consoleDist,
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
  return {
    origin: `http://127.0.0.1:${port}`,
    token,
    close() {
      server.close()
      service.close()
    },
  }
}
