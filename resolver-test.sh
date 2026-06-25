#!/usr/bin/env bash
set -euo pipefail

# Proves the cascade read-path on OKF-local sources: section/field merge with
# provenance, vertical precedence, and per-section suppression. Conflict
# surfacing is covered in Task 5; heterogeneous (MCP) stitch in source-test.sh.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
resolver="$repo_root/resolver.mjs"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

fail() { echo "FAIL: $1" >&2; [ "${2:-}" ] && echo "$2" >&2; exit 1; }

company="$tmpdir/company"; team="$tmpdir/team"; personal="$tmpdir/personal"
mkdir -p "$company/decisions" "$team/decisions" "$personal/scratch"

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
EOF

cat > "$team/decisions/primary-db.md" <<'EOF'
---
type: decision
title: Primary database
updated: 2026-05-01
---

## Engine

SingleStore (chosen for HTAP workloads).
EOF

cat > "$tmpdir/layers.json" <<'EOF'
{
  "layers": [
    { "name": "personal", "level": 3, "path": "personal" },
    { "name": "team",     "level": 2, "path": "team" },
    { "name": "company",  "level": 0, "path": "company" }
  ]
}
EOF

resolved="$(node "$resolver" --manifest "$tmpdir/layers.json" --concept decisions/primary-db)"

grep -q 'SingleStore'     <<<"$resolved" || fail "Team override of Engine did not win" "$resolved"
grep -q 'Nightly snapshots' <<<"$resolved" || fail "Company Backups section was not inherited" "$resolved"
grep -q '"sourceLayer": "team"'    <<<"$resolved" || fail "missing team provenance" "$resolved"
grep -q '"sourceLayer": "company"' <<<"$resolved" || fail "missing company provenance" "$resolved"

# --- Per-section suppression: {#anchor override=none} tombstone (KEPT) ---
sup_company="$tmpdir/sup-company"; sup_team="$tmpdir/sup-team"
mkdir -p "$sup_company/decisions" "$sup_team/decisions"

cat > "$sup_company/decisions/retention.md" <<'EOF'
---
type: decision
title: Data retention
updated: 2026-01-01
---

## Policy {#policy}

Retain all logs for 90 days.

## Exceptions {#exceptions}

PII may be purged earlier on request.
EOF

cat > "$sup_team/decisions/retention.md" <<'EOF'
---
type: decision
title: Data retention
updated: 2026-06-01
---

## Exceptions {#exceptions override=none}
EOF

cat > "$tmpdir/sup-layers.json" <<'EOF'
{ "layers": [
  { "name": "team", "level": 2, "path": "sup-team" },
  { "name": "company", "level": 0, "path": "sup-company" }
] }
EOF

sup="$(node "$resolver" --manifest "$tmpdir/sup-layers.json" --concept decisions/retention)"
grep -q 'Retain all logs' <<<"$sup" || fail "suppression — Policy should be inherited" "$sup"
if grep -q 'PII may be purged' <<<"$sup"; then fail "suppression — Exceptions should be suppressed" "$sup"; fi
grep -q '"suppressed": true' <<<"$sup" || fail "suppression — suppressed section needs suppressed=true for audit" "$sup"

echo "resolver test passed (section merge + provenance + vertical precedence + suppression)"
