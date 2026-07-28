#!/usr/bin/env bash
set -euo pipefail

CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
UNIT_FILE="${CONFIG_HOME}/systemd/user/bela-codex-bridge.service"

systemctl --user disable --now bela-codex-bridge.service 2>/dev/null || true
if [[ -f "${UNIT_FILE}" ]]; then
  mv "${UNIT_FILE}" "${UNIT_FILE}.disabled.$(date +%Y%m%d%H%M%S)"
fi
systemctl --user daemon-reload

echo "The service was disabled. State, database, token and releases were preserved."
echo "The Marveen adapter is intentionally left in place; with the service stopped, Claude agents remain unaffected."
echo "Use the timestamped backup under ~/.local/state/bela-codex-bridge/adapter-backups for an explicit adapter rollback."
