#!/usr/bin/env bash
# Index lifecycle regression suite.
#
# Five failures of the background index, each reproduced against the bare engine
# service. index-stability-test.sh gates the three field reports that produced
# the background index; this gates what an adversarial read of that work found
# afterwards. Every assertion below failed against the tree at 97c48d4.
#
#   1. A LAYER FIELD NAMED `kind` SERVED ANOTHER SOURCE'S DOCUMENTS. The index
#      key was built from an object seeded with {kind: layer.source} and then
#      overwritten with every other layer field — and `kind` is not a reserved
#      layer field: validateLayer accepts unknown keys and the desktop app's
#      settings sync writes one. Two layers collided onto ONE index entry, and
#      the snapshot was then served under each layer's own name and level.
#
#   2. THE HANDOFF DEPENDED ON WHO ASKED FIRST. A re-key handed the orphaned
#      snapshot forward through ensureIndexes only. If a watcher-driven
#      invalidateIndex was the first consumer after the re-key, the handoff was
#      dropped and the source blanked to 0 concepts for the whole re-index.
#
#   3. THE HANDOFF CROSSED POLICY CHANGES. The key carries the indexing settings
#      and the credential epoch; the handoff was keyed on the layer's content
#      identity alone. So lowering a document cap kept serving the over-cap
#      answer — forever, if the re-index then failed — and disconnecting an
#      account kept serving the private repo's content.
#
#   4. A DOTTED DIRECTORY SWALLOWED EVERY DOCUMENT INSIDE IT. The watcher
#      decided file-ness with path.extname, and directories routinely have dots.
#      Moving "Archive 2024.10/" into a vault delivers ONE event, for the
#      directory — filtered out, so its documents never reached the index.
#
#   5. SUSTAINED EDITING NEVER SETTLED. A pass dirtied mid-flight started
#      another the moment it landed, forever: a full re-walk and re-read of
#      every document for as long as the user kept typing, with the source
#      pinned at status=indexing so the UI spinner never cleared.
#
# What "fixed" looks like: every assertion passes with no change to the
# assertions themselves. Network-free. Run from the repo root.
set -uo pipefail

PORT="${INDEX_LIFECYCLE_PORT:-8871}"    # colliding-identity host
PORT2=$((PORT + 1))                     # vault host: handoff, dotted dirs, churn
PORT3=$((PORT + 2))                     # policy host: a lowered document cap
BASE="http://127.0.0.1:$PORT"
BASE2="http://127.0.0.1:$PORT2"
BASE3="http://127.0.0.1:$PORT3"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
PIDS=()
CHURN_PID=""
FAILED=0

# Corpus size. Same reasoning as index-stability-test.sh: one undisturbed pass
# has to take long enough that a 300ms edit cycle lands inside it, or assertion
# 5 measures nothing. The control below reports the real number for this
# machine and the churn assertions are derived from it.
NOTES="${INDEX_LIFECYCLE_NOTES:-3000}"
CHURN_MS=300
CHURN_SLEEP="$(awk "BEGIN{print $CHURN_MS/1000}")"
CHURN_WINDOW_MS=12000
POLL_MS=400
SETTLE_TIMEOUT_MS=60000

cleanup() {
  [ -n "$CHURN_PID" ] && kill "$CHURN_PID" 2>/dev/null
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

for _p in "$PORT" "$PORT2" "$PORT3"; do
  if lsof -nP -iTCP:"$_p" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'PREFLIGHT FAIL port %s is already in use — a previous run leaked a host.\n' "$_p"
    printf '  remedy: lsof -nP -iTCP:%s -sTCP:LISTEN   then kill the pid\n' "$_p"
    exit 1
  fi
done

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
G2() { curl -s "${AUTH[@]}" "$BASE2/api/graph"; }
ROW2() { G2 | JQ "JSON.stringify((d.sources ?? []).find((s) => s.name === '$1') ?? null)"; }

# ---- a bare node:http host around createEngineService ------------------------
cat > "$TMP/host.mjs" <<'EOF'
import http from "node:http";
import { pathToFileURL } from "node:url";
const { createEngineService } = await import(pathToFileURL(process.env.SERVICE_MJS).href);
const [port, manifestPath] = process.argv.slice(2);
const svc = createEngineService({ manifestPath, token: "sekrit" });
http.createServer(async (req, res) => {
  if (await svc.handleRequest(req, res)) return;
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "host-fallthrough", path: req.url }));
}).listen(Number(port), "127.0.0.1");
EOF

