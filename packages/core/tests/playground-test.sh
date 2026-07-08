#!/usr/bin/env bash
# Playground server tests: locks in the sandbox + hardening so they can't
# silently regress. Network-free (no real git clone). Run from the repo root.
set -uo pipefail

PORT="${PORT:-8799}"
BASE="http://127.0.0.1:$PORT"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
SRV_PID=""
FAILED=0

cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  [ -n "${CPID:-}" ] && kill "$CPID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILED=1; }

# code <expected> <actual> <label>
code() { [ "$2" = "$1" ] && pass "$3 ($2)" || fail "$3 (got $2, want $1)"; }

# ---- fixtures: a temp OKF bundle + a symlink escaping it + a manifest --------
mkdir -p "$TMP/bundle" "$TMP/outside"
printf 'SECRET\n' > "$TMP/outside/secret.txt"
ln -s "$TMP/outside/secret.txt" "$TMP/bundle/escape.md"
FENCE='```'
{
  printf -- '---\ntype: runbook\ntitle: Deploy\nupdated: 2026-07-01\n---\n\n# Deploy\n\n## Trigger {#trigger}\n\nRun:\n\n'
  printf '%sbash\n# a comment\necho hi\n%s\n\ndone.\n\n## Rollback {#rollback}\n\nroll back.\n' "$FENCE" "$FENCE"
} > "$TMP/bundle/deploy.md"
cat > "$TMP/manifest.json" <<EOF
{ "layers": [ { "name": "t", "level": 1, "path": "$TMP/bundle" } ] }
EOF

# ---- start server -----------------------------------------------------------
node "$ROOT/apps/playground/server.mjs" --manifest "$TMP/manifest.json" --port "$PORT" >/dev/null 2>&1 &
SRV_PID=$!
for _ in $(seq 1 30); do curl -sf "$BASE/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done

C() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "token accounting"
TOK="$(curl -s "$BASE/api/graph" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const g=JSON.parse(s);process.stdout.write(`${g.tokenizer}:${g.totals.sourceTokens>0}`)})')"
[ "$TOK" = "o200k_base:true" ] && pass "graph reports o200k tokens" || fail "token accounting ($TOK)"

echo "path + symlink sandbox"
code 403 "$(C "$BASE/api/file?path=t/../../../etc/hosts")" "traversal read blocked"
code 403 "$(C "$BASE/api/file?path=t/escape.md")" "symlink read blocked"
code 403 "$(C -X PUT -H 'content-type: application/json' -d '{"path":"t/escape.md","text":"x"}' "$BASE/api/file")" "symlink write blocked"
grep -q SECRET "$TMP/outside/secret.txt" && pass "secret not overwritten" || fail "secret overwritten"

echo "CSRF + DNS-rebinding guard"
code 403 "$(C -X POST -H 'content-type: application/json' -H 'Sec-Fetch-Site: cross-site' -d '{}' "$BASE/api/sources")" "cross-site POST blocked"
code 403 "$(C -X POST -H 'content-type: application/json' -H 'Origin: http://evil.com' -d '{}' "$BASE/api/sources")" "cross-origin Origin blocked"
code 403 "$(C -X POST -H 'content-type: application/json' -H 'Host: evil.com' -d '{}' "$BASE/api/sources")" "non-loopback Host blocked"

echo "git transport allowlist (no network)"
code 400 "$(C -X POST -H 'content-type: application/json' -d '{"kind":"github","name":"x","level":1,"repo":"ext::sh -c whoami"}' "$BASE/api/sources")" "ext:: transport rejected"

echo "fence-aware section replace"
curl -s -X PUT -H 'content-type: application/json' \
  -d '{"conceptId":"deploy","sectionKey":"trigger","layers":["t"],"content":"NEW"}' "$BASE/api/section" >/dev/null
grep -q 'roll back.' "$TMP/bundle/deploy.md" && pass "next section survived" || fail "next section corrupted"
grep -q 'a comment' "$TMP/bundle/deploy.md" && fail "fenced comment leaked (boundary bug)" || pass "fenced comment replaced cleanly"

echo "bulk resolve (/api/resolve-all)"
RA="$(curl -s "$BASE/api/resolve-all" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(`${r.concepts.length}:${r.errors.length}:${r.concepts[0]?.id}`)})')"
[ "$RA" = "1:0:deploy" ] && pass "resolve-all returns all concepts in one pass" || fail "resolve-all ($RA)"

echo "console not mounted → friendly notice (default server)"
code 503 "$(C "$BASE/console/")" "unmounted /console/ returns 503"
curl -s "$BASE/console/" | grep -q 'console:live' && pass "notice explains npm run console:live" || fail "unmounted notice content"

echo "source add/remove roundtrip"
mkdir -p "$TMP/b2"
printf -- '---\ntype: note\ntitle: N\n---\n\n# N\n\n## S {#s}\n\nx.\n' > "$TMP/b2/n.md"
code 200 "$(C -X POST -H 'content-type: application/json' -d "{\"kind\":\"local\",\"name\":\"b2\",\"level\":2,\"path\":\"$TMP/b2\"}" "$BASE/api/sources")" "add local source"
code 200 "$(C -X DELETE "$BASE/api/sources?name=b2")" "remove source"

echo "console static mount (--console)"
CPORT=$((PORT + 1)); CBASE="http://127.0.0.1:$CPORT"
mkdir -p "$TMP/cdist/assets"
printf '<!doctype html><title>Console</title><div id=root>CONSOLE_OK</div>\n' > "$TMP/cdist/index.html"
printf 'body{color:#000}\n' > "$TMP/cdist/assets/app.css"
ln -s "$TMP/outside/secret.txt" "$TMP/cdist/escape.txt" # symlink escaping the dist
node "$ROOT/apps/playground/server.mjs" --manifest "$TMP/manifest.json" --port "$CPORT" --console "$TMP/cdist" >/dev/null 2>&1 &
CPID=$!
for _ in $(seq 1 30); do curl -sf "$CBASE/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done
curl -s "$CBASE/console/" | grep -q CONSOLE_OK && pass "/console/ serves index" || fail "/console/ index"
code 200 "$(C "$CBASE/console/assets/app.css")" "console asset served"
curl -s "$CBASE/console/concepts/anything" | grep -q CONSOLE_OK && pass "SPA route → index fallback" || fail "SPA fallback"
curl -s --path-as-is "$CBASE/console/../outside/secret.txt" | grep -q SECRET && fail "console traversal exposed secret" || pass "console traversal blocked"
curl -s "$CBASE/console/escape.txt" | grep -q SECRET && fail "console symlink exposed secret" || pass "console symlink escape blocked"
grep -q SECRET "$TMP/outside/secret.txt" && pass "console secret intact" || fail "console secret exposed"
kill "$CPID" 2>/dev/null; CPID=""

[ "$FAILED" = 0 ] && echo "playground test passed (sandbox + CSRF/host + fence + tokens + source CRUD + console mount)" || { echo "playground test FAILED"; exit 1; }
