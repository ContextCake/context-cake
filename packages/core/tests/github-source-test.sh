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
# Serves one repo (acme/payments), including real subtree listings
# (GET .../git/trees/{ref}:{dir}) so path-scoped indexing is actually
# exercised rather than mocked. POST-free mode switch drives failure paths:
#   forbidden  -> 403 on everything (rate limit / bad token)
#   nocommits  -> 403 on /commits only (exercises the pushed_at fallback)
#   nocontent  -> 403 on /contents only (index fine, per-file reads denied)
#   truncated  -> every tree listing comes back truncated
#   bigrepo    -> only the WHOLE-tree listing truncates, as a monorepo does;
#                 subtrees answer in full

cat > "$tmpdir/api.mjs" <<'EOF'
import http from "node:http";

const FILES = {
  "CLAUDE.md": "# Payments Service\n\nHouse rules for the payments repo.\n\n## Engine\n\nPostgres 16 (per the repo).\n\n## Getting Started\n\nRead the repo CLAUDE.md first.\n",
  "docs/runbook.md": "# Runbook\n\n## Oncall\n\nPage the payments rotation.\n",
  "docs/deep/nested.md": "# Nested\n\n## Detail\n\nStill indexed by docs/**.\n",
  "docs/okf.md": "---\ntype: decision\ntitle: OKF-authored in-repo\nupdated: 2026-05-01\n---\n\n## Engine {#engine updated=2026-04-01}\n\nSingleStore.\n",
  "docs/okf-undated.md": "---\ntype: decision\ntitle: Undated OKF document\n---\n\n## Engine\n\nPostgres.\n",
  "notes.txt": "Loose text note.\n",
  // Same concept id from two extensions — precedence must not depend on the
  // order GitHub returns the tree in.
  "docs/dup.md": "# Dup\n\n## Body\n\nfrom the md file.\n",
  "docs/dup.txt": "from the txt file.\n",
  "src/index.js": "should never be indexed (not a doc extension)",
  "internal/private.md": "should never be indexed (outside the path globs)",
};
const COMMIT_DATES = {
  "CLAUDE.md": "2026-06-11T09:00:00Z",
  "docs/runbook.md": "2026-03-02T09:00:00Z",
  "docs/okf-undated.md": "2026-02-14T09:00:00Z",
};
// Mutable so a test can simulate an upstream edit between index generations.
let editedDate = null;
let reverseTree = false;

