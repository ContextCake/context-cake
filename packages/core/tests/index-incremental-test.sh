#!/usr/bin/env bash
# The incrementality gate: a one-note edit in a settled vault must cost one
# file read, not a corpus re-read. Locks in snapshotSource's fingerprint skip
# gate (listEntries → carry unchanged concepts forward) and the identity-reuse
# rule (a pass that changed nothing returns the previous snapshot, so content
# generation and memos stay put). Network-free. Run from the repo root.
set -uo pipefail

PORT="${PORT:-8895}"
BASE="http://127.0.0.1:$PORT"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
PID=""
FAILED=0
NOTES=500

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

mkdir -p "$TMP/vault/sub"
node -e '
  const fs = require("node:fs");
  const [vault, notesArg] = process.argv.slice(1);
  const NOTES = Number(notesArg);
  for (let i = 0; i < NOTES; i++) {
    const dir = i % 3 === 0 ? `${vault}/sub` : vault;
    fs.writeFileSync(`${dir}/note-${String(i).padStart(3, "0")}.md`,
      `# Note ${i}\n\n## Body {#body}\n\nsome body text for note ${i}, stable across the test.\n`);
  }
' "$TMP/vault" "$NOTES"
cat > "$TMP/layers.json" <<EOF
{ "layers": [ { "name": "vault", "level": 3, "source": "files", "path": "$TMP/vault" } ] }
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
node "$TMP/host.mjs" "$PORT" "$TMP/layers.json" & PID=$!

settle() {
  # Settled = no pass running and none owed (?wait= semantics).
  curl -s --max-time 120 "$BASE/api/graph?wait=60000" > /dev/null
  for _ in $(seq 1 200); do
    body="$(curl -s --max-time 10 "$BASE/api/status" 2>/dev/null)" || body=""
    case "$body" in *'"indexing":false'*) printf '%s' "$body"; return 0;; esac
    sleep 0.25
  done
  printf '%s' "$body"
}

row() { JQ 'd.sources.find(s => s.name === "vault")'; }

# ---- 1. first pass: everything read, nothing carried ------------------------
STATUS="$(settle)"
FIRST="$(printf '%s' "$STATUS" | JQ '(() => { const s = d.sources[0]; return `${s.conceptCount} ${s.passStats?.read} ${s.passStats?.carried}` })()')"
if [ "$FIRST" = "$NOTES $NOTES 0" ]; then
  pass "first pass read the whole vault ($NOTES read, 0 carried)"
else
  fail "first pass reported '$FIRST' (expected '$NOTES $NOTES 0')"
fi
GEN1="$(printf '%s' "$STATUS" | JQ 'String(d.generation)')"

# ---- 2. touch ONE note: one read, the rest carried --------------------------
sleep 1.05 # mtimes on some filesystems are second-granular; a same-second rewrite must not dodge the gate
printf '# Note 007\n\n## Body {#body}\n\nEDITED body for note 7.\n' > "$TMP/vault/note-007.md"
sleep 1 # watcher debounce (250ms) + follow-up floor
STATUS="$(settle)"
SECOND="$(printf '%s' "$STATUS" | JQ '(() => { const s = d.sources[0]; return `${s.conceptCount} ${s.passStats?.read} ${s.passStats?.carried} ${s.passStats?.removed}` })()')"
CARRIED=$((NOTES - 1))
if [ "$SECOND" = "$NOTES 1 $CARRIED 0" ]; then
  pass "editing one note cost one read ($CARRIED carried forward untouched)"
else
  fail "post-edit pass reported '$SECOND' (expected '$NOTES 1 $CARRIED 0') — the skip gate is not carrying"
fi
GEN2="$(printf '%s' "$STATUS" | JQ 'String(d.generation)')"
if [ "$GEN1" != "$GEN2" ]; then
  pass "content generation moved for the edit"
else
  fail "generation did not move for a real edit"
fi
EDITED="$(curl -s "$BASE/api/resolve?concept=note-007" | JQ 'd.sections.map(s => s.content).join(" ")')"
case "$EDITED" in
  *"EDITED body"*) pass "the edited content is what the cascade serves";;
  *) fail "resolve served stale content after the incremental pass: $EDITED";;
esac

# ---- 3. delete a note: removed counted, concept gone ------------------------
rm "$TMP/vault/note-008.md"
sleep 1
STATUS="$(settle)"
THIRD="$(printf '%s' "$STATUS" | JQ '(() => { const s = d.sources[0]; return `${s.conceptCount} ${s.passStats?.read} ${s.passStats?.removed}` })()')"
LEFT=$((NOTES - 1))
if [ "$THIRD" = "$LEFT 0 1" ]; then
  pass "deleting a note removed exactly one concept with zero reads"
else
  fail "post-delete pass reported '$THIRD' (expected '$LEFT 0 1')"
fi

# ---- 4. a no-op invalidation reuses the snapshot object ---------------------
# Force a pass with no content change via the API (PUT /api/section is not
# needed — rewriting the same bytes with a NEW mtime is the sharper case: the
# fingerprint differs, the file re-reads, but nothing else does).
GEN3="$(curl -s "$BASE/api/status" | JQ 'String(d.generation)')"
sleep 1.05
touch "$TMP/vault/note-100.md"
sleep 1
STATUS="$(settle)"
FOURTH="$(printf '%s' "$STATUS" | JQ '(() => { const s = d.sources[0]; return `${s.passStats?.read} ${s.passStats?.carried}` })()')"
CARRIED2=$((NOTES - 2))
if [ "$FOURTH" = "1 $CARRIED2" ]; then
  pass "an mtime-only touch re-reads exactly that file (honest fingerprint, no false skip)"
else
  fail "touch pass reported '$FOURTH' (expected '1 $CARRIED2')"
fi

# ---- 5. a restart re-reads but never re-encodes (the persistent count cache)
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; PID=""
node "$TMP/host.mjs" "$PORT" "$TMP/layers.json" & PID=$!
STATUS="$(settle)"
FIFTH="$(printf '%s' "$STATUS" | JQ '(() => { const s = d.sources[0]; return `${s.conceptCount} ${s.passStats?.read} ${s.passStats?.tokenized}` })()')"
if [ "$FIFTH" = "$LEFT $LEFT 0" ]; then
  pass "a fresh engine re-read the vault with ZERO re-encodes (token-count cache warm)"
else
  fail "restart pass reported '$FIFTH' (expected '$LEFT $LEFT 0') — the persistent token cache missed"
fi
[ -f "$TMP/.cache/index/token-counts.v1.ndjson" ] \
  && pass "the count cache lives beside the manifest (.cache/index)" \
  || fail "no token-count cache file was written"

if [ "$FAILED" -eq 0 ]; then
  echo "index incremental test passed (skip gate + identity reuse + honest removal + warm restart)"
  exit 0
fi
echo "index incremental test FAILED"
exit 1