# ---- the observer ------------------------------------------------------------
# Polls /api/graph and reports what one source's index DID over a window rather
# than where it ended up. `passes` is the index's own count of how many times it
# has read the source: the only way from outside to tell "kept serving its
# snapshot" from "re-read the entire vault eleven times to produce the same
# snapshot".
#
# argv: <base> <sourceName> <windowMs> <intervalMs>
cat > "$TMP/watch.mjs" <<'EOF'
const [base, name, windowMs, intervalMs] = process.argv.slice(2);
const headers = { authorization: "Bearer sekrit" };
const started = Date.now();
const deadline = started + Number(windowMs);
const out = {
  samples: 0, httpErrors: 0, missingRows: 0,
  minConceptCount: null, maxConceptCount: null,
  minPasses: null, maxPasses: null,
  statuses: [], phases: [], refreshingSeen: false, indexingFlagSeen: false,
  lastError: null, observedMs: 0,
};
for (;;) {
  out.samples += 1;
  try {
    const res = await fetch(`${base}/api/graph`, { headers });
    if (!res.ok) { out.httpErrors += 1; out.lastError = `HTTP ${res.status}`; }
    else {
      const graph = await res.json();
      if (graph.indexing) out.indexingFlagSeen = true;
      const row = (graph.sources ?? []).find((s) => s.name === name);
      if (!row) {
        out.missingRows += 1;
        out.minConceptCount = 0;
      } else {
        const count = row.conceptCount ?? 0;
        const passes = row.indexing?.passes ?? 0;
        out.minConceptCount = out.minConceptCount === null ? count : Math.min(out.minConceptCount, count);
        out.maxConceptCount = out.maxConceptCount === null ? count : Math.max(out.maxConceptCount, count);
        out.minPasses = out.minPasses === null ? passes : Math.min(out.minPasses, passes);
        out.maxPasses = out.maxPasses === null ? passes : Math.max(out.maxPasses, passes);
        if (!out.statuses.includes(row.status)) out.statuses.push(row.status);
        if (!out.phases.includes(row.indexing?.phase)) out.phases.push(row.indexing?.phase);
        if (row.indexing?.refreshing) out.refreshingSeen = true;
        if (row.error) out.lastError = row.error;
      }
    }
  } catch (err) { out.httpErrors += 1; out.lastError = String(err.message); }
  if (Date.now() >= deadline) break;
  await new Promise((r) => setTimeout(r, Number(intervalMs)));
}
out.observedMs = Date.now() - started;
console.log(JSON.stringify(out));
EOF

export SERVICE_MJS="$ROOT/packages/core/src/service.mjs"

# =============================================================================
echo "1. two layers over one folder keep their own documents"
# =============================================================================
# The collision, reduced to its smallest honest form: ONE folder holding an OKF
# markdown document and a plain .txt, read by two adapters that disagree about
# what is a document. okf-local sees one concept, files sees two. The `kind`
# field on the second layer is what the desktop app's settings sync writes onto
# a synced source record — it is not a reserved layer field, and under a flat
# identity it overwrote the source kind, making both layers' identities (and so
# their index keys) identical. One entry, served twice: whichever adapter
# indexed first answered for both rows.
mkdir -p "$TMP/shared"
printf -- '---\ntype: note\ntitle: One\nupdated: 2026-07-01\n---\n\n# One\n\n## Body {#body}\n\nokf document.\n' > "$TMP/shared/one.md"
printf 'a plain text note, which only the files adapter indexes.\n' > "$TMP/shared/two.txt"
cat > "$TMP/manifest-collide.json" <<EOF
{ "layers": [
    { "name": "notes", "level": 5, "source": "okf-local", "path": "$TMP/shared" },
    { "name": "docs", "level": 2, "source": "files", "path": "$TMP/shared", "kind": "okf-local" }
  ] }
