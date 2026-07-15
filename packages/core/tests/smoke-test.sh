#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

personal="$tmpdir/personal"
shared="$tmpdir/shared"

mkdir -p "$personal/scratch" "$shared/systems" "$shared/runbooks"

cat > "$personal/scratch/auth-notes.md" <<'EOF'
---
type: concept
title: Auth Notes
tags: [auth]
---

# Auth Notes

Draft notes for the login flow. See [[shared:systems/api-gateway]] and [old private link](personal:runbooks/login.md).
EOF

cat > "$shared/systems/api-gateway.md" <<'EOF'
---
type: system
title: API Gateway
tags: [auth, edge]
---

# API Gateway

Routes login requests to the auth service.
EOF

cat > "$shared/runbooks/login.md" <<'EOF'
---
type: runbook
title: Login Runbook
---

# Login Runbook

Operational checklist for login incidents.
EOF

node "$repo_root/promote.mjs" \
  --personal "$personal" \
  --shared "$shared" \
  --file scratch/auth-notes

responses="$(
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"login","bundle":"both","limit":5}}}' \
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_links","arguments":{"concept_id":"scratch/auth-notes","bundle":"shared"}}}' \
    '{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}' |
    node "$repo_root/mcp-server.mjs" --personal "$personal" --shared "$shared"
)"

if ! grep -q '"name":"contextcake"' <<<"$responses"; then
  echo "Missing initialize response" >&2
  exit 1
fi

if ! grep -q '"instructions":"Consult ContextCake before answering project-specific questions.' <<<"$responses"; then
  echo "Missing MCP server instructions" >&2
  exit 1
fi

if ! grep -q '"readOnlyHint":true' <<<"$responses"; then
  echo "Missing read-only MCP tool annotations" >&2
  exit 1
fi

if ! grep -q 'scratch/auth-notes' <<<"$responses"; then
  echo "Search did not return promoted concept" >&2
  exit 1
fi

if ! grep -q 'systems/api-gateway' <<<"$responses"; then
  echo "Link resolution did not find shared API Gateway" >&2
  exit 1
fi

if ! grep -q 'Login Runbook' "$shared/index.md"; then
  echo "Shared index was not rebuilt" >&2
  exit 1
fi

cat > "$tmpdir/event.json" <<'EOF'
{
  "repo": "identity-service",
  "source": "pull_request",
  "type": "pr_merged",
  "title": "JWT audience contract changed for internal clients",
  "body": "Updates auth behavior across service boundaries.",
  "labels": ["api-contract"],
  "paths": ["auth/jwt.ts"]
}
EOF

classification="$(node "$repo_root/classify-context.mjs" --event "$tmpdir/event.json")"

if ! grep -q '"route": "review_required"' <<<"$classification"; then
  echo "Classifier did not flag auth contract change for review" >&2
  exit 1
fi

# Ingestion pipeline: mock events -> classifier -> dashboard signals.json
signals_out="$tmpdir/signals.json"
node "$repo_root/ingest.mjs" \
  --events "$repo_root/packages/core/fixtures/mock-events.json" \
  --repos "$repo_root/packages/core/fixtures/repos.json" \
  --out "$signals_out"

if [ ! -f "$signals_out" ]; then
  echo "Ingest did not write signals.json" >&2
  exit 1
fi

for route in review_required team_candidate ignore; do
  if ! grep -q "\"route\": \"$route\"" "$signals_out"; then
    echo "Ingest output missing expected route: $route" >&2
    exit 1
  fi
done

# Cascade-aware MCP: manifest mode resolves the effective concept with provenance.
cat > "$tmpdir/mcp-layers.json" <<EOF
{ "layers": [
  { "name": "personal", "level": 3, "path": "$personal" },
  { "name": "shared",   "level": 0, "path": "$shared" }
] }
EOF

mcp_resolved="$(
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_file","arguments":{"concept_id":"systems/api-gateway"}}}' |
    node "$repo_root/mcp-server.mjs" --manifest "$tmpdir/mcp-layers.json"
)"

if ! grep -q 'API Gateway' <<<"$mcp_resolved"; then
  echo "Cascade MCP read_file did not resolve systems/api-gateway" >&2
  echo "$mcp_resolved" >&2
  exit 1
fi
if ! grep -q 'sourceLayer' <<<"$mcp_resolved"; then
  echo "Cascade MCP read_file did not return section provenance" >&2
  echo "$mcp_resolved" >&2
  exit 1
fi

# Write-path: signals -> OKF layer bundle.
write_layer="$tmpdir/write-team"
mkdir -p "$write_layer"

cat > "$tmpdir/write-manifest.json" <<EOF
{ "layers": [
  { "name": "team", "level": 2, "path": "$write_layer" }
] }
EOF

# Run ingest to produce a fresh signals file, then feed it to write.mjs.
ingest_signals="$tmpdir/write-signals.json"
node "$repo_root/ingest.mjs" \
  --events "$repo_root/packages/core/fixtures/mock-events.json" \
  --repos "$repo_root/packages/core/fixtures/repos.json" \
  --out "$ingest_signals"

node "$repo_root/write.mjs" \
  --signals "$ingest_signals" \
  --manifest "$tmpdir/write-manifest.json" \
  --target-layer team

# team_candidate concepts should be written directly into the layer.
team_candidate_files="$(find "$write_layer" -name '*.md' ! -path '*/_review/*' | wc -l | tr -d ' ')"
if [ "$team_candidate_files" -lt 1 ]; then
  echo "Write-path: no team_candidate concepts written to layer" >&2
  exit 1
fi

# review_required concepts should be staged under _review/.
review_files="$(find "$write_layer/_review" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$review_files" -lt 1 ]; then
  echo "Write-path: no review_required concepts staged under _review/" >&2
  exit 1
fi

# Written concepts should be valid OKF (have frontmatter with type and draft: true).
sample_file="$(find "$write_layer" -name '*.md' ! -path '*/_review/*' | head -1)"
if ! grep -q 'draft: true' "$sample_file"; then
  echo "Write-path: written concept missing draft: true frontmatter" >&2
  exit 1
fi

echo "contextcake smoke test passed"
