#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
pack_cli="$repo_root/pack.mjs"
source_pack="$repo_root/specs/contextcake-packs/packs/contextcake"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

mkdir -p "$tmpdir/personal/decisions" "$tmpdir/team"
cat > "$tmpdir/personal/decisions/local-only.md" <<'EOF'
---
type: decision
updated: 2026-07-17
---

## Local {#local}

This overlay must survive every Pack operation.
EOF

cat > "$tmpdir/manifest.json" <<'EOF'
{
  "layers": [
    { "name": "personal", "level": 3, "source": "okf-local", "path": "personal" }
  ],
  "profiles": {
    "work": {
      "label": "Work",
      "layers": [
        { "name": "team", "level": 2, "source": "okf-local", "path": "team" }
      ]
    }
  }
}
EOF

node "$pack_cli" inspect "$source_pack" > "$tmpdir/inspect.json"
node -e 'const p=require(process.argv[1]); if(p.id!=="contextcake"||p.permissions.networkAccess!==false||!p.checksum.startsWith("sha256:")||!p.heroWorkflow||p.samples.length<1||p.changelog!=="updates/CHANGELOG.md") process.exit(1)' "$tmpdir/inspect.json" \
  || fail "inspect did not return the verified trust contract"

node "$pack_cli" install "$source_pack" --manifest "$tmpdir/manifest.json" --packs-dir "$tmpdir/packs" --level 0 > "$tmpdir/install.json"
test -f "$tmpdir/packs/contextcake/0.1.0/PACK.yaml" || fail "versioned Pack files were not installed"
test -f "$tmpdir/personal/decisions/local-only.md" || fail "install removed the local overlay"
node - "$tmpdir/manifest.json" <<'NODE' || fail "install did not create exactly one Pack base layer"
const fs = require('node:fs')
const m = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (m.layers.length !== 2) process.exit(1)
if (m.layers[0].name !== 'personal') process.exit(1)
const layer = m.layers.find((entry) => entry.origin === 'pack:contextcake@0.1.0')
if (!layer || layer.level !== 0 || layer.path !== 'packs/contextcake/0.1.0') process.exit(1)
if (m.packs.contextcake.installedVersions.length !== 1) process.exit(1)
NODE

# Installing into a named profile must not mutate the default layer stack.
node "$pack_cli" install "$source_pack" --manifest "$tmpdir/manifest.json" --packs-dir "$tmpdir/packs" --profile work --level 1 > /dev/null
node - "$tmpdir/manifest.json" <<'NODE' || fail "profile Pack assignment was not isolated"
const fs = require('node:fs')
const m = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (m.layers.filter((entry) => entry.origin?.startsWith('pack:contextcake@')).length !== 1) process.exit(1)
if (m.profiles.work.layers.filter((entry) => entry.origin === 'pack:contextcake@0.1.0').length !== 1) process.exit(1)
NODE

# A new version becomes active without overwriting the retained first version.
cp -R "$source_pack" "$tmpdir/contextcake-v2"
sed -i.bak 's/version: "0.1.0"/version: "0.2.0"/' "$tmpdir/contextcake-v2/PACK.yaml"
rm "$tmpdir/contextcake-v2/PACK.yaml.bak"
node "$pack_cli" update "$tmpdir/contextcake-v2" --manifest "$tmpdir/manifest.json" --packs-dir "$tmpdir/packs" > "$tmpdir/update-preview.json"
grep -q '"action": "update-preview"' "$tmpdir/update-preview.json" || fail "update did not produce a reviewable preview"
grep -q '"PACK.yaml"' "$tmpdir/update-preview.json" || fail "update preview did not identify the changed manifest"
test ! -e "$tmpdir/packs/contextcake/0.2.0" || fail "update preview wrote the candidate version"
grep -q 'pack:contextcake@0.1.0' "$tmpdir/manifest.json" || fail "update preview switched the active layer"
node "$pack_cli" update "$tmpdir/contextcake-v2" --manifest "$tmpdir/manifest.json" --packs-dir "$tmpdir/packs" --level 0 --apply > /dev/null
test -f "$tmpdir/packs/contextcake/0.1.0/PACK.yaml" || fail "update deleted the prior Pack version"
test -f "$tmpdir/packs/contextcake/0.2.0/PACK.yaml" || fail "update did not install the new Pack version"
node - "$tmpdir/manifest.json" <<'NODE' || fail "update duplicated the Pack layer or changed the overlay"
const fs = require('node:fs')
const m = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (m.layers.length !== 2 || m.layers[0].name !== 'personal') process.exit(1)
if (!m.layers.some((entry) => entry.origin === 'pack:contextcake@0.2.0')) process.exit(1)
if (m.packs.contextcake.installedVersions.length !== 2) process.exit(1)
NODE

