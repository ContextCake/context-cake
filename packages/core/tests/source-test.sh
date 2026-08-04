#!/usr/bin/env bash
set -euo pipefail

# Proves the heterogeneous stitch: an OKF-local team layer + a foreign MCP
# source (examples/mock-mcp-source/server.mjs) resolve into one OKF concept, with
# conflict surfacing and cross-source inheritance. Also proves graceful
# degradation when an MCP source is unreachable.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
resolver="$repo_root/resolver.mjs"
mock="$repo_root/examples/mock-mcp-source/server.mjs"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
fail() { echo "FAIL: $1" >&2; [ "${2:-}" ] && echo "$2" >&2; exit 1; }

team="$tmpdir/team"; mkdir -p "$team/decisions"
cat > "$team/decisions/database-engine.md" <<'EOF'
---
type: decision
title: Database engine
updated: 2026-05-12
---

## Engine {#engine}

SingleStore (HTAP / reporting).
EOF

cat > "$tmpdir/m.json" <<EOF
{ "layers": [
  { "name": "team", "level": 2, "source": "okf-local", "path": "team" },
  { "name": "org-default", "level": 0, "source": "mcp", "command": "node", "args": ["${mock}"] }
] }
EOF

res="$(node "$resolver" --manifest "$tmpdir/m.json" --concept decisions/database-engine)"

# Team (OKF) wins Engine; org-default (MCP) Engine dissent is surfaced with its date.
grep -q 'SingleStore' <<<"$res" || fail "team OKF Engine should win" "$res"
grep -q '"conflicts"' <<<"$res" || fail "org-default MCP dissent should surface as a conflict" "$res"
grep -q 'Postgres' <<<"$res" || fail "MCP Postgres value should be translated + surfaced" "$res"
grep -q '"layer": "org-default"' <<<"$res" || fail "dissent should name the MCP layer" "$res"
grep -q '2026-06-01' <<<"$res" || fail "MCP dissent should carry its lastTouched date" "$res"

# Cross-source inheritance: Backups exists ONLY in the MCP source -> inherited.
grep -q 'Nightly snapshots' <<<"$res" || fail "MCP-only Backups section should be inherited" "$res"
grep -q '"sourceLayer": "org-default"' <<<"$res" || fail "inherited Backups should carry MCP provenance" "$res"

# Cross-references (see_also) translate into ONE Related section, not duplicated
# onto every section — and must not leak into the Engine content or its conflict.
grep -q '"key": "related"' <<<"$res" || fail "see_also should translate to a single Related section" "$res"
engine_block="$(python3 -c "import sys,json; s=[x for x in json.load(open('/dev/stdin'))['sections'] if x['key']=='engine'][0]; print(s['content']); print(s.get('conflicts',[{}])[0].get('content',''))" <<<"$res")"
if grep -q 'scaling-policy' <<<"$engine_block"; then fail "see_also leaked into the Engine section/conflict content" "$engine_block"; fi

# Pure inheritance from MCP: a concept the team is silent on resolves from MCP alone.
obs="$(node "$resolver" --manifest "$tmpdir/m.json" --concept decisions/observability)"
grep -q 'OpenTelemetry' <<<"$obs" || fail "MCP-only concept should resolve from the MCP source" "$obs"

# Graceful degradation: an unreachable MCP source must not fail resolution.
cat > "$tmpdir/bad.json" <<EOF
{ "layers": [
  { "name": "team", "level": 2, "source": "okf-local", "path": "team" },
  { "name": "org-default", "level": 0, "source": "mcp", "command": "node", "args": ["${tmpdir}/does-not-exist.mjs"] }
] }
EOF
bad="$(node "$resolver" --manifest "$tmpdir/bad.json" --concept decisions/database-engine 2>/dev/null)"
grep -q 'SingleStore' <<<"$bad" || fail "unreachable MCP source should degrade to remaining layers, not fail" "$bad"

# probe() checks the ANSWER, not just the transport: a server that responds but
# lacks the two graph tools must fail the probe with err.code === "CONTRACT",
# so the add form can word it differently from "did not respond". A transport
# failure (missing binary) must NOT carry that code.
cat > "$tmpdir/no-get-node.mjs" <<'EOF'
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (o) => process.stdout.write(JSON.stringify(o) + "\n");
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") return write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "no-get-node", version: "0" } } });
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") return write({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "list_nodes" }, { name: "something_else" }] } });
});
EOF
probe_out="$(MOCK="$mock" LACKING="$tmpdir/no-get-node.mjs" MCP_URL="file://$repo_root/packages/core/src/sources/mcp.mjs" node --input-type=module -e '
const { createMcpSource } = await import(process.env.MCP_URL);
const probeOf = (args) => createMcpSource({ name: "p", level: 0, command: process.execPath, args });
const good = probeOf([process.env.MOCK]);
const goodTools = (await good.probe()).tools.map((t) => t.name).sort().join(",");
good.close();
const lacking = probeOf([process.env.LACKING]);
let contractCode = "NO-THROW";
try { await lacking.probe(); } catch (e) { contractCode = e.code ?? "NO-CODE"; }
lacking.close();
const ghost = createMcpSource({ name: "p", level: 0, command: "definitely-not-a-real-binary-xyz", args: [] });
let transportCode = "NO-THROW";
try { await ghost.probe(); } catch (e) { transportCode = e.code === "CONTRACT" ? "CONTRACT" : "TRANSPORT"; }
ghost.close();
console.log(`${goodTools}|${contractCode}|${transportCode}`);
')"
[ "$probe_out" = "get_node,list_nodes|CONTRACT|TRANSPORT" ] || fail "probe contract check (got: $probe_out)"

echo "source test passed (heterogeneous stitch + conflict + cross-source inherit + graceful degrade + probe contract)"
