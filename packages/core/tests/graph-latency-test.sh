#!/usr/bin/env bash
# Engine responsiveness + /api/graph cost budget.
#
# Two numbers, both about the same complaint: the shipped 0.5.0 Mac app feels
# laggy. The engine is single-threaded inside an Electron utility process and
# the console is the only client, so anything that owns the serving loop for a
# long time is felt directly.
#
#   1. RESPONSIVENESS WHILE INDEXING. The ratified background-work doctrine says
#      long work is fine and a busy UI is not: any task over 1s shows progress
#      and the user can navigate throughout. Expressed as a number: while a
#      source indexes, a cheap unrelated request (GET /api/settings — a manifest
#      read, not a corpus operation) must answer at p95 < 50ms and max < 250ms.
#      This is the loop-starvation gate. It catches a regression in the index
#      loop's yield discipline: raise YIELD_EVERY, or drop a yield, and this
#      goes red.
#
#      Note what this assertion does NOT reproduce, because it was written
#      expecting to: index work does not starve the serving loop. YIELD_EVERY=25
#      is not the yield that matters on the index path — snapshotSource awaits
#      source.loadConcept(id), and both files.mjs and okf-local.mjs reach fsp
#      for it, so the loop is released on EVERY document. The 25-document yield
#      only bites where loadConcept is a Map lookup, i.e. snapshotView inside
#      buildGraph. So this assertion is GREEN today and is kept as a live SLO
#      gate: it goes red the day someone raises YIELD_EVERY, drops a yield, or
#      makes loadConcept synchronous.
#
#   2. /api/graph IS O(corpus) ON EVERY CALL. buildGraph loops every concept id,
#      resolves it, and runs an exact BPE countTokens — uncached, per request.
#      The console polls it every 900ms while indexing. Three consecutive calls
#      must come in under a 150ms median. THIS FAILS TODAY by more than an order
#      of magnitude and stays red until buildGraph is memoized. It is the whole
#      of the field-reported lag: the data the console asks for takes seconds,
#      not because cheap unrelated requests are starved.
#
# What "fixed" looks like: both pass with no change to the assertions.
# Network-free. Run from the repo root.
#
# ---- how the during-index window is measured, and why it is honest -----------
#
# The probe is GET /api/settings, deliberately: probing /api/graph would measure
# the expensive thing rather than the starvation it causes. The probe runs in a
# separate Node process using fetch + performance.now(), because curl's
# fork/exec overhead is tens of milliseconds and would swamp a 50ms threshold.
#
# The window runs from the add POST until the source reports ready, which needs
# a readiness signal — and /api/graph is the only route that carries index
# state at all. That would normally perturb what is being measured, except for
# one property of buildGraph: it resolves only sources that have FINISHED
# indexing (`perSource.filter((p) => p.snap)`), so while the corpus is still
# being read the graph call sees nothing but the 1-document seed layer and costs
# ~1.5ms. It is polled at 500ms, so the readiness signal costs well under a
# tenth of a percent of the window. The moment the corpus lands, that same call
# becomes a full O(corpus) build — which is exactly why the readiness poll is
# issued with a 200ms abort: a graph call that suddenly stops being cheap IS the
# completion signal, and aborting it keeps a five-second buildGraph from
# contaminating the tail of the measurement.
#
# The tokenizer's one-time ~800ms BPE table load (tokenize.mjs) is paid before
# any measurement: createEngineService warms it at boot, and the boot handshake
# below additionally drives one full /api/graph?wait= over the seed layer, so
# countTokens has run for real before the control probe starts. The idle control
# probe would report it as a multi-hundred-millisecond max if it had not.
set -uo pipefail

PORT="${GRAPH_LATENCY_PORT:-8861}"
BASE="http://127.0.0.1:$PORT"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
PIDS=()
FAILED=0

# Corpus knobs. 3,000 documents at 10-50KB is the plan's fixture: small docs
# hide the per-document CPU cost entirely, and the whole point is to measure it
# at a realistic size. ~90MB on disk, generated in well under a second.
NOTES="${GRAPH_LATENCY_NOTES:-3000}"
DOC_MIN_KB="${GRAPH_LATENCY_DOC_MIN_KB:-10}"
DOC_MAX_KB="${GRAPH_LATENCY_DOC_MAX_KB:-50}"