EOF
node "$TMP/host.mjs" "$PORT" "$TMP/manifest-collide.json" >/dev/null 2>&1 &
PIDS+=($!)
for _ in $(seq 1 80); do curl -sf "${AUTH[@]}" "$BASE/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done

COL="$(curl -s "${AUTH[@]}" "$BASE/api/graph?wait=15000")"
COL_ROWS="$(JQ 'JSON.stringify((d.sources ?? []).map((s) => [s.name, s.kind, s.conceptCount]))' <<<"$COL")"
[ "$(JQ 'String((d.sources ?? []).find((s) => s.name === "notes")?.conceptCount)' <<<"$COL")" = "1" ] \
  && pass "the okf-local layer reports its own 1 document" \
  || fail "the okf-local layer is serving another layer's index ($COL_ROWS)"
[ "$(JQ 'String((d.sources ?? []).find((s) => s.name === "docs")?.conceptCount)' <<<"$COL")" = "2" ] \
  && pass "the files layer reports its own 2 documents" \
  || fail "the files layer is serving another layer's index ($COL_ROWS)"
# The user-visible half: a concept only one adapter can see must still be in the
# graph, attributed to the layer that actually holds it.
TWO="$(JQ 'JSON.stringify((d.concepts ?? []).find((c) => c.id === "two") ?? null)' <<<"$COL")"
[ "$(JQ '(((d.concepts ?? []).find((c) => c.id === "two") ?? {}).contributors ?? []).join(",")' <<<"$COL")" = "docs" ] \
  && pass "the .txt document is in the graph, contributed by the layer that reads it" \
  || fail "a document was lost to an index collision (concept row: $TWO; sources: $COL_ROWS)"

# =============================================================================
echo "2. a rename hands the index over, whoever asks first"
# =============================================================================
mkdir -p "$TMP/vault" "$TMP/quiet" "$TMP/staging"
printf '# Quiet\n\n## Body\n\nA layer nothing writes to until assertion 4.\n' > "$TMP/quiet/seed.md"
node -e '
  const fs = require("node:fs");
  const [dir, count] = process.argv.slice(1);
  const words = "decision architecture retrieval cascade layer precedence conflict provenance manifest indexing rollout migration schema latency invariant".split(" ");
  const para = (i) => Array.from({ length: 70 }, (_, k) => words[(i + k) % words.length]).join(" ");
  for (let i = 0; i < Number(count); i++) {
    const body = Array.from({ length: 6 }, (_, p) => para(i + p)).join("\n\n");
    fs.writeFileSync(`${dir}/note-${i}.md`, `# Note ${i}\n\n## Body\n\n${body}\n\n## Links\n\n${body}\n`);
  }
' "$TMP/vault" "$NOTES"
cat > "$TMP/manifest-vault.json" <<EOF
{ "settings": { "sourceBudgetMs": 120000 },
  "layers": [
    { "name": "quiet", "level": 1, "source": "files", "path": "$TMP/quiet" },
    { "name": "vault", "level": 3, "source": "files", "path": "$TMP/vault" }
  ] }
EOF
node "$TMP/host.mjs" "$PORT2" "$TMP/manifest-vault.json" >/dev/null 2>&1 &
PIDS+=($!)
for _ in $(seq 1 80); do curl -sf "${AUTH[@]}" "$BASE2/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done