node "$pack_cli" rollback contextcake --manifest "$tmpdir/manifest.json" --packs-dir "$tmpdir/packs" > /dev/null
grep -q 'pack:contextcake@0.1.0' "$tmpdir/manifest.json" || fail "rollback did not reactivate the retained version"

node "$pack_cli" remove contextcake --manifest "$tmpdir/manifest.json" > "$tmpdir/remove.json"
grep -q '"0.2.0"' "$tmpdir/remove.json" || fail "remove did not report retained versions"
test -f "$tmpdir/packs/contextcake/0.2.0/PACK.yaml" || fail "remove deleted retained Pack content"
test -f "$tmpdir/personal/decisions/local-only.md" || fail "remove deleted the local overlay"
node - "$tmpdir/manifest.json" <<'NODE' || fail "remove left the default Pack layer attached"
const fs = require('node:fs')
const m = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (m.layers.some((entry) => entry.origin?.startsWith('pack:contextcake@'))) process.exit(1)
if (!m.profiles.work.layers.some((entry) => entry.origin === 'pack:contextcake@0.1.0')) process.exit(1)
NODE

# Content-only and integrity boundaries fail closed.
cp -R "$source_pack" "$tmpdir/unsafe-pack"
printf 'console.log("no")\n' > "$tmpdir/unsafe-pack/run.js"
if node "$pack_cli" inspect "$tmpdir/unsafe-pack" >/dev/null 2>&1; then fail "executable Pack content was accepted"; fi
cp -R "$source_pack" "$tmpdir/no-changelog"
rm "$tmpdir/no-changelog/updates/CHANGELOG.md"
if node "$pack_cli" inspect "$tmpdir/no-changelog" >/dev/null 2>&1; then fail "Pack without its declared changelog was accepted"; fi
cp -R "$source_pack" "$tmpdir/ambiguous-manifest"
printf '\npermissions:\n  content_only: true\n' >> "$tmpdir/ambiguous-manifest/PACK.yaml"
if node "$pack_cli" inspect "$tmpdir/ambiguous-manifest" >/dev/null 2>&1; then fail "Pack with duplicate manifest keys was accepted"; fi
if node "$pack_cli" inspect "$source_pack" --checksum sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >/dev/null 2>&1; then
  fail "incorrect external checksum was accepted"
fi
if node "$pack_cli" install "$source_pack" --manifest "$tmpdir/manifest.json" --packs-dir "$tmpdir/packs" --profile missing >/dev/null 2>&1; then
  fail "unknown profile was silently created"
fi

# Canonical v2 uses the explicit default profile id in both the registry and
# the profile layer stack; the legacy null assignment must not leak forward.
cat > "$tmpdir/manifest-v2.json" <<'EOF'
{
  "profiles": {
    "default": { "label": "Default", "layers": [] }
  },
  "projects": {}
}
EOF
node "$pack_cli" install "$source_pack" --manifest "$tmpdir/manifest-v2.json" --packs-dir "$tmpdir/packs-v2" --level 0 >/dev/null
node - "$tmpdir/manifest-v2.json" <<'NODE' || fail "v2 default Pack assignment was not canonical"
const fs = require('node:fs')
const m = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const assignment = m.packs.contextcake.assignments[0]
if (assignment.profile !== 'default') process.exit(1)
if (!m.profiles.default.layers.some((layer) => layer.origin === 'pack:contextcake@0.1.0')) process.exit(1)
if (Object.hasOwn(m, 'layers')) process.exit(1)
NODE

