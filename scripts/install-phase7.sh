#!/usr/bin/env bash
set -euo pipefail

VERSION="0.3.4"
SOURCE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
NODE_BIN=""
CODEX_BIN=""
CONFIG_SOURCE=""
ACTIVATE=0
SKIP_DEPENDENCIES=0
SKIP_TESTS=0

usage() {
  cat <<'EOF'
Usage: install-phase7.sh --node-bin PATH --codex-bin PATH [options]

Options:
  --config-source PATH    Install an existing private Federation config.
  --activate              Activate and start the standalone service.
  --prepare-only          Install as candidate only (default).
  --skip-dependencies     Test-only: do not run npm ci.
  --skip-tests            Do not run the packaged mock verification.

The installer never reads or modifies the Marveen source tree.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-bin) NODE_BIN="${2:?missing Node path}"; shift 2 ;;
    --codex-bin) CODEX_BIN="${2:?missing Codex path}"; shift 2 ;;
    --config-source) CONFIG_SOURCE="${2:?missing config path}"; shift 2 ;;
    --activate) ACTIVATE=1; shift ;;
    --prepare-only) ACTIVATE=0; shift ;;
    --skip-dependencies) SKIP_DEPENDENCIES=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$(id -u)" -ne 0 ]] || { echo "Refusing root installation" >&2; exit 1; }
