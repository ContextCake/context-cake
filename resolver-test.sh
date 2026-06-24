#!/usr/bin/env bash
set -euo pipefail

# Proves the cascade read-path: section/field merge with provenance, recency
# tie-break, and shadow-staleness detection. See the worked example in
# docs/architecture.md (§4.4).

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
resolver="$repo_root/resolver.mjs"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

company="$tmpdir/company"
team="$tmpdir/team"
personal="$tmpdir/personal"
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

# Team overrides only the Engine section; records the base hash for shadow detection.
base_ref="$(node "$resolver" --hash "$company/decisions/primary-db.md")"

cat > "$team/decisions/primary-db.md" <<EOF
---
type: decision
title: Primary database
updated: 2026-05-01
override: merge
overrides_layer: company
overrides_ref: ${base_ref}
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

# Team's Engine wins; Company's Backups is inherited (not lost).
if ! grep -q 'SingleStore' <<<"$resolved"; then
  echo "FAIL: Team override of Engine did not win" >&2
  echo "$resolved" >&2
  exit 1
fi
if ! grep -q 'Nightly snapshots' <<<"$resolved"; then
  echo "FAIL: Company Backups section was not inherited" >&2
  echo "$resolved" >&2
  exit 1
fi
if ! grep -q '"sourceLayer": "team"' <<<"$resolved"; then
  echo "FAIL: missing team provenance" >&2
  exit 1
fi
if ! grep -q '"sourceLayer": "company"' <<<"$resolved"; then
  echo "FAIL: missing company provenance" >&2
  exit 1
fi

# Shadow detector: clean before the base changes.
shadow_clean="$(node "$resolver" --manifest "$tmpdir/layers.json" --shadow)"
if ! grep -q '"alerts": \[\]' <<<"$shadow_clean"; then
  echo "FAIL: expected no shadow alerts before base change" >&2
  echo "$shadow_clean" >&2
  exit 1
fi

# Change the Company base; the Team override now shadows newer content.
cat >> "$company/decisions/primary-db.md" <<'EOF'

## Security

Encryption at rest is now required.
EOF

shadow_changed="$(node "$resolver" --manifest "$tmpdir/layers.json" --shadow)"
if ! grep -q 'decisions/primary-db' <<<"$shadow_changed"; then
  echo "FAIL: shadow detector did not flag the changed base" >&2
  echo "$shadow_changed" >&2
  exit 1
fi

# --- Section-level recency: same-level horizontal tie-break (decision B) ---
team_a="$tmpdir/team-a"
team_b="$tmpdir/team-b"
mkdir -p "$team_a/systems" "$team_b/systems"

cat > "$team_a/systems/pipeline.md" <<'EOF'
---
type: system
title: Pipeline
updated: 2026-06-01
---

## Throughput {#throughput updated=2026-01-01}

Team A: 10k events/sec (older measurement).
EOF

cat > "$team_b/systems/pipeline.md" <<'EOF'
---
type: system
title: Pipeline
updated: 2026-01-01
---

## Throughput {#throughput updated=2026-06-01}

Team B: 50k events/sec (newer measurement).
EOF

cat > "$tmpdir/two-teams.json" <<'EOF'
{ "layers": [
  { "name": "team-a", "level": 2, "path": "team-a" },
  { "name": "team-b", "level": 2, "path": "team-b" }
] }
EOF

two_team="$(node "$resolver" --manifest "$tmpdir/two-teams.json" --concept systems/pipeline)"

# team-a's DOCUMENT is newer, but team-b's SECTION is newer -> section recency wins.
if ! grep -q '50k events/sec' <<<"$two_team"; then
  echo "FAIL: section-level recency did not pick the newer section" >&2
  echo "$two_team" >&2
  exit 1
fi
if ! grep -q '"sourceLayer": "team-b"' <<<"$two_team"; then
  echo "FAIL: expected team-b to win the section on section-level recency" >&2
  echo "$two_team" >&2
  exit 1
fi

# --- Null override (decision C): {#anchor override=none} tombstone ---
null_company="$tmpdir/null-company"
null_team="$tmpdir/null-team"
mkdir -p "$null_company/decisions" "$null_team/decisions"

cat > "$null_company/decisions/retention.md" <<'EOF'
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

cat > "$null_team/decisions/retention.md" <<'EOF'
---
type: decision
title: Data retention
updated: 2026-06-01
---

## Exceptions {#exceptions override=none}
EOF

cat > "$tmpdir/null-layers.json" <<'EOF'
{ "layers": [
  { "name": "team", "level": 2, "path": "null-team" },
  { "name": "company", "level": 0, "path": "null-company" }
] }
EOF

null_result="$(node "$resolver" --manifest "$tmpdir/null-layers.json" --concept decisions/retention)"

# Policy section is inherited from company.
if ! grep -q 'Retain all logs' <<<"$null_result"; then
  echo "FAIL: null override test — Policy section should be inherited from company" >&2
  echo "$null_result" >&2
  exit 1
fi

# Exceptions section is suppressed by the team tombstone.
if grep -q 'PII may be purged' <<<"$null_result"; then
  echo "FAIL: null override test — Exceptions section should be suppressed" >&2
  echo "$null_result" >&2
  exit 1
fi

# Suppressed section is recorded with suppressed=true for audit.
if ! grep -q '"suppressed": true' <<<"$null_result"; then
  echo "FAIL: null override test — suppressed section should carry suppressed=true for audit" >&2
  echo "$null_result" >&2
  exit 1
fi

# --- mark-exception (decision D): override: exception is governance metadata only ---
exc_company="$tmpdir/exc-company"
exc_team="$tmpdir/exc-team"
mkdir -p "$exc_company/decisions" "$exc_team/decisions"

cat > "$exc_company/decisions/deploy-window.md" <<'EOF'
---
type: decision
title: Deploy window
updated: 2026-01-01
---

## Window {#window}

Deploys only during Tuesday/Thursday 10am-2pm.

## Approvals {#approvals}

All deploys require two approvals.
EOF

cat > "$exc_team/decisions/deploy-window.md" <<'EOF'
---
type: decision
title: Deploy window
updated: 2026-06-01
override: exception
---

## Window {#window}

This team deploys continuously via automated pipelines.
EOF

cat > "$tmpdir/exc-layers.json" <<'EOF'
{ "layers": [
  { "name": "team", "level": 2, "path": "exc-team" },
  { "name": "company", "level": 0, "path": "exc-company" }
] }
EOF

exc_result="$(node "$resolver" --manifest "$tmpdir/exc-layers.json" --concept decisions/deploy-window)"

# Team's Window section wins (higher level).
if ! grep -q 'automated pipelines' <<<"$exc_result"; then
  echo "FAIL: mark-exception — team Window section should win" >&2
  echo "$exc_result" >&2
  exit 1
fi

# Company Approvals section is inherited (team didn't redefine it).
if ! grep -q 'two approvals' <<<"$exc_result"; then
  echo "FAIL: mark-exception — company Approvals section should be inherited" >&2
  echo "$exc_result" >&2
  exit 1
fi

# Concept-level exception flag is set.
if ! grep -q '"exception": true' <<<"$exc_result"; then
  echo "FAIL: mark-exception — resolved concept should carry exception=true" >&2
  echo "$exc_result" >&2
  exit 1
fi

echo "resolver test passed (section merge + provenance + vertical precedence + section-level recency + shadow detection + null override + mark-exception)"