# Thresholds. Generous on purpose: CI boxes vary, and the regression classes
# being caught here are order-of-magnitude ones (O(corpus) per call, loop
# starvation), not micro-benchmarks.
PROBE_P95_MS=50
PROBE_MAX_MS=250
GRAPH_P50_MS=150

PROBE_INTERVAL_MS=100
READY_POLL_MS=500
READY_ABORT_MS=200
CONTROL_MS=2000
WINDOW_CEILING_MS=180000

# Guards against a green that means nothing. See the block above each use.
MIN_SAMPLES=20        # fewer than this and a p95 is not a percentile
MIN_WINDOW_MS=3400    # ~34 samples; also the floor that makes the corpus heavy enough
MIN_CORPUS_MB=20
MIN_AVG_DOC_KB=10

cleanup() {
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
# Integer math on values that came back from Node as strings.
num() { case "${1:-}" in ''|*[!0-9]*) echo "${2:-0}" ;; *) echo "$1" ;; esac; }

# ---- fixture -----------------------------------------------------------------
# Written by Node rather than a shell loop: 3,000 files is slow enough from bash
# to be worth a process. Sizes are spread deterministically across the range so
# a re-run measures the same corpus.
mkdir -p "$TMP/corpus" "$TMP/seed"
printf -- '---\ntype: note\ntitle: Seed\nupdated: 2026-07-01\n---\n\n# Seed\n\n## Body {#body}\n\nOne tiny document, so the graph stays cheap while the corpus indexes.\n' \
  > "$TMP/seed/seed.md"
cat > "$TMP/gen.mjs" <<'EOF'
import fs from "node:fs";
const [dir, count, minKB, maxKB] = process.argv.slice(2);
const words = ("decision architecture retrieval cascade layer precedence conflict provenance "
  + "manifest indexing rollout migration schema latency invariant tokenizer budget throughput "
  + "starvation worker snapshot resolver percentile responsiveness").split(" ");
const para = (i) => Array.from({ length: 70 }, (_, k) => words[(i + k) % words.length]).join(" ");
const n = Number(count);
const lo = Number(minKB) * 1024;
const hi = Number(maxKB) * 1024;
const t0 = Date.now();
let bytes = 0;
try {
  for (let i = 0; i < n; i++) {
    // 7919 is prime, so consecutive documents land on different sizes and the
    // spread covers the whole range instead of clustering.
    const target = lo + ((i * 7919) % (hi - lo + 1));
    let body = "";
    for (let p = 0; body.length < target; p++) body += `${para(i + p)}\n\n`;
    const doc = `---\ntype: note\ntitle: Note ${i}\nupdated: 2026-07-01\n---\n\n# Note ${i}\n\n`
      + `## Body {#body}\n\n${body}## Links {#links}\n\nrelated: note-${(i + 1) % n}\n`;
    fs.writeFileSync(`${dir}/note-${i}.md`, doc);
    bytes += Buffer.byteLength(doc);
  }
} catch (err) {
  console.log(JSON.stringify({ error: `${err.message} (wrote ${bytes} bytes before failing)` }));
  process.exit(0);
}
console.log(JSON.stringify({
  ms: Date.now() - t0,
  mb: +(bytes / 1048576).toFixed(1),
  avgKB: +(bytes / n / 1024).toFixed(1),
}));
EOF
echo "fixture: $NOTES documents at ${DOC_MIN_KB}-${DOC_MAX_KB}KB"
GEN="$(node "$TMP/gen.mjs" "$TMP/corpus" "$NOTES" "$DOC_MIN_KB" "$DOC_MAX_KB")"
GEN_ERR="$(JQ 'd.error ? String(d.error) : ""' <<<"$GEN")"
if [ -n "$GEN_ERR" ]; then
  fail "could not write the corpus: $GEN_ERR — $MIN_CORPUS_MB+MB of temp space is required under $(dirname "$TMP")"
  echo "graph latency test FAILED"; exit 1
fi
CORPUS_MB="$(JQ 'String(d.mb)' <<<"$GEN")"
AVG_KB="$(JQ 'String(d.avgKB)' <<<"$GEN")"
echo "  ${CORPUS_MB}MB, avg ${AVG_KB}KB/doc, written in $(JQ 'String(d.ms)' <<<"$GEN")ms"

