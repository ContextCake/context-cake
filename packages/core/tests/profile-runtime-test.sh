#!/usr/bin/env bash
set -euo pipefail

# Project Profiles PR2: one selected stack across resolver, MCP, write,
# capture/telemetry, promotion, cache identity, and the profile CLI.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
core="$repo_root/packages/core/src"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
fail() { echo "FAIL: $1" >&2; [ "${2:-}" ] && echo "$2" >&2; exit 1; }

export GIT_CONFIG_GLOBAL="$tmpdir/gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
export CONTEXTCAKE_LOCAL_STATE_DIR="$tmpdir/local-state"
git config --file "$tmpdir/gitconfig" user.name "Profile Tester"
git config --file "$tmpdir/gitconfig" user.email "profiles@example.invalid"
git config --file "$tmpdir/gitconfig" init.defaultBranch main

mkdir -p "$tmpdir/default" "$tmpdir/work" "$tmpdir/curated" "$tmpdir/project/nested" "$tmpdir/sibling"
cat > "$tmpdir/default/default-only.md" <<'EOF'
---
type: context
title: Default sentinel
---

# Default sentinel

Only the default profile may reveal DEFAULT-SECRET-SENTINEL.

[Work sentinel](work-only.md)
EOF
cat > "$tmpdir/work/work-only.md" <<'EOF'
---
type: context
title: Work sentinel
---

# Work sentinel

Only the work profile may reveal WORK-SECRET-SENTINEL.
EOF

bare="$tmpdir/live-remote.git"
git init --quiet --bare "$bare"
live="$tmpdir/work-live"
git clone --quiet "$bare" "$live" 2>/dev/null
( cd "$live" && git commit --quiet --allow-empty -m init && git push --quiet -u origin main )
default_bare="$tmpdir/default-live-remote.git"
git init --quiet --bare "$default_bare"
default_live="$tmpdir/default-live"
git clone --quiet "$default_bare" "$default_live" 2>/dev/null
( cd "$default_live" && git commit --quiet --allow-empty -m init && git push --quiet -u origin main )

manifest="$tmpdir/manifest.json"
cat > "$manifest" <<EOF
{
  "profiles": {
    "default": {
      "label": "Default",
      "layers": [
        { "name": "same-name", "level": 2, "source": "files", "path": "default", "cache": { "dir": "cache", "ttlSeconds": 60 } },
        { "name": "team-live", "level": 0, "source": "okf-local", "path": "default-live", "live": true,
          "git": { "pullTtlSeconds": 0, "retentionDays": 14 } }
      ]
    },
    "work": {
      "label": "Work",
      "layers": [
        { "name": "same-name", "level": 2, "source": "files", "path": "work", "cache": { "dir": "cache", "ttlSeconds": 60 } },
        { "name": "curated", "level": 1, "source": "okf-local", "path": "curated" },
        { "name": "team-live", "level": 0, "source": "okf-local", "path": "work-live", "live": true,
          "git": { "pullTtlSeconds": 0, "retentionDays": 14 } }
      ]
    }
  },
  "projects": { "$tmpdir/project": "work" }
}
EOF

# Resolver: cwd mapping wins, explicit override wins over cwd, sibling prefixes do not match.
out="$(cd "$tmpdir/project/nested" && node "$core/resolver.mjs" --manifest "$manifest" --concept work-only)"
grep -q 'WORK-SECRET-SENTINEL' <<<"$out" || fail "mapped resolver did not use work profile" "$out"
set +e
out="$(cd "$tmpdir/project/nested" && node "$core/resolver.mjs" --manifest "$manifest" --concept default-only 2>&1)"
rc=$?
set -e
[ $rc -ne 0 ] || fail "mapped resolver leaked default concept" "$out"
out="$(cd "$tmpdir/project/nested" && node "$core/resolver.mjs" --manifest "$manifest" --profile default --concept default-only)"
grep -q 'DEFAULT-SECRET-SENTINEL' <<<"$out" || fail "explicit resolver override did not win"
out="$(cd "$tmpdir/sibling" && node "$core/profile-cli.mjs" current --manifest "$manifest" --json)"
node -e "const x=JSON.parse(process.argv[1]); if(x.id!=='default'||x.reason!=='default') throw new Error(JSON.stringify(x))" "$out" \
  || fail "sibling path should select default" "$out"