let mode = null;
let lastAuth = null;
let requests = 0;
let treeCalls = []; // which trees were actually requested — scoping is about the REQUEST

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const raw = (body) => { res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) }); res.end(body); };

  // Test-only control endpoints (not part of the GitHub API surface).
  if (url.pathname === "/__auth") return json(200, { authorization: lastAuth });
  if (url.pathname === "/__mode") { mode = url.searchParams.get("value") || null; return json(200, { mode }); }
  if (url.pathname === "/__count") { const n = requests; if (url.searchParams.get("reset")) requests = 0; return json(200, { requests: n }); }
  if (url.pathname === "/__edit") { editedDate = url.searchParams.get("date") || null; return json(200, { editedDate }); }
  if (url.pathname === "/__reverse") { reverseTree = url.searchParams.get("on") === "1"; return json(200, { reverseTree }); }
  if (url.pathname === "/__trees") { const t = treeCalls; if (url.searchParams.get("reset")) treeCalls = []; return json(200, { trees: t }); }

  requests += 1;
  lastAuth = req.headers.authorization ?? null;
  if (mode === "forbidden") return json(403, { message: "API rate limit exceeded" });

  if (url.pathname === "/repos/acme/payments") {
    return json(200, { default_branch: "main", pushed_at: "2026-07-20T12:00:00Z" });
  }
  // "{ref}" lists the root, "{ref}:{dir}" the tree object at that path; without
  // ?recursive=1 only the entries directly at that level. Paths in a subtree
  // response are RELATIVE to the subtree — the caller has to re-prefix them.
  const treeReq = url.pathname.match(/^\/repos\/acme\/payments\/git\/trees\/(.+)$/);
  if (treeReq) {
    const [refPart, dirPart = ""] = treeReq[1].split(":");
    const ref = decodeURIComponent(refPart);
    const dir = dirPart.split("/").filter(Boolean).map(decodeURIComponent).join("/");
    const recursive = url.searchParams.get("recursive") === "1";
    treeCalls.push((dir ? `${ref}:${dir}` : ref) + (recursive ? "?recursive" : ""));
    if (ref !== "main") return json(404, { message: "Not Found" });
    const held = Object.keys(FILES).filter((p) => (dir ? p.startsWith(dir + "/") : true));
    if (dir && held.length === 0) return json(404, { message: "Not Found" }); // no such directory
    const rel = held.map((p) => (dir ? p.slice(dir.length + 1) : p));
    const blobs = rel
      .filter((p) => recursive || !p.includes("/"))
      .map((p) => ({ path: p, type: "blob", size: Buffer.byteLength(FILES[dir ? `${dir}/${p}` : p]) }));
    const subdirs = [...new Set(rel.filter((p) => p.includes("/")).map((p) => p.split("/")[0]))]
      .map((p) => ({ path: p, type: "tree", size: 0 }));
    return json(200, {
      truncated: mode === "truncated" || (mode === "bigrepo" && !dir && recursive),
      tree: (reverseTree ? blobs.reverse() : blobs).concat(subdirs),
    });
  }
  if (url.pathname === "/repos/acme/payments/commits") {
    if (mode === "nocommits") return json(403, { message: "forbidden" });
    const p = url.searchParams.get("path");
    if (editedDate) return json(200, [{ commit: { committer: { date: editedDate } } }]);
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
undated_okf="$(node "$tmpdir/load.mjs" "$api" acme/payments/docs/okf-undated)"
grep -q '"updated":"2026-02-14"' <<<"$undated_okf" || fail "an undated OKF section should inherit the file commit date" "$undated_okf"

# A commit date belongs to the index generation it was read against. When the
# index expires and refreshes, an upstream edit has to show through — a date
# memo that outlives its index reports the old date for the life of the process.
cat > "$tmpdir/dates.mjs" <<EOF
import { createGithubSource } from "${sources_dir}/github.mjs";
const api = process.argv[2];
const s = createGithubSource({ name: "repo", level: 3, repo: "acme/payments", apiBase: api, indexTtlMs: 30 });
const before = (await s.loadConcept("acme/payments/CLAUDE")).sections[0].updated;
await fetch(api + "/__edit?date=2026-09-09T00:00:00Z").then((r) => r.json());
await new Promise((r) => setTimeout(r, 60)); // let the index TTL lapse
const after = (await s.loadConcept("acme/payments/CLAUDE")).sections[0].updated;
await fetch(api + "/__edit").then((r) => r.json()); // clear for later sections
s.close();
if (before !== "2026-06-11") throw new Error("unexpected pre-edit date: " + before);
if (after !== "2026-09-09") throw new Error("an upstream edit should surface after the index refreshes, got " + after);
console.log("DATES-OK");
EOF
dates_out="$(node "$tmpdir/dates.mjs" "$api" 2>&1)"
grep -q 'DATES-OK' <<<"$dates_out" || fail "commit dates must refresh with the index generation" "$dates_out"

# docs/dup.md and docs/dup.txt collapse to one id. files.mjs resolves that by
# extension precedence (.md > .mdx > .txt); github must agree, and must not let
# the answer depend on the order GitHub returned the tree in.
for order in 0 1; do
  curl -fsS "$api/__reverse?on=$order" > /dev/null
  dup="$(node "$tmpdir/load.mjs" "$api" acme/payments/docs/dup)"
  grep -q 'from the md file' <<<"$dup" || fail "extension precedence should pick .md over .txt (tree order $order)" "$dup"
done
curl -fsS "$api/__reverse?on=0" > /dev/null

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
console.log(check({ name: "h", auth: { tokenEnv: "CC_TEST_TOKEN", token: rawLooking } }, {}));
console.log(check({ name: "i", auth: ["CC_TEST_TOKEN"] }, {}));
EOF
auth_out="$(node "$tmpdir/auth.mjs")"
[ "$(sed -n 1p <<<"$auth_out")" = '"s3cret"' ] || fail "a keychain alias should resolve from injected tokens" "$auth_out"
[ "$(sed -n 2p <<<"$auth_out")" = "null" ] || fail "an uninjected alias should be null, not an error" "$auth_out"
[ "$(sed -n 3p <<<"$auth_out")" = "null" ] || fail "no auth block should be null" "$auth_out"
[ "$(sed -n 4p <<<"$auth_out")" = '"from-env"' ] || fail "tokenEnv should resolve headlessly" "$auth_out"
grep -q '^THROW' <<<"$(sed -n 5p <<<"$auth_out")" || fail "a raw credential in a manifest must be rejected" "$auth_out"
grep -q '^THROW' <<<"$(sed -n 6p <<<"$auth_out")" || fail "an unrecognized auth object must be rejected" "$auth_out"
grep -q '^THROW' <<<"$(sed -n 7p <<<"$auth_out")" || fail "an empty keychain alias must be rejected" "$auth_out"
grep -q '^THROW' <<<"$(sed -n 8p <<<"$auth_out")" || fail "tokenEnv plus an embedded credential must be rejected" "$auth_out"
grep -q '^THROW' <<<"$(sed -n 9p <<<"$auth_out")" || fail "an auth array must be rejected" "$auth_out"

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
[ "$trunc" = "[]" ] || fail "a truncated tree must not publish a partial index" "$trunc"
grep -q 'refusing to index incomplete context' "$tmpdir/trunc.log" || fail "a truncated tree should explain the integrity failure" "$(cat "$tmpdir/trunc.log")"

set_mode nocommits
fallback="$(node "$tmpdir/load.mjs" "$api" acme/payments/CLAUDE 2>/dev/null)"
grep -q '"updated":"2026-07-20"' <<<"$fallback" || fail "a forbidden commits call should fall back to pushed_at" "$fallback"
set_mode ""

# A failed REFRESH (including an incomplete tree) must serve the last good index
# rather than blanking the layer, and must stop retrying (and stop warning) for
# the cooldown.
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
await setMode("truncated");
await count(true);
const during = [];
for (let i = 0; i < 5; i += 1) during.push((await s.listConceptIds()).length);
if (during.some((n) => n !== good.length)) throw new Error("outage should serve the cached index, got " + JSON.stringify(during));
const hits = await count(true);
// One refresh attempt is repo metadata plus one call per scope the default
// selectors derive (docs/, .context/, and the root level) = 4. The cooldown
// must prevent the remaining four reads from starting a second attempt.
if (hits > 4) throw new Error("cooldown should cap retries during an outage, got " + hits + " requests");
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

# --- 8. Service: Sync refreshes a remote source, and neither Sync nor the -----
#        graph row reports a green result for a repo it never reached.

cat > "$tmpdir/service-sync.mjs" <<EOF
import fs from "node:fs";
import http from "node:http";
import { createEngineService } from "${repo_root}/packages/core/src/service.mjs";

const [apiBase, manifestPath] = process.argv.slice(2);
fs.writeFileSync(manifestPath, JSON.stringify({ layers: [{
  name: "repo",
  level: 3,
  source: "github",
  repo: "acme/payments",
  apiBase,
  auth: { tokenEnv: "CC_GH_TOKEN" },
  cache: { ttlSeconds: 600 },
}] }));

const service = createEngineService({ manifestPath });
const server = http.createServer(async (req, res) => {
  if (await service.handleRequest(req, res)) return;
  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;

try {
  const warm = await fetch(base + "/api/graph");
  if (!warm.ok) throw new Error("failed to prime service: " + warm.status);
  await fetch(apiBase + "/__count?reset=1");
  const response = await fetch(base + "/api/sources/sync?name=repo", { method: "POST" });
  const body = await response.json();
  if (!response.ok) throw new Error("remote Sync failed: " + JSON.stringify(body));
  if (!body.lastSynced || Number.isNaN(Date.parse(body.lastSynced))) {
    throw new Error("remote Sync did not surface lastSynced: " + JSON.stringify(body));
  }
  const requests = await fetch(apiBase + "/__count").then((r) => r.json()).then((j) => j.requests);
  if (requests < 2) throw new Error("remote Sync did not refresh the GitHub index (requests=" + requests + ")");
  if (body.concepts < 1) throw new Error("a successful Sync should report what it indexed: " + JSON.stringify(body));
  if (!body.lastSuccessAt) throw new Error("a successful Sync should report when the index loaded: " + JSON.stringify(body));

  const graphRow = async () => {
    const g = await fetch(base + "/api/graph").then((r) => r.json());
    return g.sources.find((s) => s.name === "repo");
  };
  const healthy = await graphRow();
  if (healthy.status !== "ok") throw new Error("a working repo should read ok: " + JSON.stringify(healthy));
  if (!healthy.lastSuccessAt) throw new Error("the graph row should carry the index time: " + JSON.stringify(healthy));

  // The adapter swallows API failures so a resolve never dies on a down repo.
  // Sync is the one caller that must not inherit that: the user asked about
  // this repo specifically, so an unreachable one is a failed Sync, not an
  // empty one. Answering 200 {ok:true} here is a green checkmark over an
  // outage — the exact thing a Sync button exists to rule out.
  await fetch(apiBase + "/__mode?value=forbidden");
  const down = await fetch(base + "/api/sources/sync?name=repo", { method: "POST" });
  const downBody = await down.json();
  if (down.ok) throw new Error("Sync against an unreachable repo answered OK: " + JSON.stringify(downBody));
  if (downBody.ok !== false) throw new Error("a failed Sync should report ok:false: " + JSON.stringify(downBody));
  if (!/403/.test(downBody.lastError ?? "")) throw new Error("a failed Sync should surface the API failure: " + JSON.stringify(downBody));
  if (!downBody.lastErrorAt || Number.isNaN(Date.parse(downBody.lastErrorAt))) {
    throw new Error("a failed Sync should timestamp the failure: " + JSON.stringify(downBody));
  }
  if (downBody.concepts !== 0) throw new Error("a failed Sync indexed nothing: " + JSON.stringify(downBody));

  // The same truth has to reach the Sources table, which reads /api/graph and
  // never sees the Sync response. Listing didn't throw here — it returned [] —
  // so without the adapter's health this row is "ok, 0 concepts": a green dot
  // over an outage, identical to a repo that simply has no docs.
  const broken = await graphRow();
  if (broken.status !== "degraded") throw new Error("an unreachable repo should read degraded: " + JSON.stringify(broken));
  if (!/403/.test(broken.error ?? "")) throw new Error("the degraded row should carry the failure: " + JSON.stringify(broken));
  if (!broken.lastErrorAt || Number.isNaN(Date.parse(broken.lastErrorAt))) {
    throw new Error("the degraded row should timestamp the failure: " + JSON.stringify(broken));
  }
  // Not vacuous: the fixture confirms this layer really did authenticate.
  const sent = await fetch(apiBase + "/__auth").then((r) => r.json());
  if (sent.authorization !== "Bearer " + process.env.CC_GH_TOKEN) {
    throw new Error("expected the layer to authenticate before checking for leaks: " + JSON.stringify(sent));
  }
  if (JSON.stringify(broken).includes(process.env.CC_GH_TOKEN)) {
    throw new Error("a graph row must never echo a credential: " + JSON.stringify(broken));
  }

  // And recovery reads clean again — in the Sync response and in the row.
  await fetch(apiBase + "/__mode?value=");
  const back = await fetch(base + "/api/sources/sync?name=repo", { method: "POST" });
  const backBody = await back.json();
  if (!back.ok || backBody.ok !== true || backBody.lastError !== null) {
    throw new Error("a recovered Sync should report clean: " + JSON.stringify(backBody));
  }
  const recovered = await graphRow();
  if (recovered.status !== "ok" || recovered.error !== null) {
    throw new Error("a recovered repo should read ok again: " + JSON.stringify(recovered));
  }
  if (recovered.conceptCount < 1) throw new Error("a recovered repo should list again: " + JSON.stringify(recovered));
  console.log("SERVICE-SYNC-OK");
} finally {
  service.close();
  await new Promise((resolve) => server.close(resolve));
}
EOF
service_sync_out="$(CC_GH_TOKEN=s3cret-graph node "$tmpdir/service-sync.mjs" "$api" "$tmpdir/service-manifest.json")"
grep -q 'SERVICE-SYNC-OK' <<<"$service_sync_out" || fail "service Sync + graph health reporting" "$service_sync_out"

# --- 9. Cache wrapper: TTL memoization, and sync() reaching the adapter -------

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

# --- 10. Scoped indexing: selectors narrow the REQUEST, not just the result ---
# GitHub truncates a whole-tree listing around 100k entries, and a truncated
# tree is refused rather than indexed half-way — which, for a repo permanently
# over that line, used to mean the layer never worked at all. The selectors are
# the way out: each one names a directory the request can be scoped to.

cat > "$tmpdir/scopes.mjs" <<EOF
import { treeScopes } from "${sources_dir}/github.mjs";
const show = (globs) => JSON.stringify(treeScopes(globs).map((s) => (s.prefix || ".") + (s.recursive ? "/**" : "/*")).sort());
console.log(show(["docs/**"]));
console.log(show(["CLAUDE.md", "AGENTS.md"]));         // literals live in their parent
console.log(show(["docs/**", "docs/adr/**"]));         // a nested scope is already covered
console.log(show(["docs/**", "docs/index.md"]));       // so is a literal under one
console.log(show(["**/*.md", "docs/**"]));             // one prefix-less selector = whole tree
console.log(show(["docs/*.md"]));                      // superset scope; matchers still filter
console.log(show(["a/b/c/*.md"]));                     // the prefix is the whole static head
console.log(show(["../../etc/**", "docs/**"]));        // no path syntax reaches a request
console.log(show(["../../etc/**"]));
EOF
scopes_out="$(node "$tmpdir/scopes.mjs")"
[ "$(sed -n 1p <<<"$scopes_out")" = '["docs/**"]' ] || fail "docs/** should scope to the docs subtree" "$scopes_out"
[ "$(sed -n 2p <<<"$scopes_out")" = '["./*"]' ] || fail "root-level literals should scope to a flat root listing" "$scopes_out"
[ "$(sed -n 3p <<<"$scopes_out")" = '["docs/**"]' ] || fail "a nested recursive scope should collapse into its parent" "$scopes_out"
[ "$(sed -n 4p <<<"$scopes_out")" = '["docs/**"]' ] || fail "a literal under a recursive scope should collapse into it" "$scopes_out"
[ "$(sed -n 5p <<<"$scopes_out")" = '["./**"]' ] || fail "a prefix-less selector must widen the plan to the whole tree" "$scopes_out"
[ "$(sed -n 6p <<<"$scopes_out")" = '["docs/**"]' ] || fail "docs/*.md should scope to docs" "$scopes_out"
[ "$(sed -n 7p <<<"$scopes_out")" = '["a/b/c/**"]' ] || fail "the scope should be the full static head" "$scopes_out"
[ "$(sed -n 8p <<<"$scopes_out")" = '["docs/**"]' ] || fail "a traversing selector must not become a scope" "$scopes_out"
[ "$(sed -n 9p <<<"$scopes_out")" = '[]' ] || fail "a traversing selector must produce no scope at all" "$scopes_out"

# ...and end to end: it reaches no request, and is reported rather than
# resolving to an empty layer that looks legitimately empty.
curl -fsS "$api/__trees?reset=1" > /dev/null
evil="$(node "$tmpdir/load.mjs" "$api" --list "" '../../etc/**' 2>"$tmpdir/evil.log")"
[ "$evil" = "[]" ] || fail "a traversing selector should index nothing" "$evil"
evil_trees="$(curl -fsS "$api/__trees?reset=1")"
[ "$evil_trees" = '{"trees":[]}' ] || fail "a traversing selector must not shape any tree request" "$evil_trees"

# The behavior that matters: a repo whose whole-tree listing always truncates
# still indexes, because the default selectors never ask for the whole tree.
curl -fsS "$api/__trees?reset=1" > /dev/null
set_mode bigrepo
big="$(node "$tmpdir/load.mjs" "$api" --list 2>"$tmpdir/big.log")"
grep -q '"acme/payments/CLAUDE"' <<<"$big" || fail "a repo too big for a whole-tree listing should still index" "$big$(cat "$tmpdir/big.log")"
grep -q '"acme/payments/docs/runbook"' <<<"$big" || fail "docs/** should index through its own subtree" "$big"
grep -q '"acme/payments/docs/deep/nested"' <<<"$big" || fail "a scoped fetch should still recurse below its prefix" "$big"
if grep -q 'internal/private' <<<"$big"; then fail "scoping must not widen what the selectors admit" "$big"; fi

trees="$(curl -fsS "$api/__trees?reset=1")"
if grep -q '"main?recursive"' <<<"$trees"; then fail "prefixed selectors must not request the whole recursive tree" "$trees"; fi
grep -q 'main:docs?recursive' <<<"$trees" || fail "docs/** should be fetched as a subtree" "$trees"
grep -q '"main"' <<<"$trees" || fail "root-level literals should be fetched as a flat root listing" "$trees"

# A selector with no static prefix has nothing to narrow with, so the whole tree
# is still the only correct request — and on this repo it still refuses rather
# than publishing half an index as complete.
anchorless="$(node "$tmpdir/load.mjs" "$api" --list "" '**/*.md' 2>"$tmpdir/anchorless.log")"
[ "$anchorless" = "[]" ] || fail "a prefix-less selector must not index a truncated tree" "$anchorless"
grep -q 'refusing to index incomplete context' "$tmpdir/anchorless.log" || fail "the prefix-less fallback should still refuse a truncated tree" "$(cat "$tmpdir/anchorless.log")"
trees="$(curl -fsS "$api/__trees?reset=1")"
grep -q '"main?recursive"' <<<"$trees" || fail "a prefix-less selector should fall back to the whole tree" "$trees"

# A subtree that truncates on its own is refused too, naming the scope — the
# actionable fix is a narrower selector for that directory.
set_mode truncated
subtrunc="$(node "$tmpdir/load.mjs" "$api" --list "" 'docs/**' 2>"$tmpdir/subtrunc.log")"
[ "$subtrunc" = "[]" ] || fail "a truncated subtree must still be refused" "$subtrunc"
grep -q 'acme/payments:docs' "$tmpdir/subtrunc.log" || fail "the refusal should name the subtree that truncated" "$(cat "$tmpdir/subtrunc.log")"
set_mode ""

# Selectors are written for a family of repos, so a directory this one lacks is
# a miss, not a failure...
mixed="$(node "$tmpdir/load.mjs" "$api" --list "" 'docs/**,nosuchdir/**' 2>"$tmpdir/mixed.log")"
grep -q 'docs/runbook' <<<"$mixed" || fail "a missing subtree must not fail the whole index" "$mixed$(cat "$tmpdir/mixed.log")"

# ...but when nothing resolves at all, that is configuration, not an empty repo.
none="$(node "$tmpdir/load.mjs" "$api" --list "" 'nosuchdir/**' 2>"$tmpdir/none.log")"
[ "$none" = "[]" ] || fail "a selector matching no directory should index nothing" "$none"
grep -q 'none of the selected paths' "$tmpdir/none.log" || fail "an all-missing selector set should be announced, not silently empty" "$(cat "$tmpdir/none.log")"

# --- 11. health(): what the read path refuses to say --------------------------
# Reads swallow API failures so one down repo can never fail a resolve, which
# leaves "empty repo" and "unreachable repo" looking identical from outside.
# health() is the out-of-band answer, and must not change any read.

cat > "$tmpdir/health.mjs" <<EOF
import { createGithubSource } from "${sources_dir}/github.mjs";
const api = process.argv[2];
const setMode = (v) => fetch(api + "/__mode?value=" + v).then((r) => r.json());
// No TTL and no cooldown: every read is a real refresh attempt, so each health
// assertion below is about the request that just happened.
const s = createGithubSource({
  name: "repo", level: 3, repo: "acme/payments", apiBase: api,
  token: "tok-health", indexTtlMs: 0, failureCooldownMs: 0,
});

const good = await s.listConceptIds();
const fresh = s.health();
if (!fresh.ok || fresh.lastError !== null) throw new Error("a healthy source should report ok: " + JSON.stringify(fresh));
if (!fresh.lastSuccessAt || fresh.indexedConcepts !== good.length) {
  throw new Error("health should report the loaded index: " + JSON.stringify(fresh));
}

// An outage still serves the cached index — the read is unchanged, and health
// is the only place the failure shows up.
await setMode("forbidden");
const during = await s.listConceptIds();
if (during.length !== good.length) throw new Error("health must not change the degraded read path");
const down = s.health();
if (down.ok) throw new Error("a failed refresh should be reported: " + JSON.stringify(down));
if (down.lastErrorScope !== "index") throw new Error("a failed refresh is an index failure: " + JSON.stringify(down));
if (!down.lastErrorAt || Number.isNaN(Date.parse(down.lastErrorAt))) throw new Error("health should timestamp the failure");
if (!down.lastSuccessAt) throw new Error("health should still report when the index last loaded");
if (JSON.stringify(down).includes("tok-health")) throw new Error("health must never echo the token");

await setMode("");
await s.listConceptIds();
if (!s.health().ok) throw new Error("a successful refresh should clear the last error");

// A denied file read is a different failure from an unreachable repo: the
// index is current, one document isn't readable.
await setMode("nocontent");
if ((await s.loadConcept("acme/payments/CLAUDE")) !== null) throw new Error("expected a denied content read to miss");
const partial = s.health();
if (partial.ok || partial.lastErrorScope !== "content") throw new Error("a denied file read should be scoped content: " + JSON.stringify(partial));
if (!partial.lastSuccessAt) throw new Error("a content failure should not erase the index success time");

// sync() is a clean slate: whatever health reports next belongs to the sync.
await setMode("");
s.sync();
if (!s.health().ok) throw new Error("sync() should clear the last error");
if (s.health().lastSuccessAt !== null) throw new Error("sync() drops the index, so there is no success to report yet");
s.close();
console.log("HEALTH-OK");
EOF
health_out="$(node "$tmpdir/health.mjs" "$api" 2>"$tmpdir/health.log")"
grep -q 'HEALTH-OK' <<<"$health_out" || fail "health() reporting" "$health_out$(cat "$tmpdir/health.log")"
if grep -q 'tok-health' "$tmpdir/health.log"; then fail "the degradation warning must never echo the token" "$(cat "$tmpdir/health.log")"; fi
set_mode ""

echo "github source test passed (scoped index + commit dates + credential indirection + cascade merge + degradation + health + cache)"
