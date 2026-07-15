#!/usr/bin/env bash
# Engine service tests: locks in the embeddable createEngineService contract —
# bearer-token auth, the allowMutations switch, caller fall-through, and the
# playground-compatible token-unset mode. Network-free. Run from the repo root.
set -uo pipefail

PORT="${PORT:-8811}"           # token-gated host
PORT2=$((PORT + 1))            # token-unset, mutations-disabled host
BASE="http://127.0.0.1:$PORT"
BASE2="http://127.0.0.1:$PORT2"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
PID1=""
PID2=""
FAILED=0

cleanup() {
  [ -n "$PID1" ] && kill "$PID1" 2>/dev/null
  [ -n "$PID2" ] && kill "$PID2" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILED=1; }

# code <expected> <actual> <label>
code() { [ "$2" = "$1" ] && pass "$3 ($2)" || fail "$3 (got $2, want $1)"; }

C() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
AUTH=(-H "Authorization: Bearer sekrit")

# ---- fixtures: a temp OKF bundle + manifest + a console dist -----------------
mkdir -p "$TMP/bundle" "$TMP/b2" "$TMP/cdist"
printf -- '---\ntype: note\ntitle: Note\nupdated: 2026-07-01\n---\n\n# Note\n\n## Body {#body}\n\nhello.\n' > "$TMP/bundle/note.md"
printf -- '---\ntype: note\ntitle: N2\n---\n\n# N2\n\n## S {#s}\n\nx.\n' > "$TMP/b2/n.md"
printf '<!doctype html><title>Console</title><div id=root>CONSOLE_OK</div>\n' > "$TMP/cdist/index.html"
cat > "$TMP/manifest.json" <<EOF
{ "layers": [ { "name": "t", "level": 1, "path": "$TMP/bundle" } ], "pendingSources": [ { "name": "b2", "level": 2, "path": { "__scrubbed": "path" } } ], "pendingSourcesOwnerUserId": "user-1" }
EOF
cp "$TMP/manifest.json" "$TMP/manifest2.json"

# ---- a bare node:http host around createEngineService ------------------------
# argv: <port> <manifest> <token|-> <allowMutations> <consoleDist|->
cat > "$TMP/host.mjs" <<'EOF'
import http from "node:http";
import { pathToFileURL } from "node:url";
const { createEngineService } = await import(pathToFileURL(process.env.SERVICE_MJS).href);
const [port, manifestPath, token, allowMutations, consoleDist] = process.argv.slice(2);
const svc = createEngineService({
  manifestPath,
  token: token === "-" ? null : token,
  allowMutations: allowMutations !== "false",
  consoleDist: consoleDist === "-" ? null : consoleDist,
});
http.createServer(async (req, res) => {
  if (await svc.handleRequest(req, res)) return; // service owned it
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "host-fallthrough", path: req.url }));
}).listen(Number(port), "127.0.0.1");
EOF

export SERVICE_MJS="$ROOT/packages/core/src/service.mjs"
node "$TMP/host.mjs" "$PORT" "$TMP/manifest.json" sekrit true "$TMP/cdist" >/dev/null 2>&1 &
PID1=$!
node "$TMP/host.mjs" "$PORT2" "$TMP/manifest2.json" - false - >/dev/null 2>&1 &
PID2=$!
for _ in $(seq 1 30); do curl -sf "${AUTH[@]}" "$BASE/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done
for _ in $(seq 1 30); do curl -sf "$BASE2/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done

