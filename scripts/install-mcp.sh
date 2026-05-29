#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# CIRA MCP Companion — install & start
#
# This script:
#   1. Installs dependencies for the MCP companion process
#   2. Registers the companion as a launchd service (macOS) or systemd (Linux)
#      for auto-start
#   3. Starts the companion immediately
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_DIR="$SCRIPT_DIR/cira-mcp"

# ── Install deps ───────────────────────────────────────────────────────────

echo "==> Installing MCP companion dependencies..."
cd "$MCP_DIR"
npm install --no-audit --no-fund

# ── macOS: launchd plist ───────────────────────────────────────────────────

if [[ "$(uname)" == "Darwin" ]]; then
  PLIST_PATH="$HOME/Library/LaunchAgents/com.cira.mcp.plist"

  cat > "$PLIST_PATH" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cira.mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>MCP_DIR_PLACEHOLDER/node_modules/.bin/tsx</string>
    <string>MCP_DIR_PLACEHOLDER/src/server.ts</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>MCP_DIR_PLACEHOLDER</string>
  <key>StandardOutPath</key>
  <string>/tmp/cira-mcp.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/cira-mcp.err.log</string>
</dict>
</plist>
PLIST

  # Replace placeholder with actual path
  sed -i '' "s|MCP_DIR_PLACEHOLDER|$MCP_DIR|g" "$PLIST_PATH"

  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
  echo "==> Registered macOS launchd service (auto-start on login)"
fi

# ── Linux: systemd ─────────────────────────────────────────────────────────
if [[ "$(uname)" == "Linux" ]]; then
  SERVICE_PATH="$HOME/.config/systemd/user/cira-mcp.service"
  mkdir -p "$(dirname "$SERVICE_PATH")"

  cat > "$SERVICE_PATH" << UNIT
[Unit]
Description=CIRA MCP Companion
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$MCP_DIR
ExecStart=$MCP_DIR/node_modules/.bin/tsx src/server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable cira-mcp.service
  systemctl --user restart cira-mcp.service
  echo "==> Registered systemd user service (auto-start on login)"
fi

# ── Verify ─────────────────────────────────────────────────────────────────

sleep 2
if curl -s http://127.0.0.1:9020/health > /dev/null 2>&1; then
  echo "==> CIRA MCP companion is running!"
  echo "    Health:   http://127.0.0.1:9020/health"
  echo "    MCP:      http://127.0.0.1:9020/mcp"
  echo "    WebSocket: ws://127.0.0.1:9021"
else
  echo "==> WARNING: Companion may not have started. Check logs:"
  echo "    macOS: /tmp/cira-mcp.log"
  echo "    Linux: journalctl --user -u cira-mcp"
fi
