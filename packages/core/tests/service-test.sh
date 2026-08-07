#!/usr/bin/env bash
# Engine service tests: locks in the embeddable createEngineService contract —
# bearer-token auth, the allowMutations switch, caller fall-through, and the
# playground-compatible token-unset mode. Network-free. Run from the repo root.
set -uo pipefail

PORT="${PORT:-8811}"           # token-gated host
PORT2=$((PORT + 1))            # token-unset, mutations-disabled host
PORT3=$((PORT + 2))            # github-rest probe fixture (stands in for api.github.com)
BASE="http://127.0.0.1:$PORT"
BASE2="http://127.0.0.1:$PORT2"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
PORT4=$((PORT + 3))            # graph-cache host: freshness of the memoized /api/graph
BASE4="http://127.0.0.1:$PORT4"
PORT5=$((PORT + 4))            # quarantine-repair host: a manifest with invalid layers
BASE5="http://127.0.0.1:$PORT5"
PID1=""
PID2=""
PID3=""
PID4=""
PID5=""
FAILED=0

cleanup() {
  [ -n "$PID1" ] && kill "$PID1" 2>/dev/null
  [ -n "$PID2" ] && kill "$PID2" 2>/dev/null
  [ -n "$PID3" ] && kill "$PID3" 2>/dev/null
  [ -n "$PID4" ] && kill "$PID4" 2>/dev/null
  [ -n "$PID5" ] && kill "$PID5" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILED=1; }

# code <expected> <actual> <label>
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

# ---- fixtures: a temp OKF bundle + manifest + a console dist -----------------
mkdir -p "$TMP/bundle" "$TMP/b2" "$TMP/cdist"
printf -- '---\ntype: note\ntitle: Note\nupdated: 2026-07-01\n---\n\n# Note\n\n## Body {#body}\n\nhello.\n' > "$TMP/bundle/note.md"
printf -- '---\ntype: note\ntitle: N2\n---\n\n# N2\n\n## S {#s}\n\nx.\n' > "$TMP/b2/n.md"
printf '<!doctype html><title>Console</title><div id=root>CONSOLE_OK</div>\n' > "$TMP/cdist/index.html"
cat > "$TMP/manifest.json" <<EOF
{ "layers": [ { "name": "t", "level": 1, "path": "$TMP/bundle" } ], "pendingSources": [ { "name": "b2", "level": 2, "path": { "__scrubbed": "path" } } ], "pendingSourcesOwnerUserId": "user-1" }
EOF
cp "$TMP/manifest.json" "$TMP/manifest2.json"

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

# ---- github-rest probe fixture ------------------------------------------------
# Stands in for api.github.com so the add-time probe is deterministic with or
# without network: a known slug answers 200, "forbidden" 403, "deadend" kills
# the socket (the network-failure shape), anything else 404. The layer the
# endpoint then WRITES still points at the real api.github.com — its graph row
# is asserted as degraded, which is true offline and online (the slug is chosen
# to exist nowhere).
cat > "$TMP/gh-probe.mjs" <<'EOF'
import http from "node:http";
http.createServer((req, res) => {
  if (req.url.startsWith("/repos/cc-no-such-owner-e3e9021/")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ default_branch: "main" }));
  }
  if (req.url.startsWith("/repos/forbidden/")) {
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ message: "rate limited" }));
  }
  if (req.url.startsWith("/repos/deadend/")) return req.socket.destroy();
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "Not Found" }));
}).listen(Number(process.argv[2]), "127.0.0.1");
EOF
node "$TMP/gh-probe.mjs" "$PORT3" >/dev/null 2>&1 &
PID3=$!

export SERVICE_MJS="$ROOT/packages/core/src/service.mjs"
CONTEXTCAKE_GITHUB_PROBE_BASE="http://127.0.0.1:$PORT3" node "$TMP/host.mjs" "$PORT" "$TMP/manifest.json" sekrit true "$TMP/cdist" >/dev/null 2>&1 &
PID1=$!
node "$TMP/host.mjs" "$PORT2" "$TMP/manifest2.json" - false - >/dev/null 2>&1 &
PID2=$!
for _ in $(seq 1 30); do curl -sf "${AUTH[@]}" "$BASE/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done
for _ in $(seq 1 30); do curl -sf "$BASE2/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done

echo "bearer token gate (token: sekrit)"
code 401 "$(C "$BASE/api/graph")" "read without header rejected"
code 401 "$(C -H 'Authorization: Bearer wrong' "$BASE/api/graph")" "read with wrong token rejected"
code 200 "$(C "${AUTH[@]}" "$BASE/api/graph")" "read with correct Bearer accepted"
code 200 "$(C -H 'Authorization: Bearer   sekrit' "$BASE/api/graph")" "extra separator whitespace still accepted"
code 401 "$(C -H 'Authorization: Bearer      ' "$BASE/api/graph")" "all-whitespace token rejected (ReDoS-safe parse)"
# ?wait= — token totals only exist once the background index has read the
# source, so a payload assertion has to ask for a settled index.
G="$(curl -s "${AUTH[@]}" "$BASE/api/graph?wait=15000" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const g=JSON.parse(s);process.stdout.write(`${g.tokenizer}:${g.totals.sources}:${g.totals.sourceTokens>0}`)})')"
[ "$G" = "o200k_base:1:true" ] && pass "graph payload intact behind auth" || fail "graph payload ($G)"
# A source with no health of its own (a local bundle) reports plain "ok" and
# null health fields — "degraded" is reserved for an adapter that says so.
H="$(curl -s "${AUTH[@]}" "$BASE/api/graph" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s).sources[0];process.stdout.write(`${x.status}:${x.error}:${x.lastErrorAt}:${x.lastSuccessAt}`)})')"
[ "$H" = "ok:null:null:null" ] && pass "healthless source reports plain ok" || fail "local source health shape ($H)"
code 401 "$(C "$BASE/api/resolve?concept=note")" "resolve without header rejected"
code 200 "$(C "${AUTH[@]}" "$BASE/api/resolve?concept=note")" "resolve with Bearer accepted"
code 401 "$(C "$BASE/api/host-only")" "unknown /api/* path still gated without token"
code 401 "$(C "$BASE/api/files")" "layer file API gated without token"

echo "console mount is static UI, not gated data"
curl -s "$BASE/console/" | grep -q CONSOLE_OK && pass "/console/ serves without auth" || fail "/console/ without auth"

echo "caller fall-through"
FT="$(curl -s "$BASE/nope")"
grep -q host-fallthrough <<<"$FT" && pass "unknown path falls through to the host" || fail "fall-through ($FT)"
# A path the service genuinely doesn't own — /api/files is now a service route
# (the layer file explorer moved out of the playground into the engine).
FT="$(curl -s "${AUTH[@]}" "$BASE/api/host-only")"
grep -q host-fallthrough <<<"$FT" && pass "unclaimed /api/* falls through once authed" || fail "authed /api fall-through ($FT)"

echo "sources CRUD through the service (authed)"
code 403 "$(C -X POST "${AUTH[@]}" -H 'Origin: http://evil.com' -d '{}' "$BASE/api/sources")" "CSRF guard survives in the service"
code 403 "$(C -X POST "${AUTH[@]}" -H 'Host: evil.com' -d '{}' "$BASE/api/sources")" "non-loopback Host blocked in the service"
code 401 "$(C -X POST -d '{}' "$BASE/api/sources")" "mutation without token rejected"
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"kind\":\"local\",\"name\":\"b2\",\"level\":2,\"path\":\"$TMP/b2\"}" "$BASE/api/sources")" "add local source"
grep -q 'pendingSources' "$TMP/manifest.json" && fail "configured source left pending metadata" || pass "configured source promoted out of pending metadata"
grep -q 'pendingSourcesOwnerUserId' "$TMP/manifest.json" && fail "configured source left pending owner metadata" || pass "configured source removed pending owner metadata"
N="$(curl -s "${AUTH[@]}" "$BASE/api/graph" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(String(JSON.parse(s).totals.sources))})')"
[ "$N" = "2" ] && pass "reload picked up the new source" || fail "reload after add (sources=$N)"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=b2")" "remove source"
mkdir -p "$TMP/files"
printf '# Existing Markdown\n\n## Notes\n\nNo frontmatter needed.\n' > "$TMP/files/notes.md"
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"notes\",\"level\":2,\"path\":\"$TMP/files\"}" "$BASE/api/sources")" "add markdown folder source"
grep -q '"source": "files"' "$TMP/manifest.json" && pass "markdown folder is persisted as files source" || fail "markdown folder source kind"
curl -s "${AUTH[@]}" "$BASE/api/resolve?concept=notes" | grep -q 'No frontmatter needed' && pass "markdown folder resolves plain files" || fail "markdown folder resolve"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=notes")" "remove markdown folder source"

