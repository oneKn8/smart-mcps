#!/usr/bin/env bash
# install-clients.sh — register built smart-mcps into all known MCP clients
# on this machine (Claude Code, Codex, Cursor).
#
# Usage:
#   ./scripts/install-clients.sh                  # registers every built MCP
#   ./scripts/install-clients.sh vercel-smart     # registers a single MCP
#
# Idempotent. Safe to re-run. Writes a backup of each modified config file
# under ~/.config/smart-mcps-backups/ before mutating it.

set -euo pipefail

MONOREPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${HOME}/.config/smart-mcps-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Discover built MCPs (any packages/*/dist/server.js)
discover_mcps() {
  local filter="${1:-}"
  for pkg in "$MONOREPO_ROOT"/packages/*/; do
    local name
    name=$(basename "$pkg")
    [[ "$name" == "core" ]] && continue
    [[ -n "$filter" && "$name" != "$filter" ]] && continue
    if [[ -f "$pkg/dist/server.js" ]]; then
      echo "$name|$pkg/dist/server.js"
    fi
  done
}

# Update Claude Code config (~/.claude.json)
update_claude_code() {
  local cfg="${HOME}/.claude.json"
  [[ ! -f "$cfg" ]] && { echo "  Claude Code config not found at $cfg, skipping"; return; }
  cp "$cfg" "$BACKUP_DIR/claude.json"

  local tmp
  tmp=$(mktemp)

  python3 - "$cfg" "$tmp" "$@" <<'PY'
import json, sys
cfg_path, tmp_path, *entries = sys.argv[1:]
with open(cfg_path) as f:
    data = json.load(f)
servers = data.setdefault("mcpServers", {})
for entry in entries:
    name, path = entry.split("|", 1)
    servers[name] = {"command": "node", "args": [path]}
with open(tmp_path, "w") as f:
    json.dump(data, f, indent=2)
PY

  mv "$tmp" "$cfg"
  echo "  Claude Code: updated $cfg"
}

# Update Codex config
update_codex() {
  local cfg="${HOME}/.codex/config.toml"
  [[ ! -f "$cfg" ]] && { echo "  Codex config not found at $cfg, skipping"; return; }
  cp "$cfg" "$BACKUP_DIR/codex-config.toml"
  echo "  Codex: manual step required — add to $cfg under [mcp_servers] (printed below)"
  for entry in "$@"; do
    local name path
    name="${entry%%|*}"
    path="${entry#*|}"
    cat <<EOF

[mcp_servers.$name]
command = "node"
args = ["$path"]
EOF
  done
}

# Update Cursor config
update_cursor() {
  local cfg="${HOME}/.cursor/mcp.json"
  [[ ! -f "$cfg" ]] && { echo "  Cursor config not found at $cfg, skipping"; return; }
  cp "$cfg" "$BACKUP_DIR/cursor-mcp.json"

  local tmp
  tmp=$(mktemp)

  python3 - "$cfg" "$tmp" "$@" <<'PY'
import json, sys
cfg_path, tmp_path, *entries = sys.argv[1:]
with open(cfg_path) as f:
    data = json.load(f)
servers = data.setdefault("mcpServers", {})
for entry in entries:
    name, path = entry.split("|", 1)
    servers[name] = {"command": "node", "args": [path]}
with open(tmp_path, "w") as f:
    json.dump(data, f, indent=2)
PY

  mv "$tmp" "$cfg"
  echo "  Cursor: updated $cfg"
}

main() {
  local filter="${1:-}"
  local entries=()
  while IFS= read -r line; do
    entries+=("$line")
  done < <(discover_mcps "$filter")

  if [[ ${#entries[@]} -eq 0 ]]; then
    echo "No built MCPs found (looked for packages/*/dist/server.js)."
    echo "Run 'npm run build' first."
    exit 1
  fi

  echo "Installing ${#entries[@]} MCP(s):"
  for entry in "${entries[@]}"; do
    echo "  - ${entry%%|*}"
  done
  echo "Backups saved to: $BACKUP_DIR"
  echo ""

  echo "Claude Code:"
  update_claude_code "${entries[@]}"
  echo ""
  echo "Codex:"
  update_codex "${entries[@]}"
  echo ""
  echo "Cursor:"
  update_cursor "${entries[@]}"
  echo ""
  echo "Done."
}

main "$@"
