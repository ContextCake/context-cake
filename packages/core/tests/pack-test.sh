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
mkdir "$tmpdir/outside-store"
ln -s "$tmpdir/outside-store" "$tmpdir/symlink-store"
if node "$pack_cli" install "$source_pack" --manifest "$tmpdir/manifest.json" --packs-dir "$tmpdir/symlink-store" >/dev/null 2>&1; then
  fail "symlinked Pack store was accepted"
fi

echo "pack test passed (trust validation + immutable install + profile assignment + reviewed update + rollback + retained removal)"
