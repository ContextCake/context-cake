#!/usr/bin/env bash
set -euo pipefail

# Proves the git mutation coordinator (git-core.mjs) and the withGitSync
# wrapper (git-sync.mjs): locked mutations, intended-paths-only commits,
# offline queue + recovery, TTL-gated pull with cache invalidation, decay
# filter, and the single-live-layer manifest contract.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
core="$repo_root/packages/core/src"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
fail() { echo "FAIL: $1" >&2; [ "${2:-}" ] && echo "$2" >&2; exit 1; }

export GIT_CONFIG_GLOBAL="$tmpdir/gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
git config --file "$tmpdir/gitconfig" user.name "Fixture User"
git config --file "$tmpdir/gitconfig" user.email "fixture@example.invalid"
git config --file "$tmpdir/gitconfig" init.defaultBranch main

bare="$tmpdir/remote.git"
git init --quiet --bare "$bare"
alice="$tmpdir/alice"
bob="$tmpdir/bob"
git clone --quiet "$bare" "$alice"
( cd "$alice" && git commit --quiet --allow-empty -m init && git push --quiet -u origin main )
git clone --quiet "$bare" "$bob"

node_run() { node --input-type=module -e "$1"; }

# ---- git-core: commitPaths stages only intended paths -----------------------
mkdir -p "$alice/captures/investigation"
echo "intended" > "$alice/captures/investigation/a.md"
echo "stray" > "$alice/stray.txt"
node_run "
import { commitPaths } from '$core/sources/git-core.mjs';
await commitPaths('$alice', ['captures/investigation/a.md'], 'feat: a');
"
( cd "$alice" && git show --stat --name-only HEAD | grep 'captures/investigation/a.md' > /dev/null ) || fail "commitPaths should commit the named path"
( cd "$alice" && git status --porcelain | grep 'stray.txt' > /dev/null ) || fail "commitPaths must not sweep up unrelated files"

# ---- git-core: push sets upstream when missing -------------------------------
( cd "$alice" && git checkout --quiet -b feature-x )
echo "up" > "$alice/captures/investigation/b.md"
out="$(node_run "
import { commitPaths, push } from '$core/sources/git-core.mjs';
await commitPaths('$alice', ['captures/investigation/b.md'], 'feat: b');
console.log(JSON.stringify(await push('$alice')));
")"
grep -q '"pushed":true' <<<"$out" || fail "push should set upstream and succeed" "$out"
( cd "$alice" && git checkout --quiet main )

# ---- git-core: offline push queues; retryQueued recovers ---------------------
mv "$bare" "$bare.away"
echo "offline" > "$alice/captures/investigation/c.md"
out="$(node_run "
import { commitPaths, push } from '$core/sources/git-core.mjs';
await commitPaths('$alice', ['captures/investigation/c.md'], 'feat: c');
console.log(JSON.stringify(await push('$alice')));
")"
grep -q '"queued":true' <<<"$out" || fail "offline push should report queued" "$out"
( cd "$alice" && git log -1 --format=%s | grep 'feat: c' > /dev/null ) || fail "queued commit must remain local"
mv "$bare.away" "$bare"
out="$(node_run "
import { retryQueued } from '$core/sources/git-core.mjs';
console.log(JSON.stringify(await retryQueued('$alice')));
")"
grep -q '"pushed":true' <<<"$out" || fail "retryQueued should land queued commits" "$out"
( cd "$bob" && git pull --quiet && [ -f captures/investigation/c.md ] ) || fail "recovered commit should reach the remote"

# ---- git-core: lock contention + stale steal ---------------------------------
printf '{"pid":%d,"ts":%d,"op":"test"}' "$$" "$(node -e 'console.log(Date.now())')" > "$alice/.contextcake.lock"
out="$(node_run "
import { pull } from '$core/sources/git-core.mjs';
console.log(JSON.stringify(await pull('$alice')));
")"
grep -q '"skipped":true' <<<"$out" || fail "reader should skip on live lock contention" "$out"
printf '{"pid":999999,"ts":1000,"op":"test"}' > "$alice/.contextcake.lock"
out="$(node_run "
import { pull } from '$core/sources/git-core.mjs';
console.log(JSON.stringify(await pull('$alice')));
")"
grep -q '"skipped":true' <<<"$out" && fail "stale lock should be stolen, not skipped" "$out"
[ -f "$alice/.contextcake.lock" ] && fail "lock should be released after steal"