# MCP: one process-selected stack, dynamic instructions, and no cross-profile list/read/search.
rpc_lines='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_concepts","arguments":{}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"SECRET SENTINEL"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_links","arguments":{"concept_id":"work-only"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_file","arguments":{"concept_id":"work-only"}}}
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"read_file","arguments":{"concept_id":"default-only"}}}'
out="$(cd "$tmpdir/project/nested" && printf '%b\n' "$rpc_lines" | node "$core/mcp-server.mjs" --manifest "$manifest")"
node -e "
const rows=process.argv[1].trim().split('\n').map(JSON.parse);
const byId=new Map(rows.map(row=>[row.id,row]));
const instructions=byId.get(1).result.instructions;
if(!instructions.includes('profile id: work; reason: project')) throw new Error('profile instructions missing');
if(instructions.includes('Work')) throw new Error('untrusted profile label entered instructions');
const profileMeta=byId.get(1).result._meta.contextcake.selectedProfile;
if(profileMeta.id!=='work'||profileMeta.label!=='Work'||profileMeta.reason!=='project') throw new Error('structured profile metadata missing');
const listed=JSON.parse(byId.get(2).result.content[0].text).map(x=>x.id);
if(!listed.includes('work-only') || listed.includes('default-only')) throw new Error('list isolation failed: '+listed);
const searched=JSON.parse(byId.get(3).result.content[0].text).map(x=>x.id);
if(!searched.includes('work-only') || searched.includes('default-only')) throw new Error('search isolation failed: '+searched);
const links=JSON.parse(byId.get(4).result.content[0].text);
if(links.incoming.some(link=>link.id==='default-only')) throw new Error('link isolation failed: '+JSON.stringify(links));
const selectedRead=byId.get(5).result.content[0].text;
if(!selectedRead.includes('WORK-SECRET-SENTINEL')) throw new Error('selected read failed: '+selectedRead);
const rejectedRead=byId.get(6);
if(!rejectedRead.error || !rejectedRead.error.message.includes('not found')) throw new Error('cross-profile read was not rejected: '+JSON.stringify(rejectedRead));
" "$out" || fail "MCP selected-stack isolation" "$out"
out="$(cd "$tmpdir/project/nested" && printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_concepts","arguments":{}}}' | node "$core/mcp-server.mjs" --manifest "$manifest" --profile default)"
node -e "const r=process.argv[1].trim().split('\n').map(JSON.parse); const row=r.find(x=>x.id===2); const ids=JSON.parse(row.result.content[0].text).map(x=>x.id); if(!ids.includes('default-only')||ids.includes('work-only')) throw new Error(ids)" "$out" \
  || fail "MCP explicit override isolation" "$out"

# Closing harness stdin drains received requests, then closes selected adapters
# so a long-lived foreign MCP child cannot keep ContextCake alive.
cat > "$tmpdir/long-lived-mcp.mjs" <<'EOF'
import readline from "node:readline";
process.on("SIGTERM", () => {});
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const row = JSON.parse(line);
  if (row.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: row.id, result: {} }));
  else if (row.method === "tools/call") console.log(JSON.stringify({ jsonrpc: "2.0", id: row.id, result: { content: [{ type: "text", text: JSON.stringify({ nodes: [] }) }] } }));
});
setInterval(() => {}, 60_000);
EOF
cat > "$tmpdir/mcp-shutdown-manifest.json" <<EOF
{"profiles":{"default":{"label":"Default","layers":[{"name":"foreign","level":1,"source":"mcp","command":"node","args":["$tmpdir/long-lived-mcp.mjs"],"cache":{"ttlSeconds":60}}]}}}
EOF
set +e
out="$(node -e "
const {spawn}=require('child_process');
const p=spawn('node',['$core/mcp-server.mjs','--manifest','$tmpdir/mcp-shutdown-manifest.json'],{stdio:['pipe','pipe','inherit']});
let stdout=''; p.stdout.on('data',d=>stdout+=d);
const timer=setTimeout(()=>{p.kill('SIGKILL');console.error('shutdown timeout');process.exit(2)},5000);
p.on('exit',code=>{clearTimeout(timer);process.stdout.write(stdout);process.exit(code===0?0:1)});
p.stdin.end('{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"list_concepts\",\"arguments\":{}}}\\n');
")"
rc=$?
set -e
[ $rc -eq 0 ] || fail "MCP did not exit after closing a long-lived selected source" "$out"
node -e "const rows=process.argv[1].trim().split('\n').map(JSON.parse);if(!rows.some(x=>x.id===2&&x.result))throw new Error(process.argv[1])" "$out" \
  || fail "MCP shutdown cut off an in-flight response" "$out"

