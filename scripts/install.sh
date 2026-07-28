#!/usr/bin/env bash
set -euo pipefail

BRIDGE_VERSION="0.1.8"
EXPECTED_NODE="v22.23.1"
EXPECTED_CODEX="0.145.0"
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARVEEN_ROOT="${HOME}/marveen"
INSTALL_ADAPTER=1
RESTART_BELA=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --marveen-root) MARVEEN_ROOT="$2"; shift 2 ;;
    --skip-adapter) INSTALL_ADAPTER=0; shift ;;
    --restart-bela) RESTART_BELA=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

NODE_BIN="${BELA_CODEX_BRIDGE_NODE:-${HOME}/.nvm/versions/node/v22.23.1/bin/node}"
CODEX_BIN="${BELA_CODEX_BRIDGE_CODEX:-${HOME}/.local/bin/codex}"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
STATE_HOME="${XDG_STATE_HOME:-${HOME}/.local/state}"
CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
INSTALL_BASE="${DATA_HOME}/bela-codex-bridge"
RELEASE_ROOT="${INSTALL_BASE}/releases/${BRIDGE_VERSION}"
CURRENT_LINK="${INSTALL_BASE}/current"
CONFIG_DIR="${CONFIG_HOME}/bela-codex-bridge"
CONFIG_FILE="${CONFIG_DIR}/config.json"
TOKEN_FILE="${CONFIG_DIR}/token"
STATE_DIR="${STATE_HOME}/bela-codex-bridge"
RUNTIME_DIR="/run/user/$(id -u)"
SOCKET_PATH="${RUNTIME_DIR}/bela-codex-bridge.sock"
LOCK_PATH="${RUNTIME_DIR}/bela-codex-bridge.lock"
UNIT_DIR="${CONFIG_HOME}/systemd/user"
UNIT_FILE="${UNIT_DIR}/bela-codex-bridge.service"

fail() { echo "ERROR: $*" >&2; exit 1; }

verify_existing_runs_idle() {
  if [[ ! -f "${CONFIG_FILE}" ]]; then
    return
  fi
  local existing_database
  existing_database="$("${NODE_BIN}" -e \
    "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(c.storage?.database || '')" \
    "${CONFIG_FILE}")"
  if [[ -z "${existing_database}" || ! -f "${existing_database}" ]]; then
    return
  fi
  local current_sqlite="${CURRENT_LINK}/node_modules/better-sqlite3"
  [[ -f "${current_sqlite}/build/Release/better_sqlite3.node" ]] \
    || fail "Existing Bridge database is present, but the current SQLite runtime is unavailable; cannot prove that all runs are idle"
  local active
  active="$("${NODE_BIN}" -e '
    const Database = require(process.argv[1])
    const db = new Database(process.argv[2], { readonly: true })
    const row = db.prepare(`
      SELECT COUNT(*) AS count FROM bridge_runs
      WHERE state IN ('"'"'starting'"'"', '"'"'running'"'"', '"'"'waiting_approval'"'"', '"'"'interrupting'"'"')
    `).get()
    db.close()
    process.stdout.write(String(row.count))
  ' "${current_sqlite}" "${existing_database}")"
  [[ "${active}" == "0" ]] \
    || fail "Refusing upgrade while ${active} Codex run(s) are active; wait for completion or interrupt them explicitly"
  echo "PASS: no active Codex runs block the Bridge upgrade"
}