# Guard one of three. Machine-independent and independent of the fix, unlike a
# timing floor: a corpus of tiny documents cannot gate either number no matter
# how fast or slow the runner is, because the per-document CPU cost being
# measured simply isn't there. Task 0.1 shipped a first version that went green
# with the bug fully present because its fixture was too small; that is the
# failure mode these three guards exist to make impossible.
# Scaled against the size the corpus would have AFTER the doc-size floor is
# applied, not the size it has now — the two knobs compound, and suggesting a
# document count computed from 2KB documents would overshoot by an order of
# magnitude. Floored at the shipped default, which is known to clear the window
# guard below as well.
FIX_MIN_KB=$(( DOC_MIN_KB > MIN_AVG_DOC_KB ? DOC_MIN_KB : MIN_AVG_DOC_KB ))
FIX_MAX_KB=$(( DOC_MAX_KB > FIX_MIN_KB ? DOC_MAX_KB : 50 ))
SUGGEST_DOCS="$(awk "BEGIN{avg=($FIX_MIN_KB+$FIX_MAX_KB)/2; n=int($MIN_CORPUS_MB*1024/avg*1.5)+1; print (n>3000?n:3000)}")"
FIXTURE_GATED=0
if awk "BEGIN{exit !($CORPUS_MB >= $MIN_CORPUS_MB && $AVG_KB >= $MIN_AVG_DOC_KB)}"; then
  pass "the corpus is heavy enough to gate per-document cost (${CORPUS_MB}MB, ${AVG_KB}KB/doc)"
else
  FIXTURE_GATED=1
  fail "fixture too small to gate the bug (${CORPUS_MB}MB at ${AVG_KB}KB/doc, need >=${MIN_CORPUS_MB}MB at >=${MIN_AVG_DOC_KB}KB/doc) — small documents hide the CPU-per-document cost these assertions measure, and BOTH assertions below go green against an unfixed engine at this size; re-run with GRAPH_LATENCY_NOTES=$SUGGEST_DOCS GRAPH_LATENCY_DOC_MIN_KB=$FIX_MIN_KB GRAPH_LATENCY_DOC_MAX_KB=$FIX_MAX_KB"
fi
# Appended to any assertion that passes while a guard is down, so a green line
# can never be quoted as evidence the engine is fixed.
GATED_NOTE=""
[ "$FIXTURE_GATED" = 1 ] && GATED_NOTE=" [UNGATED: the fixture guard failed, so this result proves nothing]"

# A budget the corpus cannot trip, and a document ceiling above the knob, so a
# failure here is always about latency and never about a limit firing.
cat > "$TMP/manifest.json" <<EOF
{ "settings": { "sourceBudgetMs": 300000, "maxDocFiles": $(( NOTES * 2 > 1000 ? NOTES * 2 : 1000 )) },
  "layers": [ { "name": "seed", "level": 1, "source": "files", "path": "$TMP/seed" } ] }
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

# ---- the latency probe -------------------------------------------------------
# One request at a time — a fixed-cadence firehose would queue against itself
# and report its own contention as engine latency. Sequential also models what a
# UI actually does: one navigation, then the next.
#
# `until` is either a duration (idle control, settled graph calls) or the word
# "indexed", which runs the window until the named source finishes indexing.
# In "indexed" mode a second loop polls /api/graph every READY_POLL_MS with a
# READY_ABORT_MS abort. While the source is unfinished that call is ~1.5ms
# (buildGraph only walks sources that already have a snapshot); the moment it
# stops being cheap the source has landed, so an abort ends the window rather
# than letting a five-second buildGraph pollute the last samples.
#
# argv: <base> <probePath> <mode:ms|indexed> <arg> <intervalMs> <maxSamples|0>
#       <readyPollMs> <readyAbortMs> <ceilingMs> <token|->
cat > "$TMP/probe.mjs" <<'EOF'
const [base, probePath, mode, arg, intervalMs, maxSamples, readyPollMs, readyAbortMs, ceilingMs, token] =
  process.argv.slice(2);
const headers = token && token !== "-" ? { authorization: `Bearer ${token}` } : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { samples: 0, errors: 0, windowMs: 0, endedBy: null, all: [], progress: null, readyPolls: 0, readyPollMs: [], dropped: [] };

// TCP/TLS setup is a client artifact, not engine latency, and the real console
// holds a keep-alive connection. Pay it once, outside the measurement.
try { await (await fetch(`${base}${probePath}`, { headers })).arrayBuffer(); } catch { /* boot handshake already proved reachability */ }