echo "section writes: stale-editor guard + updated= refresh (B4)"
TODAY="$(date -u +%Y-%m-%d)"
printf -- '---\ntype: note\ntitle: Merge me\n---\n\n# Merge me\n\n## Pick {#pick updated=2026-01-01}\n\nold value.\n\n## After {#after}\n\nuntouched.\n' > "$TMP/bundle/merge-me.md"
MT="$(curl -s "${AUTH[@]}" "$BASE/api/file?path=t/merge-me.md" | JQ 'd.modified')"
code 200 "$(C -X PUT "${AUTH[@]}" -H 'content-type: application/json' -d "{\"conceptId\":\"merge-me\",\"sectionKey\":\"pick\",\"layers\":[\"t\"],\"content\":\"AGREED.\",\"modified\":{\"t\":\"$MT\"}}" "$BASE/api/section")" "matching mtime writes the section"
grep -q 'AGREED.' "$TMP/bundle/merge-me.md" && pass "section body replaced" || fail "section body not written"
grep -q "## Pick {#pick updated=$TODAY}" "$TMP/bundle/merge-me.md" && pass "authored updated= attr refreshed to today, anchor intact" || fail "updated= not refreshed ($(grep '## Pick' "$TMP/bundle/merge-me.md"))"
grep -q 'untouched.' "$TMP/bundle/merge-me.md" && pass "next section survived" || fail "next section corrupted"
MT="$(curl -s "${AUTH[@]}" "$BASE/api/file?path=t/merge-me.md" | JQ 'd.modified')"
sleep 0.1
printf '\nexternal edit line.\n' >> "$TMP/bundle/merge-me.md"
code 409 "$(C -X PUT "${AUTH[@]}" -H 'content-type: application/json' -d "{\"conceptId\":\"merge-me\",\"sectionKey\":\"pick\",\"layers\":[\"t\"],\"content\":\"STALE WRITE\",\"modified\":{\"t\":\"$MT\"}}" "$BASE/api/section")" "a stale mtime is refused with 409"
grep -q 'STALE WRITE' "$TMP/bundle/merge-me.md" && fail "stale write reached disk" || pass "stale write never reached disk"
grep -q 'external edit line.' "$TMP/bundle/merge-me.md" && pass "the external edit survived the refused write" || fail "external edit lost"
# All-or-nothing across layers: one stale target refuses the WHOLE write.
mkdir -p "$TMP/m2"
printf -- '# Merge me\n\n## Pick {#pick}\n\nother value.\n' > "$TMP/m2/merge-me.md"
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"m2\",\"level\":1,\"path\":\"$TMP/m2\"}" "$BASE/api/sources")" "add second layer defining the section"
MT2="$(curl -s "${AUTH[@]}" "$BASE/api/file?path=m2/merge-me.md" | JQ 'd.modified')"
code 409 "$(C -X PUT "${AUTH[@]}" -H 'content-type: application/json' -d "{\"conceptId\":\"merge-me\",\"sectionKey\":\"pick\",\"layers\":[\"t\",\"m2\"],\"content\":\"HOMOGENIZED\",\"modified\":{\"t\":\"$MT\",\"m2\":\"$MT2\"}}" "$BASE/api/section")" "one stale layer fails the whole multi-layer write"
grep -q 'HOMOGENIZED' "$TMP/m2/merge-me.md" && fail "partial write reached the fresh layer" || pass "the fresh layer was not partially homogenized"

echo "conflict decisions: safe automation, plain choice, and append-only history"
code 409 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"conceptId":"merge-me","sectionKey":"pick","selectedLayer":"t","method":"automatic"}' "$BASE/api/conflict-resolutions")" "meaning-changing conflict refuses the wand"
grep -q 'other value.' "$TMP/m2/merge-me.md" && pass "refused wand left dissent untouched" || fail "refused wand changed dissent"
MANUAL="$(curl -s -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"conceptId":"merge-me","sectionKey":"pick","selectedLayer":"m2","method":"manual"}' "$BASE/api/conflict-resolutions")"
[ "$(JQ 'String(d.ok)' <<<"$MANUAL")" = "true" ] && pass "manual answer applied" || fail "manual answer failed ($MANUAL)"
[ "$(JQ 'String(d.resolution.contributions.every((item) => item.level === 1))' <<<"$MANUAL")" = "true" ] && pass "history retains custom layer precedence" || fail "history dropped layer precedence ($MANUAL)"
grep -q 'other value.' "$TMP/bundle/merge-me.md" && pass "manual answer reached the former winner" || fail "manual answer missed former winner"
RID="$(JQ 'd.resolution.id' <<<"$MANUAL")"
HISTORY="$(curl -s "${AUTH[@]}" "$BASE/api/conflict-resolutions")"
[ "$(JQ 'String(d.resolutions.length)' <<<"$HISTORY")" = "1" ] && pass "decision appears in append-only history" || fail "decision history shape ($HISTORY)"
grep -q 'AGREED.' <<<"$HISTORY" && pass "history retains the original answer" || fail "history dropped original answer"
CHANGED="$(curl -s -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"conceptId\":\"merge-me\",\"sectionKey\":\"pick\",\"selectedLayer\":\"t\",\"method\":\"manual\",\"resolutionId\":\"$RID\"}" "$BASE/api/conflict-resolutions")"
[ "$(JQ 'String(d.ok)' <<<"$CHANGED")" = "true" ] && pass "past decision can be changed" || fail "change decision failed ($CHANGED)"
grep -q 'AGREED.' "$TMP/m2/merge-me.md" && pass "changed decision reused the saved original answer" || fail "saved answer was not restored"
[ "$(curl -s "${AUTH[@]}" "$BASE/api/conflict-resolutions" | JQ 'String(d.resolutions.length)')" = "2" ] && pass "changed decision appends instead of rewriting history" || fail "changed decision did not append"
code 405 "$(C -X POST -H 'content-type: application/json' -d '{}' "$BASE2/api/conflict-resolutions")" "resolution respects the service mutation gate"

printf -- '# Format only\n\n## Pick {#pick}\n\nUse **Postgres** for writes.\n' > "$TMP/bundle/format-only.md"
printf -- '# Format only\n\n## Pick {#pick}\n\nUse postgres for writes\n' > "$TMP/m2/format-only.mdx"
AUTO="$(curl -s -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"conceptId":"format-only","sectionKey":"pick","selectedLayer":"t","method":"automatic"}' "$BASE/api/conflict-resolutions")"
[ "$(JQ 'd.resolution.method' <<<"$AUTO")" = "automatic" ] && pass "format-only conflict resolves automatically" || fail "format-only resolution failed ($AUTO)"
grep -q 'Use \*\*Postgres\*\* for writes.' "$TMP/m2/format-only.mdx" && pass "wand keeps .mdx contributors in sync" || fail "wand missed the .mdx contributor"

printf -- '# Race\n\n## Pick {#pick}\n\nred\n' > "$TMP/bundle/race.md"
printf -- '# Race\n\n## Pick {#pick}\n\nblue\n' > "$TMP/m2/race.mdx"
curl -s -o "$TMP/race-t.json" -w '%{http_code}' -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"conceptId":"race","sectionKey":"pick","selectedLayer":"t","method":"manual"}' "$BASE/api/conflict-resolutions" > "$TMP/race-t.status" &
RACE_T_PID=$!
curl -s -o "$TMP/race-m2.json" -w '%{http_code}' -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"conceptId":"race","sectionKey":"pick","selectedLayer":"m2","method":"manual"}' "$BASE/api/conflict-resolutions" > "$TMP/race-m2.status" &
RACE_M2_PID=$!
wait "$RACE_T_PID" "$RACE_M2_PID"
RACE_T="$(<"$TMP/race-t.status")"
RACE_M2="$(<"$TMP/race-m2.status")"
if { [ "$RACE_T" = "200" ] && [ "$RACE_M2" = "409" ]; } || { [ "$RACE_T" = "409" ] && [ "$RACE_M2" = "200" ]; }; then
  pass "simultaneous decisions serialize instead of racing"
else
  fail "simultaneous decisions raced ($RACE_T, $RACE_M2)"
fi

