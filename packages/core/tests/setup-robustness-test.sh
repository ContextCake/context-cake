#!/usr/bin/env bash
# Setup robustness tests: the app must stay usable while it indexes.
#
# The contract this locks in:
#   - adding a source returns immediately, whatever its size
#   - /api/graph and /api/resolve-all answer from what is indexed SO FAR and
#     report what is still running — no request ever waits for a slow source
#   - a folder too big for the configured limits becomes a visible source
#     error, not a rejected form and not a hang
#   - the limits are settings (manifest-backed, /api/settings), not env-only
#   - the layer file explorer/editor is engine surface, so the desktop app has
#     it, and it covers markdown-folder layers too
#
# Network-free. Run from the repo root.
set -uo pipefail

PORT="${SETUP_PORT:-8821}"   # tight caps via env: add-validation, over-cap, files, MCP
PORT2=$((PORT + 1))          # default caps: responsiveness + wait= + equivalence
PORT3=$((PORT + 2))          # default caps: settings API and its effect on indexing
BASE="http://127.0.0.1:$PORT"
BASE2="http://127.0.0.1:$PORT2"
BASE3="http://127.0.0.1:$PORT3"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC="$ROOT/packages/core/src"
TMP="$(mktemp -d)"
PIDS=()
FAILED=0

