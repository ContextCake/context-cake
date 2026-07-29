#!/usr/bin/env bash
set -euo pipefail

# Proves the github source adapter against a local node:http fixture that
# speaks the shape of the GitHub REST API (no network). Covers: path-glob
# selection, repo-qualified concept ids, commit-date sections with a pushed_at
# fallback, OKF-frontmatter delegation, cross-adapter section merging in the
# cascade, credential indirection, traversal/foreign-id rejection, and
# warn-and-continue when the API is unreachable or forbidden.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
resolver="$repo_root/resolver.mjs"
sources_dir="$repo_root/packages/core/src/sources"
tmpdir="$(mktemp -d)"
fail() { echo "FAIL: $1" >&2; [ "${2:-}" ] && echo "$2" >&2; exit 1; }

# --- Fixture GitHub API -------------------------------------------------------
# Serves one repo (acme/payments). POST-free mode switch drives failure paths:
#   forbidden  -> 403 on everything (rate limit / bad token)
#   nocommits  -> 403 on /commits only (exercises the pushed_at fallback)
#   nocontent  -> 403 on /contents only (index fine, per-file reads denied)
#   truncated  -> the tree listing comes back truncated

cat > "$tmpdir/api.mjs" <<'EOF'
import http from "node:http";

const FILES = {
  "CLAUDE.md": "# Payments Service\n\nHouse rules for the payments repo.\n\n## Engine\n\nPostgres 16 (per the repo).\n\n## Getting Started\n\nRead the repo CLAUDE.md first.\n",
  "docs/runbook.md": "# Runbook\n\n## Oncall\n\nPage the payments rotation.\n",
  "docs/deep/nested.md": "# Nested\n\n## Detail\n\nStill indexed by docs/**.\n",
  "docs/okf.md": "---\ntype: decision\ntitle: OKF-authored in-repo\nupdated: 2026-05-01\n---\n\n## Engine {#engine updated=2026-04-01}\n\nSingleStore.\n",
  "notes.txt": "Loose text note.\n",
  "src/index.js": "should never be indexed (not a doc extension)",
  "internal/private.md": "should never be indexed (outside the path globs)",
};
const COMMIT_DATES = { "CLAUDE.md": "2026-06-11T09:00:00Z", "docs/runbook.md": "2026-03-02T09:00:00Z" };

let mode = null;
let lastAuth = null;
let requests = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const raw = (body) => { res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) }); res.end(body); };

  // Test-only control endpoints (not part of the GitHub API surface).
  if (url.pathname === "/__auth") return json(200, { authorization: lastAuth });
  if (url.pathname === "/__mode") { mode = url.searchParams.get("value") || null; return json(200, { mode }); }
  if (url.pathname === "/__count") { const n = requests; if (url.searchParams.get("reset")) requests = 0; return json(200, { requests: n }); }

  requests += 1;
  lastAuth = req.headers.authorization ?? null;
  if (mode === "forbidden") return json(403, { message: "API rate limit exceeded" });

  if (url.pathname === "/repos/acme/payments") {
    return json(200, { default_branch: "main", pushed_at: "2026-07-20T12:00:00Z" });
  }
  if (url.pathname === "/repos/acme/payments/git/trees/main") {
    return json(200, {
      truncated: mode === "truncated",
      tree: Object.entries(FILES)
        .map(([p, c]) => ({ path: p, type: "blob", size: Buffer.byteLength(c) }))
        .concat([{ path: "docs", type: "tree", size: 0 }]),
    });
  }
  if (url.pathname === "/repos/acme/payments/commits") {
    if (mode === "nocommits") return json(403, { message: "forbidden" });
    const p = url.searchParams.get("path");
    if (!COMMIT_DATES[p]) return json(200, []);
    return json(200, [{ commit: { committer: { date: COMMIT_DATES[p] } } }]);
  }
  const contents = url.pathname.match(/^\/repos\/acme\/payments\/contents\/(.+)$/);
  if (contents) {
    if (mode === "nocontent") return json(403, { message: "forbidden" });
    const p = contents[1].split("/").map(decodeURIComponent).join("/");
    if (!(p in FILES)) return json(404, { message: "Not Found" });
    return raw(FILES[p]);
  }
  return json(404, { message: "Not Found" });
});

server.listen(0, "127.0.0.1", () => console.log(server.address().port));
EOF

