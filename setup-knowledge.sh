#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  setup-knowledge.sh --personal <dir> --shared <dir> [--settings <file>]

Creates starter OKF bundle directories and prints an MCP server config.
If --settings is provided, the MCP server entry is merged into that JSON file
when jq is available. Otherwise the config is printed only.
EOF
}

personal=""
shared=""
settings=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --personal)
      personal="$2"
      shift 2
      ;;
    --shared)
      shared="$2"
      shift 2
      ;;
    --settings)
      settings="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$personal" || -z "$shared" ]]; then
  usage
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server_path="$script_dir/mcp-server.mjs"

mkdir -p "$personal/scratch" "$personal/drafts" "$shared/decisions" "$shared/systems" "$shared/runbooks"

write_index() {
  local file="$1"
  local title="$2"
  if [[ ! -f "$file" ]]; then
    cat > "$file" <<EOF
---
type: index
title: $title
---

# $title

EOF
  fi
}

write_index "$personal/index.md" "Personal Knowledge Index"
write_index "$shared/index.md" "Shared Knowledge Index"

config="$(cat <<EOF
{
  "mcpServers": {
    "team-knowledge": {
      "command": "node",
      "args": [
        "$server_path",
        "--personal",
        "$personal",
        "--shared",
        "$shared"
      ]
    }
  }
}
EOF
)"

if [[ -n "$settings" ]]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "jq is required to merge --settings. Config to add:" >&2
    echo "$config"
    exit 1
  fi

  mkdir -p "$(dirname "$settings")"
  if [[ ! -f "$settings" ]]; then
    echo '{}' > "$settings"
  fi

  tmp="$(mktemp)"
  jq --arg server "$server_path" --arg personal "$personal" --arg shared "$shared" \
    '.mcpServers["team-knowledge"] = {
      "command": "node",
      "args": [$server, "--personal", $personal, "--shared", $shared]
    }' "$settings" > "$tmp"
  mv "$tmp" "$settings"
  echo "Updated $settings"
else
  echo "$config"
fi