mkdir "$tmpdir/outside-store"
ln -s "$tmpdir/outside-store" "$tmpdir/symlink-store"
if node "$pack_cli" install "$source_pack" --manifest "$tmpdir/manifest.json" --packs-dir "$tmpdir/symlink-store" >/dev/null 2>&1; then
  fail "symlinked Pack store was accepted"
fi

# The content checksum must be a portable code-unit content hash, not locale
# collation. README-extra.md vs data-extra.md sort in opposite order under
# localeCompare, so a locale-sorted engine would diverge from this reference.
cp -R "$source_pack" "$tmpdir/order-pack"
printf 'extra one\n' > "$tmpdir/order-pack/README-extra.md"
printf 'extra two\n' > "$tmpdir/order-pack/data-extra.md"
node "$pack_cli" inspect "$tmpdir/order-pack" > "$tmpdir/order-inspect.json"
node - "$tmpdir/order-pack" "$tmpdir/order-inspect.json" <<'NODE' || fail "checksum is not a deterministic code-unit content hash"
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
const engineChecksum = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).checksum
function walk(dir, base, acc) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const stat = fs.lstatSync(full)
    const rel = path.relative(base, full).split(path.sep).join('/')
    if (stat.isDirectory()) { acc.push({ rel, dir: true }); walk(full, base, acc) }
    else if (stat.isFile()) acc.push({ rel, dir: false })
  }
  return acc
}
const entries = walk(root, root, []).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
// Length-prefixed fields: the boundary between path and content must not be
// expressible inside either of them, or one file's bytes could carry the
// framing of another and two different trees would hash alike.
function field(hash, buffer) {
  const length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(buffer.length))
  hash.update(length)
  hash.update(buffer)
}
const hash = crypto.createHash('sha256')
for (const entry of entries) {
  field(hash, Buffer.from(entry.rel, 'utf8'))
  hash.update(entry.dir ? 'd' : 'f')
  if (entry.dir) { field(hash, Buffer.alloc(0)); continue }
  let content = fs.readFileSync(path.join(root, entry.rel))
  if (entry.rel === 'PACK.yaml') content = Buffer.from(content.toString('utf8').replace(/(^\s*checksum:\s*).+$/m, '$1"pending-release"'))
  field(hash, content)
}
const reference = `sha256:${hash.digest('hex')}`
if (reference !== engineChecksum) {
  console.error(`code-unit reference ${reference} != engine ${engineChecksum}`)
  process.exit(1)
}
NODE

# PACK.schema.json and the hand-rolled validator must agree on the commerce
# contract (paid price bands, team seats, pack contract version).
node - "$repo_root" <<'NODE' || fail "PACK.schema.json drifted from the engine commerce contract"
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
;(async () => {
  const engine = await import(path.join(root, 'packages/core/src/pack-manager.mjs'))
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'specs/contextcake-packs/PACK.schema.json'), 'utf8'))
  const paid = schema.allOf[0].then.properties.license
  const bands = paid.oneOf.map((entry) => ({
    personal: entry.properties.personal_price_usd.const,
    team: entry.properties.team_price_usd.const,
  }))
  if (JSON.stringify(bands) !== JSON.stringify(engine.PAID_PRICE_BANDS)) process.exit(1)
  if (paid.properties.team_seats.const !== engine.PAID_TEAM_SEATS) process.exit(1)
  if (schema.properties.compatibility.properties.pack_contract.const !== engine.PACK_CONTRACT) process.exit(1)
})().catch((error) => { console.error(error); process.exit(1) })
NODE