curl -s "${AUTH[@]}" "$BASE2/api/graph?wait=$SETTLE_TIMEOUT_MS" >/dev/null
# What one undisturbed pass over this vault costs on this machine, from the
# index's own clock — the number every "is a chain of these expensive?"
# statement below is measured against.
CTRL_MS="$(ROW2 vault | JQ 'String(d.indexing.elapsedMs)')"
case "$CTRL_MS" in ''|*[!0-9]*) CTRL_MS=0 ;; esac
[ "$(ROW2 vault | JQ 'String(d.conceptCount)')" = "$NOTES" ] \
  && pass "the vault indexed all $NOTES notes in ${CTRL_MS}ms" \
  || fail "the vault did not index (row: $(ROW2 vault))"
BEFORE_PASSES="$(ROW2 vault | JQ 'String(d.indexing.passes)')"

# Ordering A: nothing happens between the re-key and the read.
code 200 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"vault","newName":"vault-a","level":3}' "$BASE2/api/sources")" "rename the settled vault"
WA="$(node "$TMP/watch.mjs" "$BASE2" vault-a 4000 100)"
WA_DESC="$(JQ '`min=${d.minConceptCount} max=${d.maxConceptCount} statuses=${d.statuses.join("/")} passes=${d.minPasses}..${d.maxPasses} missing=${d.missingRows}`' <<<"$WA")"
[ "$(JQ 'String(d.minConceptCount)' <<<"$WA")" = "$NOTES" ] \
  && pass "conceptCount held at $NOTES with a read as the first consumer" \
  || fail "the source blanked on a plain re-key — $WA_DESC"
[ "$(JQ 'String(d.statuses.join(","))' <<<"$WA")" = "ok" ] \
  && pass "the renamed source never reported itself unready" \
  || fail "the rename made the source unready — $WA_DESC"
# The whole point of separating the key from the handoff: the entry MOVED, so
# the rename cost nothing at all. A re-read would have bumped the pass counter.
MID_PASSES="$(ROW2 vault-a | JQ 'String(d.indexing.passes)')"
# Guarded: without a pass counter both sides read "undefined" and this assertion
# would agree with itself forever.
case "$BEFORE_PASSES$MID_PASSES" in ''|*[!0-9]*) fail "no pass counter on the index row (before=$BEFORE_PASSES after=$MID_PASSES) — the re-read assertions below cannot be evaluated" ;; esac
[ "$MID_PASSES" = "$BEFORE_PASSES" ] \
  && pass "the rename re-read nothing (passes still $MID_PASSES)" \
  || fail "a rename re-read the whole vault (passes $BEFORE_PASSES -> $MID_PASSES)"

# Ordering B: the same re-key, with an invalidation as the first thing that
# touches the entry afterwards and no read in between. This is the ordering
# that dropped the handoff — the 250ms watcher debounce fires long before a
# console poll would, and only one of the two consumers knew how to inherit.
code 200 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"vault-a","newName":"vault-b","level":3}' "$BASE2/api/sources")" "rename it again"
printf '# Note 1 (edited)\n\n## Body\n\nedited immediately after the rename.\n' > "$TMP/vault/note-1.md"
WB="$(node "$TMP/watch.mjs" "$BASE2" vault-b 6000 100)"
WB_DESC="$(JQ '`min=${d.minConceptCount} max=${d.maxConceptCount} statuses=${d.statuses.join("/")} passes=${d.minPasses}..${d.maxPasses} missing=${d.missingRows}`' <<<"$WB")"
[ "$(JQ 'String(d.minConceptCount)' <<<"$WB")" = "$NOTES" ] \
  && pass "conceptCount held at $NOTES with an invalidation as the first consumer" \
  || fail "the source blanked when an invalidation landed first after the re-key — $WB_DESC"
[ "$(JQ 'String(d.statuses.join(","))' <<<"$WB")" = "ok" ] \
  && pass "and it refreshed from the snapshot it inherited rather than from empty" \
  || fail "the inherited snapshot was dropped by the invalidation path — $WB_DESC"

