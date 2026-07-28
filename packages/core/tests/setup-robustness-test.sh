#!/usr/bin/env bash
# Setup robustness tests: locks in the fixes for the first-run "Resolving…"
# hang. The engine must never block or spin forever on a bad or over-sized
# source — walks are bounded, resolution reads each source once behind a time
# budget, and /api/sources validates folders and MCP commands at add time so
# setup fails on the form, not as a frozen app. Network-free. Run from repo root.
set -uo pipefail

PORT="${SETUP_PORT:-8821}"   # tight-caps host (env-shrunk limits)
PORT2=$((PORT + 1))          # default-caps host (responsiveness corpus)
BASE="http://127.0.0.1:$PORT"
BASE2="http://127.0.0.1:$PORT2"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC="$ROOT/packages/core/src"
TMP="$(mktemp -d)"
PID=""
PID2=""
FAILED=0

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
  [ -n "$PID2" ] && kill "$PID2" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILED=1; }
code() { [ "$2" = "$1" ] && pass "$3 ($2)" || fail "$3 (got $2, want $1)"; }
C() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

echo "bounded walk (walkDocs caps + honest errors)"

# A folder over the file cap and a folder over the scanned-entry cap.
mkdir -p "$TMP/many" "$TMP/wide"
node -e '
  const fs = require("node:fs");
  for (let i = 0; i < 30; i++) fs.writeFileSync(`${process.argv[1]}/many/doc-${i}.md`, "# D\n\ntext\n");
  for (let i = 0; i < 60; i++) fs.writeFileSync(`${process.argv[1]}/wide/junk-${i}.bin`, "x");
' "$TMP"

OUT="$(node --input-type=module -e "
import { walkDocs } from '$SRC/sources/okf-local.mjs';
try { await walkDocs('$TMP/many', ['.md'], { maxFiles: 5 }); console.log('NO-ERROR'); }
catch (e) { console.log(e.message); }
try { await walkDocs('$TMP/wide', ['.md'], { maxEntries: 10 }); console.log('NO-ERROR'); }
catch (e) { console.log(e.message); }
console.log(JSON.stringify(await walkDocs('$TMP/many', ['.md'])));
")"
grep -q 'too many documents' <<<"$OUT" && pass "file cap rejects with actionable message" || fail "file cap ($OUT)"
grep -q 'too large to index' <<<"$OUT" && pass "entry cap rejects with actionable message" || fail "entry cap ($OUT)"
grep -q 'doc-29' <<<"$OUT" && pass "in-bounds folder still lists fully" || fail "in-bounds walk ($OUT)"

OUT="$(CONTEXTCAKE_MAX_DOC_FILES=5 node --input-type=module -e "
import { createFilesSource } from '$SRC/sources/files.mjs';
const s = createFilesSource({ name: 'd', level: 2, root: '$TMP/many' });
try { await s.listConceptIds(); console.log('NO-ERROR'); } catch (e) { console.log(e.message); }
")"
grep -q 'too many documents' <<<"$OUT" && pass "files adapter honors CONTEXTCAKE_MAX_DOC_FILES" || fail "adapter env cap ($OUT)"

echo "bounded token counting"
T0="$(now_ms)"
OUT="$(node --input-type=module -e "
import { countTokens } from '$SRC/tokenize.mjs';
const huge = 'All work and no play makes for one giant markdown file. '.repeat(120000);
console.log(countTokens(huge) > 100000 ? 'BIG-COUNT-OK' : 'BAD-COUNT');
")"
T1="$(now_ms)"
grep -q 'BIG-COUNT-OK' <<<"$OUT" && pass "oversized text still yields a plausible count" || fail "tokenize count ($OUT)"
[ $((T1 - T0)) -lt 10000 ] && pass "6MB text counted in bounded time ($((T1 - T0))ms)" || fail "tokenize too slow ($((T1 - T0))ms)"

