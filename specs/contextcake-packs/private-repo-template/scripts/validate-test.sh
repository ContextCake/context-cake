#!/usr/bin/env bash
set -euo pipefail

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

template_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

copy_template() {
  local dest="$1"
  mkdir -p "$dest"
  cp -R "$template_root/." "$dest/"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

valid="$tmpdir/valid"
copy_template "$valid"
(cd "$valid" && node scripts/validate-okf.mjs) >"$tmpdir/valid.out" 2>&1 || fail "valid fixture should pass"

missing_updated="$tmpdir/missing-updated"
copy_template "$missing_updated"
perl -0pi -e 's/updated: 2026-07-06\n//' "$missing_updated/packs/data-analytics-team/skills/data-analytics-team-pack/overview/pack-purpose.md"
if (cd "$missing_updated" && node scripts/validate-okf.mjs) >"$tmpdir/missing-updated.out" 2>&1; then
  fail "missing updated fixture should fail"
fi
grep -q 'missing frontmatter field "updated"' "$tmpdir/missing-updated.out" || fail "missing updated error should name field"

missing_anchor="$tmpdir/missing-anchor"
copy_template "$missing_anchor"
perl -0pi -e 's/ \{#pack-purpose\}//' "$missing_anchor/packs/data-analytics-team/skills/data-analytics-team-pack/overview/pack-purpose.md"
if (cd "$missing_anchor" && node scripts/validate-okf.mjs) >"$tmpdir/missing-anchor.out" 2>&1; then
  fail "missing anchor fixture should fail"
fi
grep -q 'missing {#anchor}' "$tmpdir/missing-anchor.out" || fail "missing anchor error should mention anchor"

version_mismatch="$tmpdir/version-mismatch"
copy_template "$version_mismatch"
perl -0pi -e 's/version: "0.1.0"/version: "0.2.0"/' "$version_mismatch/packs/data-analytics-team/skills/data-analytics-team-pack/PACK.yaml"
if (cd "$version_mismatch" && node scripts/validate-okf.mjs) >"$tmpdir/version.out" 2>&1; then
  fail "version mismatch fixture should fail"
fi
grep -q 'version mismatch' "$tmpdir/version.out" || fail "version mismatch error should be explicit"

invalid_version="$tmpdir/invalid-version"
copy_template "$invalid_version"
perl -0pi -e 's/version: "0.1.0"/version: "not-a-version"/' "$invalid_version/packs/data-analytics-team/skills/data-analytics-team-pack/PACK.yaml"
if (cd "$invalid_version" && node scripts/validate-okf.mjs) >"$tmpdir/invalid-version.out" 2>&1; then
  fail "invalid version fixture should fail"
fi
grep -q 'version must be semver' "$tmpdir/invalid-version.out" || fail "invalid version error should mention semver"

missing_rights="$tmpdir/missing-rights"
copy_template "$missing_rights"
perl -0pi -e 's/  attested: true\n//' "$missing_rights/packs/data-analytics-team/skills/data-analytics-team-pack/PACK.yaml"
if (cd "$missing_rights" && node scripts/validate-okf.mjs) >"$tmpdir/missing-rights.out" 2>&1; then
  fail "missing rights attestation fixture should fail"
fi
grep -q 'rights.attested' "$tmpdir/missing-rights.out" || fail "missing rights error should name field"

executable="$tmpdir/executable"
copy_template "$executable"
printf 'console.log("not allowed")\n' > "$executable/packs/data-analytics-team/skills/data-analytics-team-pack/run.js"
if (cd "$executable" && node scripts/validate-okf.mjs) >"$tmpdir/executable.out" 2>&1; then
  fail "executable content fixture should fail"
fi
grep -q 'curated Packs may contain only' "$tmpdir/executable.out" || fail "executable error should explain allowlist"

unsafe_permissions="$tmpdir/unsafe-permissions"
copy_template "$unsafe_permissions"
perl -0pi -e 's/  network_access: false/  network_access: true/' "$unsafe_permissions/packs/data-analytics-team/skills/data-analytics-team-pack/PACK.yaml"
if (cd "$unsafe_permissions" && node scripts/validate-okf.mjs) >"$tmpdir/unsafe-permissions.out" 2>&1; then
  fail "unsafe permissions fixture should fail"
fi
grep -q 'permissions.network_access' "$tmpdir/unsafe-permissions.out" || fail "unsafe permission error should name field"

excluded="$tmpdir/excluded"
copy_template "$excluded"
printf '# No Anchor Here\n' >> "$excluded/packs/data-analytics-team/skills/data-analytics-team-pack/START-HERE.md"
(cd "$excluded" && node scripts/validate-okf.mjs) >"$tmpdir/excluded.out" 2>&1 || fail "excluded START-HERE heading should not fail"

echo "validate-test.sh passed"