node "$tmpdir/api.mjs" > "$tmpdir/port" 2>"$tmpdir/api.err" &
api_pid=$!
trap 'kill "$api_pid" 2>/dev/null || true; rm -rf "$tmpdir"' EXIT
for _ in $(seq 1 50); do [ -s "$tmpdir/port" ] && break; sleep 0.1; done
port="$(head -1 "$tmpdir/port")"
[ -n "$port" ] || fail "fixture API did not start" "$(cat "$tmpdir/api.err" 2>/dev/null)"
api="http://127.0.0.1:$port"
set_mode() { curl -fsS "$api/__mode?value=$1" > /dev/null; }

# Driver: exercise createGithubSource directly.
cat > "$tmpdir/load.mjs" <<EOF
import { createGithubSource } from "${sources_dir}/github.mjs";
const [, , apiBase, arg, ...rest] = process.argv;
const opts = { name: "repo", level: 3, repo: "acme/payments", apiBase, token: rest[0] || null };
if (rest[1]) opts.paths = rest[1].split(",");
const s = createGithubSource(opts);
if (arg === "--list") console.log(JSON.stringify(await s.listConceptIds()));
else console.log(JSON.stringify(await s.loadConcept(arg)));
s.close();
EOF

# --- 1. Index: default path globs select docs, exclude everything else --------

ids="$(node "$tmpdir/load.mjs" "$api" --list)"
grep -q '"acme/payments/CLAUDE"' <<<"$ids" || fail "CLAUDE.md should be indexed by default" "$ids"
grep -q '"acme/payments/docs/runbook"' <<<"$ids" || fail "docs/** should be indexed" "$ids"
grep -q '"acme/payments/docs/deep/nested"' <<<"$ids" || fail "docs/** should span nested segments" "$ids"
if grep -q 'src/index' <<<"$ids"; then fail "non-doc extensions must not be indexed" "$ids"; fi
if grep -q 'internal/private' <<<"$ids"; then fail "paths outside the globs must not be indexed" "$ids"; fi
if grep -q '"acme/payments/notes"' <<<"$ids"; then fail "notes.txt is outside the default globs" "$ids"; fi

