#!/usr/bin/env bash
set -euo pipefail

# Proves the files source adapter: a plain directory of docs (.md/.mdx/.txt)
# becomes a context layer — synthesized frontmatter/sections for plain files,
# full OKF parsing delegated to okf-local when frontmatter is present. Also
# proves the cascade over a files layer, the traversal guard, and the TTL
# cache wrapper (memory + disk + sync).

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
resolver="$repo_root/resolver.mjs"
sources_dir="$repo_root/packages/core/src/sources"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
fail() { echo "FAIL: $1" >&2; [ "${2:-}" ] && echo "$2" >&2; exit 1; }

docs="$tmpdir/docs"
mkdir -p "$docs/team" "$docs/.hidden" "$docs/node_modules/pkg"

# --- Fixtures ---------------------------------------------------------------

cat > "$docs/guide.md" <<'EOF'
# Onboarding Guide

Welcome to the team docs.

## Getting Started

Install the CLI first.

## Advanced Topics & Tips

Read the spec.
EOF

cat > "$docs/okf.md" <<'EOF'
---
type: decision
title: OKF-authored doc
updated: 2026-05-01
---

## Engine {#engine updated=2026-04-01}

Postgres.

## Old Section {#legacy override=none}
EOF

cat > "$docs/notes.txt" <<'EOF'
Plain text notes.
Second line.
EOF

cat > "$docs/widget.mdx" <<'EOF'
# Widget

## Props

Takes a size and a label.
EOF

echo "# Roadmap" > "$docs/team/roadmap.md"
echo "should be excluded" > "$docs/.hidden/secret.md"
echo "should be excluded" > "$docs/node_modules/pkg/readme.md"
echo "outside root" > "$tmpdir/secret.md"

# Driver script: load a concept (or list ids) through createFilesSource directly.
cat > "$tmpdir/load.mjs" <<EOF
import { createFilesSource } from "${sources_dir}/files.mjs";
const s = createFilesSource({ name: "docs", level: 2, root: process.argv[2] });
if (process.argv[3] === "--list") console.log(JSON.stringify(await s.listConceptIds()));
else console.log(JSON.stringify(await s.loadConcept(process.argv[3])));
EOF

# Section dates come from file mtime — compute the expected date from the file itself.
guide_date="$(node -e 'console.log(require("node:fs").statSync(process.argv[1]).mtime.toISOString().slice(0,10))' "$docs/guide.md")"

# --- 1. Plain .md: synthesized frontmatter, okf-normalized keys, mtime dates --

guide="$(node "$tmpdir/load.mjs" "$docs" guide)"
grep -q '"type":"document"' <<<"$guide" || fail "plain md should synthesize type: document" "$guide"
grep -q '"title":"Onboarding Guide"' <<<"$guide" || fail "plain md title should come from the H1" "$guide"
grep -q '"key":"overview"' <<<"$guide" || fail "content before the first ## should become overview" "$guide"
grep -q '"key":"getting started"' <<<"$guide" || fail "section keys should use okf-local's normalizeHeading scheme" "$guide"
grep -q '"key":"advanced topics & tips"' <<<"$guide" || fail "normalized keys keep punctuation, lowercase, single spaces" "$guide"
if grep -q '"heading":"# Onboarding Guide"' <<<"$guide"; then fail "the H1 line must not be a section" "$guide"; fi
grep -q "\"updated\":\"$guide_date\"" <<<"$guide" || fail "plain md sections should carry the file mtime date" "$guide"

# --- 2. OKF frontmatter: structured attrs win, document dates fill gaps ------

cat > "$tmpdir/delegate.mjs" <<EOF
import fs from "node:fs";
import { createFilesSource } from "${sources_dir}/files.mjs";
import { parseConcept } from "${sources_dir}/okf-local.mjs";
const s = createFilesSource({ name: "docs", level: 2, root: process.argv[2] });
const viaFiles = await s.loadConcept("okf");
const viaOkf = parseConcept(fs.readFileSync(process.argv[2] + "/okf.md", "utf8"));
if (JSON.stringify(viaFiles.frontmatter) !== JSON.stringify(viaOkf.frontmatter)) throw new Error("frontmatter diverged");
if (viaFiles.sections[0].updated !== viaOkf.sections[0].updated) throw new Error("explicit section date diverged");
if (viaFiles.sections[1].updated !== viaFiles.frontmatter.updated) throw new Error("frontmatter date did not fill the undated section");
console.log("STRUCTURE-PRESERVED");
console.log(JSON.stringify(viaFiles));
EOF
okf_out="$(node "$tmpdir/delegate.mjs" "$docs")"
grep -q 'STRUCTURE-PRESERVED' <<<"$okf_out" || fail "OKF-frontmatter structure and explicit attrs should be preserved" "$okf_out"
grep -q '"key":"engine"' <<<"$okf_out" || fail "OKF {#key} attr should be honored" "$okf_out"
grep -q '"updated":"2026-04-01"' <<<"$okf_out" || fail "OKF updated= attr should be honored" "$okf_out"
grep -q '"override":"none"' <<<"$okf_out" || fail "OKF override= attr should be honored" "$okf_out"

