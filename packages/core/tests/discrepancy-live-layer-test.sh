#!/usr/bin/env bash
set -euo pipefail

# F30: a discrepancy decision that writes into the live team layer goes through
# git-core — one locked, pathspec-only commit per decision, pushed once per
# request, queued (never thrown) when the remote is unreachable, refused with
# 409 while another process holds the repo lock, and skipped cleanly when the
# decision leaves the live file byte-identical. Recovery of a crash between the
# git commit and the decision append commits the restore so git and the log
# agree. Hosted like service-test.sh over a real bare + clone pair.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
core="$repo_root/packages/core/src"
tmpdir="$(mktemp -d)"
PORT="${PORT:-8907}"
BASE="http://127.0.0.1:$PORT"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; rm -rf "$tmpdir"; }
trap cleanup EXIT
fail() { echo "FAIL: $1" >&2; [ "${2:-}" ] && echo "$2" >&2; exit 1; }
pass() { printf '  ok   %s\n' "$1"; }

export GIT_CONFIG_GLOBAL="$tmpdir/gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
git config --file "$tmpdir/gitconfig" user.name "Fixture User"
git config --file "$tmpdir/gitconfig" user.email "fixture@example.invalid"
git config --file "$tmpdir/gitconfig" init.defaultBranch main

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
C() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# ---- fixtures: bare + clone (the live layer) + a personal folder --------------
bare="$tmpdir/remote.git"
git init --quiet --bare "$bare"
live="$tmpdir/team-live"
git clone --quiet "$bare" "$live"
personal="$tmpdir/personal"
mkdir -p "$live/decisions" "$personal/decisions"

doc() { printf -- '---\ntype: decision\ntitle: %s\n---\n\n# %s\n\n## Choice {#choice}\n\n%s\n' "$1" "$1" "$2"; }
doc Database "team answer"   > "$live/decisions/db.md"
doc Cache    "team cache"    > "$live/decisions/cache.md"
doc Queue    "team queue"    > "$live/decisions/queue.md"
doc Search   "team search"   > "$live/decisions/search.md"
( cd "$live" && git add -A && git commit --quiet -m "seed" && git push --quiet -u origin main )
doc Database "personal answer" > "$personal/decisions/db.md"
doc Cache    "personal cache"  > "$personal/decisions/cache.md"
doc Queue    "personal queue"  > "$personal/decisions/queue.md"
doc Search   "personal search" > "$personal/decisions/search.md"

manifest="$tmpdir/manifest.json"
cat > "$manifest" <<EOF
{ "layers": [
  { "name": "personal", "level": 3, "path": "$personal" },
  { "name": "team-live", "level": 2, "source": "okf-local", "path": "$live", "live": true,
    "git": { "pullTtlSeconds": 3600, "retentionDays": 14, "profileName": "Fixture Team" } }
] }
EOF

cat > "$tmpdir/host.mjs" <<'EOF'
import http from "node:http";
import { pathToFileURL } from "node:url";
const { createEngineService } = await import(pathToFileURL(process.env.SERVICE_MJS).href);
const [port, manifestPath] = process.argv.slice(2);
const svc = createEngineService({ manifestPath, token: null });
http.createServer(async (req, res) => {
  if (await svc.handleRequest(req, res)) return;
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "host-fallthrough" }));
}).listen(Number(port), "127.0.0.1");
EOF
export SERVICE_MJS="$core/service.mjs"
start_host() {
  node "$tmpdir/host.mjs" "$PORT" "$manifest" >"$tmpdir/host.log" 2>&1 &
  PID=$!
  for _ in $(seq 1 50); do curl -sf "$BASE/api/status" >/dev/null 2>&1 && break; sleep 0.1; done
}
start_host

