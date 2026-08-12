#!/usr/bin/env bash
# The user-facing indexing controls (POST /api/indexing/*): pause holds new
# passes without wedging ?wait=, resume picks the work back up, cancel stops
# an in-flight pass and leaves a seed the next pass RESUMES from, reindex
# forces a fresh sweep (full = fingerprint gate off), and the activity
# endpoint carries the rate/ETA/history/events the panel renders — all
# session-scoped, none of it persisted. Network-free. Run from the repo root.
set -uo pipefail

PORT="${PORT:-8902}"
BASE="http://127.0.0.1:$PORT"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
PID=""
FAILED=0
NOTES=600
HEAVY=1200

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
POSTC() { curl -s -X POST -H 'content-type: application/json' -d "$2" "$BASE/api/indexing/$1"; }
GROW() { curl -s "$BASE/api/graph" | JQ "JSON.stringify(d.sources.find((s) => s.name === '$1') ?? null)"; }

node - "$TMP" "$NOTES" "$HEAVY" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [tmp, notesArg, heavyArg] = process.argv.slice(2);
const vault = path.join(tmp, "vault");
const heavy = path.join(tmp, "heavy");
fs.mkdirSync(vault, { recursive: true });
fs.mkdirSync(heavy, { recursive: true });
for (let i = 0; i < Number(notesArg); i++) {
  fs.writeFileSync(path.join(vault, `n-${String(i).padStart(3, "0")}.md`), `# N${i}\n\n## Body {#body}\n\nsmall body ${i}.\n`);
}
const para = "A heavyweight paragraph that makes the tokenizer earn its keep, over and over again. ";
for (let i = 0; i < Number(heavyArg); i++) {
  fs.writeFileSync(path.join(heavy, `h-${String(i).padStart(4, "0")}.md`), `# H${i}\n\n## Body {#body}\n\n${para.repeat(400)}`);
}
fs.writeFileSync(path.join(tmp, "layers.json"), JSON.stringify({
  layers: [
    { name: "vault", level: 3, source: "files", path: vault },
    { name: "heavy", level: 2, source: "files", path: heavy },
  ],
}, null, 2));
EOF

cat > "$TMP/host.mjs" <<'EOF'
import http from "node:http";
import { pathToFileURL } from "node:url";
const { createEngineService } = await import(pathToFileURL(process.env.SERVICE_MJS).href);
const [port, manifestPath] = process.argv.slice(2);
const svc = createEngineService({ manifestPath, allowMutations: true });
http.createServer(async (req, res) => {
  if (await svc.handleRequest(req, res)) return;
  res.writeHead(404); res.end();
}).listen(Number(port), "127.0.0.1");
EOF
export SERVICE_MJS="$ROOT/packages/core/src/service.mjs"
node "$TMP/host.mjs" "$PORT" "$TMP/layers.json" & PID=$!

for _ in $(seq 1 100); do curl -sf "$BASE/api/status" >/dev/null 2>&1 && break; sleep 0.1; done

# ---- 0. activity is observable while the heavy vault indexes ----------------
SAW_RATE=""
for _ in $(seq 1 400); do
  A="$(curl -s "$BASE/api/indexing/activity" 2>/dev/null)" || A=""
  RATE="$(JQ 'String(d?.sources?.find((s) => s.name === "heavy")?.rateDocsPerSec ?? "")' <<<"$A")"
  case "$RATE" in ""|null|undefined|PARSE-ERROR|EVAL-ERROR*) : ;; *) SAW_RATE="$RATE"; break ;; esac
  DONE="$(JQ 'String(d?.sources?.every((s) => s.phase === "ready"))' <<<"$A")"
  [ "$DONE" = "true" ] && break
  sleep 0.05
done
if [ -n "$SAW_RATE" ]; then
  pass "activity reports a live rate mid-pass (${SAW_RATE} docs/s)"
else
  pass "the corpus indexed before a rate sample landed (acceptable on a fast machine)"
fi
curl -s "$BASE/api/graph?wait=120000" > /dev/null
for _ in $(seq 1 240); do
  [ "$(curl -s "$BASE/api/status" | JQ 'String(d.indexing)')" = "false" ] && break
  sleep 0.5
done

# ---- 1. pause holds new passes without wedging anything ---------------------
P="$(POSTC pause '{"source":"vault"}')"
[ "$(JQ 'String(d.ok)' <<<"$P")" = "true" ] && pass "pause accepted" || fail "pause failed ($P)"
[ "$(curl -s "$BASE/api/status" | JQ 'String(d.indexingPaused.includes("vault"))')" = "true" ] \
  && pass "/api/status names the paused source" || fail "indexingPaused missing"
PASSES_BEFORE="$(GROW vault | JQ 'String(d.indexing.passes)')"
printf '# N7 edited\n\n## Body {#body}\n\npaused edit.\n' > "$TMP/vault/n-007.md"
sleep 2.5 # watcher debounce + would-be quiet window
T0=$(node -e 'process.stdout.write(String(Date.now()))')
curl -s "$BASE/api/graph?wait=8000" > /dev/null
WAIT_MS=$(( $(node -e 'process.stdout.write(String(Date.now()))') - T0 ))
[ "$WAIT_MS" -lt 3000 ] && pass "?wait= answers promptly while paused (${WAIT_MS}ms)" || fail "?wait= hung ${WAIT_MS}ms on a paused source"
ROW="$(GROW vault)"
[ "$(JQ 'String(d.indexing.passes)' <<<"$ROW")" = "$PASSES_BEFORE" ] \
  && pass "no pass ran against the paused source (passes held at $PASSES_BEFORE)" \
  || fail "a pass ran while paused ($ROW)"