# Profile-aware cache calls produce separate opaque namespaces for same-named sources.
find "$tmpdir/cache" -mindepth 1 -maxdepth 1 -type d | sort > "$tmpdir/cache-dirs.txt"
[ "$(wc -l < "$tmpdir/cache-dirs.txt" | tr -d ' ')" -eq 2 ] || fail "same-named profiles should have two cache namespaces" "$(cat "$tmpdir/cache-dirs.txt")"

# Batch write selects the same mapped stack.
cat > "$tmpdir/signals.json" <<'EOF'
{"signals":[{"id":"write-1","route":"team_candidate","destination":"systems/profile-write","title":"Profile write","repo":"test/repo","action":"WORK-WRITE-SENTINEL"}]}
EOF
( cd "$tmpdir/project/nested" && node "$core/write.mjs" --signals "$tmpdir/signals.json" --manifest "$manifest" --target-layer curated >/dev/null )
[ -f "$tmpdir/curated/systems/profile-write.md" ] || fail "write did not target selected profile"
[ ! -f "$tmpdir/default/systems/profile-write.md" ] || fail "write crossed into default profile"
set +e
( cd "$tmpdir/project/nested" && node "$core/write.mjs" --signals "$tmpdir/signals.json" --manifest "$manifest" --target-layer same-name >/dev/null 2>&1 )
rc=$?
set -e
[ $rc -ne 0 ] || fail "batch write should reject a plain Markdown-folder source"

# Batch destinations are untrusted classifier output: traversal, symlinked
# parents, and symlinked final files must not escape or overwrite anything.
cat > "$tmpdir/traversal-signals.json" <<'EOF'
{"signals":[{"id":"escape","route":"team_candidate","destination":"../default/cross-profile-leak","title":"Escape","repo":"test/repo"}]}
EOF
set +e
( cd "$tmpdir/project/nested" && node "$core/write.mjs" --signals "$tmpdir/traversal-signals.json" --manifest "$manifest" --target-layer curated >/dev/null 2>&1 )
rc=$?
set -e
[ $rc -ne 0 ] || fail "batch traversal destination should be rejected"
[ ! -f "$tmpdir/default/cross-profile-leak.md" ] || fail "batch traversal crossed into another profile"

mkdir -p "$tmpdir/outside-write"
ln -s "$tmpdir/outside-write" "$tmpdir/curated/escape-parent"
cat > "$tmpdir/symlink-parent-signals.json" <<'EOF'
{"signals":[{"id":"parent-link","route":"team_candidate","destination":"escape-parent/new/leak","title":"Parent link","repo":"test/repo"}]}
EOF
set +e
( cd "$tmpdir/project/nested" && node "$core/write.mjs" --signals "$tmpdir/symlink-parent-signals.json" --manifest "$manifest" --target-layer curated >/dev/null 2>&1 )
rc=$?
set -e
[ $rc -ne 0 ] || fail "batch symlinked parent should be rejected"
[ ! -e "$tmpdir/outside-write/new" ] || fail "batch write created directories through a symlinked parent"

