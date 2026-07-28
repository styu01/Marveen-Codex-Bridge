#!/usr/bin/env bash
set -euo pipefail

BRIDGE_ONLY=0
if [[ "${1:-}" == "--bridge-only" ]]; then
  BRIDGE_ONLY=1
  shift
fi

MARVEEN_ROOT="${1:-${HOME}/marveen}"
NODE_BIN="${BELA_CODEX_BRIDGE_NODE:-${HOME}/.nvm/versions/node/v22.23.1/bin/node}"
INSTALL_ROOT="${XDG_DATA_HOME:-${HOME}/.local/share}/bela-codex-bridge/current"
CONFIG_FILE="${XDG_CONFIG_HOME:-${HOME}/.config}/bela-codex-bridge/config.json"
TOKEN_FILE="${XDG_CONFIG_HOME:-${HOME}/.config}/bela-codex-bridge/token"
SOCKET_PATH="/run/user/$(id -u)/bela-codex-bridge.sock"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -x "${NODE_BIN}" ]] || fail "Bridge Node binary is missing: ${NODE_BIN}"
NODE_VERSION="$("${NODE_BIN}" --version 2>/dev/null)" \
  || fail "Bridge Node cannot be executed: ${NODE_BIN}"
[[ "${NODE_VERSION}" == "v22.23.1" ]] \
  || fail "Expected Bridge Node v22.23.1, found ${NODE_VERSION}"
pass "fixed Bridge Node is v22.23.1"

DEFAULT_NODE="$(node --version 2>/dev/null || true)"
if [[ "${DEFAULT_NODE}" == v24.* ]]; then
  pass "Béla default Node remains ${DEFAULT_NODE}"
else
  echo "WARN: Béla default Node is ${DEFAULT_NODE:-unavailable}; Bridge still uses fixed Node 22."
fi

[[ -L "${INSTALL_ROOT}" || -d "${INSTALL_ROOT}" ]] \
  || fail "Bridge current release is missing: ${INSTALL_ROOT}"
[[ -f "${CONFIG_FILE}" ]] || fail "Bridge config is missing: ${CONFIG_FILE}"
[[ -f "${TOKEN_FILE}" ]] || fail "Bridge token is missing: ${TOKEN_FILE}"
[[ "$(stat -c '%a' "${TOKEN_FILE}")" == "600" ]] \
  || fail "Bridge token permissions must be 600"
pass "config and private token are present"

if ! systemctl --user is-active --quiet bela-codex-bridge.service; then
  systemctl --user status bela-codex-bridge.service --no-pager >&2 || true
  fail "bela-codex-bridge.service is not active"
fi
pass "systemd user service is active"

VERIFY_WAIT_SECONDS="${BELA_CODEX_BRIDGE_VERIFY_WAIT_SECONDS:-90}"
[[ "${VERIFY_WAIT_SECONDS}" =~ ^[0-9]+$ ]] \
  || fail "BELA_CODEX_BRIDGE_VERIFY_WAIT_SECONDS must be an integer"
VERIFY_DEADLINE=$((SECONDS + VERIFY_WAIT_SECONDS))
while true; do
  if [[ -S "${SOCKET_PATH}" ]] \
    && curl --silent --show-error --fail --unix-socket "${SOCKET_PATH}" \
      http://localhost/readyz >/dev/null 2>&1
  then
    break
  fi
  if ! systemctl --user is-active --quiet bela-codex-bridge.service; then
    systemctl --user status bela-codex-bridge.service --no-pager >&2 || true
    journalctl --user -u bela-codex-bridge.service -n 80 --no-pager >&2 || true
    fail "Bridge service stopped while waiting for readiness"
  fi
  if (( SECONDS >= VERIFY_DEADLINE )); then
    systemctl --user status bela-codex-bridge.service --no-pager >&2 || true
    journalctl --user -u bela-codex-bridge.service -n 80 --no-pager >&2 || true
    fail "Bridge did not become ready within ${VERIFY_WAIT_SECONDS} seconds"
  fi
  sleep 1