backup_existing_database() {
  if [[ ! -f "${CONFIG_FILE}" ]]; then
    return
  fi
  local existing_database
  existing_database="$("${NODE_BIN}" -e \
    "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(c.storage?.database || '')" \
    "${CONFIG_FILE}")"
  if [[ -z "${existing_database}" || ! -f "${existing_database}" ]]; then
    return
  fi
  local current_sqlite="${CURRENT_LINK}/node_modules/better-sqlite3"
  [[ -f "${current_sqlite}/build/Release/better_sqlite3.node" ]] \
    || fail "Cannot create a pre-migration database backup: current SQLite runtime is unavailable"
  local backup_dir="${STATE_DIR}/database-backups"
  local backup_path="${backup_dir}/bridge-before-${BRIDGE_VERSION}-$(date +%Y%m%d%H%M%S)-$$.sqlite3"
  mkdir -p "${backup_dir}"
  chmod 700 "${backup_dir}"
  "${NODE_BIN}" -e '
    const Database = require(process.argv[1])
    const source = new Database(process.argv[2], { readonly: true, fileMustExist: true })
    source.backup(process.argv[3])
      .then(() => source.close())
      .catch((error) => {
        try { source.close() } catch {}
        console.error(error)
        process.exit(1)
      })
  ' "${current_sqlite}" "${existing_database}" "${backup_path}" \
    || fail "Pre-migration database backup failed"
  chmod 600 "${backup_path}"
  echo "PASS: pre-migration database backup created: ${backup_path}"
}

restart_dashboard() {
  if ! systemctl --user cat bela-dashboard.service >/dev/null 2>&1; then
    fail "bela-dashboard.service is missing; the new Marveen dist cannot be activated safely"
  fi
  echo "Activating the rebuilt Marveen dashboard..."
  systemctl --user restart bela-dashboard.service
  for _ in {1..30}; do
    if systemctl --user is-active --quiet bela-dashboard.service; then
      echo "PASS: bela-dashboard.service restarted with the current dist"
      return
    fi
    sleep 1
  done
  systemctl --user status bela-dashboard.service --no-pager --full >&2 || true
  fail "bela-dashboard.service did not become active after restart"
}

