#!/usr/bin/env bash
# Write the matrix-relay MCP config used by bridged Claude sessions.
#
# Sessions are launched with `--mcp-config <this file> --strict-mcp-config`,
# so only the relay loads in bridged sessions. Nothing is registered at user
# or project scope, so ordinary Claude Code sessions are unaffected.
#
# Safe to run repeatedly. Removes an earlier user-scope registration.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELAY_PATH="$REPO_DIR/packages/matrix-relay"
CONFIG_DIR="$HOME/.config/claude-matrix-bridge"
CONFIG_FILE="$CONFIG_DIR/relay-mcp.json"

if [ ! -d "$RELAY_PATH" ]; then
  echo "[ERROR] matrix-relay not found at $RELAY_PATH" >&2
  exit 1
fi

# Find bun via mise (preferred) or PATH
BUN_PATH=$(mise which bun 2>/dev/null || which bun 2>/dev/null) || {
  echo "[ERROR] bun not found. Run 'mise install' first." >&2
  exit 1
}

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
node -e '
  const [bun, relay] = process.argv.slice(1)
  const config = { mcpServers: { "matrix-relay": {
    command: bun,
    args: ["run", "--cwd", relay, "--shell=bun", "--silent", "start"],
  } } }
  process.stdout.write(JSON.stringify(config, null, 2) + "\n")
' "$BUN_PATH" "$RELAY_PATH" > "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

# An earlier user-scope registration would load the relay in every Claude session.
if claude mcp list 2>/dev/null | grep -q "^matrix-relay"; then
  claude mcp remove --scope user matrix-relay >/dev/null 2>&1 || true
  echo "[INFO] Removed earlier user-scope matrix-relay registration"
fi

echo "[INFO] matrix-relay MCP config written to $CONFIG_FILE"
