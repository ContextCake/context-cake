#!/usr/bin/env bash
set -euo pipefail

# Proves the team-sync MCP surface: 6 tools read-only / 8 with --capture
# (original 4 byte-identical to the committed baseline), honest server
# instructions, boolean flag parsing, find_captures ranking, whats_new,
# the unreviewed banner, two-phase capture over stdio, content-free
# telemetry, and the team-activity generator.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
core="$repo_root/packages/core/src"
server="$repo_root/packages/core/src/mcp-server.mjs"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
fail() { echo "FAIL: $1" >&2; [ "${2:-}" ] && echo "$2" >&2; exit 1; }

export GIT_CONFIG_GLOBAL="$tmpdir/gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
git config --file "$tmpdir/gitconfig" user.name "Alice Example"
git config --file "$tmpdir/gitconfig" user.email "alice@example.invalid"
git config --file "$tmpdir/gitconfig" init.defaultBranch main

bare="$tmpdir/remote.git"
git init --quiet --bare "$bare"
live="$tmpdir/live"
git clone --quiet "$bare" "$live" 2>/dev/null
( cd "$live" && git commit --quiet --allow-empty -m init && git push --quiet -u origin main )

team="$tmpdir/team"
mkdir -p "$team/decisions"
cat > "$team/decisions/db.md" <<'EOF'
---
type: decision
title: Database
updated: 2026-07-10
---

## Choice {#choice}

SingleStore.
EOF

cat > "$tmpdir/m.json" <<EOF
{ "layers": [
  { "name": "team", "level": 2, "source": "okf-local", "path": "team" },
  { "name": "team-live", "level": 1, "source": "okf-local", "path": "live", "live": true,
    "git": { "pullTtlSeconds": 0, "retentionDays": 14 } }
] }
EOF

rpc() { # rpc <server-args...> -- <json lines...>
  local args=()
  while [ "$1" != "--" ]; do args+=("$1"); shift; done
  shift
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' "$@" \
    | node "$server" "${args[@]}" 2>/dev/null
}

# ---- 6 tools without --capture; original 4 byte-identical to baseline ---------
out="$(rpc --manifest "$tmpdir/m.json" -- '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
node -e "
const fs = require('fs');
const lines = process.argv[1].trim().split('\n');
const init = JSON.parse(lines[0]);
const tools = JSON.parse(lines[1]).result.tools;
const names = tools.map(t => t.name);
if (names.length !== 6) throw new Error('expected 6 tools, got: ' + names.join(','));
for (const n of ['search','read_file','list_concepts','get_links','find_captures','whats_new']) {
  if (!names.includes(n)) throw new Error('missing tool ' + n);
}
const baseline = JSON.parse(fs.readFileSync('$repo_root/packages/core/fixtures/mcp-tools-baseline.json', 'utf8'));
for (const b of baseline) {
  const t = tools.find(x => x.name === b.name);
  if (JSON.stringify({name: t.name, inputSchema: t.inputSchema, annotations: t.annotations}) !== JSON.stringify(b)) {
    throw new Error('original tool drifted: ' + b.name);
  }
}
for (const n of ['find_captures','whats_new']) {
  const t = tools.find(x => x.name === n);
  if (!t.annotations.readOnlyHint) throw new Error(n + ' must be read-only annotated');
}
if (!init.result.instructions.includes('read-only')) throw new Error('read-only claim missing without --capture');
" "$out" || fail "6-tool surface / baseline diff" "$out"

# ---- 8 tools with --capture; honest instructions; flag order permutations ------
for flags in "--capture --manifest $tmpdir/m.json" "--manifest $tmpdir/m.json --capture"; do
  out="$(rpc $flags -- '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
  node -e "
const lines = process.argv[1].trim().split('\n');
const init = JSON.parse(lines[0]);
const tools = JSON.parse(lines[1]).result.tools;
if (tools.length !== 8) throw new Error('expected 8 tools, got ' + tools.map(t=>t.name).join(','));
const lc = tools.find(t => t.name === 'log_capture');
if (lc.annotations.readOnlyHint !== false) throw new Error('log_capture must not claim read-only');
const instr = init.result.instructions;
if (/All (ContextCake )?tools are read-only/.test(instr)) throw new Error('instructions must not claim all-read-only with capture on');
if (!instr.includes('confirm_capture')) throw new Error('instructions must explain the confirm flow');
" "$out" || fail "8-tool surface with flags: $flags" "$out"
done

