#!/usr/bin/env bash
# Index-stability regression suite.
#
# THIS SUITE IS EXPECTED TO FAIL until the source-stability work lands. It is
# the gate, written first: three field-reported failures of the shipped Mac app,
# each reproduced here against the bare engine service.
#
#   1. CHURN NEVER SETTLES. syncWatchers puts an unfiltered recursive fs.watch
#      on every layer root, and any event debounces 250ms into invalidateIndex,
#      which CANCELS and RESTARTS the running index job. Obsidian rewrites
#      .obsidian/workspace.json the whole time the vault is open, so the index
#      sawtooths and never reaches "ready". Untouched, the same vault indexes in
#      a couple of seconds — the control assertion below proves exactly that, so
#      a failure here is the watcher and not a slow machine.
#
#   2. RENAME THROWS THE INDEX AWAY. The index cache key is JSON.stringify(layer),
#      which includes `name` and `level`. Renaming a source through
#      PATCH /api/sources therefore mints a new key: pruneIndexes drops the
#      finished entry and ensureIndexes starts a fresh job with previousSnap
#      null, so the source blinks to 0 concepts and re-reads every file. Nothing
#      about the source's content changed.
#
#   3. ONE BAD LAYER BRICKS EVERY ENDPOINT. Manifest validation runs inside
#      openSources(), which every route calls, so a single malformed layer makes
#      /api/settings, /api/graph and everything else answer 500 — including the
#      Settings screen a user would need to fix the bad source.
#
# What "fixed" looks like: all three assertions pass with no change to the
# assertions themselves. Network-free. Run from the repo root.
set -uo pipefail

PORT="${INDEX_STABILITY_PORT:-8841}"   # churn + rename host
PORT2=$((PORT + 1))                    # control host: same corpus, no churn
PORT3=$((PORT + 2))                    # bad-layer quarantine host
BASE="http://127.0.0.1:$PORT"
BASE2="http://127.0.0.1:$PORT2"
BASE3="http://127.0.0.1:$PORT3"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
PIDS=()
CHURN_PID=""
FAILED=0

# Corpus size. Tuned so one undisturbed pass takes a second or two: long enough
# that a 300ms churn cycle cannot let it finish (the restart period is several
# times shorter than the work), small enough to stay cheap in CI. Absolute
# indexing speed is not load-bearing — the observation window below is derived
# from the control's own measurement, so a slow machine gets more time rather
# than a false failure.
NOTES="${INDEX_STABILITY_NOTES:-3000}"
CHURN_MS=300           # Obsidian rewrites workspace.json at roughly this rate
CHURN_SLEEP="$(awk "BEGIN{print $CHURN_MS/1000}")"
POLL_MS=400            # /api/graph resolves every concept; polling harder starves the indexer
READY_TIMEOUT_MS=30000 # recomputed from the control measurement below
RENAME_OBSERVE_MS=5000

cleanup() {
  [ -n "$CHURN_PID" ] && kill "$CHURN_PID" 2>/dev/null
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILED=1; }
code() { [ "$2" = "$1" ] && pass "$3 ($2)" || fail "$3 (got $2, want $1)"; }
C() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
AUTH=(-H "Authorization: Bearer sekrit")
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

# ---- fixtures ----------------------------------------------------------------
# Two copies of the same corpus: one gets churned, one never does, so the
# control's timing is a real answer about this machine rather than a reading
# taken through the bug under test.
mkdir -p "$TMP/vault" "$TMP/vault-control" "$TMP/seed"
printf '# Seed\n\n## Body\n\nA small layer that is never churned.\n' > "$TMP/seed/seed.md"
node -e '
  const fs = require("node:fs");
  const [dirA, dirB, count] = process.argv.slice(1);
  const words = "decision architecture retrieval cascade layer precedence conflict provenance manifest indexing rollout migration schema latency invariant".split(" ");
  const para = (i) => Array.from({ length: 70 }, (_, k) => words[(i + k) % words.length]).join(" ");
  for (let i = 0; i < Number(count); i++) {
    const body = Array.from({ length: 6 }, (_, p) => para(i + p)).join("\n\n");
    const doc = `# Note ${i}\n\n## Body\n\n${body}\n\n## Links\n\n${body}\n`;
    fs.writeFileSync(`${dirA}/note-${i}.md`, doc);
    fs.writeFileSync(`${dirB}/note-${i}.md`, doc);
  }
' "$TMP/vault" "$TMP/vault-control" "$NOTES"
# The vault's own app-state directory, present before anything watches it —
# this is the file Obsidian rewrites while it is open.
mkdir -p "$TMP/vault/.obsidian"
printf '{"main":{"id":"seed"}}' > "$TMP/vault/.obsidian/workspace.json"