printf 'DO-NOT-OVERWRITE\n' > "$tmpdir/outside-write/final.md"
ln -s "$tmpdir/outside-write/final.md" "$tmpdir/curated/final-link.md"
cat > "$tmpdir/symlink-final-signals.json" <<'EOF'
{"signals":[{"id":"final-link","route":"team_candidate","destination":"final-link","title":"Final link","repo":"test/repo"}]}
EOF
set +e
( cd "$tmpdir/project/nested" && node "$core/write.mjs" --signals "$tmpdir/symlink-final-signals.json" --manifest "$manifest" --target-layer curated >/dev/null 2>&1 )
rc=$?
set -e
[ $rc -ne 0 ] || fail "batch symlinked final file should be rejected"
grep -q 'DO-NOT-OVERWRITE' "$tmpdir/outside-write/final.md" || fail "batch write overwrote symlink target"

# A staged capture is bound to the startup profile + manifest revision. Editing
# even local profile metadata before confirmation consumes and rejects it.
out="$(node -e "
const {spawn}=require('child_process'), fs=require('fs');
const p=spawn('node',['$core/mcp-server.mjs','--manifest','$manifest','--profile','work','--capture'],{cwd:'$tmpdir/project'});
let buf='', state=0, staged=null; const rows=[];
const send=o=>p.stdin.write(JSON.stringify(o)+'\n');
p.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))!==-1){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const row=JSON.parse(line);rows.push(row);
  if(state===0){state=1;send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'log_capture',arguments:{kind:'gotcha',title:'Bound capture',sections:{body:'Must stay in work'}}}});}
  else if(state===1){state=2;staged=JSON.parse(row.result.content[0].text);const m=JSON.parse(fs.readFileSync('$manifest','utf8'));m.profiles.work.label='Work renamed during session';fs.writeFileSync('$manifest',JSON.stringify(m,null,2)+'\n');send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'confirm_capture',arguments:{token:staged.token}}});}
  else if(state===2){console.log(JSON.stringify(row));p.stdin.end();}
}});
p.on('exit',()=>process.exit(0));send({jsonrpc:'2.0',id:1,method:'initialize',params:{}});setTimeout(()=>{p.kill();process.exit(1)},15000);
")"
node -e "const r=JSON.parse(process.argv[1]); if(!r.error||!r.error.message.includes('changed after staging')) throw new Error(JSON.stringify(r))" "$out" \
  || fail "capture confirmation should reject a changed binding" "$out"
[ ! -f "$live/captures/gotcha/profile-tester--bound-capture.md" ] || fail "rejected capture reached live layer"

# A fresh process can confirm into the selected same-named live layer; capture
# and content-free telemetry never touch the default profile's live repo.
out="$(node -e "
const {spawn}=require('child_process');
const p=spawn('node',['$core/mcp-server.mjs','--manifest','$manifest','--profile','work','--capture','--telemetry','--harness','profile-test'],{cwd:'$tmpdir/project'});
let buf='', state=0, staged=null; const send=o=>p.stdin.write(JSON.stringify(o)+'\n');
p.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))!==-1){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const row=JSON.parse(line);
  if(state===0){state=1;send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'log_capture',arguments:{kind:'gotcha',title:'Selected capture',sections:{body:'Work live only'}}}});}
  else if(state===1){state=2;staged=JSON.parse(row.result.content[0].text);send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'confirm_capture',arguments:{token:staged.token}}});}
  else if(state===2){console.log(JSON.stringify(row));p.stdin.end();}
}});
p.on('exit',()=>process.exit(0));send({jsonrpc:'2.0',id:1,method:'initialize',params:{}});setTimeout(()=>{p.kill();process.exit(1)},20000);
")"
node -e "const r=JSON.parse(process.argv[1]); const x=JSON.parse(r.result.content[0].text); if(!x.id||!x.pushed) throw new Error(JSON.stringify(r))" "$out" \
  || fail "selected capture confirmation" "$out"