# ---- git-core: a future-dated lock is stale, not un-stealable (L3) -------------
future="$(node -e 'console.log(Date.now() + 3600000)')"  # 1h in the future
printf '{"pid":999999,"ts":%d,"op":"test"}' "$future" > "$alice/.contextcake.lock"
out="$(node_run "
import { pull } from '$core/sources/git-core.mjs';
console.log(JSON.stringify(await pull('$alice')));
")"
grep -q '"skipped":true' <<<"$out" && fail "future-dated lock must be treated as stale" "$out"
[ -f "$alice/.contextcake.lock" ] && fail "future-dated lock should be released after steal"

# ---- git-core: concurrent stale-steal never double-acquires (F3) --------------
# One parent forks two workers that race to steal the SAME stale lock while each
# holds it briefly; exactly one must acquire, the other must see LockBusy.
# Self-contained in node so no shell/grep/-x fragility affects the count.
printf '{"pid":999998,"ts":1000,"op":"stale"}' > "$alice/.contextcake.lock"
out="$(node --input-type=module -e "
import { spawn } from 'node:child_process';
const worker = \`
import { withRepoLock } from '$core/sources/git-core.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { await withRepoLock('$alice', process.argv[1], async () => { await sleep(300); }, { lockRetryMs: 40, lockRetries: 3 }); process.stdout.write('WON'); }
catch (e) { process.stdout.write(e.code ?? 'ERR'); }
\`;
function race(tag) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', worker, tag], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.on('exit', () => resolve(buf.trim() || 'NONE'));
  });
}
console.log(JSON.stringify(await Promise.all([race('a'), race('b')])));
")"
wins="$(node -e "const r=JSON.parse(process.argv[1]); console.log(r.filter(x=>x==='WON').length)" "$out")"
busy="$(node -e "const r=JSON.parse(process.argv[1]); console.log(r.filter(x=>x==='LockBusy').length)" "$out")"
[ "$wins" = "1" ] || fail "concurrent stale-steal must yield exactly one winner" "$out"
[ "$busy" = "1" ] || fail "the loser of a stale-steal race must see LockBusy" "$out"
rm -f "$alice/.contextcake.lock"

# ---- git-core: a delayed holder cannot remove a replacement lock ---------------
out="$(node_run "
import fs from 'node:fs';
import { withRepoLock } from '$core/sources/git-core.mjs';
await withRepoLock('$alice', 'ownership', async () => {
  fs.writeFileSync('$alice/.contextcake.lock', JSON.stringify({ pid: 2, ts: Date.now(), op: 'replacement', token: 'replacement-token' }));
});
console.log(JSON.parse(fs.readFileSync('$alice/.contextcake.lock', 'utf8')).token);
")"
grep -q 'replacement-token' <<<"$out" || fail "a stale holder must not delete a replacement lock" "$out"
rm -f "$alice/.contextcake.lock"

# ---- git-core: mutation on held lock errors LockBusy -------------------------
printf '{"pid":%d,"ts":%d,"op":"test"}' "$$" "$(node -e 'console.log(Date.now())')" > "$alice/.contextcake.lock"
out="$(node_run "
import { commitPaths } from '$core/sources/git-core.mjs';
try {
  await commitPaths('$alice', ['captures/investigation/a.md'], 'nope', { lockRetryMs: 50, lockRetries: 2 });
  console.log('NO_ERROR');
} catch (e) { console.log(e.code ?? e.message); }
")"
grep -q 'LockBusy' <<<"$out" || fail "mutation should error LockBusy on held lock" "$out"
rm -f "$alice/.contextcake.lock"

# ---- git-core: errors are URL-scrubbed ----------------------------------------
( cd "$alice" && git remote set-url origin "https://user:secret-token@example.invalid/repo.git" )
out="$(node_run "
import { push } from '$core/sources/git-core.mjs';
const r = await push('$alice');
console.log(JSON.stringify(r));
" 2>&1 || true)"
grep -q 'secret-token' <<<"$out" && fail "git errors must scrub remote URLs" "$out"
( cd "$alice" && git remote set-url origin "$bare" )

# ---- git-core: identity fallback in identity-less repo -----------------------
noident="$tmpdir/noident"
git init --quiet "$noident"
echo "x" > "$noident/f.md"
out="$(GIT_CONFIG_GLOBAL=/dev/null node_run "
import { commitPaths } from '$core/sources/git-core.mjs';
await commitPaths('$noident', ['f.md'], 'feat: ident', { author: 'Dana Q' });
console.log('OK');
")"
grep -q 'OK' <<<"$out" || fail "identity-less repo should commit with fallback identity" "$out"
( cd "$noident" && git log -1 --format='%an' | grep 'Dana Q' > /dev/null ) || fail "fallback author name should be used"

# ---- withGitSync: propagation through a warm cache ----------------------------
mkdir -p "$bob/captures/investigation"
now_iso="$(node -e 'console.log(new Date().toISOString())')"
cat > "$alice/captures/investigation/fresh.md" <<EOF
---
kind: investigation
author: alice
captured: $now_iso
status: unreviewed
title: Fresh finding
---

# Fresh finding

## Problem {#problem}

Webhook timeouts.

## Fix {#fix}

Raise the client timeout.
EOF
node_run "
import { commitPaths, push } from '$core/sources/git-core.mjs';
await commitPaths('$alice', ['captures/investigation/fresh.md'], 'feat: fresh');
await push('$alice');
"
out="$(node_run "
import { createOkfLocalSource } from '$core/sources/okf-local.mjs';
import { withCache } from '$core/sources/cache.mjs';
import { withGitSync } from '$core/sources/git-sync.mjs';
const raw = createOkfLocalSource({ name: 'live', level: 1, root: '$bob' });
const cached = withCache(raw, { ttlMs: 3600000 });
await cached.listConceptIds(); // warm the cache BEFORE the pull
const src = withGitSync(cached, { root: '$bob', pullTtlMs: 0 });
const ids = await src.listConceptIds();
console.log(JSON.stringify(ids));
")"
grep -q 'captures/investigation/fresh' <<<"$out" || fail "pull must invalidate the warm cache (composition order)" "$out"

# ---- withGitSync: within TTL stays stale until sync() -------------------------
# First read pulls (fresh process); a push landing AFTER that read stays
# invisible within the TTL window until an explicit sync().
out="$(node_run "
import { execFileSync } from 'node:child_process';
import { createOkfLocalSource } from '$core/sources/okf-local.mjs';
import { withGitSync } from '$core/sources/git-sync.mjs';
import { commitPaths, push } from '$core/sources/git-core.mjs';
import fs from 'node:fs';
const raw = createOkfLocalSource({ name: 'live', level: 1, root: '$bob' });
const src = withGitSync(raw, { root: '$bob', pullTtlMs: 3600000 });
await src.listConceptIds(); // first read: pulls once
fs.writeFileSync('$alice/captures/investigation/second.md', [
  '---', 'kind: investigation', 'author: alice', 'captured: $now_iso',
  'status: unreviewed', 'title: Second', '---', '', '# Second', '',
  '## Problem {#problem}', '', 'P.', '', '## Fix {#fix}', '', 'F.', ''
].join('\n'));
await commitPaths('$alice', ['captures/investigation/second.md'], 'feat: second');
await push('$alice');
const before = (await src.listConceptIds()).includes('captures/investigation/second');
await src.sync();
const after = (await src.listConceptIds()).includes('captures/investigation/second');
console.log(JSON.stringify({ before, after }));
")"
grep -q '"before":false,"after":true' <<<"$out" || fail "within TTL should stay stale until sync()" "$out"

# ---- withGitSync: sync() pushes queued commits --------------------------------
mv "$bare" "$bare.away"
echo "queued-via-sync" > "$bob/captures/investigation/queued.md"
node_run "
import { commitPaths, push } from '$core/sources/git-core.mjs';
await commitPaths('$bob', ['captures/investigation/queued.md'], 'feat: queued');
await push('$bob');
" >/dev/null 2>&1 || true
mv "$bare.away" "$bare"
node_run "
import { createOkfLocalSource } from '$core/sources/okf-local.mjs';
import { withGitSync } from '$core/sources/git-sync.mjs';
const raw = createOkfLocalSource({ name: 'live', level: 1, root: '$bob' });
const src = withGitSync(raw, { root: '$bob', pullTtlMs: 0 });
await src.sync();
"
( cd "$alice" && git pull --quiet && [ -f captures/investigation/queued.md ] ) || fail "sync() should push queued commits"

# ---- withGitSync: decay filter -------------------------------------------------
old_iso="$(node -e 'console.log(new Date(Date.now() - 20*86400000).toISOString())')"
mkdir -p "$bob/captures/gotcha"
cat > "$bob/captures/gotcha/old.md" <<EOF
---
kind: gotcha
author: bob
captured: $old_iso
status: unreviewed
title: Old gotcha
---

# Old gotcha

## Body {#body}

Ancient wisdom.
EOF
mkdir -p "$bob/decisions"
cat > "$bob/decisions/evergreen.md" <<EOF
---
type: decision
title: Evergreen
updated: 2026-01-01
---

## Choice {#choice}

Keep.
EOF
out="$(node_run "
import { createOkfLocalSource } from '$core/sources/okf-local.mjs';
import { withGitSync } from '$core/sources/git-sync.mjs';
const raw = createOkfLocalSource({ name: 'live', level: 1, root: '$bob' });
const src = withGitSync(raw, { root: '$bob', pullTtlMs: 3600000, retentionDays: 14 });
const ids = await src.listConceptIds();
const direct = await src.loadConcept('captures/gotcha/old');
console.log(JSON.stringify({ listed: ids.includes('captures/gotcha/old'), evergreen: ids.includes('decisions/evergreen'), direct: direct !== null }));
")"
grep -q '"listed":false,"evergreen":true,"direct":true' <<<"$out" || fail "decay: old captures leave list, stay readable; curated never decays" "$out"

# ---- resolveLiveLayer: manifest contract ---------------------------------------
cat > "$tmpdir/m-good.json" <<EOF
{ "layers": [
  { "name": "team-live", "level": 1, "source": "okf-local", "path": "bob", "live": true,
    "git": { "pullTtlSeconds": 90, "retentionDays": 14 } },
  { "name": "team", "level": 2, "source": "okf-local", "path": "alice" }
] }
EOF
out="$(node_run "
import { resolveLiveLayer } from '$core/sources/git-sync.mjs';
import fs from 'node:fs';
const m = JSON.parse(fs.readFileSync('$tmpdir/m-good.json', 'utf8'));
console.log(JSON.stringify(resolveLiveLayer(m, '$tmpdir')));
")"
grep -q '"name":"team-live"' <<<"$out" || fail "resolveLiveLayer should find the live layer" "$out"
grep -q '"pullTtlMs":90000' <<<"$out" || fail "resolveLiveLayer should expose pullTtlMs" "$out"

cat > "$tmpdir/m-two.json" <<EOF
{ "layers": [
  { "name": "a", "level": 1, "source": "okf-local", "path": "bob", "live": true, "git": {} },
  { "name": "b", "level": 2, "source": "okf-local", "path": "alice", "live": true, "git": {} }
] }
EOF
out="$(node_run "
import { resolveLiveLayer } from '$core/sources/git-sync.mjs';
import fs from 'node:fs';
try { resolveLiveLayer(JSON.parse(fs.readFileSync('$tmpdir/m-two.json', 'utf8')), '$tmpdir'); console.log('NO_ERROR'); }
catch (e) { console.log('ERR:' + e.message); }
")"
grep -q 'ERR:' <<<"$out" || fail "two live layers must be rejected" "$out"

cat > "$tmpdir/m-nogit.json" <<EOF
{ "layers": [
  { "name": "a", "level": 1, "source": "okf-local", "path": "bob", "live": true }
] }
EOF
out="$(node_run "
import { resolveLiveLayer } from '$core/sources/git-sync.mjs';
import fs from 'node:fs';
try { resolveLiveLayer(JSON.parse(fs.readFileSync('$tmpdir/m-nogit.json', 'utf8')), '$tmpdir'); console.log('NO_ERROR'); }
catch (e) { console.log('ERR:' + e.message); }
")"
grep -q 'ERR:' <<<"$out" || fail "live layer without git block must be rejected" "$out"

out="$(node_run "
import { resolveLiveLayer } from '$core/sources/git-sync.mjs';
console.log(JSON.stringify(resolveLiveLayer({ layers: [ { name: 'x', level: 1, source: 'okf-local', path: 'bob' } ] }, '$tmpdir')));
")"
grep -q 'null' <<<"$out" || fail "no live layer should resolve to null" "$out"

# ---- buildSources: git block wires the wrapper (outermost) ---------------------
cat > "$tmpdir/m-build.json" <<EOF
{ "layers": [
  { "name": "team-live", "level": 1, "source": "okf-local", "path": "bob", "live": true,
    "git": { "pullTtlSeconds": 0, "retentionDays": 14 }, "cache": { "ttlSeconds": 3600 } }
] }
EOF
cat > "$alice/captures/investigation/wired.md" <<EOF
---
kind: investigation
author: alice
captured: $now_iso
status: unreviewed
title: Wired
---

# Wired

## Problem {#problem}

P.

## Fix {#fix}

F.
EOF
node_run "
import { commitPaths, push } from '$core/sources/git-core.mjs';
await commitPaths('$alice', ['captures/investigation/wired.md'], 'feat: wired');
await push('$alice');
"
out="$(node_run "
import { buildSources } from '$core/sources/index.mjs';
import fs from 'node:fs';
const m = JSON.parse(fs.readFileSync('$tmpdir/m-build.json', 'utf8'));
const [src] = buildSources(m, '$tmpdir');
await src.listConceptIds(); // warms inner cache after first pull
const ids = await src.listConceptIds();
console.log(JSON.stringify(ids.includes('captures/investigation/wired')));
src.close();
")"
grep -q 'true' <<<"$out" || fail "buildSources should wire withGitSync outermost over the cache" "$out"

echo "git-sync test passed (git-core lock/queue/scrub/identity + withGitSync pull/decay/contract)"
