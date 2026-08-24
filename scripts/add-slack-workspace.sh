#!/usr/bin/env bash
# Add a Slack workspace to slack-smart on this machine and on the gateway box.
# Prompts silently for the secrets so they never land in shell history.
#
# Usage: scripts/add-slack-workspace.sh <name> [box-ssh-target]
#   name            workspace name, becomes SLACK_USER_TOKEN_<NAME> (e.g. vllm)
#   box-ssh-target  optional, e.g. root@100.97.130.0; skips the box when omitted
set -euo pipefail

name="${1:?usage: $0 <name> [box-ssh-target]}"
box="${2:-}"
upper="$(printf '%s' "$name" | tr '[:lower:]-' '[:upper:]_')"
local_env="${HOME}/.config/smart-mcps/.env"
box_env="/opt/mcp/.config/smart-mcps/.env"

read -r -s -p "User token for ${name} (xoxp-... or xoxc-...): " token; echo
[ -n "$token" ] || { echo "empty token" >&2; exit 1; }
cookie=""
case "$token" in
  xoxc-*)
    read -r -s -p "Slack 'd' cookie value for ${name}: " cookie; echo
    [ -n "$cookie" ] || { echo "session tokens need the d cookie" >&2; exit 1; }
    ;;
esac

block="$(printf 'SLACK_USER_TOKEN_%s=%s\n' "$upper" "$token")"
if [ -n "$cookie" ]; then
  block="$(printf '%s\nSLACK_COOKIE_%s=%s\n' "$block" "$upper" "$cookie")"
fi

append() {
  # $1 = file, reads block from stdin; refuses to duplicate an existing key
  if grep -q "^SLACK_USER_TOKEN_${upper}=" "$1" 2>/dev/null; then
    echo "SLACK_USER_TOKEN_${upper} already present in $1; remove it first" >&2
    exit 1
  fi
  printf '%s\n' "$block" >> "$1"
  chmod 600 "$1"
}

append "$local_env"
echo "laptop: added ${name} to ${local_env}"

if [ -n "$box" ]; then
  printf '%s\n' "$block" | ssh "$box" "
    set -e
    if grep -q '^SLACK_USER_TOKEN_${upper}=' '$box_env'; then
      echo 'already present on box' >&2; exit 1
    fi
    cat >> '$box_env'
    chmod 600 '$box_env'; chown mcp:mcp '$box_env'
    systemctl restart mcp-gateway
    sleep 2; systemctl is-active mcp-gateway
    cd /opt/mcp/smart-mcps/packages/slack-smart
    sudo -u mcp HOME=/opt/mcp node --input-type=module -e '
      import { buildContext } from \"./dist/context.js\";
      import { list_workspaces } from \"./dist/tools/workspaces.js\";
      const out = await list_workspaces.handler({ check: true }, buildContext());
      for (const w of out.workspaces) console.log(w.name, w.token_kind, w.default ? \"(default)\" : \"\", w.team ?? w.error);
    '
  "
  echo "box: added ${name}, gateway restarted"
fi