# A generous per-source budget so a slow machine reports the watcher behaviour
# under test rather than the 30s default budget tripping first.
cat > "$TMP/manifest.json" <<EOF
{ "settings": { "sourceBudgetMs": 120000 },
  "layers": [ { "name": "seed", "level": 1, "source": "files", "path": "$TMP/seed" } ] }
EOF
cat > "$TMP/manifest-control.json" <<EOF
{ "settings": { "sourceBudgetMs": 120000 },
  "layers": [
    { "name": "seed", "level": 1, "source": "files", "path": "$TMP/seed" },
    { "name": "vault", "level": 3, "source": "files", "path": "$TMP/vault-control" }
  ] }
EOF

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

# ---- the observer ------------------------------------------------------------
# Polls /api/graph and reports what one source's index actually DID over a
# window, not just where it ended up: the phases it passed through, how far it
# got, how often it went backwards (a cancel/restart), and the lowest concept
# count anyone querying at that moment would have seen. Every failure message in
# this suite is built from this summary, because "never ready" and "ready in
# 1.9s" are the same single sample until you watch the whole window.
#
# argv: <base> <sourceName> <timeoutMs> <intervalMs> <stopOnReady> <token|->
cat > "$TMP/observe.mjs" <<'EOF'
const [base, name, timeoutMs, intervalMs, stopOnReady, token] = process.argv.slice(2);
const headers = token && token !== "-" ? { authorization: `Bearer ${token}` } : {};
const started = Date.now();
const deadline = started + Number(timeoutMs);
const out = {
  samples: 0, httpErrors: 0, missingRows: 0,
  reachedReady: false, leftReady: false, restarts: 0,
  minConceptCount: null, maxConceptCount: null, maxLoaded: 0,
  lastStatus: null, lastPhase: null, lastLoaded: null, lastTotal: null,
  lastElapsedMs: null, lastError: null, observedMs: 0,
};
let prevLoaded = null;
let prevElapsed = null;
for (;;) {
  out.samples += 1;
  let graph = null;
  try {
    const res = await fetch(`${base}/api/graph`, { headers });
    if (!res.ok) { out.httpErrors += 1; out.lastError = `HTTP ${res.status}`; }
    else graph = await res.json();
  } catch (err) { out.httpErrors += 1; out.lastError = String(err.message); }

  if (graph) {
    const row = (graph.sources ?? []).find((s) => s.name === name);
    if (!row) {
      // A vanished row contributes nothing, which is the same user-visible
      // outcome as a zeroed one.
      out.missingRows += 1;
      out.leftReady = true;
      out.minConceptCount = 0;
    } else {
      const count = row.conceptCount ?? 0;
      const phase = row.indexing?.phase ?? null;
      const loaded = row.indexing?.loaded ?? 0;
      const elapsed = row.indexing?.elapsedMs ?? 0;
      out.minConceptCount = out.minConceptCount === null ? count : Math.min(out.minConceptCount, count);
      out.maxConceptCount = out.maxConceptCount === null ? count : Math.max(out.maxConceptCount, count);
      out.maxLoaded = Math.max(out.maxLoaded, loaded);
      // Progress running backwards, or the job clock resetting, means the
      // previous job was cancelled and a new one started.
      if (prevLoaded !== null && (loaded < prevLoaded || elapsed < prevElapsed)) out.restarts += 1;
      prevLoaded = loaded;
      prevElapsed = elapsed;
      out.lastStatus = row.status;
      out.lastPhase = phase;
      out.lastLoaded = loaded;
      out.lastTotal = row.indexing?.total ?? null;
      out.lastElapsedMs = elapsed;
      if (row.error) out.lastError = row.error;
      if (phase === "ready") out.reachedReady = true; else out.leftReady = true;
      if (phase === "ready" && stopOnReady === "true") break;
    }
  }
  if (Date.now() >= deadline) break;
  await new Promise((r) => setTimeout(r, Number(intervalMs)));
}
out.observedMs = Date.now() - started;
console.log(JSON.stringify(out));
EOF

export SERVICE_MJS="$ROOT/packages/core/src/service.mjs"

# ---- control: the harness works, and the corpus is sized for this machine -----
# If this fails, nothing below is trustworthy: it would mean the poller, the
# JSON shape, or the fixture size is wrong rather than the engine.
node "$TMP/host.mjs" "$PORT2" "$TMP/manifest-control.json" sekrit true - >/dev/null 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do curl -sf "${AUTH[@]}" "$BASE2/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done