# --- 2b. Adapter parity: same bytes, same dates, whichever adapter reads them --
# An OKF doc with no `updated:` anywhere used to resolve to the mtime through a
# files layer and to null through an okf-local layer.

cat > "$docs/undated.md" <<'EOF'
---
type: decision
title: Undated doc
---

## Engine {#engine}

Postgres.
EOF

cat > "$tmpdir/parity.mjs" <<EOF
import { createFilesSource } from "${sources_dir}/files.mjs";
import { createOkfLocalSource } from "${sources_dir}/okf-local.mjs";
const root = process.argv[2];
const viaFiles = await createFilesSource({ name: "docs", level: 2, root }).loadConcept("undated");
const viaOkf = await createOkfLocalSource({ name: "okf", level: 2, root }).loadConcept("undated");
if (JSON.stringify(viaFiles) !== JSON.stringify(viaOkf)) {
  throw new Error("adapters disagree: " + JSON.stringify({ viaFiles, viaOkf }));
}
console.log(JSON.stringify(viaOkf.sections[0].updated));
EOF
undated_date="$(node -e 'console.log(require("node:fs").statSync(process.argv[1]).mtime.toISOString().slice(0,10))' "$docs/undated.md")"
parity="$(node "$tmpdir/parity.mjs" "$docs")"
grep -q "\"$undated_date\"" <<<"$parity" || fail "an undated OKF doc should fall back to the file mtime in both adapters" "$parity"

# --- 3. .txt, nested ids, exclusions ------------------------------------------

notes="$(node "$tmpdir/load.mjs" "$docs" notes)"
grep -q '"key":"body"' <<<"$notes" || fail ".txt should become a single body section" "$notes"
grep -q '"title":"notes"' <<<"$notes" || fail ".txt title should be the filename stem" "$notes"
grep -q 'Plain text notes.' <<<"$notes" || fail ".txt content should be preserved" "$notes"

mdx="$(node "$tmpdir/load.mjs" "$docs" widget)"
grep -q '"key":"props"' <<<"$mdx" || fail ".mdx should parse like plain markdown" "$mdx"

ids="$(node "$tmpdir/load.mjs" "$docs" --list)"
grep -q '"team/roadmap"' <<<"$ids" || fail "nested files should list with / ids" "$ids"
grep -q '"notes"' <<<"$ids" || fail ".txt files should be listed" "$ids"
grep -q '"widget"' <<<"$ids" || fail ".mdx files should be listed" "$ids"
if grep -q 'secret' <<<"$ids"; then fail "dot-directories should be excluded" "$ids"; fi
if grep -q 'readme' <<<"$ids"; then fail "node_modules should be excluded" "$ids"; fi

# --- 4. Cascade: files layer over an okf-local layer via the resolver CLI -----

company="$tmpdir/company"; mkdir -p "$company/decisions" "$docs/decisions"
cat > "$company/decisions/primary-db.md" <<'EOF'
---
type: decision
title: Primary database
updated: 2026-01-10
---

## Engine

Postgres.

## Backups

Nightly snapshots to cold storage.

## Getting Started

Read the company handbook first.
EOF

cat > "$docs/decisions/primary-db.md" <<'EOF'
# Primary database

## Engine

SingleStore (per the team docs folder).

## Getting Started

Skim the team docs folder first.
EOF

cat > "$tmpdir/m.json" <<'EOF'
{ "layers": [
  { "name": "docs",    "level": 2, "source": "files", "path": "docs" },
  { "name": "company", "level": 0, "source": "okf-local", "path": "company" }
] }
EOF

res="$(node "$resolver" --manifest "$tmpdir/m.json" --concept decisions/primary-db)"
grep -q 'SingleStore' <<<"$res" || fail "files layer should win the Engine section" "$res"
grep -q '"sourceLayer": "docs"' <<<"$res" || fail "winning section should carry files-layer provenance" "$res"
grep -q 'Nightly snapshots' <<<"$res" || fail "okf-local Backups section should be inherited" "$res"
grep -q '"sourceLayer": "company"' <<<"$res" || fail "inherited section should carry okf-local provenance" "$res"
grep -q '"conflicts"' <<<"$res" || fail "company Engine dissent should surface as a conflict" "$res"