# Explicit paths replace the defaults (and .txt is a supported doc extension).
custom="$(node "$tmpdir/load.mjs" "$api" --list "" "notes.txt,docs/*.md")"
grep -q '"acme/payments/notes"' <<<"$custom" || fail "explicit paths should select notes.txt" "$custom"
grep -q '"acme/payments/docs/runbook"' <<<"$custom" || fail "docs/*.md should select the top level" "$custom"
if grep -q 'deep/nested' <<<"$custom"; then fail "a single * must not span path separators" "$custom"; fi
if grep -q 'CLAUDE' <<<"$custom"; then fail "explicit paths should replace the defaults" "$custom"; fi

# --- 2. Concepts parse with files.mjs rules and carry the commit date ---------

claude="$(node "$tmpdir/load.mjs" "$api" acme/payments/CLAUDE)"
grep -q '"type":"document"' <<<"$claude" || fail "plain repo markdown should synthesize type: document" "$claude"
grep -q '"title":"Payments Service"' <<<"$claude" || fail "title should come from the H1" "$claude"
grep -q '"key":"engine"' <<<"$claude" || fail "## headings should become okf-normalized section keys" "$claude"
grep -q '"key":"getting started"' <<<"$claude" || fail "multi-word keys must match files.mjs normalization" "$claude"
grep -q '"updated":"2026-06-11"' <<<"$claude" || fail "sections should carry the file's last commit date" "$claude"

runbook="$(node "$tmpdir/load.mjs" "$api" acme/payments/docs/runbook)"
grep -q '"updated":"2026-03-02"' <<<"$runbook" || fail "each file should get its own commit date" "$runbook"

# A file with no commit history falls back to the repo pushed_at.
nested="$(node "$tmpdir/load.mjs" "$api" acme/payments/docs/deep/nested)"
grep -q '"updated":"2026-07-20"' <<<"$nested" || fail "empty commit history should fall back to pushed_at" "$nested"

# OKF frontmatter in a repo file gets full OKF parsing, same as on disk.
okf="$(node "$tmpdir/load.mjs" "$api" acme/payments/docs/okf)"
grep -q '"title":"OKF-authored in-repo"' <<<"$okf" || fail "OKF frontmatter should be honored" "$okf"
grep -q '"updated":"2026-04-01"' <<<"$okf" || fail "an OKF updated= attr should win over the commit date" "$okf"

# --- 3. Foreign, traversal, and unknown ids are misses, not crashes -----------

for evil in "other/repo/CLAUDE" "acme/payments/../../etc/passwd" "acme/payments/.." "CLAUDE" "acme/payments/nope" ""; do
  out="$(node "$tmpdir/load.mjs" "$api" "$evil")"
  [ "$out" = "null" ] || fail "id '$evil' should load as null" "$out"
done

# An id that cannot belong to this repo must be rejected BEFORE any network
# call. mcp-server sweeps every id across every layer, so a github layer that
# round-trips on ids owned by other layers burns the rate limit for nothing.
cat > "$tmpdir/nonet.mjs" <<EOF
import { createGithubSource } from "${sources_dir}/github.mjs";
const s = createGithubSource({ name: "repo", level: 3, repo: "acme/payments", apiBase: process.argv[2] });
for (const id of ["other/repo/CLAUDE", "CLAUDE", "acme/payments/../../etc/passwd", "acme/payments/..", ""]) {
  if ((await s.loadConcept(id)) !== null) throw new Error("expected null for " + JSON.stringify(id));
}
s.close();
EOF
curl -fsS "$api/__count?reset=1" > /dev/null
node "$tmpdir/nonet.mjs" "$api"
after="$(curl -fsS "$api/__count?reset=1")"
grep -q '"requests":0' <<<"$after" || fail "ids outside this repo must not reach the API" "$after"

# --- 4. Credential indirection: a manifest names a secret, never carries one --

cat > "$tmpdir/auth.mjs" <<EOF
import { resolveToken } from "${sources_dir}/index.mjs";
const check = (layer, tokens) => { try { return JSON.stringify(resolveToken(layer, tokens)); } catch (e) { return "THROW: " + e.message; } };
// Built at runtime so no token-shaped literal is ever committed to a file.
const rawLooking = "gh" + "p_" + "A".repeat(36);
console.log(check({ name: "a", auth: "keychain:github" }, { github: "s3cret" }));
console.log(check({ name: "b", auth: "keychain:missing" }, {}));
console.log(check({ name: "c" }, {}));
process.env.CC_TEST_TOKEN = "from-env";
console.log(check({ name: "d", auth: { tokenEnv: "CC_TEST_TOKEN" } }, {}));
console.log(check({ name: "e", auth: rawLooking }, {}));
console.log(check({ name: "f", auth: { token: "raw" } }, {}));
console.log(check({ name: "g", auth: "keychain:" }, {}));
EOF
auth_out="$(node "$tmpdir/auth.mjs")"
[ "$(sed -n 1p <<<"$auth_out")" = '"s3cret"' ] || fail "a keychain alias should resolve from injected tokens" "$auth_out"
[ "$(sed -n 2p <<<"$auth_out")" = "null" ] || fail "an uninjected alias should be null, not an error" "$auth_out"
[ "$(sed -n 3p <<<"$auth_out")" = "null" ] || fail "no auth block should be null" "$auth_out"
[ "$(sed -n 4p <<<"$auth_out")" = '"from-env"' ] || fail "tokenEnv should resolve headlessly" "$auth_out"
grep -q '^THROW' <<<"$(sed -n 5p <<<"$auth_out")" || fail "a raw credential in a manifest must be rejected" "$auth_out"
grep -q '^THROW' <<<"$(sed -n 6p <<<"$auth_out")" || fail "an unrecognized auth object must be rejected" "$auth_out"
grep -q '^THROW' <<<"$(sed -n 7p <<<"$auth_out")" || fail "an empty keychain alias must be rejected" "$auth_out"

# The resolved token actually reaches the request as a bearer header.
node "$tmpdir/load.mjs" "$api" acme/payments/CLAUDE "tok-abc123" > /dev/null
sent="$(curl -fsS "$api/__auth")"
grep -q 'Bearer tok-abc123' <<<"$sent" || fail "the token should be sent as an Authorization bearer header" "$sent"

# --- 5. Cascade: a github layer over an okf-local layer, sections merged ------

company="$tmpdir/company"; mkdir -p "$company/acme/payments"
cat > "$company/acme/payments/CLAUDE.md" <<'EOF'
---
type: decision
title: Payments Service
updated: 2026-01-10
---

## Engine

MySQL (the company standard).

## Backups

Nightly snapshots to cold storage.
EOF

cat > "$tmpdir/m.json" <<EOF
{ "layers": [
  { "name": "repo",    "level": 3, "source": "github", "repo": "acme/payments", "apiBase": "$api", "auth": { "tokenEnv": "CC_GH_TOKEN" } },
  { "name": "company", "level": 0, "source": "okf-local", "path": "company" }
] }
EOF

res="$(CC_GH_TOKEN=tok-cascade node "$resolver" --manifest "$tmpdir/m.json" --concept acme/payments/CLAUDE)"
grep -q 'Postgres 16' <<<"$res" || fail "the github layer should win the Engine section" "$res"
grep -q '"sourceLayer": "repo"' <<<"$res" || fail "the winning section should carry github-layer provenance" "$res"
grep -q 'Nightly snapshots' <<<"$res" || fail "the okf-local Backups section should be inherited" "$res"
grep -q 'MySQL' <<<"$res" || fail "company dissent should surface in conflicts[]" "$res"

# One merged Engine section across the two adapter kinds — not two parallel ones.
python3 -c "
import json, sys
doc = json.load(sys.stdin)
eng = [s for s in doc['sections'] if s['key'] == 'engine']
assert len(eng) == 1, 'expected ONE merged engine section, got %d' % len(eng)
assert eng[0]['sourceLayer'] == 'repo', eng[0]['sourceLayer']
assert eng[0]['sourceUpdated'] == '2026-06-11', eng[0]['sourceUpdated']
assert any(c['layer'] == 'company' for c in eng[0].get('conflicts', [])), 'company dissent missing'
" <<<"$res" || fail "github and okf-local sections must merge on identical keys" "$res"

# --- 6. Warn-and-continue: a failing remote never fails the resolve ----------

set_mode forbidden
degraded="$(CC_GH_TOKEN=tok node "$resolver" --manifest "$tmpdir/m.json" --concept acme/payments/CLAUDE 2>"$tmpdir/warn.log")"
grep -q 'MySQL' <<<"$degraded" || fail "the company layer should still resolve when github is down" "$degraded"
grep -q '"sourceLayer": "company"' <<<"$degraded" || fail "the surviving section should come from the reachable layer" "$degraded"
grep -q 'unavailable' "$tmpdir/warn.log" || fail "degradation should be announced on stderr" "$(cat "$tmpdir/warn.log")"
if grep -q 'tok' "$tmpdir/warn.log"; then fail "the warning must never echo the token" "$(cat "$tmpdir/warn.log")"; fi

direct="$(node "$tmpdir/load.mjs" "$api" --list 2>/dev/null)"
[ "$direct" = "[]" ] || fail "listConceptIds should degrade to [] when the API is down" "$direct"

set_mode truncated
trunc="$(node "$tmpdir/load.mjs" "$api" --list 2>"$tmpdir/trunc.log")"
grep -q 'CLAUDE' <<<"$trunc" || fail "a truncated tree should still index what it returned" "$trunc"
grep -q 'truncated' "$tmpdir/trunc.log" || fail "a truncated tree should warn" "$(cat "$tmpdir/trunc.log")"

set_mode nocommits
fallback="$(node "$tmpdir/load.mjs" "$api" acme/payments/CLAUDE 2>/dev/null)"
grep -q '"updated":"2026-07-20"' <<<"$fallback" || fail "a forbidden commits call should fall back to pushed_at" "$fallback"
set_mode ""

# A failed REFRESH must serve the last good index rather than blanking the
# layer, and must stop retrying (and stop warning) for the cooldown — otherwise
# a rate limit turns one sweep into one API call per concept.
cat > "$tmpdir/stale.mjs" <<EOF
import { createGithubSource } from "${sources_dir}/github.mjs";
const api = process.argv[2];
const setMode = (v) => fetch(api + "/__mode?value=" + v).then((r) => r.json());
const count = (reset) => fetch(api + "/__count" + (reset ? "?reset=1" : "")).then((r) => r.json()).then((j) => j.requests);
// indexTtlMs 0 forces a refresh attempt on every read; the cooldown is what
// has to hold the retries back.
const s = createGithubSource({ name: "repo", level: 3, repo: "acme/payments", apiBase: api, indexTtlMs: 0, failureCooldownMs: 60000 });
const good = await s.listConceptIds();
if (good.length === 0) throw new Error("expected a populated index before the outage");
await setMode("forbidden");
await count(true);
const during = [];
for (let i = 0; i < 5; i += 1) during.push((await s.listConceptIds()).length);
if (during.some((n) => n !== good.length)) throw new Error("outage should serve the cached index, got " + JSON.stringify(during));
const hits = await count(true);
if (hits > 1) throw new Error("cooldown should cap retries during an outage, got " + hits + " requests");
// sync() is the user-facing escape hatch: it clears the cooldown and retries.
await setMode("");
s.sync();
if ((await s.listConceptIds()).length !== good.length) throw new Error("post-sync read should work again");
if ((await count(false)) === 0) throw new Error("sync() should have forced a real refetch");
s.close();
console.log("STALE-OK");
EOF
stale_out="$(node "$tmpdir/stale.mjs" "$api" 2>"$tmpdir/stale.log")"
grep -q 'STALE-OK' <<<"$stale_out" || fail "stale-serve + failure cooldown" "$stale_out$(cat "$tmpdir/stale.log")"
grep -q 'serving the index cached' "$tmpdir/stale.log" || fail "a stale-serve should announce the cache age" "$(cat "$tmpdir/stale.log")"
[ "$(grep -c 'serving the index cached' "$tmpdir/stale.log")" = "1" ] || fail "the degradation warning should not repeat per read" "$(cat "$tmpdir/stale.log")"

# Partial failure: the index loads but per-file reads are denied. Every concept
# misses, and stderr gets ONE line — an MCP server sweeping a large layer must
# not emit a warning per concept.
cat > "$tmpdir/partial.mjs" <<EOF
import { createGithubSource } from "${sources_dir}/github.mjs";
const api = process.argv[2];
const s = createGithubSource({ name: "repo", level: 3, repo: "acme/payments", apiBase: api });
const ids = await s.listConceptIds();
await fetch(api + "/__mode?value=nocontent").then((r) => r.json());
const loaded = await Promise.all(ids.map((id) => s.loadConcept(id)));
if (loaded.some((c) => c !== null)) throw new Error("denied content reads should miss, not return partial concepts");
if (ids.length < 3) throw new Error("expected several concepts to sweep, got " + ids.length);
s.close();
console.log("PARTIAL-OK " + ids.length);
EOF
partial_out="$(node "$tmpdir/partial.mjs" "$api" 2>"$tmpdir/partial.log")"
grep -q 'PARTIAL-OK' <<<"$partial_out" || fail "denied content reads should degrade to misses" "$partial_out$(cat "$tmpdir/partial.log")"
warn_lines="$(grep -c 'unavailable' "$tmpdir/partial.log" || true)"
[ "$warn_lines" = "1" ] || fail "a swept layer should warn once, not once per concept (got $warn_lines)" "$(cat "$tmpdir/partial.log")"
set_mode ""

# --- 7. Bad repo slugs are config errors, caught at construction --------------

cat > "$tmpdir/slug.mjs" <<EOF
import { createGithubSource } from "${sources_dir}/github.mjs";
for (const repo of ["acme", "acme/pay/extra", "../../etc", "acme/..", "", "acme/pay?x=1", "https://github.com/acme/pay"]) {
  try { createGithubSource({ name: "r", level: 1, repo }); console.log("ACCEPTED " + JSON.stringify(repo)); }
  catch { console.log("REJECTED " + JSON.stringify(repo)); }
}
EOF
slug_out="$(node "$tmpdir/slug.mjs")"
if grep -q 'ACCEPTED' <<<"$slug_out"; then fail "every malformed repo slug must be rejected" "$slug_out"; fi

# --- 8. Cache wrapper: TTL memoization, and sync() reaching the adapter -------

cat > "$tmpdir/cache.mjs" <<EOF
import { createGithubSource } from "${sources_dir}/github.mjs";
import { withCache } from "${sources_dir}/cache.mjs";
let inner = 0;
const src = createGithubSource({ name: "repo", level: 3, repo: "acme/payments", apiBase: process.argv[2] });
const counted = {
  name: src.name, level: src.level,
  loadConcept: (id) => src.loadConcept(id),
  listConceptIds: () => { inner += 1; return src.listConceptIds(); },
  sync: () => src.sync(),
  close: () => src.close(),
};
const cached = withCache(counted, { ttlMs: 60000 });
await cached.listConceptIds();
await cached.listConceptIds();
if (inner !== 1) throw new Error("expected one inner call within ttl, got " + inner);
cached.sync();
await cached.listConceptIds();
if (inner !== 2) throw new Error("sync() should force a refetch, got " + inner);
if (!src.lastSynced) throw new Error("cache sync() must propagate to the adapter's own sync()");
console.log("CACHE-OK");
EOF
cache_out="$(node "$tmpdir/cache.mjs" "$api")"
grep -q 'CACHE-OK' <<<"$cache_out" || fail "cache wrapper over the github adapter" "$cache_out"

echo "github source test passed (glob index + commit dates + credential indirection + cascade merge + degradation + cache)"
