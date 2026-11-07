#!/usr/bin/env bash
set -euo pipefail

EXPECTED_VERSION="0.3.4.1"
OFFLINE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --offline) OFFLINE=1; shift ;;
    --help|-h) echo "Usage: verify-install-phase7.sh [--offline]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}/marveen-codex-bridge"
STATE_ROOT="${XDG_STATE_HOME:-${HOME}/.local/state}/marveen-codex-bridge"
DATA_ROOT="${XDG_DATA_HOME:-${HOME}/.local/share}/marveen-codex-bridge"
SERVICE_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
CANDIDATE="${DATA_ROOT}/candidate"
CURRENT="${DATA_ROOT}/current"
UNIT="${SERVICE_ROOT}/marveen-codex-bridge.service"
CONFIG="${CONFIG_ROOT}/config.json"

[[ -L "${CANDIDATE}" ]] || { echo "FAIL: candidate symlink missing"; exit 1; }
TARGET="$(readlink -f -- "${CANDIDATE}")"
[[ -f "${TARGET}/package.json" && -f "${TARGET}/web/index.html" ]] \
  || { echo "FAIL: candidate release incomplete"; exit 1; }
VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).version" \
  "${TARGET}/package.json")"
[[ "${VERSION}" == "${EXPECTED_VERSION}" ]] \
  || { echo "FAIL: candidate version is ${VERSION}"; exit 1; }
[[ -f "${CONFIG}" && ! -L "${CONFIG}" ]] || { echo "FAIL: private config missing"; exit 1; }
[[ "$(stat -c '%a' "${CONFIG}")" == "600" ]] || { echo "FAIL: config mode is not 600"; exit 1; }
[[ -f "${UNIT}" ]] || { echo "FAIL: systemd unit missing"; exit 1; }
! rg -q '/marveen/(src|web)|~/marveen|HOME/marveen' "${TARGET}/scripts/install-phase7.sh" \
  || { echo "FAIL: installer contains a Marveen source mutation path"; exit 1; }
echo "PASS: candidate ${EXPECTED_VERSION} is installed without Marveen source coupling"

if [[ "${OFFLINE}" -eq 1 ]]; then
echo "RESULT: PHASE 7 OFFLINE INSTALL VERIFICATION PASS"
  exit 0
fi

[[ -L "${CURRENT}" ]] || { echo "FAIL: active release symlink missing"; exit 1; }
systemctl --user is-active --quiet marveen-codex-bridge.service \
  || { echo "FAIL: standalone service is not active"; exit 1; }
! systemctl --user is-active --quiet bela-codex-bridge.service \
  || { echo "FAIL: legacy and Federation Bridge run simultaneously"; exit 1; }
curl --silent --fail http://127.0.0.1:3431/readyz | grep -q '"status":"ready"' \
  || { echo "FAIL: readiness endpoint is not ready"; exit 1; }
curl --silent --fail http://127.0.0.1:3431/dashboard | grep -q 'Marveen Codex Bridge' \
  || { echo "FAIL: dashboard is unavailable"; exit 1; }
echo "RESULT: PHASE 6.1 ACTIVE INSTALL VERIFICATION PASS"