[ -f "$live/captures/gotcha/profile-tester--selected-capture.md" ] || fail "selected capture missing from work live layer"
[ ! -f "$default_live/captures/gotcha/profile-tester--selected-capture.md" ] || fail "capture crossed into default live layer"
[ -d "$live/telemetry/profile-tester" ] || fail "selected telemetry missing from work live layer"
[ ! -d "$default_live/telemetry" ] || fail "telemetry crossed into default live layer"

# Profile-aware promotion resolves both roots from the selected profile and
# binds approval to the same revision and layer fingerprints.
mkdir -p "$live/captures/investigation"
cat > "$live/captures/investigation/profile-tester--promotion-one.md" <<'EOF'
---
kind: investigation
title: Promotion one
author: Profile Tester
captured: 2026-07-29T00:00:00.000Z
status: unreviewed
---

# Promotion one

## Fix {#fix}

Use the selected profile only.
EOF
( cd "$live" && git add -A && git commit -qm "seed profile promotion" && git push -q )
node "$core/promote.mjs" --manifest "$manifest" --profile work --capture captures/investigation/profile-tester--promotion-one --target-layer curated --dest systems/profile-promotion >/dev/null
review="$tmpdir/curated/_review/promotions/profile-promotion.md"
[ -f "$review" ] || fail "profile-aware promotion request missing"
node "$core/promote.mjs" --manifest "$manifest" --profile work --approve "$review" --target-layer curated >/dev/null
[ -f "$tmpdir/curated/systems/profile-promotion.md" ] || fail "profile-aware promotion did not write curated target"
[ ! -f "$live/captures/investigation/profile-tester--promotion-one.md" ] || fail "successful profile promotion did not clean live capture"

# A live-repo symlink must never turn promotion into a local file read.
printf 'LOCAL-SECRET-MUST-NOT-BE-PROMOTED\n' > "$tmpdir/outside-promotion-secret.md"
mkdir -p "$live/captures/investigation"
ln -s "$tmpdir/outside-promotion-secret.md" "$live/captures/investigation/profile-tester--symlink.md"
( cd "$live" && git add -A && git commit -qm "seed malicious capture symlink" && git push -q )
set +e
out="$(node "$core/promote.mjs" --manifest "$manifest" --profile work --capture captures/investigation/profile-tester--symlink --target-layer curated --dest systems/symlink-leak 2>&1)"
rc=$?
set -e
[ $rc -ne 0 ] || fail "promotion should reject a symlinked live capture" "$out"
[ ! -f "$tmpdir/curated/_review/promotions/symlink-leak.md" ] || fail "symlinked capture reached the review queue"

# An unreviewed capture cannot pre-seed reserved frontmatter that overrides the
# trusted promotion source/destination or binding fields.
cat > "$live/captures/investigation/profile-tester--reserved.md" <<'EOF'
---
kind: investigation
title: Reserved keys
author: Profile Tester
captured: 2026-07-29T00:00:00.000Z
status: unreviewed
promoteTo: systems/redirected
---

# Reserved keys

## Fix {#fix}

Must be rejected before staging.
EOF
( cd "$live" && git add -A && git commit -qm "seed reserved promotion metadata" && git push -q )
set +e
out="$(node "$core/promote.mjs" --manifest "$manifest" --profile work --capture captures/investigation/profile-tester--reserved --target-layer curated --dest systems/reserved 2>&1)"
rc=$?
set -e
[ $rc -ne 0 ] || fail "promotion should reject reserved capture frontmatter" "$out"
[ ! -f "$tmpdir/curated/_review/promotions/reserved.md" ] || fail "reserved promotion metadata reached review"

# A commit failure after live deletion begins must restore the exact capture,
# clear its staged deletion, and keep the review retryable.
cat > "$live/captures/investigation/profile-tester--retryable.md" <<'EOF'
---
kind: investigation
title: Retryable promotion
author: Profile Tester
captured: 2026-07-29T00:00:00.000Z
status: unreviewed
---

# Retryable promotion

## Fix {#fix}

