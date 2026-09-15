import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTelemetry } from './telemetry.mjs'
const [entry, configPath, ...args] = process.argv.slice(2)
const telemetry = createTelemetry({ configPath, role: 'mcp' })
process.argv = [process.execPath, entry, ...args]
process.once('exit', () => telemetry.close())
await import(pathToFileURL(path.resolve(entry)).href)