# Finder writes .DS_Store into any folder a Mac user opens, so a Pack author
# could fail their own install by looking at their Pack. The walk and the copy
# must agree about ignoring it: if only the walk skipped it, the file would
# install unvalidated and outside the checksum, and hidden content could then
# change a Pack without changing its identity.
#
# Junk is a fact about who wrote the file, not about whether its name starts
# with a dot: Finder also writes Icon\r for a custom folder icon and Explorer
# writes Thumbs.db, none of which the author chose.
cp -R "$source_pack" "$tmpdir/junked-pack"
printf 'Mac Finder junk\0' > "$tmpdir/junked-pack/.DS_Store"
mkdir -p "$tmpdir/junked-pack/updates"
printf 'more junk\0' > "$tmpdir/junked-pack/updates/.DS_Store"
printf 'icon junk' > "$tmpdir/junked-pack/$(printf 'Icon\r')"
printf 'thumb junk' > "$tmpdir/junked-pack/Thumbs.db"
printf 'ini junk' > "$tmpdir/junked-pack/desktop.ini"
printf 'apple double' > "$tmpdir/junked-pack/._overview"

node "$pack_cli" inspect "$tmpdir/junked-pack" > "$tmpdir/junked-inspect.json" \
  || fail "a Pack containing .DS_Store failed to inspect"

node - "$tmpdir/inspect.json" "$tmpdir/junked-inspect.json" <<'NODE' || fail "OS junk changed the Pack checksum — a Finder visit must not change a Pack's identity"
const fs = require('node:fs')
const clean = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const junked = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
if (clean.checksum !== junked.checksum) process.exit(1)
NODE

cat > "$tmpdir/junk-manifest.json" <<'EOF'
{ "layers": [] }
EOF
node "$pack_cli" install "$tmpdir/junked-pack" --manifest "$tmpdir/junk-manifest.json" --packs-dir "$tmpdir/junk-packs" --level 0 > /dev/null \
  || fail "a Pack containing .DS_Store failed to install"
test -f "$tmpdir/junk-packs/contextcake/0.1.0/PACK.yaml" || fail "the Pack did not install"
test -e "$tmpdir/junk-packs/contextcake/0.1.0/.DS_Store" && fail "install copied a file the checksum never covered"
test -e "$tmpdir/junk-packs/contextcake/0.1.0/updates/.DS_Store" && fail "install copied nested junk the checksum never covered"
test -e "$tmpdir/junk-packs/contextcake/0.1.0/Thumbs.db" && fail "install copied Windows junk the checksum never covered"

# Hidden is NOT the same as incidental. An author who ships .claude/skills or a
# dotfile chose that content, and dropping it silently would change the Pack's
# checksum — which breaks rollback and re-attach on an ALREADY INSTALLED Pack,
# because both re-verify against the checksum recorded in the manifest.
cp -R "$source_pack" "$tmpdir/hidden-pack"
printf '# authored\n' > "$tmpdir/hidden-pack/.hidden-note.md"
mkdir -p "$tmpdir/hidden-pack/.claude/skills"
printf '# skill\n' > "$tmpdir/hidden-pack/.claude/skills/review.md"
node "$pack_cli" inspect "$tmpdir/hidden-pack" > "$tmpdir/hidden-inspect.json" \
  || fail "a Pack shipping hidden authored content failed to inspect"
node - "$tmpdir/inspect.json" "$tmpdir/hidden-inspect.json" <<'NODE' || fail "authored hidden content was dropped from the Pack — it must be validated, checksummed and installed"
const fs = require('node:fs')
const clean = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const hidden = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
if (!hidden.files.includes('.hidden-note.md')) process.exit(1)
if (!hidden.files.includes('.claude/skills/review.md')) process.exit(1)
if (clean.checksum === hidden.checksum) process.exit(1)
NODE