# ---- --capture without a live layer exits with the manifest hint ----------------
cat > "$tmpdir/m-nolive.json" <<EOF
{ "layers": [ { "name": "team", "level": 2, "source": "okf-local", "path": "team" } ] }
EOF
set +e
err="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node "$server" --capture --manifest "$tmpdir/m-nolive.json" 2>&1 >/dev/null)"
rc=$?
set -e
[ $rc -ne 0 ] || fail "--capture without live layer must exit non-zero"
grep -qi 'live' <<<"$err" || fail "error should mention the live layer" "$err"

# ---- two-phase capture over stdio; unreviewed banner; ranking; whats_new --------
old_iso="$(node -e 'console.log(new Date(Date.now() - 10*86400000).toISOString())')"
mkdir -p "$live/captures/investigation"
cat > "$live/captures/investigation/bob--old-webhook-timeout-fix.md" <<EOF
---
kind: investigation
title: "Old webhook timeout fix: retries everywhere"
author: bob
captured: $old_iso
status: unreviewed
---

# Old webhook timeout fix

## Problem {#problem}

webhook timeout timeout timeout retries.

## Fix {#fix}

Retry with backoff. webhook timeout.
EOF
( cd "$live" && git add -A && git commit -qm "seed old capture" && git push -q )

# two-phase needs the token from the first response — drive interactively
out="$(node -e "
const { spawn } = require('child_process');
const p = spawn('node', ['$server','--capture','--telemetry','--harness','test-harness','--manifest','$tmpdir/m.json']);
let buf = '';
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
const responses = [];
p.stdout.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
    if (line.trim()) responses.push(JSON.parse(line));
    step();
  }
});
let state = 0;
function step() {
  if (state === 0) { state = 1; send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'log_capture',arguments:{kind:'investigation',title:'Webhook timeout root cause',sections:{problem:'POST /hooks times out under load',fix:'Raise client timeout to 30s'}}}}); }
  else if (state === 1) { state = 2;
    const r = JSON.parse(responses[responses.length-1].result.content[0].text);
    if (!r.preview || !r.preview.includes('unreviewed')) { console.error('preview missing unreviewed'); process.exit(1); }
    send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'confirm_capture',arguments:{token:r.token}}});
  }
  else if (state === 2) { state = 3; send({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'find_captures',arguments:{query:'webhook timeout'}}}); }
  else if (state === 3) { state = 4; send({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'whats_new',arguments:{since:new Date(Date.now()-3600000).toISOString()}}}); }
  else if (state === 4) { state = 5;
    const confirm = JSON.parse(responses[2].result.content[0].text);
    send({jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'read_file',arguments:{concept_id:confirm.id}}});
  }
  else if (state === 5) {
    const result = JSON.stringify({
      confirm: JSON.parse(responses[2].result.content[0].text),
      finds: JSON.parse(responses[3].result.content[0].text),
      news: JSON.parse(responses[4].result.content[0].text),
      read: JSON.parse(responses[5].result.content[0].text),
    });
    // Shut the server down cleanly (stdin end) and only print once it has
    // fully exited — this reaps any in-flight git child so the test reads a
    // quiescent telemetry file (no concurrent working-tree rewrite).
    p.on('exit', () => { console.log(result); process.exit(0); });
    p.stdin.end();
    setTimeout(() => { p.kill('SIGKILL'); }, 3000); // fallback if it lingers
  }
}
send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});
setTimeout(() => { console.error('timeout; got ' + responses.length + ' responses'); process.exit(1); }, 20000);
" 2>&1)"
node -e "
const r = JSON.parse(process.argv[1]);
if (!r.confirm.pushed) throw new Error('confirm should push: ' + JSON.stringify(r.confirm));
const rows = r.finds;
if (!Array.isArray(rows) || rows.length < 2) throw new Error('find_captures should hit both captures: ' + JSON.stringify(rows));
if (rows[0].id !== r.confirm.id) throw new Error('fresh capture must outrank the 10-day-old keyword-heavy one: ' + rows.map(x=>x.id).join(','));
if (!rows[0].author || !rows[0].kind || rows[0].ageDays === undefined || !rows[0].status) throw new Error('row fields missing: ' + JSON.stringify(rows[0]));
const newsIds = r.news.captures.map(c => c.id);
if (!newsIds.includes(r.confirm.id)) throw new Error('whats_new should include the fresh capture');
if (!r.read.markdown.includes('unreviewed capture from Alice Example')) throw new Error('read_file must show the unreviewed banner: ' + r.read.markdown.slice(0,200));
" "$out" || fail "two-phase capture / ranking / whats_new / banner" "$out"