# =============================================================================
echo "3. a policy change never serves the pre-change answer"
# =============================================================================
# Two policies carried in the key, one assertion each. Both were handed the old
# snapshot: identity was what the handoff matched on, and neither the settings
# nor the credential epoch is part of a layer's identity.
mkdir -p "$TMP/capped"
node -e 'const fs=require("node:fs");for(let i=0;i<200;i++)fs.writeFileSync(`${process.argv[1]}/n${i}.md`,`# N${i}\n\n## Body\n\nbulk ${i}.\n`)' "$TMP/capped"
cat > "$TMP/manifest-policy.json" <<EOF
{ "layers": [ { "name": "capped", "level": 1, "source": "files", "path": "$TMP/capped" } ] }
EOF
node "$TMP/host.mjs" "$PORT3" "$TMP/manifest-policy.json" >/dev/null 2>&1 &
PIDS+=($!)
for _ in $(seq 1 80); do curl -sf "${AUTH[@]}" "$BASE3/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done
curl -s "${AUTH[@]}" "$BASE3/api/graph?wait=30000" >/dev/null
P_ROW() { curl -s "${AUTH[@]}" "$BASE3/api/graph" | JQ 'JSON.stringify((d.sources ?? []).find((s) => s.name === "capped") ?? null)'; }
[ "$(P_ROW | JQ 'String(d.conceptCount)')" = "200" ] \
  && pass "200 documents indexed under the default cap" \
  || fail "the capped layer did not index (row: $(P_ROW))"

code 200 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d '{"maxDocFiles":100}' "$BASE3/api/settings")" "lower maxDocFiles below the layer's size"
# The user just said "index at most 100 documents". Serving 200 after that is
# wrong at every moment — the re-key must drop the over-cap snapshot rather
# than hand it forward. What replaces it changed deliberately with the
# truncating cap: the fresh pass serves AT MOST the new cap, visibly marked
# partial, instead of an error row with nothing behind it.
STILL_200=0
for _ in $(seq 1 60); do
  ROW="$(P_ROW)"
  [ "$(JQ 'String(d.conceptCount)' <<<"$ROW")" = "200" ] && STILL_200=1
  COUNT="$(JQ 'String(d.conceptCount)' <<<"$ROW")"
  [ "$(JQ 'String(d.status)' <<<"$ROW")" = "ok" ] && [ "$COUNT" = "100" ] && break
  sleep 0.25
done
[ "$STILL_200" = "0" ] \
  && pass "the over-cap answer was never served after the cap was lowered" \
  || fail "the pre-change snapshot survived the settings change (row: $(P_ROW))"
FINAL="$(P_ROW)"
[ "$(JQ '`${d.status}:${d.conceptCount}`' <<<"$FINAL")" = "ok:100" ] \
  && pass "the re-index serves exactly the new cap, truncated, never the old answer" \
  || fail "a policy change did not land on the capped truncated answer ($FINAL)"
grep -q 'Indexed the first 100 documents' <<<"$(JQ 'String((d.warningMessages ?? []).join(" | "))' <<<"$FINAL")" \
  && pass "and the partial answer says so out loud (truncation warning)" \
  || fail "a truncated source carries no visible warning ($FINAL)"

# The credential half, in-process: the engine receives secrets by value, so
# Disconnect is a setTokens({}) call rather than an HTTP route.
cat > "$TMP/creds.mjs" <<'EOF'
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { createEngineService } = await import(pathToFileURL(process.env.SERVICE_MJS).href);

const dir = process.argv[2];
const SECRET = "gh" + "u_" + "P".repeat(36);
const FILE = "---\ntype: note\ntitle: Private\nupdated: 2026-07-01\n---\n\n# Private\n\n## S {#s}\n\nprivate body.\n";