let stop = false;
const ceiling = Number(ceilingMs);
// The instant the readiness poll that turned out to be expensive was ISSUED.
// Everything the probe recorded from that moment on is suspect — see the
// truncation below.
let cutoffAt = null;

async function readyLoop(sourceName) {
  const started = performance.now();
  while (!stop) {
    await sleep(Number(readyPollMs));
    if (stop) break;
    const t = performance.now();
    try {
      const res = await fetch(`${base}/api/graph`, { headers, signal: AbortSignal.timeout(Number(readyAbortMs)) });
      const body = await res.json();
      out.readyPolls += 1;
      out.readyPollMs.push(+(performance.now() - t).toFixed(2));
      const row = (body.sources ?? []).find((s) => s.name === sourceName);
      out.progress = row?.indexing ? `${row.indexing.phase} ${row.indexing.loaded}/${row.indexing.total}` : null;
      if (!row || row.indexing?.phase === "ready" || row.status === "error") {
        out.endedBy = row?.status === "error" ? "source-error" : "ready";
        stop = true;
      }
    } catch {
      // A graph call that stopped being cheap means the snapshot landed while
      // this request was in flight. End the window here rather than measuring
      // the buildGraph it triggered.
      out.endedBy = "graph-no-longer-cheap";
      cutoffAt = t;
      stop = true;
    }
    if (performance.now() - started >= ceiling) { out.endedBy = "ceiling"; stop = true; }
  }
}

const t0 = performance.now();
const ready = mode === "indexed" ? readyLoop(arg) : null;
const deadline = mode === "indexed" ? t0 + ceiling : t0 + Number(arg);
const cap = Number(maxSamples) || Infinity;
const taken = []; // { at, ms, failed }
for (;;) {
  const s = performance.now();
  let failed = false;
  try {
    const res = await fetch(`${base}${probePath}`, { headers });
    await res.arrayBuffer();
    if (!res.ok) failed = true;
  } catch { failed = true; }
  taken.push({ at: s, ms: +(performance.now() - s).toFixed(2), failed });
  if (stop) break;
  if (taken.length >= cap) { out.endedBy ??= "samples"; break; }
  if (performance.now() >= deadline) { out.endedBy ??= mode === "indexed" ? "ceiling" : "duration"; break; }
  await sleep(Number(intervalMs));
}
stop = true;
out.windowMs = Math.round(performance.now() - t0);
if (ready) await ready;

// Truncate at the completion transition. Ending the window on an aborted
// readiness poll stops the MEASUREMENT, but the server carries on building the
// full graph that poll triggered — so every probe issued from the moment that
// poll went out is queued behind work that is no longer indexing. Keeping those
// samples reports a ~100ms outlier as index starvation when it is nothing of
// the kind; measured, not assumed, and it is where every stray max in this
// window came from. They are reported, not silently swallowed: a reader is
// entitled to see what was excluded and judge the call.
for (const t of taken) {
  if (cutoffAt !== null && t.at >= cutoffAt) { out.dropped.push(t.ms); continue; }
  if (t.failed) out.errors += 1;
  out.all.push(t.ms);
  out.samples += 1;
}

const sorted = [...out.all].sort((a, b) => a - b);
// Nearest-rank percentile: with ~50 samples an interpolating estimator would
// invent precision the sample size does not support.
const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
out.p50 = pct(50);
out.p95 = pct(95);
out.min = sorted[0] ?? null;
out.max = sorted[sorted.length - 1] ?? null;
console.log(JSON.stringify(out));
EOF

export SERVICE_MJS="$ROOT/packages/core/src/service.mjs"
node "$TMP/host.mjs" "$PORT" "$TMP/manifest.json" sekrit true - >/dev/null 2>&1 &
PIDS+=($!)
for _ in $(seq 1 100); do curl -sf "${AUTH[@]}" "$BASE/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done
# Drives a real countTokens over the seed layer, so the tokenizer's one-time
# ~800ms BPE table load is definitely paid before anything is timed.
code 200 "$(C "${AUTH[@]}" "$BASE/api/graph?wait=15000")" "engine up, tokenizer warm"