# capture landed in the live repo and was pushed
( cd "$live" && git pull -q && git log --oneline | grep 'feat: capture' > /dev/null ) || fail "capture commit should exist in live repo"

# ---- telemetry: content-free NDJSON, committed alongside -------------------------
tel_dir="$live/telemetry/alice-example"
[ -d "$tel_dir" ] || fail "telemetry dir should exist for alice"
tel_file="$(ls "$tel_dir" | head -1)"
node -e "
const fs = require('fs');
const lines = fs.readFileSync('$tel_dir/$tel_file', 'utf8').trim().split('\n').map(JSON.parse);
const events = lines.map(l => l.event);
if (!events.includes('capture')) throw new Error('missing capture event');
if (!events.includes('confirm')) throw new Error('missing confirm event');
if (!events.includes('read')) throw new Error('missing read event');
if (!events.includes('search_hit')) throw new Error('missing search_hit event');
for (const l of lines) {
  for (const k of Object.keys(l)) {
    if (!['ts','user','harness','event','concept','layer','captureKind'].includes(k)) throw new Error('unexpected telemetry field: ' + k);
  }
  if (l.harness !== 'test-harness') throw new Error('harness should carry the flag value');
}
const raw = fs.readFileSync('$tel_dir/$tel_file', 'utf8');
for (const s of ['POST /hooks', 'Raise client timeout', 'SingleStore']) {
  if (raw.includes(s)) throw new Error('telemetry must never contain content: ' + s);
}
" || fail "telemetry schema / content-free invariant"

# ---- F8: a read-only telemetry session pushes its telemetry on session end ------
# A consumer who only reads (never confirms) must still get their reuse
# telemetry committed + pushed, else cross-brain metrics under-count.
rm -rf "$live/telemetry"; ( cd "$live" && git rm -r --quiet --cached --ignore-unmatch telemetry 2>/dev/null; git commit -q --allow-empty -m "reset telemetry" && git push -q )
node -e "
const { spawn } = require('child_process');
const p = spawn('node', ['$server','--telemetry','--harness','reader','--manifest','$tmpdir/m.json']);
let buf=''; const responses=[]; let state=0;
const send=(o)=>p.stdin.write(JSON.stringify(o)+'\n');
p.stdout.on('data', d => { buf+=d; let i; while((i=buf.indexOf('\n'))!==-1){ const l=buf.slice(0,i); buf=buf.slice(i+1); if(l.trim()) responses.push(JSON.parse(l)); step(); } });
function step(){
  if(state===0){ state=1; send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read_file',arguments:{concept_id:'captures/investigation/bob--old-webhook-timeout-fix'}}}); }
  else if(state===1){ state=2; p.stdin.end(); } // session end -> should flush telemetry to git
}
p.on('exit', ()=>process.exit(0));
send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});
setTimeout(()=>{ console.error('reader session timeout'); process.exit(1); }, 20000);
" || fail "read-only telemetry session should run and exit"
( cd "$live" && git log --oneline | grep 'chore: telemetry' > /dev/null ) || fail "F8: read-only session must commit telemetry on session end"
[ -z "$(cd "$live" && git log --oneline @{u}.. 2>/dev/null)" ] || fail "F8: session-end telemetry must be pushed, not left queued"

# ---- telemetry off → no files; tools still work -----------------------------------
rm -rf "$live/telemetry"
out="$(rpc --manifest "$tmpdir/m.json" -- '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"find_captures","arguments":{"query":"webhook"}}}')"
grep -q 'Webhook timeout root cause' <<<"$out" || fail "find_captures should work without telemetry" "$out"
[ -d "$live/telemetry" ] && fail "no telemetry files without --telemetry"

# ---- team-activity generator --------------------------------------------------------
ancient_iso="$(node -e 'console.log(new Date(Date.now() - 20*86400000).toISOString())')"
mkdir -p "$live/captures/gotcha"
cat > "$live/captures/gotcha/bob--ancient-wisdom.md" <<EOF
---
kind: gotcha
title: Ancient wisdom
author: bob
captured: $ancient_iso
status: unreviewed
---

# Ancient wisdom

## Body {#body}