cleanup() {
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILED=1; }
code() { [ "$2" = "$1" ] && pass "$3 ($2)" || fail "$3 (got $2, want $1)"; }
C() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# Milliseconds a request took, from curl itself (no node startup in the number).
ms() { curl -s -o /dev/null -w '%{time_total}' "$@" | awk '{printf "%d", $1 * 1000}'; }
faster_than() { [ "$1" -lt "$2" ] && pass "$3 (${1}ms)" || fail "$3 (${1}ms, want < ${2}ms)"; }
# Poll until one named source has finished indexing. /api/resolve is NOT a
# readiness signal — it reads live sources, so it answers before the index
# lands. Only the graph reports index state.
await_source_ready() {
  for _ in $(seq 1 200); do
    [ "$(curl -s "$1/api/graph" | JQ "d.sources.find((s) => s.name === \"$2\")?.status")" = "ok" ] && return 0
    sleep 0.05
  done
  return 1
}
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

echo "bounded walk (walkDocs caps + honest errors)"

mkdir -p "$TMP/many" "$TMP/wide"
node -e '
  const fs = require("node:fs");
  for (let i = 0; i < 30; i++) fs.writeFileSync(`${process.argv[1]}/many/doc-${i}.md`, "# D\n\ntext\n");
  for (let i = 0; i < 60; i++) fs.writeFileSync(`${process.argv[1]}/wide/junk-${i}.bin`, "x");
' "$TMP"

OUT="$(node --input-type=module -e "
import { walkDocs, probeDocs } from '$SRC/sources/okf-local.mjs';
try { await walkDocs('$TMP/many', ['.md'], { maxFiles: 5 }); console.log('NO-ERROR'); }
catch (e) { console.log(e.message); }
try { await walkDocs('$TMP/wide', ['.md'], { maxEntries: 10 }); console.log('NO-ERROR'); }
catch (e) { console.log(e.message); }
console.log(JSON.stringify(await walkDocs('$TMP/many', ['.md'])));
// probeDocs is the add-form check: bounded, first-hit, and it never throws on size.
console.log('probe-many:' + JSON.stringify(await probeDocs('$TMP/many', ['.md'])));
console.log('probe-wide:' + JSON.stringify(await probeDocs('$TMP/wide', ['.md'])));
")"
grep -q 'too many documents' <<<"$OUT" || fail "file cap should reject with an actionable message ($OUT)"
grep -q 'too large to index' <<<"$OUT" || fail "entry cap should reject with an actionable message ($OUT)"
grep -q 'doc-29' <<<"$OUT" || fail "in-bounds folder should list fully ($OUT)"
grep -q 'too many documents' <<<"$OUT" && grep -q 'too large to index' <<<"$OUT" && grep -q 'doc-29' <<<"$OUT" && pass "walk caps enforced with actionable messages, in-bounds walk complete"
grep -q 'probe-many:{"found":true' <<<"$OUT" && pass "probeDocs finds a document without walking the folder" || fail "probeDocs found ($OUT)"
grep -q 'probe-wide:{"found":false' <<<"$OUT" && pass "probeDocs reports an empty folder honestly" || fail "probeDocs empty ($OUT)"

OUT="$(CONTEXTCAKE_MAX_DOC_FILES=5 node --input-type=module -e "
import { createFilesSource } from '$SRC/sources/files.mjs';
const s = createFilesSource({ name: 'd', level: 2, root: '$TMP/many' });
try { await s.listConceptIds(); console.log('NO-ERROR'); } catch (e) { console.log(e.message); }
")"
grep -q 'too many documents' <<<"$OUT" && pass "env var still works as the pre-UI default" || fail "adapter env cap ($OUT)"

echo "settings module (manifest > env > default)"
OUT="$(CONTEXTCAKE_MAX_DOC_FILES=777 node --input-type=module -e "
import { resolveSettings, validateSettingsPatch } from '$SRC/settings.mjs';
console.log('env:' + resolveSettings({}).maxDocFiles);
console.log('manifest:' + resolveSettings({ settings: { maxDocFiles: 4242 } }).maxDocFiles);
console.log('default:' + resolveSettings({}).maxScanEntries);
console.log('bad-range:' + resolveSettings({ settings: { maxDocFiles: 1 } }).maxDocFiles);
try { validateSettingsPatch({ maxDocFiles: 5 }); console.log('NO-ERROR'); } catch (e) { console.log('range:' + e.message); }
try { validateSettingsPatch({ nope: 5 }); console.log('NO-ERROR'); } catch (e) { console.log('unknown:' + e.message); }
")"
grep -q 'env:777' <<<"$OUT" && pass "env overrides the shipped default" || fail "env precedence ($OUT)"
grep -q 'manifest:4242' <<<"$OUT" && pass "manifest setting beats env (or the settings UI would do nothing)" || fail "manifest precedence ($OUT)"
grep -q 'default:150000' <<<"$OUT" && pass "unset keys fall back to the default" || fail "default ($OUT)"
grep -q 'bad-range:777' <<<"$OUT" && pass "an out-of-range stored value is ignored, not obeyed" || fail "range guard ($OUT)"
grep -q 'range:.*between' <<<"$OUT" && pass "patch validation rejects an out-of-range value" || fail "patch range ($OUT)"
grep -q 'unknown:Unknown setting' <<<"$OUT" && pass "patch validation rejects an unknown key" || fail "patch unknown ($OUT)"
OUT="$(CONTEXTCAKE_MAX_DOC_FILES=999999999 node --input-type=module -e "
import { resolveSettings } from '$SRC/settings.mjs';
console.log(resolveSettings({}).maxDocFiles);
")"
[ "$OUT" = "10000" ] && pass "out-of-range env values fall back safely" || fail "env range guard ($OUT)"

echo "per-source time budget (withDeadline)"
OUT="$(node --input-type=module -e "
import { withDeadline } from '$SRC/service.mjs';
// The deadline timer is unref'd (it must never hold the real service open at
// exit), so a bare script needs its own keepalive to observe the rejection.
const keepalive = setInterval(() => {}, 50);
let cancelled = false;
try { await withDeadline(new Promise(() => {}), 200, 'stalled source', () => { cancelled = true; }); console.log('NO-ERROR'); }
catch (e) { console.log(e.message); }
console.log('cancelled:' + cancelled);
console.log(await withDeadline(Promise.resolve('fast'), 200, 'nope'));
clearInterval(keepalive);
")"
grep -q 'stalled source' <<<"$OUT" && pass "a never-settling source rejects at the deadline" || fail "deadline reject ($OUT)"
grep -q 'cancelled:true' <<<"$OUT" && pass "the deadline cancels underlying indexing work" || fail "deadline cancellation ($OUT)"
grep -q 'fast' <<<"$OUT" && pass "a fast source passes through untouched" || fail "deadline passthrough ($OUT)"

# ---- hosts -------------------------------------------------------------------
mkdir -p "$TMP/vault" "$TMP/empty" "$TMP/home/tilde-vault" "$TMP/notes"
printf -- '---\ntype: note\ntitle: Note\nupdated: 2026-07-01\n---\n\n# Note\n\n## Body {#body}\n\nfrom vault.\n' > "$TMP/vault/note.md"
printf '# Tilde\n\n## Body\n\nfrom home vault.\n' > "$TMP/home/tilde-vault/tilde-note.md"
printf '# Meeting notes\n\n## Decision\n\nShip on Friday.\n' > "$TMP/notes/meeting.md"
cat > "$TMP/manifest.json" <<EOF
{ "layers": [
  { "name": "vault", "level": 3, "path": "$TMP/vault" },
  { "name": "notes", "level": 2, "source": "files", "path": "$TMP/notes" }
] }
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
PIDS+=($!)
for _ in $(seq 1 40); do curl -sf "$BASE/api/graph" >/dev/null 2>&1 && break; sleep 0.1; done

echo "add-time validation: only what the user can fix on the form"
code 400 "$(C -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"missing\",\"level\":3,\"path\":\"$TMP/does-not-exist\"}" "$BASE/api/sources")" "missing folder rejected"
curl -s -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"missing\",\"level\":3,\"path\":\"$TMP/does-not-exist\"}" "$BASE/api/sources" | grep -q 'Folder not found' && pass "missing folder names the path problem" || fail "missing folder message"
code 400 "$(C -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"afile\",\"level\":3,\"path\":\"$TMP/vault/note.md\"}" "$BASE/api/sources")" "a file (not a folder) rejected"
grep -q 'missing\|afile' "$TMP/manifest.json" && fail "rejected source leaked into the manifest" || pass "rejected source never touches the manifest"