echo "per-source time budget (withDeadline)"
OUT="$(node --input-type=module -e "
import { withDeadline } from '$SRC/service.mjs';
// The deadline timer is unref'd (it must never hold the real service open at
// exit), so a bare script needs its own keepalive to observe the rejection.
const keepalive = setInterval(() => {}, 50);
try { await withDeadline(new Promise(() => {}), 200, 'stalled source'); console.log('NO-ERROR'); }
catch (e) { console.log(e.message); }
console.log(await withDeadline(Promise.resolve('fast'), 200, 'nope'));
clearInterval(keepalive);
")"
grep -q 'stalled source' <<<"$OUT" && pass "a never-settling source rejects at the deadline" || fail "deadline reject ($OUT)"
grep -q 'fast' <<<"$OUT" && pass "a fast source passes through untouched" || fail "deadline passthrough ($OUT)"

# ---- service host: tight caps via env so oversize is cheap to simulate -------
mkdir -p "$TMP/vault" "$TMP/empty" "$TMP/home/tilde-vault"
printf -- '---\ntype: note\ntitle: Note\nupdated: 2026-07-01\n---\n\n# Note\n\n## Body {#body}\n\nfrom vault.\n' > "$TMP/vault/note.md"
printf '# Tilde\n\n## Body\n\nfrom home vault.\n' > "$TMP/home/tilde-vault/tilde-note.md"
cat > "$TMP/manifest.json" <<EOF
{ "layers": [ { "name": "vault", "level": 3, "path": "$TMP/vault" } ] }
EOF

cat > "$TMP/host.mjs" <<'EOF'
import http from "node:http";
import { pathToFileURL } from "node:url";
const { createEngineService } = await import(pathToFileURL(process.env.SERVICE_MJS).href);
const [port, manifestPath] = process.argv.slice(2);
const svc = createEngineService({ manifestPath, token: null });
http.createServer(async (req, res) => {
  if (await svc.handleRequest(req, res)) return;
  res.writeHead(404); res.end();
}).listen(Number(port), "127.0.0.1");
EOF

export SERVICE_MJS="$SRC/service.mjs"
HOME="$TMP/home" CONTEXTCAKE_MAX_DOC_FILES=10 node "$TMP/host.mjs" "$PORT" "$TMP/manifest.json" >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 30); do curl -sf "$BASE/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done

echo "add-time folder validation (fail on the form, not as a hang)"
code 400 "$(C -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"missing\",\"level\":3,\"path\":\"$TMP/does-not-exist\"}" "$BASE/api/sources")" "missing folder rejected"
curl -s -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"missing\",\"level\":3,\"path\":\"$TMP/does-not-exist\"}" "$BASE/api/sources" | grep -q 'Folder not found' && pass "missing folder names the path problem" || fail "missing folder message"
code 400 "$(C -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"afile\",\"level\":3,\"path\":\"$TMP/vault/note.md\"}" "$BASE/api/sources")" "a file (not a folder) rejected"
code 400 "$(C -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"huge\",\"level\":3,\"path\":\"$TMP/many\"}" "$BASE/api/sources")" "over-cap folder rejected at add time"
curl -s -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"huge\",\"level\":3,\"path\":\"$TMP/many\"}" "$BASE/api/sources" | grep -q 'more specific folder' && pass "over-cap error tells the user what to do" || fail "over-cap message"
grep -q 'huge' "$TMP/manifest.json" && fail "rejected source leaked into the manifest" || pass "rejected source never touches the manifest"

ADD="$(curl -s -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"docs\",\"level\":2,\"path\":\"$TMP/vault\"}" "$BASE/api/sources")"
grep -q '"docCount":1' <<<"$ADD" && pass "add reports the indexed doc count" || fail "docCount ($ADD)"
code 200 "$(C -X DELETE "$BASE/api/sources?name=docs")" "cleanup added source"
ADD="$(curl -s -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"empty\",\"level\":2,\"path\":\"$TMP/empty\"}" "$BASE/api/sources")"
grep -q '"docCount":0' <<<"$ADD" && pass "an empty folder is allowed, reported as 0 docs" || fail "empty docCount ($ADD)"
code 200 "$(C -X DELETE "$BASE/api/sources?name=empty")" "cleanup empty source"