# Cross-adapter section identity: a multi-word heading defined in BOTH layers
# must merge into ONE section (files layer wins, okf-local dissent surfaced) —
# adapters have to agree on keys or the cascade splits into parallel sections.
gs="$(python3 -c "
import sys, json
secs = [s for s in json.load(open('/dev/stdin'))['sections'] if s['key'] == 'getting started']
assert len(secs) == 1, 'expected ONE merged getting-started section, got %d' % len(secs)
s = secs[0]
print(s['sourceLayer']); print(s['content']); print(json.dumps(s.get('conflicts', [])))
" <<<"$res")" || fail "multi-word heading should merge into one section across adapters" "$res"
grep -q '^docs$' <<<"$gs" || fail "merged multi-word section should be won by the files layer" "$gs"
grep -q 'Skim the team docs folder' <<<"$gs" || fail "merged section content should come from the files layer" "$gs"
grep -q 'company handbook' <<<"$gs" || fail "okf-local dissent should surface in conflicts[]" "$gs"
grep -q '"layer": "company"' <<<"$gs" || fail "conflict should name the okf-local layer" "$gs"

# --- 5. Traversal ids are rejected (null, no crash) ---------------------------

for evil in "../secret" ".." "/etc/passwd" "a/.." "decisions/../../secret"; do
  out="$(node "$tmpdir/load.mjs" "$docs" "$evil")"
  [ "$out" = "null" ] || fail "traversal id '$evil' should load as null" "$out"
done

# --- 6. Cache wrapper: memoization, sync(), TTL expiry, disk round-trip -------

cat > "$tmpdir/cache.mjs" <<EOF
import { createFilesSource } from "${sources_dir}/files.mjs";
import { withCache } from "${sources_dir}/cache.mjs";
import fs from "node:fs";
const root = process.argv[2];
const doc = root + "/notes.txt";
const body = (c) => c.sections[0].lines.join("\n");

// Stale-while-cached, then sync() forces a fresh read.
fs.writeFileSync(doc, "version one");
const s = withCache(createFilesSource({ name: "docs", level: 2, root }), { ttlMs: 60000 });
const first = body(await s.loadConcept("notes"));
fs.writeFileSync(doc, "version two");
const stale = body(await s.loadConcept("notes"));
if (first !== "version one" || stale !== "version one") throw new Error("expected memoized stale read, got: " + stale);
s.sync();
if (!s.lastSynced || Number.isNaN(Date.parse(s.lastSynced))) throw new Error("sync() should set an ISO lastSynced");
const synced = body(await s.loadConcept("notes"));
if (synced !== "version two") throw new Error("post-sync read should be fresh, got: " + synced);

// TTL expiry with a tiny ttl.
const t = withCache(createFilesSource({ name: "docs", level: 2, root }), { ttlMs: 40 });
await t.loadConcept("notes");
fs.writeFileSync(doc, "version three");
await new Promise((r) => setTimeout(r, 80));
const expired = body(await t.loadConcept("notes"));
if (expired !== "version three") throw new Error("expired ttl should re-read the source, got: " + expired);

// Disk round-trip: a cold wrapper (fresh memory) serves from cacheDir within ttl.
const cacheDir = process.argv[3];
const warm = withCache(createFilesSource({ name: "docs", level: 2, root }), { ttlMs: 60000, cacheDir });
await warm.loadConcept("team/roadmap");
const entry = cacheDir + "/docs/" + encodeURIComponent("concept:team/roadmap") + ".json";
if (!fs.existsSync(entry)) throw new Error("disk cache entry missing: " + entry);
fs.writeFileSync(root + "/team/roadmap.md", "# Changed underneath");
const cold = withCache(createFilesSource({ name: "docs", level: 2, root }), { ttlMs: 60000, cacheDir });
const fromDisk = await cold.loadConcept("team/roadmap");
if (fromDisk.frontmatter.title !== "Roadmap") throw new Error("cold wrapper should serve the disk entry, got: " + fromDisk.frontmatter.title);
cold.sync();
if (fs.existsSync(entry)) throw new Error("sync() should clear the disk cache");
const refetched = await cold.loadConcept("team/roadmap");
if (refetched.frontmatter.title !== "Changed underneath") throw new Error("post-sync disk read should be fresh");
console.log("CACHE-OK");
EOF
cache_out="$(node "$tmpdir/cache.mjs" "$docs" "$tmpdir/cache")"
grep -q 'CACHE-OK' <<<"$cache_out" || fail "cache wrapper behavior" "$cache_out"

echo "files source test passed (plain md/mdx/txt synthesis + OKF delegation + cascade + traversal guard + cache)"