Commit failure must preserve this capture.
EOF
( cd "$live" && git add -A && git commit -qm "seed retryable promotion" && git push -q )
node "$core/promote.mjs" --manifest "$manifest" --profile work --capture captures/investigation/profile-tester--retryable --target-layer curated --dest systems/retryable >/dev/null
retry_review="$tmpdir/curated/_review/promotions/retryable.md"
cat > "$live/.git/hooks/pre-commit" <<'EOF'
#!/usr/bin/env sh
exit 1
EOF
chmod +x "$live/.git/hooks/pre-commit"
set +e
out="$(node "$core/promote.mjs" --manifest "$manifest" --profile work --approve "$retry_review" --target-layer curated 2>&1)"
rc=$?
set -e
[ $rc -ne 0 ] || fail "forced promotion commit failure should fail approval" "$out"
[ -f "$retry_review" ] || fail "failed promotion removed its review"
[ -f "$live/captures/investigation/profile-tester--retryable.md" ] || fail "failed promotion did not restore its live capture"
[ -z "$(cd "$live" && git diff --cached --name-only -- captures/investigation/profile-tester--retryable.md)" ] || fail "failed promotion left capture deletion staged"
rm "$live/.git/hooks/pre-commit"
node "$core/promote.mjs" --manifest "$manifest" --profile work --approve "$retry_review" --target-layer curated >/dev/null
[ ! -f "$retry_review" ] || fail "retryable promotion did not clear review after success"
[ ! -f "$live/captures/investigation/profile-tester--retryable.md" ] || fail "retryable promotion did not clean live capture"

# Editing both visible field pairs and the capture hash still cannot redirect a
# promotion because the authoritative tuple lives in machine-local state.
cat > "$live/captures/investigation/profile-tester--binding-source.md" <<'EOF'
---
kind: investigation
title: Binding source
author: Profile Tester
captured: 2026-07-29T00:00:00.000Z
status: unreviewed
---

# Binding source

## Fix {#fix}

This is the authorized source.
EOF
cat > "$live/captures/investigation/profile-tester--binding-redirect.md" <<'EOF'
---
kind: investigation
title: Binding redirect
author: Profile Tester
captured: 2026-07-29T00:00:00.000Z
status: unreviewed
---

# Binding redirect

## Fix {#fix}

This source must not be substituted.
EOF
( cd "$live" && git add -A && git commit -qm "seed promotion binding attack" && git push -q )
node "$core/promote.mjs" --manifest "$manifest" --profile work --capture captures/investigation/profile-tester--binding-source --target-layer curated --dest systems/binding-source >/dev/null
binding_review="$tmpdir/curated/_review/promotions/binding-source.md"
node -e "
const fs=require('fs'),crypto=require('crypto');
const review=process.argv[1], redirect=process.argv[2];
const hash=crypto.createHash('sha256').update(fs.readFileSync(redirect)).digest('hex');
let raw=fs.readFileSync(review,'utf8');
raw=raw.replace(/^promoteTo:.*$/m,'promoteTo: systems/binding-redirected')
  .replace(/^promotedFrom:.*$/m,'promotedFrom: captures/investigation/profile-tester--binding-redirect')
  .replace(/^promotionCapture:.*$/m,'promotionCapture: captures/investigation/profile-tester--binding-redirect')
  .replace(/^promotionDestination:.*$/m,'promotionDestination: systems/binding-redirected')
  .replace(/^promotionCaptureHash:.*$/m,'promotionCaptureHash: '+hash);
fs.writeFileSync(review,raw);
" "$binding_review" "$live/captures/investigation/profile-tester--binding-redirect.md"
set +e
out="$(node "$core/promote.mjs" --manifest "$manifest" --profile work --approve "$binding_review" --target-layer curated 2>&1)"
rc=$?
set -e
[ $rc -ne 0 ] || fail "editable review metadata should not replace its local binding" "$out"
grep -q 'authoritative local binding' <<<"$out" || fail "binding mismatch error should name the authoritative boundary" "$out"
[ -f "$live/captures/investigation/profile-tester--binding-source.md" ] || fail "binding attack removed authorized source"
[ -f "$live/captures/investigation/profile-tester--binding-redirect.md" ] || fail "binding attack removed substituted source"
[ ! -f "$tmpdir/curated/systems/binding-redirected.md" ] || fail "binding attack wrote substituted destination"