echo "tilde paths expand to the real home directory"
ADD="$(curl -s -X POST -H 'content-type: application/json' -d '{"kind":"files","name":"tilde","level":3,"path":"~/tilde-vault"}' "$BASE/api/sources")"
grep -q '"docCount":1' <<<"$ADD" && pass "~/folder validates against the expanded path" || fail "tilde add ($ADD)"
grep -q '"~/tilde-vault"' "$TMP/manifest.json" && fail "manifest kept the literal ~" || pass "manifest stores the expanded path"
curl -s "$BASE/api/resolve?concept=tilde-note" | grep -q 'from home vault' && pass "tilde source resolves" || fail "tilde resolve"
code 200 "$(C -X DELETE "$BASE/api/sources?name=tilde")" "cleanup tilde source"

echo "add-time MCP probe (wrong command fails the form in bounded time)"
T0="$(now_ms)"
code 400 "$(C -X POST -H 'content-type: application/json' -d '{"kind":"mcp","name":"ghost","level":0,"command":"definitely-not-a-real-binary-xyz"}' "$BASE/api/sources")" "missing binary rejected"
T1="$(now_ms)"
[ $((T1 - T0)) -lt 10000 ] && pass "missing binary fails fast ($((T1 - T0))ms)" || fail "missing binary too slow ($((T1 - T0))ms)"
T0="$(now_ms)"
code 400 "$(C -X POST -H 'content-type: application/json' -d '{"kind":"mcp","name":"mute","level":0,"command":"sleep","args":["30"]}' "$BASE/api/sources")" "unresponsive command rejected"
T1="$(now_ms)"
[ $((T1 - T0)) -lt 20000 ] && pass "unresponsive command bounded by probe timeouts ($((T1 - T0))ms)" || fail "unresponsive probe too slow ($((T1 - T0))ms)"
grep -Eq 'ghost|mute' "$TMP/manifest.json" && fail "failed MCP probe leaked into the manifest" || pass "failed MCP probes never touch the manifest"
code 200 "$(C -X POST -H 'content-type: application/json' -d "{\"kind\":\"mcp\",\"name\":\"mock\",\"level\":0,\"command\":\"node\",\"args\":[\"$ROOT/examples/mock-mcp-source/server.mjs\"]}" "$BASE/api/sources")" "a real MCP server passes the probe"
code 200 "$(C -X DELETE "$BASE/api/sources?name=mock")" "cleanup mcp source"

echo "resolving degrades an over-sized source instead of hanging"
cat > "$TMP/manifest-mixed.json" <<EOF
{ "layers": [
  { "name": "vault", "level": 3, "path": "$TMP/vault" },
  { "name": "big", "level": 2, "source": "files", "path": "$TMP/many" }
] }
EOF
node -e '
  const fs = require("node:fs");
  fs.copyFileSync(process.argv[1], process.argv[2]);
' "$TMP/manifest-mixed.json" "$TMP/manifest.json"
G="$(curl -s "$BASE/api/graph")"
grep -q '"status":"error"' <<<"$G" && pass "over-cap source surfaces as errored" || fail "graph error status ($G)"
grep -q 'too many documents' <<<"$G" && pass "graph carries the actionable error" || fail "graph error message"
node -e '
  const g = JSON.parse(process.argv[1]);
  const vault = g.sources.find((s) => s.name === "vault");
  if (!(vault && vault.status === "ok" && vault.conceptCount === 1)) process.exit(1);
  if (!g.concepts.some((c) => c.id === "note")) process.exit(1);
' "$G" && pass "healthy layer still resolves alongside the errored one" || fail "healthy layer degraded too"