// A private repo: everything 404s without a credential, which is what GitHub
// does. The adapter answers [] rather than throwing, so an anonymous read is
// an empty layer — the state a disconnected account must reach immediately.
const api = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (c, b) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (!req.headers.authorization) return json(404, { message: "Not Found" });
  if (url.pathname === "/repos/acme/private") return json(200, { default_branch: "main", pushed_at: "2026-07-20T12:00:00Z" });
  if (url.pathname.startsWith("/repos/acme/private/git/trees/")) {
    return json(200, { truncated: false, tree: [{ path: "README.md", type: "blob", size: FILE.length }] });
  }
  if (url.pathname === "/repos/acme/private/commits") return json(200, []);
  if (url.pathname.startsWith("/repos/acme/private/contents/")) {
    res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(FILE) });
    return res.end(FILE);
  }
  return json(404, { message: "Not Found" });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const apiHost = "127.0.0.1:" + api.address().port;

const manifestPath = path.join(dir, "creds-manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify({
  layers: [{ name: "private", level: 2, source: "github", repo: "acme/private", apiBase: "http://" + apiHost, auth: "keychain:acct" }],
}));

const svc = createEngineService({ manifestPath, tokens: { acct: { secret: SECRET, host: apiHost } } });
const server = http.createServer(async (req, res) => {
  if (await svc.handleRequest(req, res)) return;
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;
const row = async (wait) => {
  const res = await fetch(base + "/api/graph" + (wait ? `?wait=${wait}` : ""));
  return ((await res.json()).sources ?? []).find((s) => s.name === "private") ?? null;
};

const connected = await row(8000);
// Disconnect, then read at once — no wait, no settling. The credentialed
// answer must already be gone.
svc.setTokens({});
const immediate = await row(0);
const settled = await row(8000);
svc.close(); server.close(); api.close();
console.log(JSON.stringify({
  connectedCount: connected?.conceptCount ?? 0,
  immediateCount: immediate?.conceptCount ?? 0,
  settledCount: settled?.conceptCount ?? 0,
  immediateStatus: immediate?.status ?? null,
}));
EOF
CRED="$(node "$TMP/creds.mjs" "$TMP" 2>/dev/null)"
[ "$(JQ 'String(d.connectedCount > 0)' <<<"$CRED")" = "true" ] \
  && pass "the credentialed repo indexed while connected ($(JQ 'String(d.connectedCount)' <<<"$CRED") concepts)" \
  || fail "the credentialed layer never indexed, so the disconnect below proves nothing ($CRED)"
[ "$(JQ 'String(d.immediateCount)' <<<"$CRED")" = "0" ] \
  && pass "disconnecting the account stops serving its content immediately" \
  || fail "the private repo's concepts survived a disconnect ($CRED)"
[ "$(JQ 'String(d.settledCount)' <<<"$CRED")" = "0" ] \
  && pass "and the anonymous re-index does not bring them back" \
  || fail "the anonymous re-index served credentialed content ($CRED)"

# =============================================================================
echo "4. a folder whose name contains a dot reaches the index"
# =============================================================================
# Moving a folder into a watched vault delivers ONE event, naming the folder.
# "Archive 2024.10" has an extension by path.extname's reckoning (".10"), so
# the watcher dropped the only event there was and every document inside stayed
# invisible until something else happened to invalidate the layer.
mkdir -p "$TMP/staging/Archive 2024.10"
printf -- '---\ntype: note\ntitle: Archived\nupdated: 2026-02-02\n---\n\n# Archived\n\n## Body {#body}\n\nmoved in from elsewhere.\n' \
  > "$TMP/staging/Archive 2024.10/archived.md"
[ "$(ROW2 quiet | JQ 'String(d.conceptCount)')" = "1" ] \
  && pass "the quiet layer holds its 1 seed document going in" \
  || fail "the quiet layer is not in the state this assertion needs ($(ROW2 quiet))"
mv "$TMP/staging/Archive 2024.10" "$TMP/quiet/"
DOTTED=0
for _ in $(seq 1 60); do
  [ "$(ROW2 quiet | JQ 'String(d.conceptCount)')" = "2" ] && { DOTTED=1; break; }
  sleep 0.25
done
[ "$DOTTED" = "1" ] \
  && pass "the documents inside the dotted folder reached the index on the watcher alone" \
  || fail "a dotted directory swallowed its documents (quiet row: $(ROW2 quiet)) — the move delivers one event, for the directory, and an extension check drops it"
[ "$(G2 | JQ 'String((d.concepts ?? []).some((c) => c.id.endsWith("archived")))')" = "true" ] \
  && pass "and the concept is in the graph" \
  || fail "the dotted folder's concept never reached the graph"

# =============================================================================
echo "5. a vault someone is typing in stays usable and stays bounded"
# =============================================================================
# A real .md rewritten every ${CHURN_MS}ms: a user with the vault open. Nothing
# here is filtered — this is the genuine edit traffic the watcher must let
# through — so the only thing standing between it and an unbounded chain of
# full re-reads is the coalescing state machine.
curl -s "${AUTH[@]}" "$BASE2/api/graph?wait=$SETTLE_TIMEOUT_MS" >/dev/null
CHURN_BEFORE="$(ROW2 vault-b | JQ 'String(d.indexing.passes)')"
[ "$(ROW2 vault-b | JQ 'String(d.conceptCount)')" = "$NOTES" ] \
  && pass "the vault is settled at $NOTES concepts before the churn" \
  || fail "the vault is not settled going into the churn ($(ROW2 vault-b))"
(
  while true; do
    printf '# Note 2 (typing)\n\n## Body\n\n%s%s\n' "$RANDOM" "$RANDOM" > "$TMP/vault/note-2.md"
    sleep "$CHURN_SLEEP"
  done
) &
CHURN_PID=$!
CHURNED="$(node "$TMP/watch.mjs" "$BASE2" vault-b "$CHURN_WINDOW_MS" "$POLL_MS")"
kill "$CHURN_PID" 2>/dev/null; wait "$CHURN_PID" 2>/dev/null; CHURN_PID=""
CH_DESC="$(JQ '`min=${d.minConceptCount} max=${d.maxConceptCount} statuses=${d.statuses.join("/")} phases=${d.phases.join("/")} passes=${d.minPasses}..${d.maxPasses} refreshingSeen=${d.refreshingSeen} indexingFlagSeen=${d.indexingFlagSeen} samples=${d.samples}`' <<<"$CHURNED")"

[ "$(JQ 'String(d.minConceptCount)' <<<"$CHURNED")" = "$NOTES" ] \
  && pass "the vault served all $NOTES concepts throughout the churn" \
  || fail "the churn blanked the vault — $CH_DESC"
[ "$(JQ 'String(d.statuses.join(","))' <<<"$CHURNED")" = "ok" ] \
  && pass "the source stayed ready rather than reverting to indexing" \
  || fail "a background refresh flipped a usable source back to unready — $CH_DESC"
[ "$(JQ 'String(d.indexingFlagSeen)' <<<"$CHURNED")" = "false" ] \
  && pass "/api/graph never claimed the cascade was indexing" \
  || fail "the graph reported indexing=true while every source had an answer — $CH_DESC; the console holds a spinner up for exactly this flag"
# Vacuity guard: if nothing invalidated, everything above passes for the wrong
# reason. At least one refresh must have run.
CHURN_AFTER="$(JQ 'String(d.maxPasses)' <<<"$CHURNED")"
case "$CHURN_AFTER$CHURN_BEFORE" in ''|*[!0-9]*) CHURN_AFTER=0; CHURN_BEFORE=0 ;; esac
CHURN_DELTA=$((CHURN_AFTER - CHURN_BEFORE))
[ "$CHURN_DELTA" -ge 1 ] \
  && pass "the churn did reach the index (${CHURN_DELTA} refresh pass(es) over ${CHURN_WINDOW_MS}ms)" \
  || fail "no pass ran during the churn window, so the assertions above prove nothing — $CH_DESC"
# The bound, restated for the incremental index. A pass is no longer a full
# re-read — the fingerprint gate re-reads only the churned file — so the cost
# model the old "3 passes max" encoded (each pass ~= the whole corpus) is
# gone. What must still hold: passes are spaced by the quiet window
# (FOLLOW_UP_MIN_QUIET_MS floor, 1s), so sustained editing costs at most ~one
# cheap sweep per second, and each of those sweeps must actually BE cheap
# (carried-dominant), or this is the old pegged core with better bookkeeping.
MAX_PASSES=$(( CHURN_WINDOW_MS / 1000 + 3 ))
[ "$CHURN_DELTA" -le "$MAX_PASSES" ] \
  && pass "and it cost ${CHURN_DELTA} pass(es), quiet-window spaced (<= $MAX_PASSES over ${CHURN_WINDOW_MS}ms of ${CHURN_MS}ms edits)" \
  || fail "sustained editing ran $CHURN_DELTA passes over ${CHURN_WINDOW_MS}ms — $CH_DESC; the quiet window is not holding edits to ~one pass per second"
CHURN_STATS="$(ROW2 vault-b | JQ '(() => { const p = d.indexing.passStats; return p ? `${p.read} ${p.carried}` : "absent" })()')"
CHURN_READ="${CHURN_STATS%% *}"
CHURN_CARRIED="${CHURN_STATS##* }"
if [ "$CHURN_STATS" != "absent" ] && [ "$CHURN_READ" -le 2 ] 2>/dev/null && [ "$CHURN_CARRIED" -ge $((NOTES - 2)) ] 2>/dev/null; then
  pass "each churn pass was a fingerprint sweep, not a re-read (last pass: read=$CHURN_READ carried=$CHURN_CARRIED)"
else
  fail "churn passes are re-reading the corpus (last pass stats: $CHURN_STATS) — incrementality regressed under sustained editing"
fi
# A refresh must be OBSERVABLE as the additive signal, never as a status
# regression — but the incremental index made refresh passes faster than the
# poll interval, so a sampler can legitimately miss the ~40ms refreshing=true
# window. Accept either: the signal was sampled, or the pass demonstrably ran
# entirely in the background (passes advanced while status never left ok and
# the indexing flag never rose) — which is the state the signal exists to
# describe.
REFRESH_SEEN="$(JQ 'String(d.refreshingSeen)' <<<"$CHURNED")"
BACKGROUNDED="$(JQ 'String(d.maxPasses > d.minPasses && d.statuses.join("") === "ok" && d.indexingFlagSeen === false)' <<<"$CHURNED")"
if [ "$REFRESH_SEEN" = "true" ] || [ "$BACKGROUNDED" = "true" ]; then
  pass "the refresh stayed a background signal (refreshingSeen=$REFRESH_SEEN, sub-poll pass=$BACKGROUNDED)"
else
  fail "a background refresh ran with no honest signal — $CH_DESC"
fi

# The edit still has to land, or "bounded" would just mean "ignored".
printf '# Note 3 (final)\n\n## Body\n\nthe last edit before the vault goes quiet.\n' > "$TMP/vault/note-3.md"
LANDED=0
for _ in $(seq 1 80); do
  curl -s "${AUTH[@]}" "$BASE2/api/graph?wait=$SETTLE_TIMEOUT_MS" >/dev/null
  [ "$(curl -s "${AUTH[@]}" "$BASE2/api/resolve?concept=note-3" | JQ 'String(JSON.stringify(d).includes("the last edit"))')" = "true" ] \
    && { LANDED=1; break; }
  sleep 0.25
done
[ "$LANDED" = "1" ] && pass "an edit made after the churn still reaches the cascade" || fail "the quiet period swallowed a real edit"
[ "$(ROW2 vault-b | JQ 'String(d.conceptCount)')" = "$NOTES" ] \
  && pass "the vault ends where it started: $NOTES concepts, no blank in between" \
  || fail "the vault did not come back ($(ROW2 vault-b))"

[ "$FAILED" = 0 ] \
  && echo "index lifecycle test passed (per-layer keys + handoff + policy re-keys + dotted dirs + bounded refresh)" \
  || { echo "index lifecycle test FAILED"; exit 1; }