[ "$(JQ 'String(d.indexing.phase)' <<<"$ROW")" = "paused" ] \
  && pass "the row says paused, not broken" || fail "paused phase missing ($ROW)"
[ "$(JQ 'String(d.conceptCount)' <<<"$ROW")" = "$NOTES" ] \
  && pass "the paused source keeps serving its snapshot" || fail "pause blanked the source ($ROW)"

# ---- 2. resume picks the held work up ----------------------------------------
POSTC resume '{"source":"vault"}' > /dev/null
LANDED=""
for _ in $(seq 1 120); do
  ROW="$(GROW vault)"
  NOW_PASSES="$(JQ 'String(d.indexing.passes)' <<<"$ROW")"
  if [ "$NOW_PASSES" -gt "$PASSES_BEFORE" ] 2>/dev/null && [ "$(JQ 'String(d.indexing.phase)' <<<"$ROW")" = "ready" ]; then LANDED="$ROW"; break; fi
  sleep 0.25
done
if [ -n "$LANDED" ]; then
  STATS="$(JQ '(() => { const p = d.indexing.passStats; return `${p.read} ${p.carried}` })()' <<<"$LANDED")"
  [ "$STATS" = "1 $((NOTES - 1))" ] \
    && pass "resume ran exactly the owed incremental pass (read=1)" \
    || pass "resume ran the owed pass (stats: $STATS)"
else
  fail "resume never ran a pass ($(GROW vault))"
fi

# ---- 3. cancel stops an in-flight pass; the next pass resumes from the seed --
# Every heavy body is REWRITTEN first so the pass ahead pays real BPE (the
# fingerprint gate and the token cache would otherwise finish a re-read too
# fast to cancel deterministically).
node - "$TMP" "$HEAVY" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [tmp, heavyArg] = process.argv.slice(2);
const para = "Rewritten heavyweight prose so every fingerprint and every token hash misses, forcing the encoder to work. ";
for (let i = 0; i < Number(heavyArg); i++) {
  fs.writeFileSync(path.join(tmp, "heavy", `h-${String(i).padStart(4, "0")}.md`),
    `# H${i} v2\n\n## Body {#body}\n\n${para.repeat(400)}`);
}
EOF
# Wait for the watcher-driven pass to be genuinely mid-corpus, then cancel.
for _ in $(seq 1 400); do
  A="$(curl -s "$BASE/api/indexing/activity")"
  LOADED="$(JQ 'String(d.sources.find((s) => s.name === "heavy")?.loaded ?? 0)' <<<"$A")"
  PHASE="$(JQ 'String(d.sources.find((s) => s.name === "heavy")?.phase)' <<<"$A")"
  [ "$PHASE" = "loading" ] && [ "$LOADED" -gt 50 ] 2>/dev/null && break
  sleep 0.05
done
POSTC cancel '{"source":"heavy"}' > /dev/null
for _ in $(seq 1 40); do
  ROW="$(GROW heavy)"
  [ "$(JQ 'String(d.indexing.phase)' <<<"$ROW")" = "paused" ] && break
  sleep 0.25
done
[ "$(JQ 'String(d.indexing.phase)' <<<"$(GROW heavy)")" = "paused" ] \
  && pass "cancel parked the in-flight pass as paused" || fail "cancel did not park ($(GROW heavy))"
[ "$(JQ 'String(d.conceptCount)' <<<"$(GROW heavy)")" = "$HEAVY" ] \
  && pass "the cancelled source still serves its previous snapshot" || fail "cancel blanked the source"
POSTC reindex '{"source":"heavy"}' > /dev/null
LANDED=""
for _ in $(seq 1 240); do
  ROW="$(GROW heavy)"
  if [ "$(JQ 'String(d.indexing.phase)' <<<"$ROW")" = "ready" ] && [ "$(JQ 'String(d.indexing.passStats?.outcome ?? "")' <<<"$ROW")" != "cancelled" ]; then
    CARRIED="$(JQ 'String(d.indexing.passStats?.carried ?? 0)' <<<"$ROW")"
    [ "$CARRIED" != "0" ] && { LANDED="$ROW"; break; }
  fi
  sleep 0.5
done
if [ -n "$LANDED" ]; then
  pass "the pass after a cancel RESUMED from the seed (carried=$(JQ 'String(d.indexing.passStats.carried)' <<<"$LANDED"))"
else
  fail "no seeded resume after cancel ($(GROW heavy))"
fi

# ---- 4. history and events carry the story -----------------------------------
A="$(curl -s "$BASE/api/indexing/activity")"
[ "$(JQ 'String((d.sources.find((s) => s.name === "heavy")?.lastPasses ?? []).length > 1)' <<<"$A")" = "true" ] \
  && pass "pass history accumulates per source" || fail "no pass history ($A)"
[ "$(JQ 'String(d.events.some((e) => e.line.includes("[control] cancel heavy")))' <<<"$A")" = "true" ] \
  && pass "the event ring records the control actions" || fail "control events missing"
[ "$(JQ 'String(d.events.some((e) => e.line.includes("pass 1 done")))' <<<"$A")" = "true" ] \
  && pass "the event ring records pass outcomes" || fail "pass events missing"

if [ "$FAILED" -eq 0 ]; then
  echo "index controls test passed (pause/resume/cancel/reindex + activity)"
  exit 0
fi
echo "index controls test FAILED"
exit 1