# discrepancy <conceptId> → sets DID/DREV for its section_content record
discrepancy() {
  DID=""; DREV=""
  for _ in $(seq 1 60); do
    local set; set="$(curl -s "$BASE/api/discrepancies?wait=15000")"
    DID="$(JQ "d.discrepancies.find((x) => x.originalKind === 'section_content' && x.conceptId === '$1' && x.status !== 'resolved')?.id ?? ''" <<<"$set")"
    DREV="$(JQ "d.discrepancies.find((x) => x.originalKind === 'section_content' && x.conceptId === '$1' && x.status !== 'resolved')?.revision ?? ''" <<<"$set")"
    [ -n "$DID" ] && [ -n "$DREV" ] && return 0
    sleep 0.1
  done
  fail "no open section discrepancy for $1" "$(curl -s "$BASE/api/discrepancies")"
}
decide() { # <id> <revision> <selectedSource>
  curl -s -X POST -H 'content-type: application/json' \
    -d "{\"discrepancyId\":\"$1\",\"revision\":\"$2\",\"action\":\"choose_contribution\",\"selectedSource\":\"$3\"}" \
    "$BASE/api/discrepancy-decisions"
}

# ---- 1. a decision that changes the live file is one locked commit, pushed --------
echo "live-layer decision: locked pathspec commit + push"
discrepancy decisions/db
OUT="$(decide "$DID" "$DREV" personal)"
[ "$(JQ 'String(d.ok)' <<<"$OUT")" = "true" ] || fail "decision failed" "$OUT"
[ "$(JQ 'd.git?.layer' <<<"$OUT")" = "team-live" ] || fail "response names the live layer" "$OUT"
[ "$(JQ 'String(d.git?.committed)' <<<"$OUT")" = "true" ] || fail "response reports the commit" "$OUT"
[ "$(JQ 'String(d.git?.pushed)' <<<"$OUT")" = "true" ] || fail "response reports the push" "$OUT"
[ "$(JQ 'd.decision.liveLayerCommit?.layer' <<<"$OUT")" = "team-live" ] || fail "decision records liveLayerCommit.layer" "$OUT"
[ "$(JQ 'JSON.stringify(d.decision.liveLayerCommit?.paths)' <<<"$OUT")" = '["decisions/db.md"]' ] || fail "decision records liveLayerCommit.paths" "$OUT"
grep -q 'personal answer' "$live/decisions/db.md" || fail "live file carries the chosen answer"
MSG="$(cd "$live" && git log -1 --format=%s)"
[ "$MSG" = "chore(contextcake): resolve section_content decisions/db#choice (choose_contribution)" ] || fail "commit message" "$MSG"
FILES="$(cd "$live" && git show --name-only --format= HEAD | sed '/^$/d')"
[ "$FILES" = "decisions/db.md" ] || fail "commit lists only the concept file" "$FILES"
[ -z "$(cd "$live" && git status --porcelain)" ] || fail "working tree is clean after the decision" "$(cd "$live" && git status --porcelain)"
[ "$(git -C "$bare" log -1 --format=%s)" = "$MSG" ] || fail "the commit reached the remote"
[ ! -f "$live/.contextcake.lock" ] || fail "repo lock released"
pass "decision committed exactly the concept file, pushed, tree clean"

# ---- 1b. the legacy "change a past decision" route takes the same locked path -------
echo "legacy change-decision route: same locked commit"
RID="$(JQ 'd.decision.id' <<<"$OUT")"
CHANGED="$(curl -s -X POST -H 'content-type: application/json' \
  -d "{\"conceptId\":\"decisions/db\",\"sectionKey\":\"choice\",\"selectedLayer\":\"team-live\",\"method\":\"manual\",\"resolutionId\":\"$RID\"}" \
  "$BASE/api/conflict-resolutions")"
[ "$(JQ 'String(d.ok)' <<<"$CHANGED")" = "true" ] || fail "change decision failed" "$CHANGED"
grep -q 'team answer' "$live/decisions/db.md" || fail "changed decision restored the team answer in the live file"
grep -q 'team answer' "$personal/decisions/db.md" || fail "changed decision restored the team answer in the personal file"
[ "$(cd "$live" && git rev-list --count HEAD)" = "3" ] || fail "change decision added exactly one commit" "$(cd "$live" && git log --oneline)"
[ "$(cd "$live" && git show HEAD:decisions/db.md | grep -c 'team answer')" = "1" ] || fail "the change-decision commit holds the restored bytes"
[ -z "$(cd "$live" && git status --porcelain)" ] || fail "tree clean after change decision" "$(cd "$live" && git status --porcelain)"
[ "$(git -C "$bare" rev-parse HEAD)" = "$(cd "$live" && git rev-parse HEAD)" ] || fail "change decision pushed"
[ "$(JQ 'd.resolution.liveLayerCommit?.layer' <<<"$CHANGED")" = "team-live" ] || fail "change decision records liveLayerCommit" "$CHANGED"
MSG="$(cd "$live" && git log -1 --format=%s)"
pass "change decision committed through git-core, pushed, tree clean"

