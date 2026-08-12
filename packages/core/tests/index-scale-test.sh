#!/usr/bin/env bash
# The 20k-file scale gate. A vault of 20,000 notes (plus 2,000 attachments the
# walk must ignore) has to: finish its first index inside a real budget, hold
# resident heap under a ceiling that keeps far from the ~4.2GB V8 limit the
# desktop app cannot raise, and — the incremental promise — absorb a one-note
# edit in single-digit seconds with exactly one read. This is the "others may
# have 10,000 or 20,000" requirement made executable. Network-free.
set -uo pipefail

PORT="${PORT:-8897}"
BASE="http://127.0.0.1:$PORT"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
PID=""
FAILED=0

NOTES=20000
ATTACHMENTS=2000
FIRST_PASS_BUDGET_MS=120000
# Ceiling on resident heap after settle. Calibration on the reference machine:
# ~330MB live (contiguous sections + fingerprints + token counts for a ~60MB
# corpus). The gate sits well above run noise and far below the 4.2GB abort.
MAX_SETTLED_HEAP_MB=600
# The edit budget is deliberately BELOW what a 20k first pass costs on CI-grade
# hardware (~9s there, ~3s here). That is the assertion: the follow-up window
# must not inherit the last pass's duration, or one slow first index makes the
# first edit wait a second slow index. A correct pass here is watcher debounce
# + the 1s quiet window + a 22k-entry walk + exactly one read (~2s on CI).
EDIT_PASS_BUDGET_MS=6000

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILED=1; }
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

echo "index scale test: generating $NOTES notes + $ATTACHMENTS attachments"
node - "$TMP" "$NOTES" "$ATTACHMENTS" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [tmp, notesArg, attachArg] = process.argv.slice(2);
const NOTES = Number(notesArg);
const vault = path.join(tmp, "vault");
for (let a = 0; a < 60; a++) fs.mkdirSync(path.join(vault, `area-${a}`), { recursive: true });
const para = "A planning note names its owner, its rollback trigger, and the checks that gate the next phase. ";
for (let i = 0; i < NOTES; i++) {
  fs.writeFileSync(
    path.join(vault, `area-${i % 60}`, `note-${String(i).padStart(5, "0")}.md`),
    `# Note ${i}\n\n## Body {#body}\n\n${para.repeat(6 + (i % 9))}`,
  );
}
for (let i = 0; i < Number(attachArg); i++) {
  fs.writeFileSync(path.join(vault, `area-${i % 60}`, `img-${i}.png`), "not-really-a-png");
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
  res.writeHead(404); res.end();
}).listen(Number(port), "127.0.0.1");
EOF
export SERVICE_MJS="$ROOT/packages/core/src/service.mjs"

START_MS=$(node -e 'process.stdout.write(String(Date.now()))')
node "$TMP/host.mjs" "$PORT" "$TMP/layers.json" & PID=$!

# Settle: poll status until the first pass lands (bounded by the budget).
SETTLED=""
for _ in $(seq 1 $((FIRST_PASS_BUDGET_MS / 500))); do
  BODY="$(curl -s --max-time 10 "$BASE/api/status" 2>/dev/null)" || BODY=""
  case "$BODY" in *'"indexing":false'*) SETTLED="$BODY"; break;; esac
  sleep 0.5
done
ELAPSED_MS=$(( $(node -e 'process.stdout.write(String(Date.now()))') - START_MS ))
if [ -n "$SETTLED" ]; then
  COUNT="$(printf '%s' "$SETTLED" | JQ 'String(d.sources[0]?.conceptCount)')"
  if [ "$COUNT" = "$NOTES" ]; then
    pass "first index over $NOTES notes finished in ${ELAPSED_MS}ms (budget ${FIRST_PASS_BUDGET_MS}ms)"
  else
    fail "settled at $COUNT of $NOTES concepts"
  fi
else
  fail "the first pass did not finish within ${FIRST_PASS_BUDGET_MS}ms"
fi

# Resident heap after settle + one idle beat (memos evicted, GC given a beat).
sleep 3
HEAP_MB="$(curl -s "$BASE/api/status" | JQ 'String(Math.round((d.memoryDetail?.heapUsedBytes ?? 0) / (1024 * 1024)))')"
if [ "$HEAP_MB" -gt 0 ] 2>/dev/null && [ "$HEAP_MB" -lt "$MAX_SETTLED_HEAP_MB" ]; then
  pass "settled engine holds ${HEAP_MB}MB of heap (ceiling ${MAX_SETTLED_HEAP_MB}MB)"
else
  fail "settled heap is ${HEAP_MB}MB against a ${MAX_SETTLED_HEAP_MB}MB ceiling — the corpus shape regressed"
fi

# The incremental promise at scale: one edit, one read, seconds not minutes.
sleep 1.05
printf '# Note 0\n\n## Body {#body}\n\nEDITED at scale.\n' > "$TMP/vault/area-0/note-00000.md"
EDIT_START=$(node -e 'process.stdout.write(String(Date.now()))')
LANDED=""
for _ in $(seq 1 240); do
  BODY="$(curl -s --max-time 10 "$BASE/api/status" 2>/dev/null)" || BODY=""
  READS="$(printf '%s' "$BODY" | JQ 'String(d.sources[0]?.passStats?.read)')"
  case "$BODY" in *'"indexing":false'*) [ "$READS" = "1" ] && { LANDED="$BODY"; break; };; esac
  sleep 0.25
done
EDIT_MS=$(( $(node -e 'process.stdout.write(String(Date.now()))') - EDIT_START ))
if [ -n "$LANDED" ]; then
  STATS="$(printf '%s' "$LANDED" | JQ '(() => { const p = d.sources[0].passStats; return `${p.read} ${p.carried}` })()')"
  CARRIED=$((NOTES - 1))
  if [ "$STATS" = "1 $CARRIED" ] && [ "$EDIT_MS" -le "$EDIT_PASS_BUDGET_MS" ]; then
    pass "a one-note edit at 20k scale cost one read and landed in ${EDIT_MS}ms (stats: $STATS)"
  else
    fail "edit pass: stats='$STATS' in ${EDIT_MS}ms (want '1 $CARRIED' within ~${EDIT_PASS_BUDGET_MS}ms)"
  fi
else
  fail "the one-note edit never landed as a single-read pass within 60s"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "index scale test passed (20k first pass + bounded heap + incremental edit)"
  exit 0
fi
echo "index scale test FAILED"
exit 1