mkdir -p "$TMP/m3"
printf -- 'keep the local plain-text note\n' > "$TMP/m2/plain-text.txt"
printf -- 'replace this plain-text note\n' > "$TMP/m3/plain-text.txt"
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"m3\",\"level\":0,\"path\":\"$TMP/m3\"}" "$BASE/api/sources")" "add plain-text contributor"
PLAIN="$(curl -s -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"conceptId":"plain-text","sectionKey":"body","selectedLayer":"m2","method":"manual"}' "$BASE/api/conflict-resolutions")"
[ "$(JQ 'String(d.ok)' <<<"$PLAIN")" = "true" ] && pass "plain-text conflict resolves" || fail "plain-text resolution failed ($PLAIN)"
grep -qx 'keep the local plain-text note' "$TMP/m3/plain-text.txt" && pass "plain-text contributor was updated" || fail "plain-text contributor was not updated"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=m3")" "cleanup plain-text contributor"
# No updated= attr -> none is invented; the anchor stays byte-identical.
MTN="$(curl -s "${AUTH[@]}" "$BASE/api/file?path=t/note.md" | JQ 'd.modified')"
code 200 "$(C -X PUT "${AUTH[@]}" -H 'content-type: application/json' -d "{\"conceptId\":\"note\",\"sectionKey\":\"body\",\"layers\":[\"t\"],\"content\":\"still hello.\",\"modified\":{\"t\":\"$MTN\"}}" "$BASE/api/section")" "write to a heading without updated="
grep -q '## Body {#body}$' "$TMP/bundle/note.md" && pass "no updated= attr invented on an undated heading" || fail "heading changed ($(grep '## Body' "$TMP/bundle/note.md"))"
# The section route reads the whole file before it rewrites it, so the cap the
# other file routes enforce has to hold here too: a 30MB note came back
# {"ok":true} and 64 bytes on disk — a document the indexer refuses to read,
# destroyed by an editor that was never able to show it.
node -e 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], "# Too big\n\n## Pick {#pick}\n\n" + "x".repeat(2_100_000) + "\n")' "$TMP/bundle/too-big.md"
BIG_BEFORE="$(wc -c < "$TMP/bundle/too-big.md" | tr -d ' ')"
code 413 "$(C -X PUT "${AUTH[@]}" -H 'content-type: application/json' -d '{"conceptId":"too-big","sectionKey":"pick","layers":["t"],"content":"TRUNCATED"}' "$BASE/api/section")" "a document past the indexing cap is refused by /api/section"
BIG_AFTER="$(wc -c < "$TMP/bundle/too-big.md" | tr -d ' ')"
[ "$BIG_BEFORE" = "$BIG_AFTER" ] && pass "the oversized document was left byte-for-byte alone" || fail "oversized document was rewritten ($BIG_BEFORE -> $BIG_AFTER bytes)"
rm -f "$TMP/bundle/too-big.md"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=m2")" "cleanup second layer"