ADD="$(curl -s -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"empty\",\"level\":2,\"path\":\"$TMP/empty\"}" "$BASE/api/sources")"
[ "$(JQ 'String(d.hasDocuments)' <<<"$ADD")" = "false" ] && pass "an empty folder is accepted but flagged as holding no documents" || fail "empty hasDocuments ($ADD)"
code 200 "$(C -X DELETE "$BASE/api/sources?name=empty")" "cleanup empty source"

echo "an over-cap folder is added instantly, then reported as a source error"
T="$(ms -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"big\",\"level\":2,\"path\":\"$TMP/many\"}" "$BASE/api/sources")"
faster_than "$T" 2000 "adding an over-cap folder returns immediately instead of rejecting"
G="$(curl -s "$BASE/api/graph?wait=15000")"
[ "$(JQ 'd.sources.find((s) => s.name === "big").status' <<<"$G")" = "error" ] && pass "over-cap source settles into an errored state" || fail "over-cap status ($G)"
JQ 'd.sources.find((s) => s.name === "big").error' <<<"$G" | grep -q 'more specific folder' && pass "the error tells the user what to do" || fail "over-cap message"
[ "$(JQ 'String(d.sources.find((s) => s.name === "vault").conceptCount)' <<<"$G")" = "1" ] && pass "healthy layers keep resolving alongside the errored one" || fail "healthy layer degraded too ($G)"
[ "$(JQ 'String(d.concepts.some((c) => c.id === "note"))' <<<"$G")" = "true" ] && pass "concepts from healthy layers still appear" || fail "concepts missing ($G)"
code 200 "$(C -X DELETE "$BASE/api/sources?name=big")" "cleanup over-cap source"

echo "tilde paths expand to the real home directory"
ADD="$(curl -s -X POST -H 'content-type: application/json' -d '{"kind":"files","name":"tilde","level":3,"path":"~/tilde-vault"}' "$BASE/api/sources")"
[ "$(JQ 'String(d.hasDocuments)' <<<"$ADD")" = "true" ] && pass "~/folder validates against the expanded path" || fail "tilde add ($ADD)"
grep -q '"~/tilde-vault"' "$TMP/manifest.json" && fail "manifest kept the literal ~" || pass "manifest stores the expanded path"
curl -s "$BASE/api/resolve?concept=tilde-note" | grep -q 'from home vault' && pass "tilde source resolves" || fail "tilde resolve"
code 200 "$(C -X DELETE "$BASE/api/sources?name=tilde")" "cleanup tilde source"