# ---- control: the instrument is not the finding ------------------------------
# Everything below rests on /api/settings being genuinely cheap and on the probe
# adding nothing measurable. If an idle engine already answers slowly, a high
# number during indexing says nothing about starvation. This runs first and its
# numbers are printed, so the during-index result is always read against a known
# floor for THIS machine.
echo "control: a cheap request against an idle engine"
CTRL="$(node "$TMP/probe.mjs" "$BASE" /api/settings ms "$CONTROL_MS" "$PROBE_INTERVAL_MS" 0 0 0 "$WINDOW_CEILING_MS" sekrit)"
CTRL_DIST="$(JQ '`p50=${d.p50}ms p95=${d.p95}ms max=${d.max}ms min=${d.min}ms n=${d.samples} errors=${d.errors}`' <<<"$CTRL")"
CTRL_OK="$(JQ "String(d.errors === 0 && d.p95 < $PROBE_P95_MS && d.max < $PROBE_MAX_MS)" <<<"$CTRL")"
[ "$CTRL_OK" = "true" ] \
  && pass "GET /api/settings on an idle engine: $CTRL_DIST (probe overhead is not the finding)" \
  || fail "the idle control already breaches the SLO ($CTRL_DIST) — measurement overhead, a loaded machine, or an unwarmed tokenizer is in the way, so the during-index number below cannot be attributed to starvation"

# ---- 1. responsiveness while a source indexes --------------------------------
echo "1. a cheap request stays responsive while $NOTES documents index"
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"kind\":\"files\",\"name\":\"corpus\",\"level\":3,\"path\":\"$TMP/corpus\"}" "$BASE/api/sources")" \
  "the corpus is added"
# Indexing is lazy: it starts on the first request that calls ensureIndexes(),
# which /api/settings never does. One graph call kicks it off — cheap here,
# because the corpus has no snapshot yet and only the seed layer resolves.
curl -s -o /dev/null "${AUTH[@]}" "$BASE/api/graph"
WIN="$(node "$TMP/probe.mjs" "$BASE" /api/settings indexed corpus "$PROBE_INTERVAL_MS" 0 \
  "$READY_POLL_MS" "$READY_ABORT_MS" "$WINDOW_CEILING_MS" sekrit)"
WIN_DIST="$(JQ '`p50=${d.p50}ms p95=${d.p95}ms max=${d.max}ms min=${d.min}ms n=${d.samples} window=${d.windowMs}ms endedBy=${d.endedBy} lastProgress=${d.progress} errors=${d.errors} droppedAtCompletion=[${d.dropped.join("ms, ")}${d.dropped.length ? "ms" : ""}]`' <<<"$WIN")"
WIN_MS="$(num "$(JQ 'String(d.windowMs)' <<<"$WIN")" 0)"
WIN_N="$(num "$(JQ 'String(d.samples)' <<<"$WIN")" 0)"
READY_COST="$(JQ 'd.readyPollMs.length ? `${d.readyPolls} readiness polls, max ${Math.max(...d.readyPollMs)}ms` : "no readiness polls"' <<<"$WIN")"

# Guard two of three: a window too short to hold a percentile. If indexing
# finishes in a few hundred milliseconds you get a handful of probes and "p95"
# is whatever the slowest of five happened to be — a number that would go green
# against any engine at all.
WINDOW_GATED=0
if [ "$WIN_N" -lt "$MIN_SAMPLES" ] || [ "$WIN_MS" -lt "$MIN_WINDOW_MS" ]; then
  SUGGEST=$(( WIN_MS > 0 ? (NOTES * MIN_WINDOW_MS * 3) / (WIN_MS * 2) + 1 : NOTES * 3 ))
  WINDOW_GATED=1
  fail "the indexing window was too short to judge (${WIN_N} samples over ${WIN_MS}ms, need >=${MIN_SAMPLES} over >=${MIN_WINDOW_MS}ms) — a p95 over a handful of probes goes green against any engine; re-run with GRAPH_LATENCY_NOTES=$SUGGEST"
else
  pass "the window held a real distribution (${WIN_N} samples over ${WIN_MS}ms; $READY_COST)"
fi
# One suffix, whichever guard is down: with both firing the line would otherwise
# carry the same warning twice and read like boilerplate.
WIN_NOTE="$GATED_NOTE"
[ "$WINDOW_GATED" = 1 ] && WIN_NOTE=" [UNGATED: the fixture or window guard failed, so this result proves nothing]"

