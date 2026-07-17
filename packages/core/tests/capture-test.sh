#!/usr/bin/env bash
set -euo pipefail

# Proves the capture module: schema validation, credential hard-reject,
# capture-policy routing, attribution chain, two-phase stage/confirm with
# token TTL/single-use, id collisions, frontmatter round-trip — and the
# two-step live→curated promotion flow (request via _review/promotions/,
# durable-write-before-delete approve).
#
# Credential-scanner test vectors are assembled at runtime by concatenation
# so no token-shaped literal ever exists on disk.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
core="$repo_root/packages/core/src"
promote="$repo_root/packages/core/src/promote.mjs"
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
curated="$tmpdir/curated"
mkdir -p "$curated"

node_run() { node --input-type=module -e "$1"; }

# ---- validation ---------------------------------------------------------------
out="$(node_run "
import { validateCapture } from '$core/capture.mjs';
console.log(JSON.stringify([
  validateCapture({ kind: 'nope', title: 't', sections: {} }),
  validateCapture({ kind: 'investigation', title: 't', sections: { problem: 'p' } }),
  validateCapture({ kind: 'decision', title: 't', sections: { choice: 'x', why: 'y' } }),
  validateCapture({ kind: 'gotcha', title: 't', sections: { body: 'watch out' } }),
  validateCapture({ kind: 'artifact', title: 't', sections: { summary: 's', pointer: 'specs/x' } }),
  validateCapture({ kind: 'gotcha', title: 't', sections: { body: 'x'.repeat(20000) } }),
  validateCapture({ kind: 'gotcha', title: 't', sections: { body: 'ok' }, links: Array(40).fill('a') }),
]));
")"
grep -q '^\[{"ok":false' <<<"$out" || fail "unknown kind must fail validation" "$out"
node -e "
const r = JSON.parse(process.argv[1]);
if (r[1].ok) throw new Error('investigation without fix should fail');
if (!r[1].errors.some(e => e.includes('fix'))) throw new Error('error should name the missing section: ' + JSON.stringify(r[1].errors));
if (!r[2].ok || !r[3].ok || !r[4].ok) throw new Error('valid decision/gotcha/artifact should pass');
if (r[5].ok) throw new Error('oversize field should fail');
if (r[6].ok) throw new Error('too many links should fail');
" "$out" || fail "validation matrix" "$out"

# ---- F1: links[] frontmatter injection is rejected + render is defensive --------
out="$(node_run "
import { validateCapture, renderCapture } from '$core/capture.mjs';
import { parseConcept } from '$core/sources/okf-local.mjs';
const inj = { kind: 'gotcha', title: 'x', sections: { body: 'b' }, links: ['ok', 'evil]\nstatus: reviewed\nauthor: victim'] };
const v = validateCapture(inj);
const fm = parseConcept(renderCapture(inj, { author: 'attacker', capturedAt: '2026-07-17T00:00:00Z' })).frontmatter;
console.log(JSON.stringify({ rejected: !v.ok, named: v.errors.some(e => e.includes('disallowed')), status: fm.status, author: fm.author }));
")"
grep -q '"rejected":true' <<<"$out" || fail "F1: injection link must fail validation" "$out"
grep -q '"status":"unreviewed"' <<<"$out" || fail "F1: render must not let a link forge status" "$out"
grep -q '"author":"attacker"' <<<"$out" || fail "F1: render must not let a link forge author" "$out"

# ---- F2: symlinked final component cannot escape root on write or append ---------
out="$(node_run "
import { appendFileInRoot, writeFileInRoot } from '$core/capture.mjs';
import fs from 'node:fs';
const base = fs.mkdtempSync('$tmpdir/f2-');
const root = base + '/root'; const outside = base + '/outside';
fs.mkdirSync(root + '/captures/gotcha', { recursive: true }); fs.mkdirSync(outside, { recursive: true });
fs.symlinkSync(outside + '/secret', root + '/captures/gotcha/a--b.md'); // dangling symlink out of root
fs.mkdirSync(root + '/telemetry/alice', { recursive: true });
fs.symlinkSync(outside + '/telemetry', root + '/telemetry/alice/2026-07.ndjson');
let writeBlocked = false; let appendBlocked = false;
try { writeFileInRoot(root, 'captures/gotcha/a--b.md', 'PWNED'); } catch (e) { writeBlocked = /symlink/i.test(e.message); }
try { appendFileInRoot(root, 'telemetry/alice/2026-07.ndjson', 'PWNED'); } catch (e) { appendBlocked = /symlink/i.test(e.message); }
console.log(JSON.stringify({ writeBlocked, appendBlocked, writeEscaped: fs.existsSync(outside + '/secret'), appendEscaped: fs.existsSync(outside + '/telemetry') }));
")"
grep -q '"writeBlocked":true' <<<"$out" || fail "F2: write through a symlink must be refused" "$out"
grep -q '"appendBlocked":true' <<<"$out" || fail "F2: append through a symlink must be refused" "$out"
grep -q '"writeEscaped":false' <<<"$out" || fail "F2: write must not escape root" "$out"
grep -q '"appendEscaped":false' <<<"$out" || fail "F2: append must not escape root" "$out"