# If repo-lock acquisition fails only after the deletion commit, the local
# binding records that cleanup and a retry pushes before clearing the review.
cat > "$live/captures/investigation/profile-tester--push-retry.md" <<'EOF'
---
kind: investigation
title: Push retry
author: Profile Tester
captured: 2026-07-29T00:00:00.000Z
status: unreviewed
---

# Push retry

## Fix {#fix}

The review survives a post-commit push lock.
EOF
( cd "$live" && git add -A && git commit -qm "seed push retry promotion" && git push -q )
node "$core/promote.mjs" --manifest "$manifest" --profile work --capture captures/investigation/profile-tester--push-retry --target-layer curated --dest systems/push-retry >/dev/null
push_review="$tmpdir/curated/_review/promotions/push-retry.md"
cat > "$live/.git/hooks/post-commit" <<'EOF'
#!/usr/bin/env sh
mv .contextcake.lock .contextcake.lock.saved
node -e 'require("fs").writeFileSync(".contextcake.lock",JSON.stringify({pid:process.pid,ts:Date.now(),op:"push-test",token:"replacement"}))'
EOF
chmod +x "$live/.git/hooks/post-commit"
set +e
out="$(node "$core/promote.mjs" --manifest "$manifest" --profile work --approve "$push_review" --target-layer curated 2>&1)"
rc=$?
set -e
[ $rc -ne 0 ] || fail "forced post-commit push lock should fail approval" "$out"
[ -f "$push_review" ] || fail "post-commit push failure removed review"
[ ! -f "$live/captures/investigation/profile-tester--push-retry.md" ] || fail "post-commit push failure should retain durable deletion"
rm "$live/.git/hooks/post-commit" "$live/.contextcake.lock" "$live/.contextcake.lock.saved"
node "$core/promote.mjs" --manifest "$manifest" --profile work --approve "$push_review" --target-layer curated >/dev/null
[ ! -f "$push_review" ] || fail "push retry did not clear review after retrying push"

# Simulate a crash after the live deletion commit but before local binding state
# flips to cleanupCommitted. Approval reconciles the exact commit from git.
cat > "$live/captures/investigation/profile-tester--crash-window.md" <<'EOF'
---
kind: investigation
title: Crash window
author: Profile Tester
captured: 2026-07-29T00:00:00.000Z
status: unreviewed
---

# Crash window

## Fix {#fix}

Git history makes the post-commit crash resumable.
EOF
( cd "$live" && git add -A && git commit -qm "seed crash-window promotion" && git push -q )
node "$core/promote.mjs" --manifest "$manifest" --profile work --capture captures/investigation/profile-tester--crash-window --target-layer curated --dest systems/crash-window >/dev/null
crash_review="$tmpdir/curated/_review/promotions/crash-window.md"
( cd "$live" && rm captures/investigation/profile-tester--crash-window.md && git add -- captures/investigation/profile-tester--crash-window.md && git commit -qm "chore: promote captures/investigation/profile-tester--crash-window -> systems/crash-window" )
node "$core/promote.mjs" --manifest "$manifest" --profile work --approve "$crash_review" --target-layer curated >/dev/null
[ ! -f "$crash_review" ] || fail "post-commit crash reconciliation did not clear review"
[ -f "$tmpdir/curated/systems/crash-window.md" ] || fail "post-commit crash reconciliation did not preserve curated write"

mkdir -p "$live/captures/investigation"
cat > "$live/captures/investigation/profile-tester--promotion-stale.md" <<'EOF'
---
kind: investigation
title: Promotion stale
author: Profile Tester
captured: 2026-07-29T00:00:00.000Z
status: unreviewed
---

# Promotion stale