echo "add-time MCP probe (wrong command fails the form in bounded time)"
UNTRUSTED="$(curl -s -X POST -H 'content-type: application/json' -d '{"kind":"mcp","name":"untrusted","level":0,"command":"node"}' "$BASE/api/sources")"
JQ 'd.error' <<<"$UNTRUSTED" | grep -q 'trusted source' && pass "MCP mutation requires explicit trust" || fail "MCP trust acknowledgement missing ($UNTRUSTED)"
T="$(ms -X POST -H 'content-type: application/json' -d '{"kind":"mcp","name":"ghost","level":0,"command":"definitely-not-a-real-binary-xyz","trusted":true}' "$BASE/api/sources")"
code 400 "$(C -X POST -H 'content-type: application/json' -d '{"kind":"mcp","name":"ghost","level":0,"command":"definitely-not-a-real-binary-xyz","trusted":true}' "$BASE/api/sources")" "missing binary rejected"
faster_than "$T" 10000 "missing binary fails fast"
code 400 "$(C -X POST -H 'content-type: application/json' -d '{"kind":"mcp","name":"mute","level":0,"command":"sleep","args":["30"],"trusted":true}' "$BASE/api/sources")" "unresponsive command rejected"
grep -Eq 'ghost|mute' "$TMP/manifest.json" && fail "failed MCP probe leaked into the manifest" || pass "failed MCP probes never touch the manifest"
code 200 "$(C -X POST -H 'content-type: application/json' -d "{\"kind\":\"mcp\",\"name\":\"mock\",\"level\":0,\"command\":\"node\",\"args\":[\"$ROOT/examples/mock-mcp-source/server.mjs\"],\"trusted\":true}" "$BASE/api/sources")" "a real MCP server passes the probe"
code 200 "$(C -X DELETE "$BASE/api/sources?name=mock")" "cleanup mcp source"

echo "layer files are engine surface (the desktop app can edit context files)"
F="$(curl -s "$BASE/api/files")"
[ "$(JQ 'String(d.layers.some((l) => l.layer === "vault"))' <<<"$F")" = "true" ] && pass "okf-local layer listed" || fail "vault layer missing ($F)"
# The playground's version only mapped okf-local roots, so markdown folders —
# now the recommended source kind — were invisible in the editor.
[ "$(JQ 'String(d.layers.some((l) => l.layer === "notes"))' <<<"$F")" = "true" ] && pass "markdown-folder layer listed too" || fail "files-kind layer missing ($F)"
[ "$(JQ 'String(d.layers.find((l) => l.layer === "notes").files[0].markdown)' <<<"$F")" = "true" ] && pass "markdown files are flagged for the rendered view" || fail "markdown flag ($F)"
R="$(curl -s "$BASE/api/file?path=notes/meeting.md")"
[ "$(JQ 'String(d.editable)' <<<"$R")" = "true" ] && pass "a markdown file comes back editable" || fail "editable ($R)"
JQ 'd.text' <<<"$R" | grep -q 'Ship on Friday' && pass "file text is returned for editing" || fail "file text ($R)"
SAVE="$(curl -s -X PUT -H 'content-type: application/json' -d "{\"path\":\"notes/meeting.md\",\"text\":\"# Meeting notes\n\n## Decision\n\nShip on Monday.\n\",\"modified\":\"$(JQ 'd.modified' <<<"$R")\"}" "$BASE/api/file")"
[ "$(JQ 'd.layer' <<<"$SAVE")" = "notes" ] && pass "a save identifies the one layer whose index is stale" || fail "save layer ($SAVE)"
grep -q 'Ship on Monday' "$TMP/notes/meeting.md" && pass "the edit reached disk" || fail "edit not written"
curl -s "$BASE/api/resolve?concept=meeting" | grep -q 'Ship on Monday' && pass "the cascade serves the edit immediately" || fail "edit not resolved"
OPEN="$(curl -s "$BASE/api/file?path=notes/meeting.md")"
printf '# Meeting notes\n\n## Decision\n\nExternal edit wins.\n' > "$TMP/notes/meeting.md"
STALE_BODY="{\"path\":\"notes/meeting.md\",\"text\":\"stale editor text\",\"modified\":\"$(JQ 'd.modified' <<<"$OPEN")\"}"
code 409 "$(C -X PUT -H 'content-type: application/json' -d "$STALE_BODY" "$BASE/api/file")" "a stale editor cannot overwrite an external edit"
grep -q 'External edit wins' "$TMP/notes/meeting.md" && pass "the external edit remains intact after the conflict" || fail "stale save overwrote disk"
# Restore the fixture for the indexed-read assertions below. Omitting modified
# remains a supported compatibility path for older playground clients.
code 200 "$(C -X PUT -H 'content-type: application/json' -d "{\"path\":\"notes/meeting.md\",\"text\":\"# Meeting notes\n\n## Decision\n\nShip on Monday.\n\"}" "$BASE/api/file")" "legacy save without a revision remains supported"
code 404 "$(C -X PUT -H 'content-type: application/json' -d '{"path":"notes/brand-new.md","text":"nope"}' "$BASE/api/file")" "the editor refuses to create new files"
code 403 "$(C "$BASE/api/file?path=notes/../../escape.md")" "traversal out of a layer root blocked"
code 404 "$(C "$BASE/api/file?path=nosuchlayer/x.md")" "unknown layer rejected"