WIN_P95_OK="$(JQ "String(d.p95 !== null && d.p95 < $PROBE_P95_MS)" <<<"$WIN")"
WIN_MAX_OK="$(JQ "String(d.max !== null && d.max < $PROBE_MAX_MS)" <<<"$WIN")"
[ "$WIN_P95_OK" = "true" ] \
  && pass "p95 < ${PROBE_P95_MS}ms while indexing ($WIN_DIST)$WIN_NOTE" \
  || fail "GET /api/settings p95 breached ${PROBE_P95_MS}ms while indexing — $WIN_DIST; idle control was $CTRL_DIST. Index work shares the serving event loop, so an unrelated request queues behind a synchronous chunk (snapshotSource yields every YIELD_EVERY=25 documents)"
[ "$WIN_MAX_OK" = "true" ] \
  && pass "max < ${PROBE_MAX_MS}ms while indexing$WIN_NOTE" \
  || fail "GET /api/settings max breached ${PROBE_MAX_MS}ms while indexing — $WIN_DIST; idle control was $CTRL_DIST"
[ "$(JQ 'String(d.errors)' <<<"$WIN")" = "0" ] \
  && pass "every probe answered (no dropped or failed requests under index load)" \
  || fail "requests failed during indexing ($WIN_DIST)"

# ---- 2. /api/graph after the index settles -----------------------------------
echo "2. /api/graph answers inside a ${GRAPH_P50_MS}ms budget once the index has settled"
code 200 "$(C "${AUTH[@]}" "$BASE/api/graph?wait=300000")" "the corpus finishes indexing"
COUNT="$(curl -s "${AUTH[@]}" "$BASE/api/graph" | JQ 'String(d.sources?.find((s) => s.name === "corpus")?.conceptCount)')"
# Without this, a truncated or failed index would make the calls below cheap and
# assertion 2 would pass by measuring a corpus that isn't there.
[ "$COUNT" = "$NOTES" ] \
  && pass "all $NOTES documents are in the graph the calls below build" \
  || fail "the graph is not measuring the full corpus (conceptCount=$COUNT, want $NOTES) — a smaller graph is a cheaper graph, so the budget below would pass for the wrong reason"

GRAPH="$(node "$TMP/probe.mjs" "$BASE" /api/graph ms 300000 0 3 0 0 "$WINDOW_CEILING_MS" sekrit)"
GRAPH_DIST="$(JQ '`calls=[${d.all.join("ms, ")}ms] median=${d.p50}ms`' <<<"$GRAPH")"
GRAPH_OK="$(JQ "String(d.samples === 3 && d.errors === 0 && d.p50 !== null && d.p50 < $GRAPH_P50_MS)" <<<"$GRAPH")"
[ "$GRAPH_OK" = "true" ] \
  && pass "3 consecutive /api/graph calls, median < ${GRAPH_P50_MS}ms ($GRAPH_DIST)$GATED_NOTE" \
  || fail "/api/graph median breached ${GRAPH_P50_MS}ms — $GRAPH_DIST over $NOTES concepts (${CORPUS_MB}MB). The flat profile across all three calls is the tell: buildGraph resolves every concept and runs an exact BPE countTokens on every request, uncached, so there is nothing to warm up. The console polls this route every 900ms while indexing"

