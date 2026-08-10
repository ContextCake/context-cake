#!/usr/bin/env bash
# Indexing concurrency: locks in that a manifest with many layers no longer
# starts every source's index pass at once (service.mjs's indexQueue), that
# the cap is the settings.maxConcurrentIndexing knob, and that /api/active-source
# lets the client-visible layer jump the queue. Network-free. Run from the repo root.
set -uo pipefail

PORT="${PORT:-8821}"
BASE="http://127.0.0.1:$PORT"
PORT2=$((PORT + 1))            # second host: the active-source priority case
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
C() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
JQ() { node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let v;
    try { v = JSON.parse(s); } catch { process.stdout.write("PARSE-ERROR"); return; }
    const fn = new Function("d", `return ${process.argv[1]}`);
    let out;
    try { out = fn(v); } catch (e) { out = "EVAL-ERROR: " + e.message; }
    process.stdout.write(typeof out === "string" ? out : JSON.stringify(out));
  });' "$1"; }

cat > "$TMP/host.mjs" <<'EOF'
import http from "node:http";
import { pathToFileURL } from "node:url";
const { createEngineService } = await import(pathToFileURL(process.env.SERVICE_MJS).href);
const [port, manifestPath] = process.argv.slice(2);
const svc = createEngineService({ manifestPath });
http.createServer(async (req, res) => {
  if (await svc.handleRequest(req, res)) return;
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "host-fallthrough", path: req.url }));
}).listen(Number(port), "127.0.0.1");
EOF

export SERVICE_MJS="$ROOT/packages/core/src/service.mjs"

# ---- 1. the cap is real: N layers, maxConcurrentIndexing=2, never more than
#         2 sources actively reading (phase scanning/loading) at once --------
mkdir -p "$TMP/cap"
LAYERS_JSON="["
for i in 0 1 2 3 4 5; do
  mkdir -p "$TMP/cap/l$i"
  node -e '
    const fs = require("node:fs");
    const dir = process.argv[1];
    for (let i = 0; i < 500; i++) {
      fs.writeFileSync(`${dir}/n${i}.md`, `# N${i}\n\n## Body {#body}\n\nsome moderately sized body text for note ${i} in ${dir}, repeated a bit ${i}${i}${i}.\n`);
    }
  ' "$TMP/cap/l$i"
  [ "$i" != "0" ] && LAYERS_JSON="$LAYERS_JSON,"
  LAYERS_JSON="$LAYERS_JSON{\"name\":\"l$i\",\"level\":1,\"path\":\"$TMP/cap/l$i\"}"
done
LAYERS_JSON="$LAYERS_JSON]"
cat > "$TMP/manifest-cap.json" <<EOF
{ "layers": $LAYERS_JSON, "settings": { "maxConcurrentIndexing": 2 } }
EOF

node "$TMP/host.mjs" "$PORT" "$TMP/manifest-cap.json" >/dev/null 2>&1 &
PID1=$!
for _ in $(seq 1 50); do curl -sf "$BASE/api/settings" >/dev/null 2>&1 && break; sleep 0.05; done

echo "settings: the concurrency knob is in the catalog"
CAT="$(curl -s "$BASE/api/settings")"
[ "$(JQ 'String(d.catalog.some((s) => s.key === "maxConcurrentIndexing"))' <<<"$CAT")" = "true" ] \
  && pass "maxConcurrentIndexing appears in the settings catalog" \
  || fail "maxConcurrentIndexing missing from catalog ($CAT)"

echo "1. six layers, cap=2: never more than 2 actively reading at once"
# Kick off indexing (the first /api/status triggers ensureIndexes()), then
# sample rapidly until every source is ok.
curl -s "$BASE/api/status" >/dev/null
MAX_ACTIVE=0
DONE=0
for _ in $(seq 1 400); do
  ST="$(curl -s "$BASE/api/status")"
  ACTIVE="$(JQ 'd.sources.filter((s) => s.phase === "scanning" || s.phase === "loading").length' <<<"$ST")"
  [ "$ACTIVE" -gt "$MAX_ACTIVE" ] 2>/dev/null && MAX_ACTIVE="$ACTIVE"
  DONE="$(JQ 'String(d.sources.every((s) => s.status === "ok"))' <<<"$ST")"
  [ "$DONE" = "true" ] && break
  sleep 0.01
done
[ "$DONE" = "true" ] && pass "all six sources reached ok" || fail "indexing never settled ($ST)"
[ "$MAX_ACTIVE" -le 2 ] 2>/dev/null && pass "at most 2 sources were actively reading at once (observed max: $MAX_ACTIVE)" \
  || fail "more than the cap ran at once (observed max: $MAX_ACTIVE)"
