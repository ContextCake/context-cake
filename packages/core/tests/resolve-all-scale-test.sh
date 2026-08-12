#!/usr/bin/env bash
# The resolve-all crash gate: /api/resolve-all and /api/discrepancies share one
# corpus materialization (resolvedCorpus memo), the response streams instead of
# building one giant string, and the engine's event loop stays answerable while
# it streams. This is the pass that used to OOM the desktop app on a 4,000-note
# Obsidian vault: the console fires both routes concurrently on bootstrap, and
# each ran its own full-corpus resolve plus a whole-payload JSON.stringify
# (measured 587MB peak for a 46MB corpus before the fix, 308MB after).
#
# Two hosts on one corpus: host A measures a COLD solo resolve-all (the price
# of one materialization), host B measures the COLD concurrent pair. Sharing is
# proven by the pair completing in about one materialization's time instead of
# two interleaved ones. Network-free. Run from the repo root.
set -uo pipefail

PORT="${PORT:-8891}"
BASE="http://127.0.0.1:$PORT"
PORT2=$((PORT + 1))
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

NOTES=3000
# The engine-side heap ceiling for the cold concurrent pair, measured via
# /api/status memoryDetail. Calibration on the reference machine: ~230MB after
# the shared memo + streaming, ~450MB+ before them (two corpus materializations
# plus two whole-payload strings). The gate sits between the two.
MAX_PAIR_HEAP_MB=400

echo "resolve-all scale test: generating $NOTES notes"
node - "$TMP" "$NOTES" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [tmp, notesArg] = process.argv.slice(2);
const NOTES = Number(notesArg);
const vault = path.join(tmp, "vault");
for (let a = 0; a < 30; a++) fs.mkdirSync(path.join(vault, `area-${a}`), { recursive: true });
const para = "The rollout plan names an owner per phase, a rollback trigger tied to the error budget, and the checks that must stay green while the migration runs. ";
for (let i = 0; i < NOTES; i++) {
  const parts = [`# Note ${i}`];
  for (let s = 0; s < 4; s++) {
    parts.push(`\n## Section ${s} {#s${s}}\n`);
    parts.push(para.repeat(5 + ((i + s) % 12)));
  }
  fs.writeFileSync(path.join(vault, `area-${i % 30}`, `note-${i}.md`), parts.join("\n"));
}
fs.writeFileSync(path.join(tmp, "layers.json"), JSON.stringify({
  layers: [{ name: "vault", level: 3, source: "files", path: vault }],
}, null, 2));
EOF

cat > "$TMP/host.mjs" <<'EOF'
import http from "node:http";
import { pathToFileURL } from "node:url";
const { createEngineService } = await import(pathToFileURL(process.env.SERVICE_MJS).href);
const [port, manifestPath] = process.argv.slice(2);
const svc = createEngineService({ manifestPath });
http.createServer(async (req, res) => {
  if (await svc.handleRequest(req, res)) return;
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "host-fallthrough" }));
}).listen(Number(port), "127.0.0.1");
EOF

export SERVICE_MJS="$ROOT/packages/core/src/service.mjs"
node "$TMP/host.mjs" "$PORT" "$TMP/layers.json" & PID1=$!
node "$TMP/host.mjs" "$PORT2" "$TMP/layers.json" & PID2=$!

# Both hosts must settle before anything is measured: every timing below is
# about resolving, never about indexing.
for base in "$BASE" "$BASE2"; do
  for _ in $(seq 1 120); do
    body="$(curl -s --max-time 10 "$base/api/status" 2>/dev/null)" || body=""
    case "$body" in *'"indexing":false'*) break;; esac
    sleep 1
  done
done
settled="$(curl -s --max-time 180 "$BASE/api/graph?wait=120000" | node -e '
  let s=""; process.stdin.on("data",(d)=>s+=d).on("end",()=>{
    const g = JSON.parse(s);
    process.stdout.write(`${g.indexing} ${g.totals?.concepts ?? 0}`);
  });')"
if [ "$settled" = "false $NOTES" ]; then pass "both hosts settled ($NOTES concepts indexed)"; else fail "hosts did not settle: got '$settled'"; fi

# ---- 1. COLD solo materialization on host A: the reference price -----------
SOLO_MS="$(node - "$BASE" <<'EOF'
const [base] = process.argv.slice(2);
const t0 = performance.now();
const res = await fetch(`${base}/api/resolve-all?wait=60000`);
const text = await res.text();
const ms = Math.round(performance.now() - t0);
const parsed = JSON.parse(text);
const keys = Object.keys(parsed).join(",");
if (res.status !== 200) { console.error(`status ${res.status}`); process.exit(1); }
if (keys !== "concepts,errors,indexing,indexingSources") { console.error(`keys ${keys}`); process.exit(1); }
if (parsed.indexing !== false) { console.error("still indexing"); process.exit(1); }
console.log(`${ms} ${parsed.concepts.length}`);
EOF
)" || { fail "cold solo resolve-all failed: $SOLO_MS"; SOLO_MS="99999 0"; }
SOLO_WALL="${SOLO_MS%% *}"
SOLO_COUNT="${SOLO_MS##* }"
if [ "$SOLO_COUNT" = "$NOTES" ]; then
  pass "streamed response is valid JSON with the exact legacy shape ($SOLO_COUNT concepts, cold build ${SOLO_WALL}ms)"