done

[[ "$(stat -c '%a' "${SOCKET_PATH}")" == "600" ]] \
  || fail "Bridge socket permissions must be 600"
pass "private Unix socket and Codex App Server are ready"

TOKEN="$(<"${TOKEN_FILE}")"
META_JSON="$(curl --silent --show-error --fail --unix-socket "${SOCKET_PATH}" \
  -H "Authorization: Bearer ${TOKEN}" \
  http://localhost/v1/meta)" \
  || fail "authenticated Bridge metadata request failed"
if ! "${NODE_BIN}" -e '
  const meta = JSON.parse(process.argv[1])
  if (
    meta.bridgeVersion !== "0.1.8"
    || meta.toolContract?.revision !== 1
    || !meta.toolContract?.exposure?.includes("dynamicTools")
    || meta.toolContract?.tools?.length !== 4
  ) process.exit(1)
' "${META_JSON}"
then
  echo "${META_JSON}" >&2
  fail "Bridge metadata is not from release 0.1.8"
fi
if [[ -z "${META_JSON}" ]]; then
  fail "authenticated Bridge metadata request failed"
fi
pass "Bridge bearer authentication reports release 0.1.8 and dynamic tool contract 1"

pass "Codex App Server compatibility probe is ready"

rg -q "dynamicTools" "${INSTALL_ROOT}/dist/src/runs/run-engine.js" \
  || fail "compiled dynamicTools thread contract is missing"
rg -q "item/tool/call" "${INSTALL_ROOT}/dist/src/service.js" \
  || fail "compiled dynamic tool request dispatcher is missing"
rg -q "dynamic_tool_identity_mismatch" "${INSTALL_ROOT}/dist/src/runs/run-engine.js" \
  || fail "compiled dynamic tool identity guard is missing"
rg -q "tool_contract_revision" "${INSTALL_ROOT}/migrations/002_dynamic_tool_contract.sql" \
  || fail "dynamic tool database migration is missing"
rg -q "app_server_generation" "${INSTALL_ROOT}/migrations/003_approval_request_identity.sql" \
  || fail "approval request identity migration is missing"
rg -q "shouldEnqueueProviderCallback" "${INSTALL_ROOT}/dist/src/runs/run-engine.js" \
  || fail "message-scoped provider callback gate is missing"
pass "dynamic tools, callback gate, identity guard, and database migrations are installed"

DATABASE_PATH="$("${NODE_BIN}" -e \
  "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(c.storage.database)" \
  "${CONFIG_FILE}")"
"${NODE_BIN}" -e '
  const Database = require(process.argv[1])
  const db = new Database(process.argv[2], { readonly: true })
  const threadColumns = db.prepare("PRAGMA table_info(codex_threads)").all()
  const approvalColumns = db.prepare("PRAGMA table_info(bridge_approvals)").all()
  const approvalIndexes = db.prepare("PRAGMA index_list(bridge_approvals)").all()
  db.close()
  if (!threadColumns.some((column) => column.name === "tool_contract_revision")) process.exit(1)
  if (!approvalColumns.some((column) => column.name === "app_server_generation")) process.exit(1)
  if (approvalIndexes.some((index) => index.unique === 1 && index.name.includes("provider"))) process.exit(1)
' "${INSTALL_ROOT}/node_modules/better-sqlite3" "${DATABASE_PATH}" \
  || fail "Bridge database migrations were not applied correctly"
pass "dynamic tool and approval identity database migrations are applied"

DOCTOR_LOG="$(mktemp)"
trap 'rm -f "${DOCTOR_LOG}"' EXIT
if ! BELA_CODEX_BRIDGE_CONFIG="${CONFIG_FILE}" \
  BELA_CODEX_BRIDGE_TOKEN_FILE="${TOKEN_FILE}" \
  "${NODE_BIN}" "${INSTALL_ROOT}/dist/src/cli/doctor.js" >"${DOCTOR_LOG}" 2>&1