echo "bearer token gate (token: sekrit)"
code 401 "$(C "$BASE/api/graph")" "read without header rejected"
code 401 "$(C -H 'Authorization: Bearer wrong' "$BASE/api/graph")" "read with wrong token rejected"
code 200 "$(C "${AUTH[@]}" "$BASE/api/graph")" "read with correct Bearer accepted"
code 200 "$(C -H 'Authorization: Bearer   sekrit' "$BASE/api/graph")" "extra separator whitespace still accepted"
code 401 "$(C -H 'Authorization: Bearer      ' "$BASE/api/graph")" "all-whitespace token rejected (ReDoS-safe parse)"
G="$(curl -s "${AUTH[@]}" "$BASE/api/graph" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const g=JSON.parse(s);process.stdout.write(`${g.tokenizer}:${g.totals.sources}:${g.totals.sourceTokens>0}`)})')"
[ "$G" = "o200k_base:1:true" ] && pass "graph payload intact behind auth" || fail "graph payload ($G)"
code 401 "$(C "$BASE/api/resolve?concept=note")" "resolve without header rejected"
code 200 "$(C "${AUTH[@]}" "$BASE/api/resolve?concept=note")" "resolve with Bearer accepted"
code 401 "$(C "$BASE/api/files")" "unknown /api/* path still gated without token"

echo "console mount is static UI, not gated data"
curl -s "$BASE/console/" | grep -q CONSOLE_OK && pass "/console/ serves without auth" || fail "/console/ without auth"

echo "caller fall-through"
FT="$(curl -s "$BASE/nope")"
grep -q host-fallthrough <<<"$FT" && pass "unknown path falls through to the host" || fail "fall-through ($FT)"
FT="$(curl -s "${AUTH[@]}" "$BASE/api/files")"
grep -q host-fallthrough <<<"$FT" && pass "unclaimed /api/* falls through once authed" || fail "authed /api fall-through ($FT)"

echo "sources CRUD through the service (authed)"
code 403 "$(C -X POST "${AUTH[@]}" -H 'Origin: http://evil.com' -d '{}' "$BASE/api/sources")" "CSRF guard survives in the service"
code 403 "$(C -X POST "${AUTH[@]}" -H 'Host: evil.com' -d '{}' "$BASE/api/sources")" "non-loopback Host blocked in the service"
code 401 "$(C -X POST -d '{}' "$BASE/api/sources")" "mutation without token rejected"
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"kind\":\"local\",\"name\":\"b2\",\"level\":2,\"path\":\"$TMP/b2\"}" "$BASE/api/sources")" "add local source"
grep -q 'pendingSources' "$TMP/manifest.json" && fail "configured source left pending metadata" || pass "configured source promoted out of pending metadata"
grep -q 'pendingSourcesOwnerUserId' "$TMP/manifest.json" && fail "configured source left pending owner metadata" || pass "configured source removed pending owner metadata"
N="$(curl -s "${AUTH[@]}" "$BASE/api/graph" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(String(JSON.parse(s).totals.sources))})')"
[ "$N" = "2" ] && pass "reload picked up the new source" || fail "reload after add (sources=$N)"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=b2")" "remove source"

echo "allowMutations: false (token unset)"
code 200 "$(C "$BASE2/api/graph")" "reads work with no header when token unset"
code 405 "$(C -X POST -H 'content-type: application/json' -d '{}' "$BASE2/api/sources")" "POST /api/sources returns 405"
code 405 "$(C -X PATCH -H 'content-type: application/json' -d '{}' "$BASE2/api/sources")" "PATCH /api/sources returns 405"
code 405 "$(C -X DELETE "$BASE2/api/sources?name=t")" "DELETE /api/sources returns 405"
code 405 "$(C -X POST "$BASE2/api/sources/sync?name=t")" "POST /api/sources/sync returns 405"
grep -q '"t"' "$TMP/manifest2.json" && pass "manifest untouched by blocked mutations" || fail "manifest mutated despite 405"
FT="$(curl -s "$BASE2/nope")"
grep -q host-fallthrough <<<"$FT" && pass "fall-through works on this host too" || fail "fall-through host2 ($FT)"

[ "$FAILED" = 0 ] && echo "service test passed (bearer gate + allowMutations + fall-through + CRUD reload + console mount)" || { echo "service test FAILED"; exit 1; }