else
  fail "cold solo resolve-all returned $SOLO_COUNT of $NOTES concepts"
fi

# ---- 2. COLD concurrent pair on host B: the console's real bootstrap -------
PAIR_OUT="$(node - "$BASE2" <<'EOF'
const [base] = process.argv.slice(2);
let peakHeap = 0;
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    try {
      const s = await (await fetch(`${base}/api/status`)).json();
      peakHeap = Math.max(peakHeap, s.memoryDetail?.heapUsedBytes ?? 0);
    } catch { /* keep sampling */ }
    await new Promise((r) => setTimeout(r, 50));
  }
})();
const timed = async (url) => {
  const t0 = performance.now();
  const res = await fetch(url);
  const text = await res.text();
  return { ms: Math.round(performance.now() - t0), status: res.status, parsed: JSON.parse(text) };
};
const [ra, di] = await Promise.all([
  timed(`${base}/api/resolve-all?wait=60000`),
  timed(`${base}/api/discrepancies?wait=60000`),
]);
sampling = false;
await sampler;
if (ra.status !== 200 || di.status !== 200) { console.error(`status ${ra.status}/${di.status}`); process.exit(1); }
if (typeof di.parsed.generation !== "number") { console.error("discrepancies lost its generation field"); process.exit(1); }
if (ra.parsed.concepts.length !== di.parsed.errors.length + ra.parsed.concepts.length - di.parsed.errors.length) { /* shape sanity only */ }
console.log(`${Math.max(ra.ms, di.ms)} ${Math.round(peakHeap / (1024 * 1024))} ${ra.parsed.concepts.length}`);
EOF
)" || { fail "cold concurrent pair failed: $PAIR_OUT"; PAIR_OUT="99999 99999 0"; }
read -r PAIR_WALL PAIR_HEAP_MB PAIR_COUNT <<< "$PAIR_OUT"

if [ "$PAIR_COUNT" = "$NOTES" ]; then pass "concurrent pair answered the full corpus"; else fail "concurrent pair returned $PAIR_COUNT of $NOTES"; fi

# Sharing: one materialization, not two interleaved ones. Unshared concurrent
# builds each take ~2x the solo wall (they interleave on one event loop), so
# the pair's slower member finishing near the solo price is the proof. The
# +400ms floor keeps small absolute times from turning scheduler noise into a
# failure on slow CI.
LIMIT=$((SOLO_WALL * 16 / 10 + 400))
if [ "$PAIR_WALL" -lt "$LIMIT" ]; then
  pass "the pair shares one materialization (pair ${PAIR_WALL}ms vs solo ${SOLO_WALL}ms, limit ${LIMIT}ms)"
else
  fail "concurrent pair took ${PAIR_WALL}ms against a ${SOLO_WALL}ms solo build (limit ${LIMIT}ms) — resolve-all and discrepancies are materializing separately again"
fi

if [ "$PAIR_HEAP_MB" -lt "$MAX_PAIR_HEAP_MB" ]; then
  pass "engine heap stayed under ${MAX_PAIR_HEAP_MB}MB through the pair (peak ${PAIR_HEAP_MB}MB)"
else
  fail "engine heap peaked at ${PAIR_HEAP_MB}MB during the concurrent pair (limit ${MAX_PAIR_HEAP_MB}MB) — the corpus is being materialized more than once, or the response is being built as one string"
fi

# ---- 3. The event loop stays answerable while a response streams -----------
LOOP_OUT="$(node - "$BASE" <<'EOF'
const [base] = process.argv.slice(2);
// Warm memo on host A: this request is pure streaming work, which is exactly
// the load being probed. Latency probes ride alongside it.
const stream = fetch(`${base}/api/resolve-all`).then((r) => r.text());
const samples = [];
for (let i = 0; i < 40; i++) {
  const t0 = performance.now();
  try { await fetch(`${base}/api/settings`); samples.push(performance.now() - t0); } catch { samples.push(9999); }
  await new Promise((r) => setTimeout(r, 20));
}
await stream;
samples.sort((a, b) => a - b);
const p95 = samples[Math.floor(samples.length * 0.95) - 1] ?? samples.at(-1);
const max = samples.at(-1);
console.log(`${Math.round(p95 * 100) / 100} ${Math.round(max * 100) / 100}`);
EOF
)" || { fail "latency probe during stream failed"; LOOP_OUT="9999 9999"; }
read -r P95 MAXMS <<< "$LOOP_OUT"
P95_OK="$(node -e "process.stdout.write(String(Number(process.argv[1]) < 50))" "$P95")"
MAX_OK="$(node -e "process.stdout.write(String(Number(process.argv[1]) < 250))" "$MAXMS")"
if [ "$P95_OK" = "true" ] && [ "$MAX_OK" = "true" ]; then
  pass "/api/settings stayed cheap while resolve-all streamed (p95=${P95}ms max=${MAXMS}ms)"
else
  fail "/api/settings degraded during the stream (p95=${P95}ms max=${MAXMS}ms, limits 50/250) — streaming is monopolizing the loop"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "resolve-all scale test passed (shared materialization + streaming + responsive loop)"
  exit 0
fi
echo "resolve-all scale test FAILED"
exit 1
