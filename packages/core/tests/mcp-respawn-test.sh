#!/usr/bin/env bash
# Regression: an MCP source whose child process crashes mid-session must
# degrade for that read and then RESPAWN on a later access — not stay
# permanently dead. Guards the held-adapter lifecycle in service.mjs (one
# adapter set across many reads) against the per-request assumption mcp.mjs
# was originally written under.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MCP_MODULE="$ROOT/packages/core/src/sources/mcp.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A foreign MCP server that answers one tools/call, then crashes on its
# second — so a fresh child (after respawn) answers again from a clean count.
cat > "$TMP/crashy.mjs" <<'JS'
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
let toolCalls = 0
const write = (o) => process.stdout.write(JSON.stringify(o) + '\n')
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    return write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'crashy', version: '0' } } })
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/call') {
    toolCalls++
    if (toolCalls >= 2) process.exit(1) // crash on this child's second call
    return write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ nodes: ['a'] }) }] } })
  }
})
JS

cat > "$TMP/driver.mjs" <<'JS'
const { createMcpSource } = await import(process.env.MCP_URL)
const src = createMcpSource({
  name: 'crashy', level: 0,
  command: process.execPath, args: [process.env.CRASHY],
  respawnCooldownMs: 100,
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const first = await src.listConceptIds()          // fresh child, call #1 → ['a']
const second = await src.listConceptIds()          // call #2 → child crashes → degraded []
await sleep(250)                                    // past the 100ms cooldown
const third = await src.listConceptIds()           // respawned child, call #1 → ['a']
src.close()

const ok = first.length === 1 && first[0] === 'a'
  && second.length === 0
  && third.length === 1 && third[0] === 'a'
console.log(JSON.stringify({ first, second, third, ok }))
process.exit(ok ? 0 : 1)
JS

echo "mcp respawn after crash"
if MCP_URL="file://$MCP_MODULE" CRASHY="$TMP/crashy.mjs" node "$TMP/driver.mjs"; then
  echo "  ok   crashed source degrades then respawns on next access"
else
  echo "  FAIL source did not recover after child crash"
  exit 1
fi

echo "mcp respawn test passed (degrade-then-recover across held-adapter lifetime)"