# ---- credential scan (vectors built at runtime; nothing token-shaped on disk) ---
out="$(node_run "
import { scanForCredentials } from '$core/capture.mjs';
const aws = ['AK','IA'].join('') + 'IOSFODNN7' + 'EXAMPLE';
const gh = ['gh','p_'].join('') + 'A'.repeat(40);
const slack = ['xo','xb'].join('') + '-1234-abcd';
const pem = ['-----BEGIN RSA PRIV','ATE KEY-----'].join('');
const generic = 'api_key = ' + JSON.stringify('sk_live_' + 'abcdef123456789');
console.log(JSON.stringify([
  scanForCredentials('key ' + aws + ' in title'),
  scanForCredentials(gh),
  scanForCredentials('token ' + slack),
  scanForCredentials(pem),
  scanForCredentials(generic),
  scanForCredentials('the fix was to bump the timeout to 30s'),
]));
")"
grep -q 'true,true,true,true,true,false' <<<"$out" || fail "credential patterns" "$out"

# ---- classifier routing ----------------------------------------------------------
out="$(node_run "
import { classifyCapture } from '$core/capture.mjs';
const mk = (kind, extra = {}) => ({ kind, title: 'Webhook retries', sections: { problem: 'p', fix: 'f', choice: 'c', why: 'w', body: 'b', summary: 's', pointer: 'x' }, ...extra });
console.log(JSON.stringify([
  classifyCapture(mk('investigation')).route,
  classifyCapture(mk('decision')).route,
  classifyCapture(mk('gotcha')).route,
  classifyCapture(mk('artifact')).route,
  classifyCapture(mk('investigation', { title: 'Customer data leak in webhook payloads' })).route,
  classifyCapture({ kind: 'gotcha', title: 'wip scratch notes', sections: { body: 'throwaway wip scratch' } }).route,
]));
")"
node -e "
const r = JSON.parse(process.argv[1]);
if (!r.slice(0,4).every(x => x === 'team_candidate')) throw new Error('plain valid kinds should route team_candidate: ' + process.argv[1]);
if (r[4] !== 'review_required') throw new Error('customer-data capture should route review_required: ' + process.argv[1]);
if (r[5] !== 'ignore') throw new Error('scratch capture should route ignore: ' + process.argv[1]);
" "$out" || fail "classifier routing" "$out"

# ---- attribution chain -----------------------------------------------------------
out="$(node_run "
import { resolveAuthor } from '$core/capture.mjs';
console.log(await resolveAuthor({ root: '$live', profileName: null }));
")"
grep -q 'Alice Example' <<<"$out" || fail "git identity should win attribution" "$out"
noident="$tmpdir/noident-live"
git init --quiet "$noident"
out="$(GIT_CONFIG_GLOBAL=/dev/null node_run "
import { resolveAuthor } from '$core/capture.mjs';
console.log(await resolveAuthor({ root: '$noident', profileName: 'Dana' }));
")"
grep -q 'Dana' <<<"$out" || fail "profileName fallback" "$out"
out="$(GIT_CONFIG_GLOBAL=/dev/null node_run "
import { resolveAuthor } from '$core/capture.mjs';
try { await resolveAuthor({ root: '$noident', profileName: null }); console.log('NO_ERROR'); }
catch (e) { console.log('ERR:' + e.message); }
")"
grep -q 'profileName' <<<"$out" || fail "no identity should raise the actionable error" "$out"