echo "an edit reaches the indexed reads, not just the live one"
# The index is a snapshot and the manifest does not change when a file is
# edited, so without explicit invalidation /api/graph and /api/resolve-all
# would serve the pre-edit content forever.
curl -s "$BASE/api/resolve-all?wait=15000" | grep -q 'Ship on Monday' && pass "an in-app edit reaches /api/resolve-all" || fail "in-app edit not indexed"
# Same file changed underneath the app, as if edited in another editor.
printf '# Meeting notes\n\n## Decision\n\nShip on Wednesday.\n' > "$TMP/notes/meeting.md"
for _ in $(seq 1 40); do
  curl -s "$BASE/api/resolve-all?wait=15000" | grep -q 'Ship on Wednesday' && break
  sleep 0.1
done
curl -s "$BASE/api/resolve-all?wait=15000" | grep -q 'Ship on Wednesday' && pass "an external edit is noticed and re-indexed" || fail "external edit not noticed"
printf '# Later note\n\n## Body\n\nAdded outside the app.\n' > "$TMP/notes/later.md"
for _ in $(seq 1 40); do
  curl -s "$BASE/api/graph?wait=15000" | grep -q 'later' && break
  sleep 0.1
done
curl -s "$BASE/api/graph?wait=15000" | grep -q 'later' && pass "a new file appears without restarting" || fail "new file not picked up"

# ---- host B: responsiveness while indexing a large corpus ---------------------
mkdir -p "$TMP/big-corpus"
node -e '
  const fs = require("node:fs");
  const body = "## Section\n\n" + "Plenty of prose in every generated document so the build takes real time. ".repeat(40);
  for (let i = 0; i < 1500; i++) fs.writeFileSync(`${process.argv[1]}/big-corpus/doc-${i}.md`, `# Doc ${i}\n\n${body}`);
' "$TMP"
mkdir -p "$TMP/vault2"
printf -- '---\ntype: note\ntitle: Note\nupdated: 2026-07-02\n---\n\n# Note\n\n## Body {#body}\n\nfrom vault2.\n' > "$TMP/vault2/note.md"
cat > "$TMP/manifest-big.json" <<EOF
{ "layers": [
  { "name": "vault", "level": 3, "path": "$TMP/vault" },
  { "name": "vault2", "level": 2, "path": "$TMP/vault2" },
  { "name": "corpus", "level": 1, "source": "files", "path": "$TMP/big-corpus" }
] }
EOF
node "$TMP/host.mjs" "$PORT2" "$TMP/manifest-big.json" >/dev/null 2>&1 &
PIDS+=($!)
# The two tiny layers index in milliseconds; the 1500-doc corpus takes seconds.
# Wait for the small one so the assertions below describe the real mid-index
# state: some sources usable, one still working.
await_source_ready "$BASE2" vault || fail "vault never finished indexing"