[[ -n "${HOME:-}" && "${HOME}" = /* && "${HOME}" != "/" ]] \
  || { echo "HOME must be an absolute non-root path" >&2; exit 1; }
[[ -x "${NODE_BIN}" ]] || { echo "--node-bin must be executable" >&2; exit 1; }
[[ -x "${CODEX_BIN}" ]] || { echo "--codex-bin must be executable" >&2; exit 1; }

NODE_REAL="$(readlink -f -- "${NODE_BIN}")"
CODEX_REAL="$(readlink -f -- "${CODEX_BIN}")"
[[ "$("${NODE_REAL}" --version)" == v22.* ]] \
  || { echo "Node 22 is required" >&2; exit 1; }
"${CODEX_REAL}" --version | grep -q '0\.164\.0' \
  || { echo "Codex CLI 0.164.0 is required" >&2; exit 1; }
"${CODEX_REAL}" login status 2>&1 | grep -q '^Logged in using' \
  || { echo "Codex ChatGPT login is required" >&2; exit 1; }

CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}/marveen-codex-bridge"
STATE_ROOT="${XDG_STATE_HOME:-${HOME}/.local/state}/marveen-codex-bridge"
DATA_ROOT="${XDG_DATA_HOME:-${HOME}/.local/share}/marveen-codex-bridge"
SERVICE_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
RELEASES_ROOT="${DATA_ROOT}/releases"
RELEASE_ROOT="${RELEASES_ROOT}/${VERSION}"
CURRENT_LINK="${DATA_ROOT}/current"
CANDIDATE_LINK="${DATA_ROOT}/candidate"
PREVIOUS_LINK="${DATA_ROOT}/previous"
CONFIG_PATH="${CONFIG_ROOT}/config.json"
UNIT_PATH="${SERVICE_ROOT}/marveen-codex-bridge.service"
WORKSPACE_ROOT="${DATA_ROOT}/agents/programozo"
RUNTIME_ROOT="${DATA_ROOT}/runtime"
DATABASE_PATH="${STATE_ROOT}/federation.sqlite3"
CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"

[[ "${CODEX_HOME}" = /* && "${CODEX_HOME}" != "/" ]] \
  || { echo "CODEX_HOME must be an absolute non-root path" >&2; exit 1; }
case "${CODEX_HOME}" in
  "${HOME}"/*) ;;
  *) echo "CODEX_HOME must stay inside HOME" >&2; exit 1 ;;
esac
if [[ -e "${CODEX_HOME}" || -L "${CODEX_HOME}" ]]; then
  [[ -d "${CODEX_HOME}" && ! -L "${CODEX_HOME}" ]] \
    || { echo "CODEX_HOME must be a real directory, not a symlink" >&2; exit 1; }
else
  install -d -m 0700 "${CODEX_HOME}"
fi
chmod go-rwx "${CODEX_HOME}"

install -d -m 0700 \
  "${CONFIG_ROOT}" "${STATE_ROOT}" "${DATA_ROOT}" "${RELEASES_ROOT}" \
  "${SERVICE_ROOT}" "${WORKSPACE_ROOT}" "${RUNTIME_ROOT}"

STAGE="$(mktemp -d "${RELEASES_ROOT}/.${VERSION}.stage.XXXXXX")"
cleanup() {
  if [[ -n "${STAGE:-}" && -d "${STAGE}" ]]; then
    rm -rf -- "${STAGE}"
  fi
}
trap cleanup EXIT

tar --exclude='./node_modules' --exclude='./.git' -C "${SOURCE_ROOT}" -cf - . \
  | tar -C "${STAGE}" -xf -

if [[ "${SKIP_DEPENDENCIES}" -eq 0 ]]; then
  NPM_CLI="$(readlink -f -- "$(dirname -- "${NODE_REAL}")/../lib/node_modules/npm/bin/npm-cli.js")"
  [[ -f "${NPM_CLI}" ]] || { echo "npm CLI belonging to Node 22 is required" >&2; exit 1; }
  (
    cd "${STAGE}"
    PATH="$(dirname -- "${NODE_REAL}"):${PATH}" \
      "${NODE_REAL}" "${NPM_CLI}" ci --omit=dev --no-audit --no-fund
  )
fi

if [[ "${SKIP_TESTS}" -eq 0 ]]; then
  [[ -d "${STAGE}/node_modules/better-sqlite3" ]] \
    || { echo "better-sqlite3 is missing from staged release" >&2; exit 1; }
  "${STAGE}/scripts/verify-phase7.sh" \
    --node-bin "${NODE_REAL}" \
    --better-sqlite3-path "${STAGE}/node_modules/better-sqlite3" \
    --mock-only
fi

if [[ -e "${RELEASE_ROOT}" ]]; then
  [[ -f "${RELEASE_ROOT}/package.json" ]] \
    || { echo "Existing release target is invalid" >&2; exit 1; }
  INSTALLED_VERSION="$("${NODE_REAL}" -p \
    "JSON.parse(require('fs').readFileSync(process.argv[1])).version" \
    "${RELEASE_ROOT}/package.json")"
  [[ "${INSTALLED_VERSION}" == "${VERSION}" ]] \
    || { echo "Existing release has the wrong version" >&2; exit 1; }
  ACTIVE_TARGET=""
  if [[ -L "${CURRENT_LINK}" ]]; then
    ACTIVE_TARGET="$(readlink -f -- "${CURRENT_LINK}")"
  fi
  [[ "${ACTIVE_TARGET}" != "${RELEASE_ROOT}" ]] \
    || { echo "Refusing to replace the active ${VERSION} release" >&2; exit 1; }
  SUPERSEDED_ROOT="${RELEASES_ROOT}/.${VERSION}.superseded.$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mv -- "${RELEASE_ROOT}" "${SUPERSEDED_ROOT}"
  if mv -- "${STAGE}" "${RELEASE_ROOT}"; then
    STAGE=""
    echo "Superseded inactive release retained at: ${SUPERSEDED_ROOT}"
  else
    mv -- "${SUPERSEDED_ROOT}" "${RELEASE_ROOT}"
    echo "Failed to replace inactive release; original restored" >&2
    exit 1
  fi
else
  chmod -R go-rwx "${STAGE}"
  mv -- "${STAGE}" "${RELEASE_ROOT}"
  STAGE=""
fi

# Re-check immediately before any existing production config/unit mutation:
# the external preflight may have completed before a new Codex task arrived.
if [[ "${ACTIVATE}" -eq 1 && -L "${CURRENT_LINK}" && -f "${CONFIG_PATH}" ]]; then
  python3 - "${CONFIG_PATH}" <<'PYIDLE'
import json, sqlite3, sys
from pathlib import Path
from urllib.parse import quote
p=Path(json.loads(Path(sys.argv[1]).read_text())['storage']['database'])
con=sqlite3.connect('file:'+quote(str(p),safe='/')+'?mode=ro', uri=True, timeout=5)
try:
    for table,condition in [
        ('codex_runtime_runs', "state IN ('starting','running')"),
        ('codex_approvals', "state='pending'"),
        ('federation_inbox', "state='dispatched'"),
        ('federation_outbox', "state='leased'")]:
        if con.execute(f'SELECT COUNT(*) FROM {table} WHERE {condition}').fetchone()[0]:
            raise SystemExit('FAIL: live Codex/Federation work appeared during verification; abort cutover')
    print('PASS: rechecked idle state immediately before activation')
finally:
    con.close()
PYIDLE
fi

if [[ -n "${CONFIG_SOURCE}" ]]; then
  [[ -f "${CONFIG_SOURCE}" && ! -L "${CONFIG_SOURCE}" ]] \
    || { echo "Config source must be a regular non-symlink file" >&2; exit 1; }
  install -m 0600 "${CONFIG_SOURCE}" "${CONFIG_PATH}"
elif [[ ! -f "${CONFIG_PATH}" ]]; then
  umask 077
  "${NODE_REAL}" -e \
    "const {randomBytes}=require('crypto');process.stdout.write(randomBytes(32).toString('hex')+'\\n')" \
    > "${CONFIG_ROOT}/admin.token"
  "${NODE_REAL}" -e \
    "const {randomBytes}=require('crypto');process.stdout.write(randomBytes(32).toString('hex')+'\\n')" \
    > "${CONFIG_ROOT}/marveen-inbound.token"
  "${NODE_REAL}" -e \
    "const {randomBytes}=require('crypto');process.stdout.write(randomBytes(32).toString('hex')+'\\n')" \
    > "${CONFIG_ROOT}/marveen-outbound.token"
  chmod 0600 "${CONFIG_ROOT}"/*.token
  DEVELOPER_INSTRUCTIONS_JSON="$("${NODE_REAL}" -e \
    "const fs=require('fs');process.stdout.write(JSON.stringify(fs.readFileSync(process.argv[1],'utf8')))" \
    "${RELEASE_ROOT}/config/programozo-developer-instructions.hu.md")"
  cat > "${CONFIG_PATH}" <<EOF
{
  "version": 1,
  "systemId": "codex",
  "listen": {"host": "127.0.0.1", "port": 3431},
  "storage": {"database": "${DATABASE_PATH}"},
  "codex": {
    "binary": "${CODEX_REAL}",
    "expectedVersion": "0.164.0",
    "runtimeRoot": "${RUNTIME_ROOT}",
    "allowedModels": ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"],
    "imageGenerationRequired": true,
    "imageModel": "gpt-image-2"
  },
  "admin": {"tokenFile": "${CONFIG_ROOT}/admin.token"},
  "agents": [{
    "id": "programozo",
    "displayName": "Codex programozó",
    "model": "gpt-5.6-terra",
    "capabilitySummary": "Programozás, webfejlesztés, marketing és képgenerálás.",
    "workspacePath": "${WORKSPACE_ROOT}",
    "sandboxMode": "workspace-write",
    "approvalPolicy": "manual",
    "federationPeer": "marveen",
    "reasoningEffort": "high",
    "developerInstructions": ${DEVELOPER_INSTRUCTIONS_JSON},
    "networkEnabled": false
  }],
  "peers": [{
    "id": "marveen",
    "baseUrl": "http://127.0.0.1:3420",
    "inboundTokenFile": "${CONFIG_ROOT}/marveen-inbound.token",
    "outboundTokenFile": "${CONFIG_ROOT}/marveen-outbound.token"
  }],
  "workers": {"intervalMs": 250}
}
EOF
  chmod 0600 "${CONFIG_PATH}"
  {
    printf 'FEDERATION_PEER_ID=codex\n'
    printf 'FEDERATION_BASE_URL=http://127.0.0.1:3431\n'
    printf 'MARVEEN_TO_CODEX_TOKEN='
    tr -d '\n' < "${CONFIG_ROOT}/marveen-inbound.token"
    printf '\nCODEX_TO_MARVEEN_TOKEN='
    tr -d '\n' < "${CONFIG_ROOT}/marveen-outbound.token"
    printf '\n'
  } > "${CONFIG_ROOT}/marveen-pairing.env"
  chmod 0600 "${CONFIG_ROOT}/marveen-pairing.env"
fi

chmod 0600 "${CONFIG_PATH}"
"${NODE_REAL}" --input-type=module - \
  "${CONFIG_PATH}" \
  "${RELEASE_ROOT}/config/programozo-developer-instructions.hu.md" <<'NODE'
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const [, , configPath, instructionsPath] = process.argv
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const agent = config.agents?.find((entry) => entry?.id === 'programozo')
if (agent && (!agent.developerInstructions || agent.developerInstructions.trim() === '')) {
  agent.developerInstructions = readFileSync(instructionsPath, 'utf8')
  const temporary = `${configPath}.0.3.4.tmp`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, configPath)
}
NODE
chmod 0600 "${CONFIG_PATH}"
"${NODE_REAL}" --input-type=module - \
  "${RELEASE_ROOT}/src/config.mjs" "${CONFIG_PATH}" "${STATE_ROOT}" "${DATA_ROOT}" "${HOME}" <<'NODE'
import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { relative } from 'node:path'

const [, , modulePath, configPath, stateRoot, dataRoot, homeRootInput] = process.argv
const { loadServiceConfig } = await import(pathToFileURL(modulePath))
const config = loadServiceConfig(configPath)
const homeRoot = realpathSync(homeRootInput)
const inside = (root, candidate) => {
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/')
}
if (!inside(stateRoot, config.storage.database)) {
  throw new Error('storage.database must stay inside the Bridge state root')
}
if (!inside(dataRoot, config.codex.runtimeRoot)) {
  throw new Error('codex.runtimeRoot must stay inside the Bridge data root')
}
for (const agent of config.agents) {
  if (!inside(homeRoot, agent.workspacePath)) {
    throw new Error(`agent '${agent.id}' workspace must stay inside HOME and must not equal HOME`)
  }
}
NODE

ln -sfn "${RELEASE_ROOT}" "${CANDIDATE_LINK}.new"
mv -Tf "${CANDIDATE_LINK}.new" "${CANDIDATE_LINK}"

render_unit() {
  local target="$1"
  local output="$2"
  local template="${target}/systemd/marveen-codex-bridge-federation.service.in"
  [[ -d "${target}" && ! -L "${target}" && -f "${template}" ]] \
    || { echo "Release cannot render a systemd unit: ${target}" >&2; return 1; }
  "${NODE_REAL}" --input-type=module - \
    "${template}" "${output}" "${CONFIG_PATH}" \
    "${NODE_REAL}" "${target}" "${CONFIG_PATH}" "${CONFIG_ROOT}" \
    "${target}/node_modules/better-sqlite3" "${STATE_ROOT}" "${DATA_ROOT}" \
    "${CODEX_HOME}" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'

const [
  , , templatePath, outputPath, configPath,
  nodeBin, releaseRoot, installedConfigPath, configRoot,
  betterSqlite3Path, stateRoot, dataRoot, codexHome,
] = process.argv
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const unitPath = (value) => {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('systemd path contains a forbidden control character')
  }
  return JSON.stringify(value.replaceAll('%', '%%'))
}
const workspaces = config.agents
  .map((agent) => `ReadWritePaths=${unitPath(agent.workspacePath)}`)
  .join('\n')
const replacements = new Map([
  ['@NODE_BIN@', nodeBin],
  ['@RELEASE_ROOT@', releaseRoot],
  ['@CONFIG_PATH@', installedConfigPath],
  ['@CONFIG_ROOT@', configRoot],
  ['@BETTER_SQLITE3_PATH@', betterSqlite3Path],
  ['@STATE_ROOT@', stateRoot],
  ['@DATA_ROOT@', dataRoot],
  ['@CODEX_HOME@', codexHome],
  ['@AGENT_WORKSPACE_READ_WRITE_PATHS@', workspaces],
])
let unit = readFileSync(templatePath, 'utf8')
unit = unit.replace(/@[A-Z0-9_]+@/g, (placeholder) => {
  if (!replacements.has(placeholder)) {
    throw new Error(`unknown systemd template placeholder: ${placeholder}`)
  }
  return replacements.get(placeholder)
})
writeFileSync(outputPath, unit, { mode: 0o600 })
NODE
  chmod 0600 "${output}"
}

render_unit "${RELEASE_ROOT}" "${UNIT_PATH}.candidate"

if [[ "${ACTIVATE}" -eq 0 ]]; then
  # Preparing a candidate must never repoint the installed service. Re-render
  # the current release to repair any unit left by an older 0.3.0 prerelease.
  if [[ -L "${CURRENT_LINK}" ]]; then
    CURRENT_TARGET="$(readlink -f -- "${CURRENT_LINK}")"
    render_unit "${CURRENT_TARGET}" "${UNIT_PATH}.new"
    mv -f "${UNIT_PATH}.new" "${UNIT_PATH}"
  fi
  echo "RESULT: PHASE 7 PREPARED (NOT ACTIVATED)"
  echo "Candidate: ${CANDIDATE_LINK}"
  echo "Pairing file: ${CONFIG_ROOT}/marveen-pairing.env"
  exit 0
fi

command -v systemctl >/dev/null || { echo "systemctl is required for activation" >&2; exit 1; }
if systemctl --user is-active --quiet bela-codex-bridge.service; then
  echo "Legacy bela-codex-bridge.service is active; refusing dual runtime activation" >&2
  exit 1
fi

OLD_TARGET=""
if [[ -L "${CURRENT_LINK}" ]]; then OLD_TARGET="$(readlink -f -- "${CURRENT_LINK}")"; fi
if [[ -n "${OLD_TARGET}" ]]; then
  render_unit "${OLD_TARGET}" "${UNIT_PATH}.rollback"
  ln -sfn "${OLD_TARGET}" "${PREVIOUS_LINK}.new"
  mv -Tf "${PREVIOUS_LINK}.new" "${PREVIOUS_LINK}"
fi
ln -sfn "${RELEASE_ROOT}" "${CURRENT_LINK}.new"
mv -Tf "${CURRENT_LINK}.new" "${CURRENT_LINK}"
mv -f "${UNIT_PATH}.candidate" "${UNIT_PATH}"

systemctl --user daemon-reload
systemctl --user reset-failed marveen-codex-bridge.service 2>/dev/null || true
systemctl --user enable marveen-codex-bridge.service
systemctl --user restart marveen-codex-bridge.service

READY=0
for _ in {1..45}; do
  if curl --silent --fail http://127.0.0.1:3431/readyz \
    | grep -q '"status":"ready"'; then
    READY=1
    break
  fi
  sleep 2
done

if [[ "${READY}" -ne 1 ]]; then
  echo "New service did not become ready; rolling back release pointer" >&2
  systemctl --user stop marveen-codex-bridge.service || true
  if [[ -n "${OLD_TARGET}" ]]; then
    ln -sfn "${OLD_TARGET}" "${CURRENT_LINK}.new"
    mv -Tf "${CURRENT_LINK}.new" "${CURRENT_LINK}"
    mv -f "${UNIT_PATH}.rollback" "${UNIT_PATH}"
    systemctl --user daemon-reload
    systemctl --user reset-failed marveen-codex-bridge.service 2>/dev/null || true
    systemctl --user restart marveen-codex-bridge.service || true
    ROLLBACK_READY=0
    for _ in {1..45}; do
      if curl --silent --fail http://127.0.0.1:3431/readyz \
        | grep -q '"status":"ready"'; then
        ROLLBACK_READY=1
        break
      fi
      sleep 2
    done
    [[ "${ROLLBACK_READY}" -eq 1 ]] \
      || echo "ROLLBACK FAILED: previous Bridge did not become ready" >&2
  fi
  exit 1
fi

if [[ -e "${UNIT_PATH}.rollback" ]]; then
  mv -f "${UNIT_PATH}.rollback" "${UNIT_PATH}.last-known-good"
fi

echo "RESULT: PHASE 7 STANDALONE SERVICE ACTIVE"
echo "Dashboard: http://127.0.0.1:3431/dashboard"