echo "control: an unchurned vault of $NOTES notes indexes to ready"
CTRL="$(node "$TMP/observe.mjs" "$BASE2" vault "$READY_TIMEOUT_MS" "$POLL_MS" true sekrit)"
CTRL_READY="$(JQ 'String(d.reachedReady)' <<<"$CTRL")"
CTRL_MS="$(JQ 'String(d.observedMs)' <<<"$CTRL")"
CTRL_COUNT="$(JQ 'String(d.maxConceptCount)' <<<"$CTRL")"
[ "$CTRL_READY" = "true" ] \
  && pass "the corpus reaches phase=ready untouched in ${CTRL_MS}ms (poller and fixture are sound)" \
  || fail "control never reached ready in ${CTRL_MS}ms — the fixture is too big for this machine or the poller is broken ($CTRL)"
[ "$CTRL_COUNT" = "$NOTES" ] \
  && pass "the control indexed all $NOTES notes" \
  || fail "control concept count ($CTRL_COUNT, want $NOTES) ($CTRL)"

# The churned vault gets a generous multiple of what the SAME corpus just took
# untouched on THIS machine, so a loaded or slow runner buys time instead of a
# false failure. The bug does not care how large the window is: the index
# restarts every ~${CHURN_MS}ms, so it cannot finish inside any window.
case "$CTRL_MS" in ''|*[!0-9]*) CTRL_MS=30000 ;; esac
READY_TIMEOUT_MS=$((CTRL_MS * 8))
[ "$READY_TIMEOUT_MS" -lt 30000 ] && READY_TIMEOUT_MS=30000
[ "$READY_TIMEOUT_MS" -gt 90000 ] && READY_TIMEOUT_MS=90000

# ---- host A: churn + rename ---------------------------------------------------
node "$TMP/host.mjs" "$PORT" "$TMP/manifest.json" sekrit true - >/dev/null 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do curl -sf "${AUTH[@]}" "$BASE/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done

echo "1. an open Obsidian vault still finishes indexing"
# The churn starts BEFORE the source is added, so the watcher is installed onto
# an already-noisy tree — exactly the order a user hits when they add a vault
# they currently have open.
#
# This fires on CI as well as on a Mac: fs.watch({recursive:true}) has delivered
# subdirectory events on Linux since Node 20.13, verified against node:22 (the
# version CI pins), so writes under .obsidian/ do reach the watcher there.
(
  while true; do
    printf '{"main":{"id":"%s%s"}}' "$RANDOM" "$RANDOM" > "$TMP/vault/.obsidian/workspace.json"
    sleep "$CHURN_SLEEP"
  done
) &
CHURN_PID=$!
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"vault\",\"level\":3,\"path\":\"$TMP/vault\"}" "$BASE/api/sources")" "the vault is added while its app-state file churns"
CHURNED="$(node "$TMP/observe.mjs" "$BASE" vault "$READY_TIMEOUT_MS" "$POLL_MS" true sekrit)"
CH_READY="$(JQ 'String(d.reachedReady)' <<<"$CHURNED")"
CH_MS="$(JQ 'String(d.observedMs)' <<<"$CHURNED")"
CH_DESC="$(JQ '`phase=${d.lastPhase} loaded=${d.lastLoaded}/${d.lastTotal} maxLoaded=${d.maxLoaded} restarts=${d.restarts} samples=${d.samples}`' <<<"$CHURNED")"
[ "$CH_READY" = "true" ] \
  && pass "the vault reaches phase=ready while .obsidian churns (${CH_MS}ms)" \
  || fail "the vault never reaches phase=ready while .obsidian churns ($CH_DESC after ${CH_MS}ms; the control settled in ${CTRL_MS}ms — every watcher event cancels and restarts the index job)"
# A churning layer must not take the rest of the cascade down with it.
SEED_STATUS="$(curl -s "${AUTH[@]}" "$BASE/api/graph" | JQ 'String(d.sources?.find((s) => s.name === "seed")?.status)')"
[ "$SEED_STATUS" = "ok" ] \
  && pass "an unrelated layer stays readable while the vault churns" \
  || fail "the churning layer took another source with it (seed status=$SEED_STATUS)"

# Stop the churn and let the vault settle: assertion 2 is about a rename of an
# already-indexed source, so it must start from a genuinely settled one.
kill "$CHURN_PID" 2>/dev/null
wait "$CHURN_PID" 2>/dev/null
CHURN_PID=""
SETTLED="$(node "$TMP/observe.mjs" "$BASE" vault "$READY_TIMEOUT_MS" "$POLL_MS" true sekrit)"
SETTLED_READY="$(JQ 'String(d.reachedReady)' <<<"$SETTLED")"
[ "$SETTLED_READY" = "true" ] \
  && pass "with the churn stopped the same vault settles in $(JQ 'String(d.observedMs)' <<<"$SETTLED")ms" \
  || fail "the vault never settled even after the churn stopped ($SETTLED)"

