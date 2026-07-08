#!/usr/bin/env bash
set -euo pipefail

# Seeds three curated OKF layer bundles for the demo. The team layer disagrees
# with the company language standard, so the resolver returns the team value as
# primary while surfacing the company value as a dated conflict.
# Manifests are committed (relative paths) and are NOT regenerated here.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
layers="$here/layers"
company="$layers/company"; team="$layers/team"; personal="$layers/personal"

rm -rf "$layers"
mkdir -p "$company/decisions" "$team/decisions" "$personal/scratch"

# --- Company base (pre-drift): the org standard ---
cat > "$company/decisions/service-stack.md" <<'HEREDOC'
---
type: decision
title: Service stack standard
updated: 2026-06-01
---

## Language and Framework {#language}

Spring Boot with Java 21. The standard for all new services org-wide.

## Secrets and Auth {#secrets}

Services authenticate via company SSO and read secrets from the company vault. No service-local credential stores.

## Security and Compliance {#security}

PII is encrypted at rest and in transit. Follow the company data-retention policy for all stored records.

## Enforcement {#enforcement}

New services must pass the Spring Boot / Java 21 conformance check in company CI. Existing exemptions must be re-confirmed.
HEREDOC

cat > "$company/index.md" <<'HEREDOC'
---
type: index
title: Company knowledge
---

# Company layer

- [Service stack standard](decisions/service-stack.md)
HEREDOC

# --- Team override: only the Language section (the team's reality) ---
cat > "$team/decisions/service-stack.md" <<'HEREDOC'
---
type: decision
title: Service stack standard
updated: 2026-05-15
---

## Language and Framework {#language}

Scala 2.13 with Spark Structured Streaming for pipelines; Java 17 for remaining legacy services. We do not use Spring Boot — our workloads are streaming/batch, not request/response.
HEREDOC

cat > "$team/index.md" <<'HEREDOC'
---
type: index
title: Data team knowledge
---

# Team layer (Data)

- [Service stack standard](decisions/service-stack.md)
HEREDOC

# --- Personal: present but silent on this concept (an unrelated scratch note) ---
cat > "$personal/scratch/todo.md" <<'HEREDOC'
---
type: note
title: Scratch
---

# Scratch

(Personal layer has no opinion on the service stack — it inherits.)
HEREDOC

cat > "$personal/index.md" <<'HEREDOC'
---
type: index
title: Personal knowledge
---

# Personal layer

Silent on the service stack — inherits from Team and Company.
HEREDOC

echo "Seeded demo layers at $layers"
echo "The team language section intentionally conflicts with the company standard."

# --- Generate MCP configs with ABSOLUTE paths (client launches node from an
#     unpredictable cwd, so relative paths in the config are unsafe). Gitignored. ---
mkdir -p "$here/mcp"
cat > "$here/mcp/full.json" <<HEREDOC
{
  "mcpServers": {
    "contextcake": {
      "command": "node",
      "args": ["$repo_root/mcp-server.mjs", "--manifest", "$here/manifests/full.json"]
    }
  }
}
HEREDOC
cat > "$here/mcp/company-only.json" <<HEREDOC
{
  "mcpServers": {
    "contextcake": {
      "command": "node",
      "args": ["$repo_root/mcp-server.mjs", "--manifest", "$here/manifests/company-only.json"]
    }
  }
}
HEREDOC

echo
echo "MCP configs written (absolute paths). Launch the two demo sessions with:"
echo "  Terminal 1 (cascade):      claude --strict-mcp-config --mcp-config $here/mcp/full.json"
echo "  Terminal 2 (company-only): claude --strict-mcp-config --mcp-config $here/mcp/company-only.json"