# ---- 2. choosing the live layer's own answer leaves its file byte-identical: no commit
echo "live-layer decision: byte-identical live file is not a commit"
discrepancy decisions/cache
OUT="$(decide "$DID" "$DREV" team-live)"
[ "$(JQ 'String(d.ok)' <<<"$OUT")" = "true" ] || fail "same-bytes decision failed" "$OUT"
[ "$(JQ 'String(d.git?.committed)' <<<"$OUT")" = "false" ] || fail "no commit for a byte-identical live file" "$OUT"
[ "$(JQ 'String(d.decision.liveLayerCommit === undefined)' <<<"$OUT")" = "true" ] || fail "no liveLayerCommit recorded when nothing was committed" "$OUT"
grep -q 'team cache' "$personal/decisions/cache.md" || fail "the personal contributor took the team answer"
[ "$(cd "$live" && git log -1 --format=%s)" = "$MSG" ] || fail "HEAD did not move" "$(cd "$live" && git log -1 --format=%s)"
[ -z "$(cd "$live" && git status --porcelain)" ] || fail "tree still clean" "$(cd "$live" && git status --porcelain)"
pass "byte-identical live file: decision applied, no empty commit, tree clean"

# ---- 3. offline: the commit lands locally and the push is queued, not thrown ------
echo "live-layer decision: offline remote queues the push"
mv "$bare" "$bare.away"
discrepancy decisions/queue
OUT="$(decide "$DID" "$DREV" personal)"
[ "$(JQ 'String(d.ok)' <<<"$OUT")" = "true" ] || fail "offline decision failed" "$OUT"
[ "$(JQ 'String(d.git?.committed)' <<<"$OUT")" = "true" ] || fail "offline decision committed locally" "$OUT"
[ "$(JQ 'String(d.git?.pushed)' <<<"$OUT")" = "false" ] || fail "offline push not claimed" "$OUT"
[ "$(JQ 'String(d.git?.queued)' <<<"$OUT")" = "true" ] || fail "offline push reported queued" "$OUT"
QMSG="$(cd "$live" && git log -1 --format=%s)"
[ "$QMSG" = "chore(contextcake): resolve section_content decisions/queue#choice (choose_contribution)" ] || fail "queued commit is local" "$QMSG"
pass "offline decision: local commit, git.queued=true, nothing thrown"

# ---- 4. restored remote: POST /api/sources/sync lands the queue ---------------------
mv "$bare.away" "$bare"
SYNC="$(curl -s -X POST "$BASE/api/sources/sync?name=team-live")"
[ "$(JQ 'String(d.ok)' <<<"$SYNC")" = "true" ] || fail "sync of the live layer" "$SYNC"
[ "$(git -C "$bare" log -1 --format=%s)" = "$QMSG" ] || fail "sync pushed the queued commit" "$(git -C "$bare" log -1 --format=%s)"
pass "POST /api/sources/sync pushed the queued decision commit"

# ---- 5. a held repo lock refuses the decision with 409 and changes no bytes -----------
echo "live-layer decision: held .contextcake.lock → 409, bytes unchanged"
discrepancy decisions/search
printf '{"pid":%d,"ts":%d,"op":"test","token":"held"}' "$$" "$(node -e 'console.log(Date.now())')" > "$live/.contextcake.lock"
STATUS="$(curl -s -o "$tmpdir/busy.json" -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d "{\"discrepancyId\":\"$DID\",\"revision\":\"$DREV\",\"action\":\"choose_contribution\",\"selectedSource\":\"personal\"}" \
  "$BASE/api/discrepancy-decisions")"