echo "the UI is usable while a large corpus indexes"
# This is the regression the whole change exists for: a graph request with
# 1500 documents still being read must answer immediately and say so.
G="$(curl -s "$BASE2/api/graph")"
T="$(ms "$BASE2/api/graph")"
faster_than "$T" 1500 "/api/graph answers without waiting for the corpus"
[ "$(JQ 'String(d.indexing)' <<<"$G")" = "true" ] && pass "the response says indexing is still running" || fail "indexing flag ($G)"
[ "$(JQ 'd.indexingSources.join(",")' <<<"$G")" = "corpus" ] && pass "it names the source still working" || fail "indexingSources ($G)"
[ "$(JQ 'd.sources.find((s) => s.name === "corpus").indexing.phase' <<<"$G")" != "" ] && pass "per-source progress is reported for a spinner" || fail "progress phase ($G)"
[ "$(JQ 'String(d.concepts.some((c) => c.id === "note"))' <<<"$G")" = "true" ] && pass "already-indexed layers are usable right away" || fail "partial concepts ($G)"
T="$(ms "$BASE2/api/resolve?concept=note")"
faster_than "$T" 1500 "a concept resolves mid-index"
T="$(ms "$BASE2/api/resolve-all")"
faster_than "$T" 3000 "resolve-all answers with what is ready"

echo "indexing completes, and the settled graph is correct"
G="$(curl -s "$BASE2/api/graph?wait=30000")"
[ "$(JQ 'String(d.indexing)' <<<"$G")" = "false" ] && pass "indexing finishes" || fail "still indexing ($G)"
[ "$(JQ 'String(d.sources.find((s) => s.name === "corpus").conceptCount)' <<<"$G")" = "1500" ] && pass "the whole corpus indexed (1500 concepts)" || fail "corpus incomplete ($G)"
# Via files, not argv: a settled resolve-all here carries 1500 concepts, which
# overflows the exec argument limit.
curl -s -o "$TMP/all.json" "$BASE2/api/resolve-all?wait=30000"
curl -s -o "$TMP/one.json" "$BASE2/api/resolve?concept=note"
node -e '
  const fs = require("node:fs");
  const all = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).concepts.find((c) => c.id === "note");
  const one = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (JSON.stringify(all) !== JSON.stringify(one)) { console.error("DIVERGED"); process.exit(1); }
  const sec = one.sections.find((s) => s.key === "body");
  if (sec.sourceLayer !== "vault" || !sec.conflicts || sec.conflicts[0].layer !== "vault2") process.exit(1);
' "$TMP/all.json" "$TMP/one.json" && pass "indexed resolve matches live resolve, conflicts intact" || fail "equivalence (see $TMP/one.json)"

echo "a second source does not re-index the first"
# Adding a source rebuilds the manifest; a finished index must survive that or
# every add would re-read every existing source.
BEFORE="$(curl -s "$BASE2/api/graph" | JQ 'String(d.sources.find((s) => s.name === "corpus").indexing.elapsedMs)')"
# Its own folder: $TMP/notes is mutated by the freshness assertions above, and
# sharing it would make this count depend on test ordering.
mkdir -p "$TMP/extra"
printf '# Extra\n\n## Body\n\nOne document.\n' > "$TMP/extra/only.md"
code 200 "$(C -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"extra\",\"level\":0,\"path\":\"$TMP/extra\"}" "$BASE2/api/sources")" "add a second source"
G="$(curl -s "$BASE2/api/graph?wait=15000")"
AFTER="$(JQ 'String(d.sources.find((s) => s.name === "corpus").indexing.elapsedMs)' <<<"$G")"
[ "$BEFORE" = "$AFTER" ] && pass "the existing corpus index was reused, not rebuilt" || fail "corpus re-indexed on add ($BEFORE -> $AFTER)"
[ "$(JQ 'String(d.sources.find((s) => s.name === "extra").conceptCount)' <<<"$G")" = "1" ] && pass "the new source indexed on its own" || fail "new source ($G)"