echo "github-rest source kind (C-a)"
code 400 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"kind":"github-rest","name":"gr","level":2,"repo":"cc-no-such-owner-e3e9021/repo","auth":"keychain:x"}' "$BASE/api/sources")" "auth field rejected, not ignored"
code 400 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"kind":"github-rest","name":"gr","level":2,"repo":"cc-no-such-owner-e3e9021/repo","apiBase":"https://ghe.corp"}' "$BASE/api/sources")" "apiBase field rejected, not ignored"
code 400 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"kind":"github-rest","name":"gr","level":2,"repo":"not-a-slug"}' "$BASE/api/sources")" "repo must be owner/name"
code 400 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"kind":"github-rest","name":"bad name!","level":2,"repo":"cc-no-such-owner-e3e9021/repo"}' "$BASE/api/sources")" "name slug shape rejected"
MISS="$(curl -s -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"kind":"github-rest","name":"gr","level":2,"repo":"missing/repo"}' "$BASE/api/sources")"
code 400 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"kind":"github-rest","name":"gr","level":2,"repo":"missing/repo"}' "$BASE/api/sources")" "404 probe rejects the add"
JQ 'd.error' <<<"$MISS" | grep -q 'repo not found or not public' && pass "404 wording points at the private-repo option" || fail "404 probe message ($MISS)"
code 400 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"kind":"github-rest","name":"gr","level":2,"repo":"forbidden/repo"}' "$BASE/api/sources")" "403 probe rejects the add"
grep -Eq 'missing/repo|forbidden/repo' "$TMP/manifest.json" && fail "rejected github-rest source leaked into the manifest" || pass "rejected github-rest adds never touch the manifest"
ADD="$(curl -s -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"kind":"github-rest","name":"gr","level":2,"repo":"cc-no-such-owner-e3e9021/repo"}' "$BASE/api/sources")"
[ "$(JQ '`${d.ok}:${d.added}:${d.indexing}`' <<<"$ADD")" = "true:gr:true" ] && pass "public repo add answers ok/added/indexing" || fail "github-rest add response ($ADD)"
SHAPE="$(node -e '
  const fs = require("node:fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const layers = m.layers ?? m.profiles?.default?.layers ?? [];
  const l = layers.find((x) => x.name === "gr");
  if (!l) { console.log("MISSING"); process.exit(0); }
  console.log([
    l.source, l.repo, l.level, l.cache?.ttlSeconds,
    "auth" in l, "apiBase" in l, "path" in l, "ref" in l, "paths" in l,
  ].join(":"));
' "$TMP/manifest.json")"
[ "$SHAPE" = "github:cc-no-such-owner-e3e9021/repo:2:900:false:false:false:false:false" ] && pass "manifest layer shape per C-a (source github + cache, no auth/apiBase/path)" || fail "github-rest layer shape ($SHAPE)"
code 409 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"kind":"github-rest","name":"gr","level":2,"repo":"cc-no-such-owner-e3e9021/repo"}' "$BASE/api/sources")" "duplicate name answers the existing 409"
ADD2="$(curl -s -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"kind":"github-rest","name":"gr2","level":1,"repo":"deadend/repo","ref":"main","paths":["docs/**","CLAUDE.md"]}' "$BASE/api/sources")"
[ "$(JQ 'String(d.ok)' <<<"$ADD2")" = "true" ] && pass "a network-failing probe fails open (the add still writes)" || fail "fail-open add ($ADD2)"
SHAPE2="$(node -e '
  const fs = require("node:fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const layers = m.layers ?? m.profiles?.default?.layers ?? [];
  const l = layers.find((x) => x.name === "gr2");
  console.log(l ? [l.ref, JSON.stringify(l.paths)].join(":") : "MISSING");
' "$TMP/manifest.json")"
[ "$SHAPE2" = 'main:["docs/**","CLAUDE.md"]' ] && pass "optional ref/paths are carried into the layer" || fail "ref/paths carry ($SHAPE2)"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=gr2")" "remove fail-open source"
G="$(curl -s "${AUTH[@]}" "$BASE/api/graph?wait=15000")"
ROW="$(JQ 'JSON.stringify((({kind,conceptCount,status}) => ({kind,conceptCount,status}))(d.sources.find((s) => s.name === "gr") ?? {}))' <<<"$G")"
[ "$ROW" = '{"kind":"github","conceptCount":0,"status":"degraded"}' ] && pass "the REST layer's graph row appears (degraded offline/online: repo is unreachable)" || fail "github-rest graph row ($ROW)"
[ "$(JQ 'String(d.sources.find((s) => s.name === "gr").lastErrorAt !== null)' <<<"$G")" = "true" ] && pass "health rides the row (lastErrorAt set)" || fail "lastErrorAt missing ($G)"
SYNC="$(curl -s -X POST "${AUTH[@]}" "$BASE/api/sources/sync?name=gr")"
code 502 "$(C -X POST "${AUTH[@]}" "$BASE/api/sources/sync?name=gr")" "sync reaches the REST branch and reports the real failure"
JQ 'd.error' <<<"$SYNC" | grep -q 'Sync failed' && pass "sync failure names itself instead of a false green" || fail "sync error copy ($SYNC)"

echo "v2 manifest reads: profile create migration keeps the service working (B2)"
PRE="$(curl -s "${AUTH[@]}" "$BASE/api/graph?wait=15000")"
PRE_ROWS="$(JQ 'd.sources.map((s) => `${s.name}/${s.level}/${s.kind}`).join(",")' <<<"$PRE")"
PRE_T_MS="$(JQ 'String(d.sources.find((s) => s.name === "t").indexing.elapsedMs)' <<<"$PRE")"
MIG="$(node --input-type=module -e "
import { migrateManifestToV2, classifyManifest } from '$ROOT/packages/core/src/manifest.mjs';
import fs from 'node:fs';
const r = migrateManifestToV2('$TMP/manifest.json', { newProfile: { label: 'Work' } });
const m = JSON.parse(fs.readFileSync('$TMP/manifest.json', 'utf8'));
console.log(r.action + ':' + classifyManifest(m));
")"
[ "$MIG" = "migrated:v2" ] && pass "profile create migrated the service-managed manifest to v2" || fail "migration ($MIG)"
POST="$(curl -s "${AUTH[@]}" "$BASE/api/graph?wait=15000")"
POST_ROWS="$(JQ 'd.sources.map((s) => `${s.name}/${s.level}/${s.kind}`).join(",")' <<<"$POST")"
[ -n "$PRE_ROWS" ] && [ "$PRE_ROWS" = "$POST_ROWS" ] && pass "/api/graph lists the same sources after migration ($POST_ROWS)" || fail "graph rows diverged (pre=$PRE_ROWS post=$POST_ROWS)"
POST_T_MS="$(JQ 'String(d.sources.find((s) => s.name === "t").indexing.elapsedMs)' <<<"$POST")"
[ "$PRE_T_MS" = "$POST_T_MS" ] && pass "migration reused the finished index (identical keys)" || fail "index rebuilt on migration ($PRE_T_MS -> $POST_T_MS)"
F="$(curl -s "${AUTH[@]}" "$BASE/api/files")"
[ "$(JQ 'String(d.layers.some((l) => l.layer === "t"))' <<<"$F")" = "true" ] && pass "/api/files still lists layer roots" || fail "file roots lost after migration ($F)"
code 200 "$(C "${AUTH[@]}" "$BASE/api/resolve?concept=note")" "a concept still resolves"
code 502 "$(C -X POST "${AUTH[@]}" "$BASE/api/sources/sync?name=gr")" "sync still FINDS the layer post-migration (502 not 404)"
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"pv2\",\"level\":1,\"path\":\"$TMP/m2\"}" "$BASE/api/sources")" "CRUD add works on a v2 manifest"
node -e '
  const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.exit(m.profiles?.default?.layers?.some((l) => l.name === "pv2") && !("layers" in m) ? 0 : 1);
' "$TMP/manifest.json" && pass "the add landed inside profiles.default, not a legacy layers array" || fail "v2 add wrote the wrong place"
code 200 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"pv2","newName":"pv2b","level":0}' "$BASE/api/sources")" "CRUD rename/re-level works on v2"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=pv2b")" "CRUD remove works on v2"

echo "a dead MCP child paints its row degraded, then recovers (C-d)"
cat > "$TMP/flaky.mjs" <<'EOF'
import readline from "node:readline";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
// The kill switch is a marker file next to this script (the spawning service
// host does not share the test shell's environment).
const MARKER = fileURLToPath(new URL("./flaky-die", import.meta.url));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (o) => process.stdout.write(JSON.stringify(o) + "\n");
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") return write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "flaky", version: "0" } } });
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") return write({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "list_nodes" }, { name: "get_node" }] } });
  if (msg.method === "tools/call") {
    if (fs.existsSync(MARKER)) process.exit(1); // crash instead of answering
    const { name, arguments: a = {} } = msg.params ?? {};
    if (name === "list_nodes") return write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ nodes: ["n1"] }) }] } });
    if (name === "get_node") return write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ node: "n1", title: "N1", kind: "note", facts: [{ topic: "Body", text: "alive.", lastTouched: "2026-06-01" }] }) }] } });
  }
});
EOF
FLAKY_DIE="$TMP/flaky-die"
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"kind\":\"mcp\",\"name\":\"flaky\",\"level\":0,\"command\":\"node\",\"args\":[\"$TMP/flaky.mjs\"],\"trusted\":true}" "$BASE/api/sources")" "mcp source added (probe passes, v2 manifest)"
G="$(curl -s "${AUTH[@]}" "$BASE/api/graph?wait=15000")"
[ "$(JQ 'JSON.stringify([d.sources.find((s) => s.name === "flaky")?.status, d.sources.find((s) => s.name === "flaky")?.conceptCount])' <<<"$G")" = '["ok",1]' ] && pass "healthy mcp row is ok with its concept" || fail "mcp pre-crash row ($G)"
touch "$FLAKY_DIE"
curl -s "${AUTH[@]}" "$BASE/api/resolve?concept=n1" >/dev/null # the read that hits the now-dying child
G="$(curl -s "${AUTH[@]}" "$BASE/api/graph")"
ROW="$(JQ 'JSON.stringify((({status,conceptCount}) => ({status,conceptCount}))(d.sources.find((s) => s.name === "flaky") ?? {}))' <<<"$G")"
[ "$ROW" = '{"status":"degraded","conceptCount":1}' ] && pass "dead child paints the row degraded, snapshot still served" || fail "mcp degraded row ($ROW)"
JQ 'd.sources.find((s) => s.name === "flaky").error' <<<"$G" | grep -q 'exited' && pass "the row names the child exit" || fail "mcp degraded error copy ($G)"
[ "$(JQ 'String(d.sources.find((s) => s.name === "flaky").lastErrorAt !== null)' <<<"$G")" = "true" ] && pass "lastErrorAt recorded" || fail "mcp lastErrorAt ($G)"
rm -f "$FLAKY_DIE"
sleep 3.2 # past the adapter's respawn cooldown
curl -s "${AUTH[@]}" "$BASE/api/resolve?concept=n1" | grep -q 'alive.' && pass "past the cooldown the child respawns and answers" || fail "mcp respawn resolve"
G="$(curl -s "${AUTH[@]}" "$BASE/api/graph")"
[ "$(JQ 'd.sources.find((s) => s.name === "flaky").status' <<<"$G")" = "ok" ] && pass "a successful read clears the degraded state" || fail "mcp recovery row ($G)"
[ "$(JQ 'String(d.sources.find((s) => s.name === "flaky").lastSuccessAt !== null)' <<<"$G")" = "true" ] && pass "lastSuccessAt recorded" || fail "mcp lastSuccessAt ($G)"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=flaky")" "cleanup mcp source"

echo "removing a clone-backed source cleans its clone dir (B5)"
CLONE="$TMP/.cache/repos/github.com__o__gh1"
mkdir -p "$CLONE/sub"
printf -- '---\ntype: note\ntitle: C\n---\n\n# C\n\n## S {#s}\n\nclone doc.\n' > "$CLONE/c.md"
printf -- '---\ntype: note\ntitle: C2\n---\n\n# C2\n\n## S {#s}\n\nclone sub doc.\n' > "$CLONE/sub/c2.md"
node -e '
  const fs = require("node:fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  m.profiles.default.layers.push(
    { name: "cl1", level: 1, path: ".cache/repos/github.com__o__gh1", origin: "https://github.com/o/gh1.git", ref: null },
    { name: "cl2", level: 1, path: ".cache/repos/github.com__o__gh1/sub", origin: "https://github.com/o/gh1.git", ref: null },
  );
  fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2) + "\n");
' "$TMP/manifest.json"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=cl2")" "remove one of two layers sharing the clone"
[ -d "$CLONE" ] && pass "the shared clone dir survives while another layer uses it" || fail "shared clone dir deleted too early"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=cl1")" "remove the last layer using the clone"
[ -d "$CLONE" ] && fail "orphaned clone dir left behind" || pass "the orphaned clone dir is deleted"
mkdir -p "$TMP/keepme"
printf '# Keep\n\n## Body\n\nuser data.\n' > "$TMP/keepme/keep.md"
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"keep\",\"level\":1,\"path\":\"$TMP/keepme\"}" "$BASE/api/sources")" "add a user folder source"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=keep")" "remove the user folder source"
[ -f "$TMP/keepme/keep.md" ] && pass "a user folder is never touched by remove" || fail "user folder deleted on remove"

# ---- repointing a source at a different folder (PATCH path) -------------------
# The one field the app used to answer with "remove the source and add it again".
# What matters here is that the source really reads the NEW folder afterwards
# (not just that the manifest string changed), that a bad path leaves the
# manifest exactly as it was, and that name/level survive a path-only patch.
echo "editable source path (PATCH path)"
mkdir -p "$TMP/from-here" "$TMP/to-here"
printf '# Old Home\n\n## Body\n\nthe folder it was added with.\n' > "$TMP/from-here/old-home.md"
printf '# New Home\n\n## Body\n\nthe folder it was repointed to.\n' > "$TMP/to-here/new-home.md"
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"movable\",\"level\":2,\"path\":\"$TMP/from-here\"}" "$BASE/api/sources")" "add the source that will be repointed"
curl -s "${AUTH[@]}" "$BASE/api/graph?wait=15000" >/dev/null
curl -s "${AUTH[@]}" "$BASE/api/resolve?concept=old-home" | grep -q 'the folder it was added with' && pass "the source serves its original folder" || fail "original folder not served"

MOVE="$(curl -s -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"movable\",\"path\":\"$TMP/to-here\"}" "$BASE/api/sources")"
[ "$(JQ 'JSON.stringify([d.ok, d.reindexing, d.hasDocuments])' <<<"$MOVE")" = '[true,true,true]' ] && pass "the path patch reports a re-index and a folder with documents" || fail "path patch response ($MOVE)"
curl -s "${AUTH[@]}" "$BASE/api/graph?wait=15000" >/dev/null
curl -s "${AUTH[@]}" "$BASE/api/resolve?concept=new-home" | grep -q 'the folder it was repointed to' && pass "the source re-indexes against the new folder" || fail "new folder not indexed"
[ "$(curl -s "${AUTH[@]}" "$BASE/api/resolve?concept=old-home" | JQ 'JSON.stringify(d.contributors ?? [])')" = "[]" ] && pass "the old folder's concepts stop resolving" || fail "old folder still resolving after the move"
ROW="$(curl -s "${AUTH[@]}" "$BASE/api/graph" | JQ 'JSON.stringify((({name,level,conceptCount}) => ({name,level,conceptCount}))(d.sources.find((s) => s.name === "movable") ?? {}))')"
[ "$ROW" = '{"name":"movable","level":2,"conceptCount":1}' ] && pass "name and level survive a path-only patch" || fail "path patch disturbed name/level ($ROW)"

code 400 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"movable\",\"path\":\"$TMP/does-not-exist\"}" "$BASE/api/sources")" "a missing folder fails the patch"
code 400 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"movable\",\"path\":\"$TMP/to-here/new-home.md\"}" "$BASE/api/sources")" "a file instead of a folder fails the patch"
code 400 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"movable","path":"   "}' "$BASE/api/sources")" "an empty path fails the patch"
# An array reaching String() would collapse to its single element and sail
# through the trim and the probe, so the type is checked before the coercion.
code 400 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"movable\",\"path\":[\"$TMP/to-here\"]}" "$BASE/api/sources")" "a path that is not a string fails the patch"
grep -q "$TMP/to-here" "$TMP/manifest.json" && pass "a refused path patch leaves the manifest on the last good folder" || fail "manifest mutated by a refused path patch"
code 404 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"no-such-source\",\"path\":\"$TMP/to-here\"}" "$BASE/api/sources")" "an unknown source name is a 404, not a new layer"

# Kinds with no folder to repoint. Each answers with the reason rather than a
# generic refusal, because "remove and add it again" is still the right advice
# for exactly these.
PR="$(curl -s -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"gr\",\"path\":\"$TMP/to-here\"}" "$BASE/api/sources")"
code 400 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"gr\",\"path\":\"$TMP/to-here\"}" "$BASE/api/sources")" "a github source refuses a path patch"
grep -q 'repository' <<<"$PR" && pass "the github refusal names the repository" || fail "github refusal copy ($PR)"
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"kind\":\"mcp\",\"name\":\"mv-mcp\",\"level\":0,\"command\":\"node\",\"args\":[\"$TMP/flaky.mjs\"],\"trusted\":true}" "$BASE/api/sources")" "add an mcp source to patch"
PR="$(curl -s -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"mv-mcp\",\"path\":\"$TMP/to-here\"}" "$BASE/api/sources")"
code 400 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"mv-mcp\",\"path\":\"$TMP/to-here\"}" "$BASE/api/sources")" "an mcp source refuses a path patch"
grep -q 'command' <<<"$PR" && pass "the mcp refusal names the command" || fail "mcp refusal copy ($PR)"
code 200 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"mv-mcp","newName":"mv-mcp2","level":1}' "$BASE/api/sources")" "rename/re-level still works on a kind that refuses paths"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=mv-mcp2")" "cleanup the mcp source"

# A clone-backed layer reads layer.path but SYNCS into .cache/repos/<slug>.
# Repointing it would leave a source that reads one folder and pulls into
# another, so it is refused even though its kind is okf-local.
mkdir -p "$CLONE"
printf -- '---\ntype: note\ntitle: C\n---\n\n# C\n\n## S {#s}\n\nclone doc.\n' > "$CLONE/c.md"
node -e '
  const fs = require("node:fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  (m.profiles?.default?.layers ?? m.layers).push(
    { name: "cl3", level: 1, path: ".cache/repos/github.com__o__gh1", origin: "https://github.com/o/gh1.git", ref: null },
  );
  fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2) + "\n");
' "$TMP/manifest.json"
PR="$(curl -s -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"cl3\",\"path\":\"$TMP/to-here\"}" "$BASE/api/sources")"
code 400 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"cl3\",\"path\":\"$TMP/to-here\"}" "$BASE/api/sources")" "a clone-backed source refuses a path patch"
grep -q 'Sync' <<<"$PR" && pass "the clone refusal points at Sync" || fail "clone refusal copy ($PR)"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=cl3")" "cleanup the clone-backed layer"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE/api/sources?name=movable")" "cleanup the repointed source"
[ -f "$TMP/to-here/new-home.md" ] && pass "repointing never touches either folder" || fail "path patch touched user files"

echo "allowMutations: false (token unset)"
code 200 "$(C "$BASE2/api/graph")" "reads work with no header when token unset"
code 405 "$(C -X POST -H 'content-type: application/json' -d '{}' "$BASE2/api/sources")" "POST /api/sources returns 405"
code 405 "$(C -X PATCH -H 'content-type: application/json' -d '{}' "$BASE2/api/sources")" "PATCH /api/sources returns 405"
code 405 "$(C -X DELETE "$BASE2/api/sources?name=t")" "DELETE /api/sources returns 405"
code 405 "$(C -X POST "$BASE2/api/sources/sync?name=t")" "POST /api/sources/sync returns 405"
grep -q '"t"' "$TMP/manifest2.json" && pass "manifest untouched by blocked mutations" || fail "manifest mutated despite 405"
FT="$(curl -s "$BASE2/nope")"
grep -q host-fallthrough <<<"$FT" && pass "fall-through works on this host too" || fail "fall-through host2 ($FT)"

# ---- the memoized /api/graph, and the cheap route that replaces polling it ----
#
# /api/graph answers the expensive half of its payload from a memo, and counts
# most concepts from numbers the index already computed. Both are keyed by
# snapshot identity read live at request time rather than cleared by an
# invalidation event — so the thing worth testing is not that the cache is fast
# but that it CANNOT go stale. Every way the answer can change gets its own
# assertion: a file edited through the API, a file edited behind the app's back,
# a source added, removed, renamed, and an indexing setting changed.
#
# Its own host on its own manifest: by this point the shared host carries a
# deliberately unreachable github layer, whose health flaps and would make
# "nothing changed" untestable.
echo "cached /api/graph: cheap to repeat, impossible to serve stale"
mkdir -p "$TMP/gc/a" "$TMP/gc/b"
# `solo` exists in one layer (answered from the index's own per-concept count);
# `shared` is defined by both (a real merge, answered from the resolved cache).
printf -- '---\ntype: note\ntitle: Solo\nupdated: 2026-07-01\n---\n\n# Solo\n\n## Body {#body}\n\nalpha.\n' > "$TMP/gc/a/solo.md"
printf -- '---\ntype: note\ntitle: Shared\nupdated: 2026-07-01\n---\n\n# Shared\n\n## Body {#body}\n\nfrom a.\n' > "$TMP/gc/a/shared.md"
printf -- '---\ntype: note\ntitle: Shared\nupdated: 2026-07-02\n---\n\n# Shared\n\n## Body {#body}\n\nfrom b.\n' > "$TMP/gc/b/shared.md"
cat > "$TMP/manifest4.json" <<EOF
{ "layers": [
    { "name": "a", "level": 1, "source": "files", "path": "$TMP/gc/a" },
    { "name": "b", "level": 2, "source": "files", "path": "$TMP/gc/b" }
  ] }
EOF
node "$TMP/host.mjs" "$PORT4" "$TMP/manifest4.json" sekrit true - >/dev/null 2>&1 &
PID4=$!
for _ in $(seq 1 60); do curl -sf "${AUTH[@]}" "$BASE4/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done

G4() { curl -s "${AUTH[@]}" "$BASE4/api/graph?wait=15000"; }
TOK4() { G4 | JQ "String((d.concepts.find((c) => c.id === '$1') ?? {}).tokens)"; }
GEN4() { curl -s "${AUTH[@]}" "$BASE4/api/status" | JQ 'String(d.generation)'; }
# What the cascade would answer with no cache at all: resolve every concept from
# live sources and encode it from scratch. Every token assertion below is against
# THIS, not against a previous cached answer — a cache that agreed only with
# itself would pass a self-comparison forever.
EXPECT4() { node --input-type=module -e "
import fs from 'node:fs';
import { buildSources } from '$ROOT/packages/core/src/sources/index.mjs';
import { resolveConcept } from '$ROOT/packages/core/src/resolver.mjs';
import { conceptText, countTokens } from '$ROOT/packages/core/src/tokenize.mjs';
const manifest = JSON.parse(fs.readFileSync('$TMP/manifest4.json', 'utf8'));
const sources = buildSources(manifest, '$TMP');
const ids = [...new Set((await Promise.all(sources.map((s) => s.listConceptIds()))).flat())].sort();
const rows = [];
for (const id of ids) rows.push([id, countTokens(conceptText(await resolveConcept(id, sources)))]);
for (const s of sources) s.close?.();
console.log(JSON.stringify(rows));
"; }
GRAPHTOK4() { G4 | JQ 'JSON.stringify(d.concepts.map((c) => [c.id, c.tokens]).sort((x, y) => x[0] < y[0] ? -1 : 1))'; }

[ "$(GRAPHTOK4)" = "$(EXPECT4)" ] \
  && pass "every concept's token count matches a from-scratch encode (single-layer and merged)" \
  || fail "cached token counts diverge from a live resolve (graph=$(GRAPHTOK4) live=$(EXPECT4))"
SUM4="$(G4 | JQ 'String(d.totals.resolvedTokens === d.concepts.reduce((n, c) => n + c.tokens, 0))')"
[ "$SUM4" = "true" ] && pass "totals.resolvedTokens is the sum of the rows it reports" || fail "resolvedTokens does not sum its own rows"

# A settled index has nothing left to move, so two calls must be byte-identical
# — including elapsedMs, which stops at the moment the job finished.
A1="$(G4)"; A2="$(G4)"
[ "$A1" = "$A2" ] && pass "two /api/graph calls at a settled index are byte-identical" || fail "the graph payload drifts between identical calls"
[ "$(GEN4)" = "$(GEN4)" ] && pass "generation holds still while nothing changes" || fail "generation moves with no state change"

S4="$(curl -s "${AUTH[@]}" "$BASE4/api/status")"
[ "$(JQ 'JSON.stringify([typeof d.generation, d.indexing, d.indexingSources.length, d.sources.map((s) => [s.name, s.status, s.phase, s.loaded, s.total, s.conceptCount])])' <<<"$S4")" \
  = '["number",false,0,[["a","ok","ready",2,2,2],["b","ok","ready",1,1,1]]]' ] \
  && pass "/api/status reports index progress per source without touching a concept" || fail "/api/status shape ($S4)"
[ "$(JQ 'String("concepts" in d || d.sources.some((s) => "tokens" in s))' <<<"$S4")" = "false" ] \
  && pass "/api/status carries no corpus-sized payload" || fail "/api/status leaked corpus data ($S4)"
code 200 "$(C "$BASE2/api/status")" "/api/status is a read route (answers with mutations disabled)"
code 401 "$(C "$BASE4/api/status")" "/api/status is behind the same bearer gate"

echo "  invalidation: a write through the API"
GEN_BEFORE="$(GEN4)"
SOLO_BEFORE="$(TOK4 solo)"
MT4="$(curl -s "${AUTH[@]}" "$BASE4/api/file?path=a/solo.md" | JQ 'd.modified')"
code 200 "$(C -X PUT "${AUTH[@]}" -H 'content-type: application/json' -d "{\"path\":\"a/solo.md\",\"text\":\"---\\ntype: note\\ntitle: Solo\\nupdated: 2026-07-01\\n---\\n\\n# Solo\\n\\n## Body {#body}\\n\\nalpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi.\\n\",\"modified\":\"$MT4\"}" "$BASE4/api/file")" "edit a file in an indexed layer"
[ "$(GRAPHTOK4)" = "$(EXPECT4)" ] && pass "the graph reflects the edit (token counts match a fresh encode)" || fail "the graph served a stale token count after an edit (graph=$(GRAPHTOK4) live=$(EXPECT4))"
[ "$(TOK4 solo)" != "$SOLO_BEFORE" ] && pass "the edited concept's count actually moved ($SOLO_BEFORE -> $(TOK4 solo))" || fail "the edited concept's count did not change"
[ "$(GEN4)" != "$GEN_BEFORE" ] && pass "generation moved on the edit" || fail "generation did not move on an edit"

echo "  invalidation: a write behind the app's back (watcher)"
printf -- '---\ntype: note\ntitle: Outside\nupdated: 2026-07-03\n---\n\n# Outside\n\n## Body {#body}\n\nwritten by another program entirely.\n' > "$TMP/gc/a/outside.md"
for _ in $(seq 1 60); do [ "$(G4 | JQ 'String(d.concepts.some((c) => c.id === "outside"))')" = "true" ] && break; sleep 0.25; done
[ "$(G4 | JQ 'String(d.concepts.some((c) => c.id === "outside"))')" = "true" ] \
  && pass "a file written outside the app reaches the graph" || fail "an externally written file never reached the cached graph"
[ "$(GRAPHTOK4)" = "$(EXPECT4)" ] && pass "counts still match a fresh encode after the external write" || fail "stale counts after an external write"

echo "  invalidation: sources added, removed, renamed"
mkdir -p "$TMP/gc/c"
printf -- '---\ntype: note\ntitle: Shared\nupdated: 2026-07-04\n---\n\n# Shared\n\n## Body {#body}\n\nfrom c, which is longer than either of the other two answers.\n' > "$TMP/gc/c/shared.md"
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"c\",\"level\":3,\"path\":\"$TMP/gc/c\"}" "$BASE4/api/sources")" "add a third layer over the merged concept"
[ "$(G4 | JQ 'd.concepts.find((c) => c.id === "shared").winner')" = "c" ] && pass "the new layer wins the merged concept" || fail "the added layer did not take the merge"
[ "$(GRAPHTOK4)" = "$(EXPECT4)" ] && pass "counts match a fresh encode after an add" || fail "stale counts after a source add (graph=$(GRAPHTOK4) live=$(EXPECT4))"
code 200 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"c","newName":"c2","level":3}' "$BASE4/api/sources")" "rename the new layer"
[ "$(G4 | JQ 'd.concepts.find((c) => c.id === "shared").winner')" = "c2" ] && pass "the rename reaches the concept rows" || fail "the cached rows kept the old layer name"
[ "$(GRAPHTOK4)" = "$(EXPECT4)" ] && pass "counts survive a rename (names are not part of merged text)" || fail "stale counts after a rename"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE4/api/sources?name=c2")" "remove the third layer"
[ "$(G4 | JQ 'd.concepts.find((c) => c.id === "shared").winner')" = "b" ] && pass "the removal hands the merge back" || fail "the cached rows kept a removed layer"
[ "$(GRAPHTOK4)" = "$(EXPECT4)" ] && pass "counts match a fresh encode after a remove" || fail "stale counts after a source remove"

echo "  invalidation: an indexing setting change"
# A layer big enough to be refused by a lowered document cap, so the re-index a
# settings change forces is observable rather than inferred: the cap is a
# setting, not layer config, so nothing in the manifest's layer JSON moves.
mkdir -p "$TMP/gc/d"
node -e 'const fs=require("node:fs");for(let i=0;i<120;i++)fs.writeFileSync(`${process.argv[1]}/n${i}.md`,`# N${i}\n\n## Body\n\nbulk ${i}.\n`)' "$TMP/gc/d"
code 200 "$(C -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"d\",\"level\":0,\"path\":\"$TMP/gc/d\"}" "$BASE4/api/sources")" "add a 120-document layer"
for _ in $(seq 1 60); do [ "$(G4 | JQ 'String(d.sources.find((s) => s.name === "d").conceptCount)')" = "120" ] && break; sleep 0.25; done
GEN_BEFORE="$(GEN4)"
code 200 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d '{"maxDocFiles":100}' "$BASE4/api/settings")" "lower maxDocFiles below that layer's size"
for _ in $(seq 1 60); do [ "$(G4 | JQ 'String(d.sources.find((s) => s.name === "d").status)')" = "error" ] && break; sleep 0.25; done
[ "$(G4 | JQ 'String(d.sources.find((s) => s.name === "d").status)')" = "error" ] \
  && pass "the settings change re-indexed rather than serving the old snapshot" || fail "a settings change left the previous index in place"
[ "$(GEN4)" != "$GEN_BEFORE" ] && pass "generation moved on the settings change" || fail "generation did not move on a settings change"
code 200 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d '{"maxDocFiles":10000}' "$BASE4/api/settings")" "restore the limit"
for _ in $(seq 1 60); do [ "$(G4 | JQ 'String(d.sources.find((s) => s.name === "d").status)')" = "ok" ] && break; sleep 0.25; done
[ "$(GRAPHTOK4)" = "$(EXPECT4)" ] && pass "counts match a fresh encode once the limit is restored" || fail "stale counts after settings were restored"

echo "repairing a manifest from the app: an invalid layer can be removed"
# Quarantine made a bad layer visible. This is the other half: it has to be
# fixable from the same app that shows it. The write stays strict — what these
# assertions pin is that the way IN tolerates a bad layer while the way OUT
# still refuses to persist one.
mkdir -p "$TMP/seedq"
printf '# Seed\n\n## Body\n\nquarantine fixture.\n' > "$TMP/seedq/seed.md"
cat > "$TMP/manifest-bad.json" <<EOF
{ "layers": [
    { "name": "seed", "level": 1, "source": "files", "path": "$TMP/seedq" },
    { "name": "bad-kind", "level": 2, "source": "notarealkind" },
    { "name": "seed", "level": 9, "source": "alsonotreal" },
    { "level": 4 }
  ] }
EOF
node "$TMP/host.mjs" "$PORT5" "$TMP/manifest-bad.json" sekrit true - >/dev/null 2>&1 &
PID5=$!
for _ in $(seq 1 60); do [ "$(C "${AUTH[@]}" "$BASE5/api/graph")" != "000" ] && break; sleep 0.1; done
BADG="$(curl -s "${AUTH[@]}" "$BASE5/api/graph?wait=15000")"
[ "$(JQ 'JSON.stringify(d.sources.map((s) => [s.name, s.status, s.quarantined === true]))' <<<"$BADG")" \
  = '[["seed","ok",false],["bad-kind","error",true],["seed (2)","error",true],["layer 4","error",true]]' ] \
  && pass "invalid entries are rows of their own, flagged quarantined, and never shadow the healthy layer" \
  || fail "quarantined rows wrong ($(JQ 'JSON.stringify(d.sources.map((s) => [s.name, s.status, s.quarantined]))' <<<"$BADG"))"

# One of three cannot be removed: the remaining two still fail validation, and
# a manifest that does not validate is never written. The refusal has to name
# what is blocking it, or the user is stuck with no way forward.
ONE="$(curl -s -o "$TMP/one.json" -w '%{http_code}' -X DELETE "${AUTH[@]}" "$BASE5/api/sources?name=bad-kind")"
code 409 "$ONE" "removing one of three invalid entries is refused"
grep -q '2 other sources are also invalid' "$TMP/one.json" && pass "the refusal names how many others block it" || fail "refusal message unhelpful ($(cat "$TMP/one.json"))"
grep -q 'notarealkind' "$TMP/manifest-bad.json" && pass "the refused removal left the manifest untouched" || fail "a refused removal edited the manifest"

# Settings are a strict write and stay one — but the answer has to point at the
# repair rather than dropping a layer validation error on the Settings screen.
SET="$(curl -s -o "$TMP/set.json" -w '%{http_code}' -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d '{"maxDocFiles":222}' "$BASE5/api/settings")"
code 409 "$SET" "settings cannot be saved while a source is invalid"
grep -q 'Remove it in Sources first' "$TMP/set.json" && pass "the settings refusal points at the screen that fixes it" || fail "settings refusal unhelpful ($(cat "$TMP/set.json"))"

# All three together is a repair, so it lands.
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE5/api/sources?name=bad-kind&name=seed%20(2)&name=layer%204")" "removing every invalid entry at once succeeds"
code 200 "$(C -X PATCH "${AUTH[@]}" -H 'content-type: application/json' -d '{"maxDocFiles":222}' "$BASE5/api/settings")" "settings save once the manifest is valid"
node -e '
  const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const names = m.layers.map((l) => l.name);
  process.stdout.write(JSON.stringify([names, m.layers.length, m.settings?.maxDocFiles]));
' "$TMP/manifest-bad.json" > "$TMP/after.json"
[ "$(cat "$TMP/after.json")" = '[["seed"],1,222]' ] \
  && pass "only the invalid entries were removed — the healthy same-named layer survived" \
  || fail "manifest after repair is wrong ($(cat "$TMP/after.json"))"
[ "$(curl -s "${AUTH[@]}" "$BASE5/api/graph?wait=15000" | JQ 'String(d.sources.find((s) => s.name === "seed")?.conceptCount)')" = "1" ] \
  && pass "the surviving layer still resolves after the repair" || fail "the repair damaged the healthy layer"
code 404 "$(C -X DELETE "${AUTH[@]}" "$BASE5/api/sources?name=ghost")" "a name that is neither a layer nor a quarantined row is still 404"
code 400 "$(C -X DELETE "${AUTH[@]}" "$BASE5/api/sources")" "DELETE with no name is still 400"

# An invalid entry blocks removing a HEALTHY source too — the write rewrites the
# whole manifest either way. So the same one-request repair has to accept a mix,
# or a user with a bad layer cannot remove anything at all.
cat > "$TMP/manifest-bad.json" <<EOF
{ "settings": { "maxDocFiles": 222 },
  "layers": [
    { "name": "seed", "level": 1, "source": "files", "path": "$TMP/seedq" },
    { "name": "extra", "level": 2, "source": "files", "path": "$TMP/seedq" },
    { "name": "late-bad", "level": 3, "source": "notarealkind" }
  ] }
EOF
code 409 "$(C -X DELETE "${AUTH[@]}" "$BASE5/api/sources?name=extra")" "removing a healthy source is refused while an entry is invalid"
code 200 "$(C -X DELETE "${AUTH[@]}" "$BASE5/api/sources?name=extra&name=late-bad")" "a healthy source and an invalid entry come out together"
[ "$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).layers.map((l) => l.name)))' "$TMP/manifest-bad.json")" = '["seed"]' ] \
  && pass "the mixed removal left exactly the untouched layer" || fail "mixed removal wrong ($(cat "$TMP/manifest-bad.json"))"

echo "injected credentials: reported, never echoed"
# The engine receives secrets by value from whoever owns the keychain. Two
# things have to hold at once: the credential must actually reach the adapter,
# and it must never come back out of an HTTP response. A source that names a
# credential it did not get has to say so — otherwise a withheld token is
# indistinguishable from an empty repo.
cat > "$TMP/creds.mjs" <<'EOF'
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { createEngineService } = await import(pathToFileURL(process.env.SERVICE_MJS).href);

const dir = process.argv[2];
const SECRET = "gh" + "u_" + "S".repeat(36);

// A stand-in GitHub API that answers just enough to index one document.
const FILE = "---\ntype: note\ntitle: Remote\nupdated: 2026-07-01\n---\n\n# Remote\n\n## S {#s}\n\nremote body.\n";
let sawAuth = null;
const api = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  sawAuth = req.headers.authorization ?? sawAuth;
  const json = (c, b) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (url.pathname === "/repos/acme/kb") return json(200, { default_branch: "main", pushed_at: "2026-07-20T12:00:00Z" });
  if (url.pathname.startsWith("/repos/acme/kb/git/trees/")) {
    return json(200, { truncated: false, tree: [{ path: "README.md", type: "blob", size: FILE.length }] });
  }
  if (url.pathname === "/repos/acme/kb/commits") return json(200, []);
  if (url.pathname.startsWith("/repos/acme/kb/contents/")) {
    res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(FILE) });
    return res.end(FILE);
  }
  return json(404, { message: "Not Found" });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const apiHost = "127.0.0.1:" + api.address().port;
const apiBase = "http://" + apiHost;

const manifestPath = path.join(dir, "creds-manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify({
  layers: [{ name: "remote", level: 2, source: "github", repo: "acme/kb", apiBase, auth: "keychain:github.com/octo" }],
}));

const svc = createEngineService({
  manifestPath,
  tokens: { "github.com/octo": { secret: SECRET, host: apiHost } },
});
const server = http.createServer(async (req, res) => {
  if (await svc.handleRequest(req, res)) return;
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

const graph = async () => (await fetch(base + "/api/graph?wait=4000")).text();
const bound = await graph();
const boundSource = JSON.parse(bound).sources.find((s) => s.name === "remote");

// Take the token away; the same layer must degrade loudly, not silently.
svc.setTokens({});
const unbound = await graph();
const unboundSource = JSON.parse(unbound).sources.find((s) => s.name === "remote");

svc.close(); server.close(); api.close();
console.log(JSON.stringify({
  reachedAdapter: sawAuth === "Bearer " + SECRET,
  leakedBound: bound.includes(SECRET),
  leakedUnbound: unbound.includes(SECRET),
  boundState: boundSource?.authState,
  boundAlias: boundSource?.authAlias,
  boundIndexed: (boundSource?.conceptCount ?? 0) > 0,
  unboundState: unboundSource?.authState,
}));
EOF
CRED="$(node "$TMP/creds.mjs" "$TMP" 2>/dev/null)"
grep -q '"reachedAdapter":true' <<<"$CRED" && pass "injected credential reaches the adapter as a bearer" || fail "credential did not reach adapter ($CRED)"
grep -q '"leakedBound":false' <<<"$CRED" && pass "the secret appears nowhere in /api/graph" || fail "SECRET LEAKED in graph payload ($CRED)"
grep -q '"leakedUnbound":false' <<<"$CRED" && pass "the secret stays absent after setTokens" || fail "SECRET LEAKED after setTokens ($CRED)"
grep -q '"boundState":"ok"' <<<"$CRED" && pass "a satisfied credential reports authState ok" || fail "authState not ok ($CRED)"
grep -q '"boundAlias":"github.com/octo"' <<<"$CRED" && pass "the alias (a name, not a secret) is reported" || fail "authAlias missing ($CRED)"
grep -q '"boundIndexed":true' <<<"$CRED" && pass "the credentialed layer actually indexed" || fail "credentialed layer did not index ($CRED)"
grep -q '"unboundState":"missing-token"' <<<"$CRED" && pass "setTokens re-indexes and reports the now-missing credential" || fail "setTokens did not invalidate ($CRED)"

echo "a /api/graph payload and its generation describe the same instant"
# The field report this gates: "a source I added shows 0 concepts forever."
# buildGraph read its source rows before awaiting the resolve and computed
# `generation` after it, so a source whose index landed during that await
# arrived in the number while its rows still said "indexing, 0 concepts". The
# console stored that generation, the next /api/status computed the identical
# one, `moved` stayed false, and the refetch that would have shown the landed
# source was never issued. The payload latched.
#
# Driven in-process because the window has to be entered on purpose. A remote
# layer is held at its very first API call until the /api/graph request lands,
# which puts every one of its remaining round trips inside the resolve — that
# loop yields to the event loop every 25 concepts, and the local layer is sized
# to give it far more turns than the remote layer needs to finish.
cat > "$TMP/pinned-generation.mjs" <<'EOF'
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { createEngineService } = await import(pathToFileURL(process.env.SERVICE_MJS).href);

const dir = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One attempt: a local layer of `concepts` documents plus a gated remote one.
async function attempt(concepts) {
  const fastRoot = path.join(dir, `pin-fast-${concepts}`);
  fs.mkdirSync(fastRoot, { recursive: true });
  for (let i = 0; i < concepts; i++) {
    fs.writeFileSync(
      path.join(fastRoot, `n${i}.md`),
      `---\ntype: note\ntitle: N${i}\nupdated: 2026-07-01\n---\n\n# N${i}\n\n## Body {#body}\n\nbody ${i}\n`,
    );
  }

  // Stands in for api.github.com. The repo-metadata call — the adapter's first
  // — blocks until this test releases it.
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  const api = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/repos/o/r") { await gate; return json({ default_branch: "main", pushed_at: "2026-07-20T12:00:00Z" }); }
    if (url.pathname === "/repos/o/r/git/trees/main") return json({ truncated: false, tree: [{ path: "README.md", type: "blob", size: 40 }] });
    if (url.pathname === "/repos/o/r/commits") return json([{ commit: { committer: { date: "2026-06-01T00:00:00Z" } } }]);
    if (url.pathname === "/repos/o/r/contents/README.md") {
      const body = "# Remote\n\n## Body\n\nremote body.\n";
      res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
      return res.end(body);
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));

  const manifestPath = path.join(dir, `pin-manifest-${concepts}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify({ layers: [
    { name: "fast", level: 1, path: fastRoot },
    { name: "remote", level: 2, source: "github", repo: "o/r", apiBase: `http://127.0.0.1:${api.address().port}`, paths: ["README.md"] },
  ] }));

  const svc = createEngineService({ manifestPath, allowMutations: false });
  let armed = false;
  const server = http.createServer(async (req, res) => {
    // Released before the request is handled, so the pin cannot see it: a
    // socket read needs a poll-phase turn, and buildGraph reaches its await
    // inside this one.
    if (armed && req.url.startsWith("/api/graph")) { armed = false; release(); }
    if (await svc.handleRequest(req, res)) return;
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();

  // /api/status only — asking /api/graph here would warm the resolve memo and
  // there would be no await left to land inside.
  let staged = false;
  for (let i = 0; i < 200 && !staged; i++) {
    const s = await get("/api/status");
    const fast = s.sources.find((x) => x.name === "fast");
    const remote = s.sources.find((x) => x.name === "remote");
    staged = fast?.status === "ok" && remote?.status === "indexing";
    if (!staged) await sleep(50);
  }

  armed = true;
  const g = await get("/api/graph");
  const s = await get("/api/status");
  const gr = g.sources.find((x) => x.name === "remote");
  const sr = s.sources.find((x) => x.name === "remote");
  svc.close(); server.close(); api.close();
  release();
  return {
    concepts, staged,
    // The remote layer was still unread when the rows were built, and had
    // landed by the time the response was read: the response spans the window.
    windowHit: staged && gr.status === "indexing" && gr.conceptCount === 0 && sr.status === "ok" && sr.conceptCount > 0,
    moved: g.generation !== s.generation,
    rowProgressStatus: gr.indexing.status,
    rowProgressPhase: gr.indexing.phase,
    topLevelIndexing: g.indexing === true && g.indexingSources.includes("remote"),
    observed: { graph: [gr.status, gr.conceptCount], status: [sr.status, sr.conceptCount] },
  };
}

let out = null;
// A second, larger attempt only if the first could not enter the window — a
// bigger local corpus buys the resolve more event-loop turns to land in.
for (const concepts of [1500, 4500]) {
  out = await attempt(concepts);
  if (out.windowHit) break;
}
console.log(JSON.stringify(out));
EOF
PIN="$(node "$TMP/pinned-generation.mjs" "$TMP" 2>&1 | tail -1)"
if grep -q '"windowHit":true' <<<"$PIN"; then
  pass "the window was entered: the remote layer landed during the graph build"
  grep -q '"moved":true' <<<"$PIN" \
    && pass "the generation names the payload returned, not the state that landed during it" \
    || fail "LATCHED: /api/graph returned a stale payload under a generation /api/status already agrees with, so a client would never refetch ($PIN)"
  grep -q '"rowProgressStatus":"indexing"' <<<"$PIN" \
    && pass "a source row's progress agrees with its own status" \
    || fail "a single source row reports status indexing and progress ready at once ($PIN)"
  grep -q '"topLevelIndexing":true' <<<"$PIN" \
    && pass "the top-level indexing flag agrees with the rows below it" \
    || fail "the payload names a source as indexing while claiming nothing is ($PIN)"
else
  fail "could not enter the window this assertion needs — the remote layer did not land during the graph build, so nothing below was actually gated ($PIN)"
fi

[ "$FAILED" = 0 ] && echo "service test passed (bearer gate + allowMutations + fall-through + CRUD reload + console mount + github-rest + v2 reads + mcp health + clone cleanup + section guard + credential injection + graph-cache freshness + /api/status + pinned generation + quarantine repair)" || { echo "service test FAILED"; exit 1; }