# The checksum must name exactly one tree. The old framing was
# `path \0 content \0`, and content can contain NUL — so a file's bytes could
# carry the framing of a second file and two different trees hashed alike. A
# Pack is context injected into an agent's graph: "an extra file appears
# without the identity changing" is the thing this checksum exists to stop.
cp -R "$source_pack" "$tmpdir/smuggle-a"
cp -R "$source_pack" "$tmpdir/smuggle-b"
printf 'Reviewed, benign.\n\0zz-b.md\0# INJECTED\n' > "$tmpdir/smuggle-a/zz-a.md"
printf 'Reviewed, benign.\n' > "$tmpdir/smuggle-b/zz-a.md"
printf '# INJECTED\n' > "$tmpdir/smuggle-b/zz-b.md"
node "$pack_cli" inspect "$tmpdir/smuggle-a" > "$tmpdir/smuggle-a.json" || fail "smuggle fixture A failed to inspect"
reviewed_checksum=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).checksum)' "$tmpdir/smuggle-a.json")
if node "$pack_cli" inspect "$tmpdir/smuggle-b" --checksum "$reviewed_checksum" > /dev/null 2>&1; then
  fail "a Pack carrying an extra file passed under the reviewed Pack's checksum — the checksum framing is forgeable"
fi

# An empty directory is installed by the copy, so it has to appear in the
# identity of what was installed.
cp -R "$source_pack" "$tmpdir/ghost-pack"
mkdir -p "$tmpdir/ghost-pack/ghost-section"
node "$pack_cli" inspect "$tmpdir/ghost-pack" > "$tmpdir/ghost-inspect.json" || fail "a Pack with an empty directory failed to inspect"
node - "$tmpdir/inspect.json" "$tmpdir/ghost-inspect.json" <<'NODE' || fail "an empty directory installs without changing the checksum"
const fs = require('node:fs')
if (JSON.parse(fs.readFileSync(process.argv[2],'utf8')).checksum === JSON.parse(fs.readFileSync(process.argv[3],'utf8')).checksum) process.exit(1)
NODE

# The guardrail that must survive: a packed repository is still an error, not
# incidental junk to wave through — including .GIT, which IS the git directory
# on a case-insensitive volume, and .git as a file (a submodule checkout).
#
# Asserting only that inspect FAILS is not enough here: a guard that misses
# .GIT still fails, by walking into it and blaming HEAD's content type. The
# error has to name the packed repository, or the guardrail is gone and the
# author is sent to fix the wrong thing.
for repo_entry in .git .GIT; do
  rm -rf "$tmpdir/repo-pack"
  cp -R "$source_pack" "$tmpdir/repo-pack"
  mkdir -p "$tmpdir/repo-pack/$repo_entry"
  printf 'ref: refs/heads/main\n' > "$tmpdir/repo-pack/$repo_entry/HEAD"
  node "$pack_cli" inspect "$tmpdir/repo-pack" > "$tmpdir/repo-out.json" 2>&1 \
    && fail "a Pack containing $repo_entry inspected cleanly; the packed-repo guardrail is gone"
  grep -q "not allowed in a Pack" "$tmpdir/repo-out.json" \
    || fail "$repo_entry was blamed on its content type instead of naming the packed repository"
done
rm -rf "$tmpdir/repo-pack"
cp -R "$source_pack" "$tmpdir/repo-pack"
printf 'gitdir: ../elsewhere\n' > "$tmpdir/repo-pack/.git"
node "$pack_cli" inspect "$tmpdir/repo-pack" > "$tmpdir/repo-file.json" 2>&1 && fail "a Pack containing a .git file inspected cleanly"
grep -q "not allowed in a Pack" "$tmpdir/repo-file.json" \
  || fail "a .git file was blamed on its content type instead of naming the packed repository"

echo "pack test passed (trust validation + immutable install + profile assignment + reviewed update + rollback + retained removal + deterministic checksum + OS junk ignored consistently + authored hidden content kept + unforgeable checksum framing + schema/contract parity)"
