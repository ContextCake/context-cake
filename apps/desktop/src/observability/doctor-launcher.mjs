import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { localEndpoint } from './telemetry.mjs'

const [entry, configPath, ...args] = process.argv.slice(2)
let observability = { state: 'disabled', scope: 'fresh-local-check' }
try {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
  if (config.enabled) {
    observability.state = 'unavailable'
    const endpoint = localEndpoint(config.endpoint)
    if (endpoint) {
      const response = await fetch(`${endpoint}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        redirect: 'error',
        signal: AbortSignal.timeout(1500),
      })
      if (response.ok) observability.state = 'available'
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') observability.state = 'unavailable'
}
const { main } = await import(pathToFileURL(path.resolve(entry)).href)
process.argv = [process.execPath, entry, ...args]
await main({ observability })