FINAL="$(curl -s "$BASE/api/status")"
[ "$(JQ 'String(d.sources.every((s) => s.conceptCount === 500))' <<<"$FINAL")" = "true" ] \
  && pass "every layer indexed its full 500 documents (the cap delayed passes, never dropped work)" \
  || fail "a layer under-counted after queueing ($FINAL)"

# ---- 2. /api/active-source: the on-screen layer jumps a serial queue -------
mkdir -p "$TMP/pri"
for i in a b c d; do
  mkdir -p "$TMP/pri/$i"
  node -e '
    const fs = require("node:fs");
    const dir = process.argv[1];
    for (let i = 0; i < 800; i++) {
      fs.writeFileSync(`${dir}/n${i}.md`, `# N${i}\n\n## Body {#body}\n\nsome moderately sized body text for note ${i} in ${dir}, repeated a bit ${i}${i}${i}.\n`);
    }
  ' "$TMP/pri/$i"
done
cat > "$TMP/manifest-pri.json" <<EOF
{ "layers": [
  {"name":"a","level":1,"path":"$TMP/pri/a"},
  {"name":"b","level":1,"path":"$TMP/pri/b"},
  {"name":"c","level":1,"path":"$TMP/pri/c"},
  {"name":"d","level":1,"path":"$TMP/pri/d"}
], "settings": { "maxConcurrentIndexing": 1 } }
EOF

node "$TMP/host.mjs" "$PORT2" "$TMP/manifest-pri.json" >/dev/null 2>&1 &
PID2=$!
for _ in $(seq 1 50); do curl -sf "$BASE2/api/settings" >/dev/null 2>&1 && break; sleep 0.05; done

echo "2. strictly serial (cap=1): the active-source hint reorders the queue"
# Fire the request that starts indexing (source "a" claims the only slot
# synchronously), then immediately mark "d" — the last in manifest order, and
# so normally the last to run — as the one on screen.
curl -s "$BASE2/api/status" >/dev/null
curl -s -X POST -H 'content-type: application/json' -d '{"name":"d"}' "$BASE2/api/active-source" >/dev/null

READY_AT=""
for _ in $(seq 1 800); do
  ST="$(curl -s "$BASE2/api/status")"
  NEWLY="$(JQ 'd.sources.filter((s) => s.status === "ok").map((s) => s.name).join(",")' <<<"$ST")"
  if [ -n "$NEWLY" ] && [ "$NEWLY" != "$READY_AT" ]; then
    READY_AT="$READY_AT|$NEWLY@$(date +%s%N)"
  fi
  DONE="$(JQ 'String(d.sources.every((s) => s.status === "ok"))' <<<"$ST")"
  [ "$DONE" = "true" ] && break
  sleep 0.005
done
ORDER="$(JQ 'd.sources.every((s) => s.status === "ok") ? "settled" : "unsettled"' <<<"$ST")"
[ "$ORDER" = "settled" ] || fail "priority run never settled"

# Reconstruct finish order from the transcript of "who's ok so far" snapshots.
FINISH_ORDER="$(node -e '
  const transcript = process.argv[1].split("|").filter(Boolean);
  const seen = [];
  for (const entry of transcript) {
    const names = entry.split("@")[0].split(",").filter(Boolean);
    for (const n of names) if (!seen.includes(n)) seen.push(n);
  }
  process.stdout.write(seen.join(","));
' "$READY_AT")"
echo "  (finish order: $FINISH_ORDER)"
A_IDX="$(node -e 'process.stdout.write(String(process.argv[1].split(",").indexOf("a")))' "$FINISH_ORDER")"
D_IDX="$(node -e 'process.stdout.write(String(process.argv[1].split(",").indexOf("d")))' "$FINISH_ORDER")"
B_IDX="$(node -e 'process.stdout.write(String(process.argv[1].split(",").indexOf("b")))' "$FINISH_ORDER")"
C_IDX="$(node -e 'process.stdout.write(String(process.argv[1].split(",").indexOf("c")))' "$FINISH_ORDER")"
[ "$A_IDX" -ge 0 ] 2>/dev/null && [ "$D_IDX" -ge 0 ] 2>/dev/null \
  && [ "$D_IDX" -lt "$B_IDX" ] 2>/dev/null && [ "$D_IDX" -lt "$C_IDX" ] 2>/dev/null \
  && pass "the marked-active layer (d) finished before the un-marked ones behind it in queue order (b, c)" \
  || fail "the active hint did not reorder the queue (finish order: $FINISH_ORDER)"

if [ "$FAILED" = "0" ]; then
  echo "index concurrency test passed (cap enforced + no dropped work + active-source reorders the queue)"
else
  exit 1
fi