then
  cat "${DOCTOR_LOG}" >&2
  fail "Bridge doctor failed"
fi
cat "${DOCTOR_LOG}"

if [[ "${BRIDGE_ONLY}" -eq 0 ]]; then
  [[ -d "${MARVEEN_ROOT}" ]] || fail "Marveen root is missing: ${MARVEEN_ROOT}"
  rg -q "tryHandleProviderCallbacks" "${MARVEEN_ROOT}/src/web.ts" \
    || fail "Marveen provider callback hook is missing"
  rg -q "readAgentProvider" "${MARVEEN_ROOT}/src/web/message-router.ts" \
    || fail "Marveen Codex message routing hook is missing"
  rg -q "tryHandleCodexApprovals|tryHandleApprovals" "${MARVEEN_ROOT}/src/web.ts" \
    || fail "Marveen Codex approval route is missing"
  rg -q "buildCodexAgentIdentityFiles" "${MARVEEN_ROOT}/dist/web/agent-scaffold.js" \
    || fail "Compiled Codex identity generator is missing from Marveen dist"
  rg -q "readAgentProvider" "${MARVEEN_ROOT}/dist/web/message-router.js" \
    || fail "Compiled Codex message router is missing from Marveen dist"
  [[ -f "${MARVEEN_ROOT}/dist/providers/codex-provider.js" ]] \
    || fail "Compiled Codex provider is missing from Marveen dist"
  rg -q "CODEX_CALLBACK_ADAPTER_REVISION = 2" \
    "${MARVEEN_ROOT}/src/web/routes/provider-callbacks.ts" \
    || fail "Marveen callback deduplication source is missing"
  rg -q "CODEX_CALLBACK_ADAPTER_REVISION = 2" \
    "${MARVEEN_ROOT}/dist/web/routes/provider-callbacks.js" \
    || fail "Compiled Marveen callback deduplication is missing"
  pass "Marveen Codex adapter revision 2 source and compiled dist hooks are installed"

  if systemctl --user is-active --quiet bela-dashboard.service; then
    DASHBOARD_PID="$(systemctl --user show bela-dashboard.service -p MainPID --value)"
    if [[ "${DASHBOARD_PID}" =~ ^[1-9][0-9]*$ && -r "/proc/${DASHBOARD_PID}/stat" ]]; then
      START_TICKS="$(awk '{print $22}' "/proc/${DASHBOARD_PID}/stat")"
      CLOCK_TICKS="$(getconf CLK_TCK)"
      UPTIME_SECONDS="$(cut -d. -f1 /proc/uptime)"
      PROCESS_STARTED_AT=$(( $(date +%s) - UPTIME_SECONDS + START_TICKS / CLOCK_TICKS ))
      DIST_MTIME="$(stat -c '%Y' "${MARVEEN_ROOT}/dist/index.js")"
      if (( DIST_MTIME > PROCESS_STARTED_AT + 2 )); then
        if [[ "${BELA_CODEX_REQUIRE_DASHBOARD_FRESH:-0}" == "1" ]]; then
          fail "bela-dashboard.service predates dist/index.js; the running API still has stale code"
        fi
        echo "WARN: bela-dashboard.service predates dist/index.js; restart it before using Codex agents."
      else
        pass "running dashboard process has loaded the current dist generation"
      fi
    else
      echo "WARN: bela-dashboard.service MainPID could not be inspected."
    fi
  else
    echo "WARN: bela-dashboard.service is not active; compiled adapter is present but not serving requests."
  fi
fi

rm -f "${DOCTOR_LOG}"
trap - EXIT
if [[ "${BRIDGE_ONLY}" -eq 1 ]]; then
  echo "RESULT: Bridge service verification passed."
else
  echo "RESULT: Bridge service and Marveen adapter verification passed."
fi