[ "$STATUS" = "409" ] || fail "held lock should answer 409" "$STATUS $(cat "$tmpdir/busy.json")"
grep -q 'busy' "$tmpdir/busy.json" || fail "409 names the busy layer" "$(cat "$tmpdir/busy.json")"
grep -q 'team search' "$live/decisions/search.md" || fail "live bytes unchanged under a held lock"
grep -q 'personal search' "$personal/decisions/search.md" || fail "personal bytes unchanged under a held lock (all-or-nothing)"
[ "$(cd "$live" && git log -1 --format=%s)" = "$QMSG" ] || fail "no commit under a held lock"
[ "$(cat "$live/.contextcake.lock" | JQ 'd.token')" = "held" ] || fail "the foreign lock was not stolen"
ls "$live/decisions/" | grep -q 'contextcake-' && fail "staged/backup files were not cleaned up" "$(ls "$live/decisions/")"
rm -f "$live/.contextcake.lock"
JOURNAL="$tmpdir/.contextcake/profiles/default/discrepancy-transactions.ndjson"
# Staging happens inside the repo lock, so a refused lock never journals a
# transaction at all — the last journal line is still the previous decision's.
tail -1 "$JOURNAL" | grep -q '"prepared"' && fail "a refused lock left a dangling prepared transaction" "$(tail -2 "$JOURNAL")"
pass "held lock: 409, no bytes changed, no commit, lock not stolen, nothing journaled"

# The refused decision is still open; it applies once the lock is gone.
OUT="$(decide "$DID" "$DREV" personal)"
[ "$(JQ 'String(d.ok && d.git.committed && d.git.pushed)' <<<"$OUT")" = "true" ] || fail "decision applies after the lock is released" "$OUT"
pass "same decision applies once the lock is released"

# ---- 6. recovery: a crash between git commit and decision append is rolled back in git
echo "live-layer recovery: restore committed as a rollback commit"
kill "$PID"; wait "$PID" 2>/dev/null || true; PID=""
target="$live/decisions/db.md"
cp "$target" "$target.contextcake-tx-crash-0.bak"                     # what the file was
doc Database "crashed write" > "$target.contextcake-tx-crash-0.new"    # what was staged
doc Database "crashed write" > "$target"                                # ...and renamed into place
( cd "$live" && git add decisions/db.md && git commit --quiet -m "chore(contextcake): resolve section_content decisions/db#choice (choose_contribution)" )
BEFORE_HEAD="$(cd "$live" && git rev-parse HEAD)"
printf '{"id":"tx-crash","state":"prepared","preparedAt":"2026-01-01T00:00:00.000Z","targets":[{"path":"%s","staged":"%s","backup":"%s"}]}\n' \
  "$(node -e 'console.log(require("fs").realpathSync.native(process.argv[1]))' "$target")" \
  "$(node -e 'console.log(require("fs").realpathSync.native(process.argv[1]))' "$target.contextcake-tx-crash-0.new")" \
  "$(node -e 'console.log(require("fs").realpathSync.native(process.argv[1]))' "$target.contextcake-tx-crash-0.bak")" >> "$JOURNAL"
start_host
for _ in $(seq 1 50); do grep -q 'roll back uncommitted' <(cd "$live" && git log -3 --format=%s) && break; sleep 0.2; done
RMSG="$(cd "$live" && git log -1 --format=%s)"
[ "$RMSG" = "chore(contextcake): roll back uncommitted discrepancy transaction tx-crash" ] || fail "recovery committed the restore" "$RMSG
$(cat "$tmpdir/host.log")
$(tail -3 "$JOURNAL")"
grep -q 'team answer' "$target" || fail "recovery restored the pre-crash bytes"
grep -q 'crashed write' "$target" && fail "crashed bytes survived recovery"
[ -z "$(cd "$live" && git status --porcelain)" ] || fail "tree clean after recovery" "$(cd "$live" && git status --porcelain)"
[ ! -f "$target.contextcake-tx-crash-0.new" ] && [ ! -f "$target.contextcake-tx-crash-0.bak" ] || fail "recovery removed the staged/backup files"
grep -q '"id":"tx-crash","state":"rolled_back"' "$JOURNAL" || fail "journal marks the crashed transaction rolled_back" "$(tail -3 "$JOURNAL")"
[ "$(cd "$live" && git rev-parse HEAD~1)" = "$BEFORE_HEAD" ] || fail "the rollback commit sits on top of the crashed commit"
pass "recovery restored the file and committed the restore so git and the log agree"

echo "discrepancy live-layer test passed (locked commit + push + skip-if-clean + offline queue + sync + lock busy 409 + recovery commit)"
