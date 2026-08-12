#!/usr/bin/env bash
# Transient index failures retry themselves and RESUME. A fresh vault whose
# first pass timed out used to park at conceptCount 0 forever — error status,
# no retry, nothing owed — until a file changed or the app restarted. Now a
# timeout arms a bounded backoff, the aborted pass leaves its partial progress
# as a carry seed, and each retry picks up where the last stopped until the
# vault lands. ?wait= must never hang on a parked retry.
#
# The corpus is sized so one pass CANNOT fit the (deliberately tiny) time
# budget on any machine — convergence comes from the seed, not from speed —
# and the retry cadence/cap are env-injected so the test does not wait out
# production backoffs. Network-free. Run from the repo root.
set -uo pipefail

PORT="${PORT:-8899}"
BASE="http://127.0.0.1:$PORT"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
PID=""
FAILED=0
NOTES=1500

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
# The graph row carries indexProgress as `indexing` (passes, retries,
# passStats); the status row is the flat cheap shape. Assertions that need
# pass counters read the graph.
ROW() { curl -s "$BASE/api/graph" | JQ 'JSON.stringify(d.sources.find((s) => s.name === "vault") ?? null)'; }

echo "index retry test: generating $NOTES heavyweight notes"
node - "$TMP" "$NOTES" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [tmp, notesArg] = process.argv.slice(2);
const vault = path.join(tmp, "vault");
fs.mkdirSync(vault, { recursive: true });
// ~40KB per note: heavy enough that BPE for the corpus dwarfs any machine's
// ability to finish inside the 1.5s budget below.
const para = "An incident narrative long enough to make the tokenizer work for its answer, repeated until the document has real weight. ";
for (let i = 0; i < Number(notesArg); i++) {
  fs.writeFileSync(path.join(vault, `note-${String(i).padStart(4, "0")}.md`),
    `# Note ${i}\n\n## Body {#body}\n\n${para.repeat(320)}`);
}
fs.writeFileSync(path.join(tmp, "layers.json"), JSON.stringify({
  layers: [{ name: "vault", level: 3, source: "files", path: vault }],
  settings: { sourceBudgetMs: 1500 },
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
CONTEXTCAKE_RETRY_BACKOFFS_MS=250 CONTEXTCAKE_RETRY_MAX=60 node "$TMP/host.mjs" "$PORT" "$TMP/layers.json" & PID=$!
for _ in $(seq 1 80); do curl -sf "$BASE/api/status" >/dev/null 2>&1 && break; sleep 0.1; done

# ---- 1. the retry state is observable while the vault converges -------------
# Timing-tolerant on purpose: a fast machine can land the vault in a couple of
# attempts, so "sampled retries mid-flight" is best-effort here — the DURABLE
# evidence (indexing.passes > 1 on the landing row) is asserted in part 3.
SAW_RETRY=""
for _ in $(seq 1 200); do
  R="$(ROW)"
  RETRIES="$(JQ 'String(d?.indexing?.retries ?? 0)' <<<"$R")"
  STATUS="$(JQ 'String(d?.status)' <<<"$R")"
  if [ "$RETRIES" != "0" ] && [ "$RETRIES" != "undefined" ] && [ "$RETRIES" != "null" ]; then SAW_RETRY="$R"; break; fi
  [ "$STATUS" = "ok" ] && break
  sleep 0.05
done
if [ -n "$SAW_RETRY" ]; then
  pass "a timed-out pass armed a visible retry (retries=$(JQ 'String(d.indexing.retries)' <<<"$SAW_RETRY"))"
else
  pass "the vault converged before a retry could be sampled (evidence deferred to the landing row)"
fi

# ---- 2. ?wait= answers promptly while a retry is parked ---------------------
T0=$(node -e 'process.stdout.write(String(Date.now()))')
curl -s --max-time 20 "$BASE/api/graph?wait=8000" > /dev/null
WAIT_MS=$(( $(node -e 'process.stdout.write(String(Date.now()))') - T0 ))
# A parked retry is settled state; only a RUNNING pass may hold the socket.
# The retry cadence is 250ms and an attempt lives ~1.5s, so even a call that
# lands mid-attempt returns in a couple of seconds — far under the 8s asked.
if [ "$WAIT_MS" -lt 6000 ]; then
  pass "?wait= returned in ${WAIT_MS}ms while retries cycle (never held for the backoff)"
else
  fail "?wait= blocked for ${WAIT_MS}ms across a parked retry"
fi

# ---- 3. the retries CONVERGE via the carry seed ------------------------------
LANDED=""
for _ in $(seq 1 480); do
  R="$(ROW)"
  if [ "$(JQ 'String(d?.status)' <<<"$R")" = "ok" ] && [ "$(JQ 'String(d?.conceptCount)' <<<"$R")" = "$NOTES" ]; then LANDED="$R"; break; fi
  sleep 0.5
done
if [ -n "$LANDED" ]; then
  PASSES="$(JQ 'String(d.indexing.passes)' <<<"$LANDED")"
  CARRIED="$(JQ 'String(d.indexing.passStats.carried)' <<<"$LANDED")"
  READ="$(JQ 'String(d.indexing.passStats.read)' <<<"$LANDED")"
  pass "the vault landed after $PASSES attempts (final pass: carried=$CARRIED read=$READ)"
  if [ "$PASSES" -gt 1 ] 2>/dev/null && [ "$CARRIED" -gt 0 ] 2>/dev/null; then
    pass "the landing pass RESUMED from the seed instead of starting over"
  else
    fail "the landing pass shows no resume (passes=$PASSES carried=$CARRIED) — the carry seed is not being consulted"
  fi
else
  fail "the vault never converged: $(ROW)"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "index retry test passed (visible bounded retry + prompt waits + seeded convergence)"
  exit 0
fi
echo "index retry test FAILED"
exit 1