## Fix {#fix}

This approval must be rejected after configuration changes.
EOF
( cd "$live" && git add -A && git commit -qm "seed stale promotion" && git push -q )
node "$core/promote.mjs" --manifest "$manifest" --profile work --capture captures/investigation/profile-tester--promotion-stale --target-layer curated --dest systems/profile-promotion-stale >/dev/null
stale_review="$tmpdir/curated/_review/promotions/profile-promotion-stale.md"
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('$manifest','utf8'));m.profiles.work.label='Work changed after promotion request';fs.writeFileSync('$manifest',JSON.stringify(m,null,2)+'\n')"
set +e
out="$(node "$core/promote.mjs" --manifest "$manifest" --profile work --approve "$stale_review" --target-layer curated 2>&1)"
rc=$?
set -e
[ $rc -ne 0 ] || fail "stale promotion approval should fail" "$out"
grep -q 'changed after staging' <<<"$out" || fail "stale promotion error should explain binding change" "$out"
[ -f "$live/captures/investigation/profile-tester--promotion-stale.md" ] || fail "stale approval removed live capture"
[ ! -f "$tmpdir/curated/systems/profile-promotion-stale.md" ] || fail "stale approval wrote curated content"

# Profile CLI: create migrates safely, current/list are adapter-free, mapping is
# canonical, deletion previews references and removes references only.
legacy="$tmpdir/legacy.json"
cat > "$legacy" <<EOF
{"layers":[{"name":"legacy","level":1,"source":"files","path":"$tmpdir/default"}]}
EOF
out="$(node "$core/profile-cli.mjs" create "Extra Profile" --manifest "$legacy" --project "$tmpdir/project" --json)"
node -e "const x=JSON.parse(process.argv[1]); if(x.created!=='extra-profile'||!x.backupPath) throw new Error(JSON.stringify(x)); require('fs').accessSync(x.backupPath)" "$out" \
  || fail "profile create/migration result" "$out"
node "$core/profile-cli.mjs" unmap "$tmpdir/project" --manifest "$legacy" >/dev/null
out="$(cd "$tmpdir/project/nested" && node "$core/profile-cli.mjs" current --manifest "$legacy" --json)"
node -e "const x=JSON.parse(process.argv[1]); if(x.id!=='default'||x.reason!=='default') throw new Error(JSON.stringify(x))" "$out" \
  || fail "profile unmap should restore default selection" "$out"
node "$core/profile-cli.mjs" map extra-profile "$tmpdir/project" --manifest "$legacy" >/dev/null
out="$(cd "$tmpdir/project/nested" && node "$core/profile-cli.mjs" current --manifest "$legacy" --json)"
node -e "const x=JSON.parse(process.argv[1]); if(x.id!=='extra-profile'||x.reason!=='project') throw new Error(JSON.stringify(x))" "$out" \
  || fail "profile current should report mapped profile" "$out"
out="$(node "$core/profile-cli.mjs" list --manifest "$legacy" --json)"
node -e "const x=JSON.parse(process.argv[1]); if(!x.some(p=>p.id==='default')||!x.some(p=>p.id==='extra-profile')) throw new Error(JSON.stringify(x))" "$out" \
  || fail "profile list"
set +e
node "$core/profile-cli.mjs" delete extra-profile --manifest "$legacy" >/dev/null 2>&1
rc=$?
set -e
[ $rc -eq 2 ] || fail "profile delete must require --confirm"
node "$core/profile-cli.mjs" delete extra-profile --manifest "$legacy" --confirm >/dev/null
out="$(node "$core/profile-cli.mjs" list --manifest "$legacy" --json)"
node -e "const x=JSON.parse(process.argv[1]); if(x.some(p=>p.id==='extra-profile')) throw new Error(JSON.stringify(x))" "$out" \
  || fail "confirmed profile deletion"
[ -d "$tmpdir/project" ] || fail "profile deletion removed underlying project folder"

echo "profile runtime test passed (selection + MCP/write isolation + cache + capture binding + promotion + CLI)"