echo "2. renaming a settled source does not re-read it"
BEFORE_COUNT="$(curl -s "${AUTH[@]}" "$BASE/api/graph" | JQ 'String(d.sources?.find((s) => s.name === "vault")?.conceptCount)')"
# Without this, a rename assertion comparing against an already-empty source
# would pass for the wrong reason.
[ "$BEFORE_COUNT" = "$NOTES" ] \
  && pass "the source holds all $NOTES concepts going in" \
  || fail "the source was not fully indexed before the rename (conceptCount=$BEFORE_COUNT, want $NOTES)"
code 200 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"vault","newName":"vault-renamed","level":3}' "$BASE/api/sources")" "rename the settled source"
# Watch the whole window, not the end of it: a re-index that starts and finishes
# inside 5s still blanked the user's graph on the way through.
RENAMED="$(node "$TMP/observe.mjs" "$BASE" vault-renamed "$RENAME_OBSERVE_MS" 100 false sekrit)"
MIN_COUNT="$(JQ 'String(d.minConceptCount)' <<<"$RENAMED")"
LEFT_READY="$(JQ 'String(d.leftReady)' <<<"$RENAMED")"
RN_DESC="$(JQ '`minConceptCount=${d.minConceptCount} maxConceptCount=${d.maxConceptCount} lastPhase=${d.lastPhase} restarts=${d.restarts} missingRows=${d.missingRows} samples=${d.samples}`' <<<"$RENAMED")"
[ "$MIN_COUNT" = "$BEFORE_COUNT" ] \
  && pass "conceptCount held at $BEFORE_COUNT across the rename" \
  || fail "the rename blanked the source: conceptCount fell to $MIN_COUNT (was $BEFORE_COUNT) within ${RENAME_OBSERVE_MS}ms — $RN_DESC; the index key includes the layer name, so a rename mints a new key and re-reads every file"
[ "$LEFT_READY" = "false" ] \
  && pass "indexing.phase stayed ready across the rename (no re-index)" \
  || fail "the rename restarted indexing: phase left ready during the ${RENAME_OBSERVE_MS}ms window — $RN_DESC"

# ---- host C: one bad layer must not brick the app -----------------------------
echo "3. a malformed layer is quarantined, not fatal"
# Two shapes, because the manifest rejects both the same way and a user can
# produce either by hand: a source kind that does not exist, and an okf-local
# layer missing its required path.
cat > "$TMP/manifest-bad.json" <<EOF
{ "layers": [
    { "name": "seed", "level": 1, "source": "files", "path": "$TMP/seed" },
    { "name": "bad-kind", "level": 2, "source": "notarealkind", "path": "$TMP/seed" },
    { "name": "bad-shape", "level": 0 }
  ] }
EOF
node "$TMP/host.mjs" "$PORT3" "$TMP/manifest-bad.json" sekrit true - >/dev/null 2>&1 &
PIDS+=($!)
# Not `curl -sf`: every route may well be answering 500 right now, which is the
# thing under test. Wait for the socket to answer at all.
for _ in $(seq 1 60); do [ "$(C "${AUTH[@]}" "$BASE3/api/settings")" != "000" ] && break; sleep 0.1; done

code 200 "$(C "${AUTH[@]}" "$BASE3/api/settings")" "GET /api/settings still answers with a bad layer in the manifest"
code 200 "$(C "${AUTH[@]}" "$BASE3/api/graph")" "GET /api/graph still answers with a bad layer in the manifest"
BAD="$(curl -s "${AUTH[@]}" "$BASE3/api/graph?wait=15000")"
BAD_ROWS="$(JQ 'JSON.stringify(d.sources?.map((s) => [s.name, s.status]) ?? d)' <<<"$BAD")"
[ "$(JQ 'String(d.sources?.find((s) => s.name === "bad-kind")?.status)' <<<"$BAD")" = "error" ] \
  && pass "the unknown-kind layer shows as an error row" \
  || fail "the unknown-kind layer is not an error row (graph says $BAD_ROWS)"
[ "$(JQ 'String(d.sources?.find((s) => s.name === "bad-shape")?.status)' <<<"$BAD")" = "error" ] \
  && pass "the shape-invalid layer shows as an error row" \
  || fail "the shape-invalid layer is not an error row (graph says $BAD_ROWS)"
[ "$(JQ 'String(d.sources?.find((s) => s.name === "seed")?.conceptCount)' <<<"$BAD")" = "1" ] \
  && pass "the healthy layer beside them still indexes" \
  || fail "a bad layer took the healthy one down with it (graph says $BAD_ROWS)"
code 200 "$(C "${AUTH[@]}" "$BASE3/api/resolve?concept=seed")" "a concept from the healthy layer still resolves"

[ "$FAILED" = 0 ] && echo "index stability test passed (churn settles + rename reuses the index + bad layers quarantined)" || { echo "index stability test FAILED"; exit 1; }