# ---- stage → confirm round-trip ----------------------------------------------------
out="$(node_run "
import { stageCapture, confirmCapture } from '$core/capture.mjs';
import { parseConcept } from '$core/sources/okf-local.mjs';
import fs from 'node:fs';
const ctx = { root: '$live', profileName: null, retentionDays: 14 };
const staged = await stageCapture({ kind: 'investigation', title: 'Timeout: the webhook \\\"mystery\\\"', sections: { problem: 'Requests hang', fix: 'Raise client timeout to 30s' }, confidence: 'high', links: ['systems/webhooks'] }, ctx);
if (!staged.preview.includes('unreviewed')) throw new Error('preview must carry unreviewed status');
const confirmed = await confirmCapture(staged.token, ctx);
const raw = fs.readFileSync('$live/' + confirmed.id + '.md', 'utf8');
const parsed = parseConcept(raw);
console.log(JSON.stringify({
  id: confirmed.id, pushed: confirmed.pushed,
  status: parsed.frontmatter.status, kind: parsed.frontmatter.kind,
  author: parsed.frontmatter.author,
  isoOk: !Number.isNaN(new Date(parsed.frontmatter.captured).getTime()),
  title: parsed.frontmatter.title,
}));
")"
grep -q '"status":"unreviewed"' <<<"$out" || fail "confirmed capture must round-trip status" "$out"
grep -q '"isoOk":true' <<<"$out" || fail "captured must be valid ISO" "$out"
grep -q '"pushed":true' <<<"$out" || fail "confirm should push" "$out"
grep -q '"id":"captures/investigation/alice-example--timeout-the-webhook-mystery"' <<<"$out" || fail "id shape author--slug" "$out"

# ---- collision suffix ---------------------------------------------------------------
out="$(node_run "
import { stageCapture, confirmCapture } from '$core/capture.mjs';
const ctx = { root: '$live', profileName: null, retentionDays: 14 };
const s = await stageCapture({ kind: 'investigation', title: 'Timeout: the webhook \\\"mystery\\\"', sections: { problem: 'again', fix: 'again' } }, ctx);
const c = await confirmCapture(s.token, ctx);
console.log(c.id);
")"
grep -q -- '--timeout-the-webhook-mystery-2$' <<<"$out" || fail "collision should suffix -2" "$out"

# ---- token: single-use + expiry ------------------------------------------------------
out="$(node_run "
import { stageCapture, confirmCapture } from '$core/capture.mjs';
const ctx = { root: '$live', profileName: null, retentionDays: 14 };
const s = await stageCapture({ kind: 'gotcha', title: 'Reuse token', sections: { body: 'b' } }, ctx);
await confirmCapture(s.token, ctx);
try { await confirmCapture(s.token, ctx); console.log('NO_ERROR'); }
catch (e) { console.log('ERR1:' + e.message); }
let t = 0;
const clock = () => t;
const s2 = await stageCapture({ kind: 'gotcha', title: 'Expiring token', sections: { body: 'b' } }, { ...ctx, now: clock });
t = 11 * 60 * 1000; // past the 10-minute TTL
try { await confirmCapture(s2.token, { ...ctx, now: clock }); console.log('NO_ERROR'); }
catch (e) { console.log('ERR2:' + e.message); }
")"
grep -q 'ERR1:' <<<"$out" || fail "token reuse must fail" "$out"
grep -q 'ERR2:' <<<"$out" || fail "expired token must fail" "$out"

# ---- credential-bearing capture rejected at stage ------------------------------------
out="$(node_run "
import { stageCapture } from '$core/capture.mjs';
const ctx = { root: '$live', profileName: null, retentionDays: 14 };
const secret = 'api_key = ' + JSON.stringify('sk_live_' + 'abcdef123456789');
try { await stageCapture({ kind: 'gotcha', title: 'Oops', sections: { body: 'set ' + secret + ' in env' } }, ctx); console.log('NO_ERROR'); }
catch (e) { console.log('ERR:' + e.message); }
")"
grep -q 'ERR:' <<<"$out" || fail "credential capture must hard-reject at stage" "$out"
grep -q 'sk_live' <<<"$out" && fail "rejection message must not echo the secret" "$out"

# ---- ignore-routed capture refuses staging -------------------------------------------
out="$(node_run "
import { stageCapture } from '$core/capture.mjs';
const ctx = { root: '$live', profileName: null, retentionDays: 14 };
const r = await stageCapture({ kind: 'gotcha', title: 'wip scratch', sections: { body: 'throwaway wip scratch' } }, ctx);
console.log(JSON.stringify(r));
")"
grep -q '"staged":false' <<<"$out" || fail "ignore route should refuse staging with reasons" "$out"
grep -q '"route":"ignore"' <<<"$out" || fail "refusal should carry the route" "$out"