Old but still on disk.
EOF
mkdir -p "$live/telemetry/alice-example" "$live/telemetry/bob"
month="$(node -e 'console.log(new Date().toISOString().slice(0,7))')"
base_ts="$(node -e 'console.log(Date.now())')"
node -e "
const fs = require('fs');
const base = Number('$base_ts');
const iso = (o) => new Date(base + o).toISOString();
fs.writeFileSync('$live/telemetry/alice-example/$month.ndjson', [
  JSON.stringify({ts: iso(-7200000*2), user: 'Alice Example', harness: 'claude-code', event: 'confirm', concept: 'captures/investigation/alice--x', layer: 'team-live', captureKind: 'investigation'}),
  JSON.stringify({ts: iso(-3600000), user: 'Alice Example', harness: 'claude-code', event: 'promote', concept: 'captures/investigation/alice--x', layer: 'team-live', captureKind: 'investigation'}),
].join('\n') + '\n');
fs.writeFileSync('$live/telemetry/bob/$month.ndjson', [
  JSON.stringify({ts: iso(-7200000), user: 'bob', harness: 'cursor', event: 'read', concept: 'captures/investigation/alice--x', layer: 'team-live'}),
  'this line is malformed {{{',
].join('\n') + '\n');
"
out="$(node "$core/team-activity.mjs" --live-root "$live" --out "$tmpdir/activity.json" 2>&1)"
node -e "
const r = JSON.parse(require('fs').readFileSync('$tmpdir/activity.json', 'utf8'));
if (r.metrics.crossBrainHits !== 1) throw new Error('crossBrainHits should be 1: ' + JSON.stringify(r.metrics));
if (r.metrics.medianTimeToFirstReuseHours !== 2) throw new Error('median reuse should be 2h: ' + JSON.stringify(r.metrics));
if (r.metrics.reviewThroughput.promoted !== 1) throw new Error('promoted should be 1');
if (!Array.isArray(r.feed) || r.feed.length < 2) throw new Error('feed should list captures');
if (!r.feed.some(f => f.archived)) throw new Error('decayed capture should appear flagged archived');
" || fail "team-activity metrics" "$out"

# ---- capture pack smoke ---------------------------------------------------------
pack="$repo_root/examples/team-sync-pack"
node -e "
const fs = require('fs');
const plugin = JSON.parse(fs.readFileSync('$pack/claude-code/.claude-plugin/plugin.json', 'utf8'));
if (!plugin.name || !plugin.description) throw new Error('plugin.json missing name/description');
JSON.parse(fs.readFileSync('$pack/claude-code/hooks/hooks.json', 'utf8'));
for (const f of ['claude-code/skills/team-sync/SKILL.md','cursor/team-sync.mdc','copilot/AGENTS-snippet.md','README.md']) {
  if (!fs.existsSync('$pack/' + f)) throw new Error('pack file missing: ' + f);
}
" || fail "pack structure"

nudge="$pack/claude-code/hooks/stop-nudge.mjs"
out="$(echo '{"stop_hook_active":true}' | node "$nudge")"
[ -z "$out" ] || fail "stop_hook_active must allow silently" "$out"
cat > "$tmpdir/transcript-worthy.jsonl" <<'EOF'
{"role":"assistant","content":"I found the root cause: the webhook client timeout was 5s."}
EOF
out="$(printf '{"stop_hook_active":false,"transcript_path":"%s"}' "$tmpdir/transcript-worthy.jsonl" | node "$nudge")"
grep -q '"decision":"block"' <<<"$out" || fail "capture-worthy transcript should nudge" "$out"
cat > "$tmpdir/transcript-logged.jsonl" <<'EOF'
{"role":"assistant","content":"I found the root cause and shared it."}
{"role":"assistant","content":"tool_use: log_capture"}
EOF
out="$(printf '{"stop_hook_active":false,"transcript_path":"%s"}' "$tmpdir/transcript-logged.jsonl" | node "$nudge")"
[ -z "$out" ] || fail "already-logged session must not nudge" "$out"
cat > "$tmpdir/transcript-plain.jsonl" <<'EOF'
{"role":"assistant","content":"Renamed the variable as requested."}
EOF
out="$(printf '{"stop_hook_active":false,"transcript_path":"%s"}' "$tmpdir/transcript-plain.jsonl" | node "$nudge")"
[ -z "$out" ] || fail "plain session must not nudge" "$out"

echo "team-sync mcp test passed (surface/flags/two-phase/ranking/banner/telemetry/activity/pack)"
