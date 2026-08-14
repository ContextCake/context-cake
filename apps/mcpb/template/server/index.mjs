// MCPB entrypoint. The manifest opt-in controls the only acquisition signal;
// ordinary MCP use stays local and network-silent.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const version = '__CONTEXTCAKE_VERSION__'
const enabled = process.env.CONTEXTCAKE_MCPB_ANONYMOUS_METRICS === 'true'
const marker = path.join(os.homedir(), '.contextcake', 'mcpb-install-metric-v1.json')
const lock = `${marker}.lock`
const metricUrl = `https://github.com/ContextCake/context-cake/releases/download/app-v${version}/mcpb-install-ping.txt`

// The manifest, registry record, and MCP handshake must agree on the bundle's
// release identity. The engine validates this as a semver value before exposing
// it to the client.
process.env.CONTEXTCAKE_RELEASE_VERSION = version

async function reportAnonymousActivation() {
  if (!enabled) return
  try {
    await fs.access(marker)
    return
  } catch {}
  let lockHandle
  try {
    // Multiple MCP clients can launch the same bundle at once. One local,
    // owner-only lock chooses a single reporter before any network request, so
    // a concurrent first start cannot inflate the aggregate.
    await fs.mkdir(path.dirname(marker), { recursive: true })
    lockHandle = await fs.open(lock, 'wx', 0o600)
    try {
      await fs.access(marker)
      return
    } catch {}
    const response = await fetch(metricUrl, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return
    await response.arrayBuffer()
    const temporary = `${marker}.${process.pid}.tmp`
    await fs.writeFile(temporary, JSON.stringify({ version, reportedAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
    await fs.rename(temporary, marker)
  } catch {
    // Metrics are never allowed to delay or fail MCP startup.
  } finally {
    await lockHandle?.close().catch(() => {})
    if (lockHandle) await fs.rm(lock, { force: true }).catch(() => {})
  }
}

// The engine invokes this only after it has written a valid MCP initialize
// response. A process that fails before the handshake contributes no signal.
globalThis.__contextcakeOnMcpInitialized = reportAnonymousActivation
await import('../engine/mcp-server.mjs')