[[ -x "${NODE_BIN}" ]] || fail "Node 22 binary not found: ${NODE_BIN}"
[[ "$("${NODE_BIN}" --version)" == "${EXPECTED_NODE}" ]] || fail "Expected Node ${EXPECTED_NODE} at ${NODE_BIN}"
[[ -x "${CODEX_BIN}" ]] || fail "Codex binary not found: ${CODEX_BIN}"
"${CODEX_BIN}" --version | grep -q "${EXPECTED_CODEX}" || fail "Expected Codex ${EXPECTED_CODEX}"
"${CODEX_BIN}" login status 2>&1 | grep -qi "logged in" || fail "Codex is not logged in with ChatGPT"
[[ -f "${SOURCE_ROOT}/dist/src/main.js" ]] || fail "Bridge is not built; dist/src/main.js is missing"
[[ -f "${SOURCE_ROOT}/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]] \
  || fail "Production dependencies are missing from the release package"

verify_existing_runs_idle

if [[ "${INSTALL_ADAPTER}" -eq 1 ]]; then
  echo "Preflight: checking Marveen adapter compatibility before installation..."
  "${SOURCE_ROOT}/scripts/install-marveen-adapter.sh" "${MARVEEN_ROOT}" --check-only
fi

mkdir -p "${INSTALL_BASE}/releases" "${CONFIG_DIR}" "${STATE_DIR}" "${UNIT_DIR}"
chmod 700 "${CONFIG_DIR}" "${STATE_DIR}"
backup_existing_database

STAGING="${INSTALL_BASE}/releases/.${BRIDGE_VERSION}.staging.$$"
trap 'if [[ -d "${STAGING:-}" ]]; then mv "${STAGING}" "${STAGING}.failed" 2>/dev/null || true; fi' EXIT
mkdir -p "${STAGING}"
cp -a \
  "${SOURCE_ROOT}/dist" \
  "${SOURCE_ROOT}/migrations" \
  "${SOURCE_ROOT}/node_modules" \
  "${SOURCE_ROOT}/package.json" \
  "${SOURCE_ROOT}/package-lock.json" \
  "${SOURCE_ROOT}/bridge-lock.json" \
  "${SOURCE_ROOT}/config" \
  "${STAGING}/"

if [[ -e "${RELEASE_ROOT}" ]]; then
  mv "${RELEASE_ROOT}" "${RELEASE_ROOT}.previous.$(date +%Y%m%d%H%M%S)"
fi
mv "${STAGING}" "${RELEASE_ROOT}"
ln -sfn "${RELEASE_ROOT}" "${CURRENT_LINK}.new"
mv -Tf "${CURRENT_LINK}.new" "${CURRENT_LINK}"

if [[ ! -s "${TOKEN_FILE}" ]]; then
  umask 077
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "${TOKEN_FILE}"
  else
    "${NODE_BIN}" -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex')+'\\n')" > "${TOKEN_FILE}"
  fi
fi
chmod 600 "${TOKEN_FILE}"

CONFIG_TMP="${CONFIG_FILE}.tmp.$$"
sed \
  -e "s|@SOCKET_PATH@|${SOCKET_PATH}|g" \
  -e "s|@CODEX_BIN@|${CODEX_BIN}|g" \
  -e "s|@DATABASE@|${STATE_DIR}/bridge.sqlite3|g" \
  -e "s|@RUNTIME_ROOT@|${INSTALL_BASE}/agents|g" \
  -e "s|@LOCK_PATH@|${LOCK_PATH}|g" \
  "${SOURCE_ROOT}/config/install.json.in" > "${CONFIG_TMP}"
"${NODE_BIN}" -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "${CONFIG_TMP}"
chmod 600 "${CONFIG_TMP}"
mv "${CONFIG_TMP}" "${CONFIG_FILE}"

sed \
  -e "s|@INSTALL_ROOT@|${CURRENT_LINK}|g" \
  -e "s|@NODE_BIN@|${NODE_BIN}|g" \
  -e "s|@CONFIG_FILE@|${CONFIG_FILE}|g" \
  -e "s|@TOKEN_FILE@|${TOKEN_FILE}|g" \
  -e "s|@HOME_DIR@|${HOME}|g" \
  -e "s|@CODEX_BIN_DIR@|$(dirname "${CODEX_BIN}")|g" \
  "${SOURCE_ROOT}/systemd/bela-codex-bridge.service.in" > "${UNIT_FILE}.tmp"
chmod 600 "${UNIT_FILE}.tmp"
mv "${UNIT_FILE}.tmp" "${UNIT_FILE}"

systemctl --user daemon-reload
systemctl --user enable bela-codex-bridge.service
systemctl --user restart bela-codex-bridge.service
"${SOURCE_ROOT}/scripts/verify-install.sh" --bridge-only "${MARVEEN_ROOT}"

if [[ "${INSTALL_ADAPTER}" -eq 1 ]]; then
  "${SOURCE_ROOT}/scripts/install-marveen-adapter.sh" "${MARVEEN_ROOT}"
fi

if [[ "${RESTART_BELA}" -eq 1 ]]; then
  # Building dist is insufficient: a long-running Node process keeps the old
  # modules in memory. Restart the dashboard explicitly before verification.
  restart_dashboard
fi

BELA_CODEX_REQUIRE_DASHBOARD_FRESH="${RESTART_BELA}" \
  "${SOURCE_ROOT}/scripts/verify-install.sh" "${MARVEEN_ROOT}"

if [[ "${RESTART_BELA}" -eq 1 ]]; then
  [[ -x "${MARVEEN_ROOT}/scripts/bela-start.sh" ]] || fail "Béla start script is missing"
  "${MARVEEN_ROOT}/scripts/bela-start.sh"
else
  echo "Bridge installed. Activate the rebuilt dashboard and restart Béla when convenient:"
  echo "  systemctl --user restart bela-dashboard.service"
  echo "  bash ${MARVEEN_ROOT}/scripts/bela-start.sh"
fi

trap - EXIT