echo "snapshot resolution matches per-concept resolution"
mkdir -p "$TMP/vault2"
printf -- '---\ntype: note\ntitle: Note\nupdated: 2026-07-02\n---\n\n# Note\n\n## Body {#body}\n\nfrom vault2.\n' > "$TMP/vault2/note.md"
cat > "$TMP/manifest2.json" <<EOF
{ "layers": [
  { "name": "vault", "level": 3, "path": "$TMP/vault" },
  { "name": "vault2", "level": 2, "path": "$TMP/vault2" }
] }
EOF
node -e 'require("node:fs").copyFileSync(process.argv[1], process.argv[2])' "$TMP/manifest2.json" "$TMP/manifest.json"
ALL="$(curl -s "$BASE/api/resolve-all")"
ONE="$(curl -s "$BASE/api/resolve?concept=note")"
node -e '
  const all = JSON.parse(process.argv[1]).concepts.find((c) => c.id === "note");
  const one = JSON.parse(process.argv[2]);
  if (JSON.stringify(all) !== JSON.stringify(one)) { console.error("DIVERGED"); process.exit(1); }
  const sec = one.sections.find((s) => s.key === "body");
  if (sec.sourceLayer !== "vault" || !sec.conflicts || sec.conflicts[0].layer !== "vault2") process.exit(1);
' "$ALL" "$ONE" && pass "resolve-all (snapshot) is byte-identical to per-concept resolve, conflicts intact" || fail "snapshot equivalence ($ALL vs $ONE)"

echo "the event loop stays free while a graph builds (no frozen app)"
mkdir -p "$TMP/big-corpus"
node -e '
  const fs = require("node:fs");
  const body = "## Section\n\n" + "Plenty of prose in every generated document so the build takes real time. ".repeat(40);
  for (let i = 0; i < 1500; i++) fs.writeFileSync(`${process.argv[1]}/big-corpus/doc-${i}.md`, `# Doc ${i}\n\n${body}`);
' "$TMP"
cat > "$TMP/manifest-big.json" <<EOF
{ "layers": [
  { "name": "vault", "level": 3, "path": "$TMP/vault" },
  { "name": "corpus", "level": 2, "source": "files", "path": "$TMP/big-corpus" }
] }
EOF
# Default caps on this host — the corpus must index fully.
node "$TMP/host.mjs" "$PORT2" "$TMP/manifest-big.json" >/dev/null 2>&1 &
PID2=$!
for _ in $(seq 1 30); do curl -sf "$BASE2/api/resolve?concept=note" >/dev/null 2>&1 && break; sleep 0.1; done
# Kick off the heavy graph build, then race a tiny resolve against it. Before
# the async/yield fixes the sync walk+tokenize pipeline blocked the server's
# event loop, so the tiny request could not be answered until the build ended.
curl -s -o "$TMP/graph-big.json" "$BASE2/api/graph" &
GRAPH_JOB=$!
sleep 0.3
T0="$(now_ms)"
R="$(C "$BASE2/api/resolve?concept=note")"
T1="$(now_ms)"
code 200 "$R" "concurrent tiny resolve answered mid-build"
[ $((T1 - T0)) -lt 2000 ] && pass "tiny resolve not starved by the build ($((T1 - T0))ms)" || fail "event loop starved ($((T1 - T0))ms)"
wait "$GRAPH_JOB"
node -e '
  const g = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const corpus = g.sources.find((s) => s.name === "corpus");
  if (!(corpus && corpus.status === "ok" && corpus.conceptCount === 1500)) process.exit(1);
' "$TMP/graph-big.json" && pass "big corpus still builds completely (1500 concepts)" || fail "big corpus graph incomplete"

[ "$FAILED" = 0 ] && echo "setup robustness test passed (bounded walks + add-time validation + probes + snapshot equivalence + responsive event loop)" || { echo "setup robustness test FAILED"; exit 1; }
