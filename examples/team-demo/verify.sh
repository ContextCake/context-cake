#!/usr/bin/env bash
set -euo pipefail

# Asserts the curated demo data resolves exactly as the RUNBOOK scripts it.
# Run this BEFORE any live demo. Mirrors resolver-test.sh.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
resolver="$repo_root/resolver.mjs"
full="$here/manifests/full.json"
company_only="$here/manifests/company-only.json"

fail() { echo "FAIL: $1" >&2; [ "${2:-}" ] && echo "$2" >&2; exit 1; }

[ -d "$here/layers/company" ] || fail "layers not seeded — run demo/setup.sh first"

# 1. Full cascade: Team wins Language; Company Secrets/Security inherited.
resolved="$(node "$resolver" --manifest "$full" --concept decisions/service-stack)"
grep -q 'Scala'        <<<"$resolved" || fail "Team Scala/Spark did not win Language" "$resolved"
grep -q 'Spark'        <<<"$resolved" || fail "Team Spark guidance missing" "$resolved"
grep -q 'company vault' <<<"$resolved" || fail "Company Secrets section not inherited" "$resolved"
grep -q 'encrypted at rest' <<<"$resolved" || fail "Company Security section not inherited" "$resolved"
grep -q '"sourceLayer": "team"'    <<<"$resolved" || fail "missing team provenance" "$resolved"
grep -q '"sourceLayer": "company"' <<<"$resolved" || fail "missing company provenance" "$resolved"

# 2. Conflict: Company dissent is surfaced with its later updated date.
grep -q '"conflicts"' <<<"$resolved" || fail "Language disagreement should surface as conflicts[]" "$resolved"
grep -q 'Spring Boot with Java 21' <<<"$resolved" || fail "Company dissent value should be present" "$resolved"
grep -q '"layer": "company"' <<<"$resolved" || fail "Conflict should name the company layer" "$resolved"
grep -q '2026-06-01' <<<"$resolved" || fail "Conflict should carry company updated date" "$resolved"

# 3. Company-only: only Spring Boot, no Team override.
co="$(node "$resolver" --manifest "$company_only" --concept decisions/service-stack)"
grep -q 'Spring Boot' <<<"$co" || fail "company-only missing Spring Boot" "$co"
# Inverted assertion: use the if-form (matches resolver-test.sh idiom) so there is
# zero ambiguity under `set -euo pipefail`.
if grep -q 'Scala' <<<"$co"; then fail "company-only leaked Team Scala override" "$co"; fi

echo "demo verify passed (resolution + inheritance + provenance + conflicts + company-only)"