# ---- review_required stages with warning ---------------------------------------------
out="$(node_run "
import { stageCapture } from '$core/capture.mjs';
const ctx = { root: '$live', profileName: null, retentionDays: 14 };
const r = await stageCapture({ kind: 'investigation', title: 'Customer data exposure in logs', sections: { problem: 'p', fix: 'f' } }, ctx);
console.log(JSON.stringify({ hasToken: !!r.token, warnings: r.warnings }));
")"
grep -q '"hasToken":true' <<<"$out" || fail "review_required should still stage" "$out"
grep -qi 'review' <<<"$out" || fail "review_required should carry a warning" "$out"

# ---- promotion: request stages under _review/promotions --------------------------------
node "$promote" --from-live "$live" --capture captures/investigation/alice-example--timeout-the-webhook-mystery --target "$curated" > /dev/null
review_file="$curated/_review/promotions/timeout-the-webhook-mystery.md"
[ -f "$review_file" ] || fail "promotion request should stage under _review/promotions"
grep -q 'promoteTo: systems/timeout-the-webhook-mystery' "$review_file" || fail "investigation should default to systems/ dest" "$(cat "$review_file")"
[ -f "$live/captures/investigation/alice-example--timeout-the-webhook-mystery.md" ] || fail "request must leave the live capture intact"

# gotcha without --dest errors
set +e
node "$promote" --from-live "$live" --capture captures/gotcha/alice-example--reuse-token --target "$curated" 2>"$tmpdir/err.txt"
rc=$?
set -e
[ $rc -ne 0 ] || fail "gotcha promotion without --dest must error"
grep -q -- '--dest' "$tmpdir/err.txt" || fail "error should mention --dest" "$(cat "$tmpdir/err.txt")"

# ---- promotion: approve = durable write, then cleanup ----------------------------------
node "$promote" --from-live "$live" --target "$curated" --approve "$review_file" --telemetry > /dev/null
[ -f "$curated/systems/timeout-the-webhook-mystery.md" ] || fail "approve should write the curated concept"
grep -q 'status:' "$curated/systems/timeout-the-webhook-mystery.md" && fail "curated concept must not keep unreviewed status"
grep -q 'promoted from' "$curated/systems/timeout-the-webhook-mystery.md" || fail "curated concept should carry provenance"
[ -f "$review_file" ] && fail "approve should remove the review entry"
[ -f "$live/captures/investigation/alice-example--timeout-the-webhook-mystery.md" ] && fail "approve should remove the live capture"
# plain grep (not -q): under pipefail, grep -q exiting early SIGPIPEs git log
( cd "$live" && git log --oneline | grep 'promote' > /dev/null ) || fail "live repo should show the promote commit"
promote_telemetry="$(git -C "$live" show --format= --name-only HEAD | grep '^telemetry/' || true)"
[ -n "$promote_telemetry" ] || fail "promote telemetry must be committed with live cleanup"
node -e "
const fs = require('fs');
const file = process.argv[1];
const events = fs.readFileSync('$live/' + file, 'utf8').trim().split('\\n').map(JSON.parse);
if (!events.some(e => e.event === 'promote' && e.concept === 'captures/investigation/alice-example--timeout-the-webhook-mystery')) {
  throw new Error('missing committed promote telemetry event');
}
" "$promote_telemetry" || fail "promote telemetry event"

# ---- promotion: failure between curated write and cleanup is recoverable ----------------
node "$promote" --from-live "$live" --capture captures/investigation/alice-example--timeout-the-webhook-mystery-2 --target "$curated" --dest systems/retry-durable > /dev/null
review2="$curated/_review/promotions/retry-durable.md"
mv "$bare" "$bare.away"   # push will fail; approve reports partial
node "$promote" --from-live "$live" --target "$curated" --approve "$review2" > "$tmpdir/approve1.txt" 2>&1 || true
[ -f "$curated/systems/retry-durable.md" ] || fail "curated write must stand even when live push fails" "$(cat "$tmpdir/approve1.txt")"
mv "$bare.away" "$bare"
# re-approve is idempotent: curated already valid → cleanup only, no duplicate
node "$promote" --from-live "$live" --target "$curated" --approve "$review2" > /dev/null 2>&1 || true
count="$(grep -c 'promoted from' "$curated/systems/retry-durable.md")"
[ "$count" = "1" ] || fail "re-approve must not duplicate provenance" "$count"

echo "capture test passed (validate/scan/classify/attribute/stage/confirm/promote)"