# ---- diagnostics: the same probe under real console traffic ------------------
# Printed, never asserted. Assertion 1 measures an idealised client that only
# navigates; the shipped console also polls /api/graph and /api/resolve-all in
# parallel every 900ms (apps/console/src/store.tsx), and those ARE the calls
# whose 25-concept synchronous chunks can push a cheap request's latency up.
#
# Not a gate yet, deliberately: the measured margin here is roughly 1.4x against
# the 50ms budget, which would flake on a loaded CI box, and a flaky gate gets
# muted and then ignored. WHOEVER LANDS THE buildGraph MEMOISATION SHOULD
# REVISIT THIS: once /api/graph is served from snapshots the margin should widen
# a lot, and the field scenario below becomes worth promoting to a hard
# assertion — it is the traffic pattern the user actually reported lag against.
echo "diagnostics: the same probe under the console's real traffic (printed, not asserted)"
cat > "$TMP/load.mjs" <<'EOF'
// Replays apps/console/src/store.tsx's refresh pass: /api/graph and
// /api/resolve-all in parallel, re-armed 900ms AFTER the pass resolves (the
// console uses setTimeout on completion, not a fixed-cadence interval, so
// passes never overlap). Appends one NDJSON line per completed request so the
// caller can still report what happened if this process is killed mid-pass.
// argv: <base> <mode:graph|console> <durationMs> <gapMs> <outFile> <token|->
import fs from "node:fs";
const [base, mode, durationMs, gapMs, outFile, token] = process.argv.slice(2);
const headers = token && token !== "-" ? { authorization: `Bearer ${token}` } : {};
const paths = mode === "console" ? ["/api/graph", "/api/resolve-all"] : ["/api/graph"];
const end = performance.now() + Number(durationMs);
const get = async (p) => {
  const t = performance.now();
  // Logged on the way IN as well as out: one /api/graph over a settled corpus
  // outlives these short diagnostic windows, so completions alone would report
  // an empty file and read as "the load never ran".
  fs.appendFileSync(outFile, `${JSON.stringify({ path: p, started: true })}\n`);
  try {
    const res = await fetch(`${base}${p}`, { headers });
    await res.arrayBuffer();
    fs.appendFileSync(outFile, `${JSON.stringify({ path: p, ms: Math.round(performance.now() - t) })}\n`);
  } catch { /* the caller kills this process; a torn-off request is expected */ }
};
while (performance.now() < end) {
  await Promise.all(paths.map(get));
  if (performance.now() >= end) break;
  await new Promise((r) => setTimeout(r, Number(gapMs)));
}
EOF
# Reports what the load process actually managed to do, so a diagnostic can
# never be read as "responsive under load" when the load never landed.
loadsum() { [ -s "$1" ] && node -e '
  const lines = require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const by = {};
  for (const l of lines) {
    const row = (by[l.path] ??= { started: 0, done: [] });
    if (l.started) row.started += 1; else row.done.push(l.ms);
  }
  process.stdout.write(Object.entries(by).map(([p, r]) => {
    const done = r.done.length ? `${r.done.length} completed, slowest ${Math.max(...r.done)}ms` : "none completed inside the window";
    return `${p}: ${r.started} issued, ${done}`;
  }).join("; "));
' "$1" || printf 'the load process issued nothing — this diagnostic is meaningless'; }

DIAG() { printf '       %-56s %s\n' "$1" "$2"; }
LOADLINE() { printf '         load: %s\n' "$1"; }
DIAG "bare index, no other client traffic (assertion 1)" "$(JQ '`p50=${d.p50}ms p95=${d.p95}ms max=${d.max}ms n=${d.samples}`' <<<"$WIN")"

# Settled corpus, console polling /api/graph alone.
: > "$TMP/load-graph.ndjson"
node "$TMP/load.mjs" "$BASE" graph 4000 900 "$TMP/load-graph.ndjson" sekrit >/dev/null 2>&1 &
LOAD_PID=$!
PIDS+=("$LOAD_PID")
D2="$(node "$TMP/probe.mjs" "$BASE" /api/settings ms 4000 "$PROBE_INTERVAL_MS" 0 0 0 "$WINDOW_CEILING_MS" sekrit)"
kill "$LOAD_PID" 2>/dev/null; wait "$LOAD_PID" 2>/dev/null
DIAG "settled corpus + /api/graph poll" "$(JQ '`p50=${d.p50}ms p95=${d.p95}ms max=${d.max}ms n=${d.samples}`' <<<"$D2")"
LOADLINE "$(loadsum "$TMP/load-graph.ndjson")"

# The full field shape: a settled corpus, a second source indexing on top of it,
# and the console's real two-endpoint refresh pass running throughout.
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"kind\":\"files\",\"name\":\"corpus2\",\"level\":2,\"path\":\"$TMP/corpus\"}" "$BASE/api/sources")" \
  "a second source is added on top of the settled one"
: > "$TMP/load-console.ndjson"
node "$TMP/load.mjs" "$BASE" console 5000 900 "$TMP/load-console.ndjson" sekrit >/dev/null 2>&1 &
LOAD_PID=$!
PIDS+=("$LOAD_PID")
D3="$(node "$TMP/probe.mjs" "$BASE" /api/settings ms 5000 "$PROBE_INTERVAL_MS" 0 0 0 "$WINDOW_CEILING_MS" sekrit)"
kill "$LOAD_PID" 2>/dev/null; wait "$LOAD_PID" 2>/dev/null
DIAG "settled corpus + second index + console refresh pass" "$(JQ '`p50=${d.p50}ms p95=${d.p95}ms max=${d.max}ms n=${d.samples}`' <<<"$D3")"
LOADLINE "$(loadsum "$TMP/load-console.ndjson")"

[ "$FAILED" = 0 ] && echo "graph latency test passed (responsive under indexing + /api/graph inside budget)" || { echo "graph latency test FAILED"; exit 1; }