# ---- host C: settings API and its effect -------------------------------------
cat > "$TMP/manifest-settings.json" <<EOF
{ "layers": [ { "name": "vault", "level": 3, "path": "$TMP/vault" } ] }
EOF
node "$TMP/host.mjs" "$PORT3" "$TMP/manifest-settings.json" >/dev/null 2>&1 &
PIDS+=($!)
for _ in $(seq 1 40); do curl -sf "$BASE3/api/settings" >/dev/null 2>&1 && break; sleep 0.1; done

echo "settings are configurable from the app, not just the environment"
S="$(curl -s "$BASE3/api/settings")"
[ "$(JQ 'String(d.settings.maxDocFiles)' <<<"$S")" = "10000" ] && pass "GET /api/settings reports the effective defaults" || fail "settings defaults ($S)"
[ "$(JQ 'String(d.catalog.length >= 3)' <<<"$S")" = "true" ] && pass "the catalog gives the UI labels, help and ranges" || fail "settings catalog ($S)"
JQ 'd.catalog[0].help' <<<"$S" | grep -qi 'folder\|source' && pass "help text is written for a person, not a config file" || fail "settings help ($S)"
code 400 "$(C -X PATCH -H 'content-type: application/json' -d '{"maxDocFiles":1}' "$BASE3/api/settings")" "a below-range value is rejected"
code 400 "$(C -X PATCH -H 'content-type: application/json' -d '{"nonsense":5}' "$BASE3/api/settings")" "an unknown setting is rejected"
P="$(curl -s -X PATCH -H 'content-type: application/json' -d '{"maxDocFiles":250}' "$BASE3/api/settings")"
[ "$(JQ 'String(d.settings.maxDocFiles)' <<<"$P")" = "250" ] && pass "a valid change is accepted and echoed back" || fail "settings patch ($P)"
grep -q '"maxDocFiles": 250' "$TMP/manifest-settings.json" && pass "the change persists in the manifest" || fail "settings not persisted"

# The point of the setting: it has to actually change indexing behavior.
code 200 "$(C -X POST -H 'content-type: application/json' -d "{\"kind\":\"files\",\"name\":\"corpus\",\"level\":2,\"path\":\"$TMP/big-corpus\"}" "$BASE3/api/sources")" "add the 1500-doc corpus under a 250-doc limit"
G="$(curl -s "$BASE3/api/graph?wait=30000")"
[ "$(JQ 'd.sources.find((s) => s.name === "corpus").status' <<<"$G")" = "error" ] && pass "the corpus exceeds the configured limit and says so" || fail "limit not applied ($G)"
curl -s -X PATCH -H 'content-type: application/json' -d '{"maxDocFiles":5000}' "$BASE3/api/settings" >/dev/null
G="$(curl -s "$BASE3/api/graph?wait=30000")"
[ "$(JQ 'String(d.sources.find((s) => s.name === "corpus").conceptCount)' <<<"$G")" = "1500" ] && pass "raising the limit in settings makes the same source index" || fail "raised limit ($G)"
R="$(curl -s -X PATCH -H 'content-type: application/json' -d '{"maxDocFiles":null}' "$BASE3/api/settings")"
[ "$(JQ 'String(d.settings.maxDocFiles)' <<<"$R")" = "10000" ] && pass "null resets a setting to its default" || fail "settings reset ($R)"
grep -q 'maxDocFiles' "$TMP/manifest-settings.json" && fail "reset left the value in the manifest" || pass "reset removes the stored value"

[ "$FAILED" = 0 ] && echo "setup robustness test passed (bounded walks + settings + background indexing + usable-while-indexing + layer file editing)" || { echo "setup robustness test FAILED"; exit 1; }
