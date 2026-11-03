#!/usr/bin/env bash
set -euo pipefail

VERSION="0.3.4"
LEGACY_MARVEEN_VERSION="1.21.1"
EXPECTED_MARVEEN_VERSION="1.25.1"
SOURCE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
MARVEEN_ROOT="${HOME}/marveen"
PHASE0_ROOT=""
CANDIDATE_COMMIT=""
BUNDLE=""
NODE_BIN="${HOME}/.nvm/versions/node/v22.23.1/bin/node"
CODEX_BIN="${HOME}/.local/bin/codex"
MAIN_AGENT_ID="bela"
ROUTING_MODE="advisory"
EXECUTE=0

usage() {
  cat <<'EOF'
Usage:
  cutover-phase7.sh --phase0-root PATH --candidate-commit SHA --bundle PATH
                    [options]

Options:
  --marveen-root PATH
  --node-bin PATH
  --codex-bin PATH
  --main-agent-id ID
  --routing-mode strong|catalog-first|advisory
  --execute

Without --execute this command is a read-only preflight.

Execute mode performs the controlled production cutover to the already tested
Marveen 1.25.1 candidate, pairs the standalone Bridge only through Marveen's
public Federation API, activates it, and runs an exactly-once live canary.

The Marveen source is never patched. On failure, Federation is disabled first.
If Marveen itself was switched, its original commit, dirty working tree and
Node modules are restored. The quarantined legacy adapter is not re-applied;
rollback intentionally returns to a safe Claude-only Marveen.
EOF
}

fail() {
  echo "FAIL: $*" >&2
  return 1
}

pass() {
  echo "PASS: $*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --marveen-root) MARVEEN_ROOT="${2:?missing path}"; shift 2 ;;
    --phase0-root) PHASE0_ROOT="${2:?missing path}"; shift 2 ;;
    --candidate-commit) CANDIDATE_COMMIT="${2:?missing commit}"; shift 2 ;;
    --bundle) BUNDLE="${2:?missing bundle}"; shift 2 ;;
    --node-bin) NODE_BIN="${2:?missing path}"; shift 2 ;;
    --codex-bin) CODEX_BIN="${2:?missing path}"; shift 2 ;;
    --main-agent-id) MAIN_AGENT_ID="${2:?missing id}"; shift 2 ;;
    --routing-mode) ROUTING_MODE="${2:?missing mode}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[[ "$(id -u)" -ne 0 ]] || fail "refusing root cutover"
[[ -d "${MARVEEN_ROOT}/.git" || -f "${MARVEEN_ROOT}/.git" ]] \
  || fail "Marveen root is not a Git worktree"
[[ -n "${PHASE0_ROOT}" && -d "${PHASE0_ROOT}" ]] \
  || fail "--phase0-root is required"
[[ -f "${PHASE0_ROOT}/MANIFEST.json" && ! -L "${PHASE0_ROOT}/MANIFEST.json" ]] \
  || fail "verified Phase 0 manifest is missing"
[[ -f "${PHASE0_ROOT}/SHA256SUMS" && ! -L "${PHASE0_ROOT}/SHA256SUMS" ]] \
  || fail "verified Phase 0 checksum inventory is missing"
for archive in \
  private/marveen-source-checkpoint.tar.gz \
  private/marveen-runtime-backup.tar.gz \
  private/legacy-bridge-backup.tar.gz \
  diagnostics-safe.tar.gz
do
  [[ -f "${PHASE0_ROOT}/${archive}" ]] \
    || fail "Phase 0 checkpoint is incomplete: ${archive}"
done
(
  cd -- "${PHASE0_ROOT}"
  sha256sum -c -- SHA256SUMS >/dev/null
) || fail "Phase 0 checkpoint checksum verification failed"
pass "Phase 0 manifest and checkpoint checksums are verified"
[[ "${CANDIDATE_COMMIT}" =~ ^[0-9a-fA-F]{7,40}$ ]] \
  || fail "--candidate-commit must be a Git object id"
[[ -f "${BUNDLE}" && ! -L "${BUNDLE}" ]] \
  || fail "--bundle must be a regular non-symlink file"
[[ -f "${BUNDLE}.sha256" ]] || fail "bundle checksum file is missing"
(
  cd -- "$(dirname -- "${BUNDLE}")"
  sha256sum -c -- "$(basename -- "${BUNDLE}.sha256")" >/dev/null
) || fail "candidate bundle checksum mismatch"
git -C "${MARVEEN_ROOT}" bundle verify "${BUNDLE}" >/dev/null 2>&1 \
  || fail "candidate bundle is invalid"
git -C "${MARVEEN_ROOT}" cat-file -e "${CANDIDATE_COMMIT}^{commit}" \
  || fail "candidate commit is not present in the Marveen repository"

NODE_REAL="$(readlink -f -- "${NODE_BIN}")"
CODEX_REAL="$(readlink -f -- "${CODEX_BIN}")"
[[ -x "${NODE_REAL}" && "$("${NODE_REAL}" --version)" == v22.* ]] \
  || fail "fixed Node 22 is required"
[[ -x "${CODEX_REAL}" ]] || fail "Codex binary is not executable"
"${CODEX_REAL}" --version | grep -q '0\.145\.0' \
  || fail "Codex CLI 0.164.0 is required"
"${CODEX_REAL}" login status 2>&1 | grep -q '^Logged in using' \
  || fail "Codex ChatGPT login is required"
[[ "${MAIN_AGENT_ID}" =~ ^[a-zA-Z0-9_-]{1,64}$ ]] \
  || fail "invalid main agent id"
[[ "${ROUTING_MODE}" =~ ^(strong|catalog-first|advisory)$ ]] \
  || fail "invalid routing mode"

DASHBOARD_TOKEN="${MARVEEN_ROOT}/store/.dashboard-token"
[[ -f "${DASHBOARD_TOKEN}" && ! -L "${DASHBOARD_TOKEN}" ]] \
  || fail "Marveen dashboard token is missing or unsafe"
[[ "$(stat -c '%a' "${DASHBOARD_TOKEN}")" =~ ^(600|400)$ ]] \
  || fail "Marveen dashboard token permissions must be 0600 or 0400"

CANDIDATE_VERSION="$(
  git -C "${MARVEEN_ROOT}" show "${CANDIDATE_COMMIT}:package.json" |
    "${NODE_REAL}" -e '
      let text = ""
      process.stdin.on("data", (chunk) => { text += chunk })
      process.stdin.on("end", () => {
        const version = JSON.parse(text).version
        if (version !== process.argv[1]) process.exit(1)
        process.stdout.write(version)
      })
    ' "${EXPECTED_MARVEEN_VERSION}"
)" || fail "candidate is not Marveen ${EXPECTED_MARVEEN_VERSION}"
pass "candidate commit is Marveen ${CANDIDATE_VERSION} and bundle is verified"

command -v systemctl >/dev/null || fail "systemctl is required"
systemctl --user is-active --quiet bela-dashboard.service \
  || fail "production Marveen dashboard is not active"
curl --silent --show-error --fail \
  -H "Authorization: Bearer $(<"${DASHBOARD_TOKEN}")" \
  http://127.0.0.1:3420/api/agents >/dev/null \
  || fail "production Marveen API is not healthy"

CURRENT_MARVEEN_VERSION="$(
  git -C "${MARVEEN_ROOT}" show HEAD:package.json |
    "${NODE_REAL}" -e '
      let text = ""
      process.stdin.on("data", (chunk) => { text += chunk })
      process.stdin.on("end", () => {
        const version = JSON.parse(text).version
        if (typeof version !== "string" || version.length === 0) process.exit(1)
        process.stdout.write(version)
      })
    '
)" || fail "current Marveen version is unreadable"

if git -C "${MARVEEN_ROOT}" cat-file -e \
  "HEAD:src/web/routes/federation.ts" 2>/dev/null
then
  "${NODE_REAL}" "${SOURCE_ROOT}/scripts/federation-cutover-api.mjs" \
    preflight-disabled \
    --token-file "${DASHBOARD_TOKEN}" \
    --main-agent-id "${MAIN_AGENT_ID}" >/dev/null
  pass "Marveen Federation is reachable and disabled"
elif [[ "${CURRENT_MARVEEN_VERSION}" == "${LEGACY_MARVEEN_VERSION}" ]] \
  && [[ ! -e "${MARVEEN_ROOT}/src/web/routes/federation.ts" ]] \
  && [[ ! -e "${MARVEEN_ROOT}/dist/web/routes/federation.js" ]] \
  && [[ ! -e "${MARVEEN_ROOT}/dist/src/web/routes/federation.js" ]] \
  && [[ ! -e "${MARVEEN_ROOT}/dist/providers/codex-provider.js" ]] \
  && [[ ! -e "${MARVEEN_ROOT}/dist/src/providers/codex-provider.js" ]]
then
  pass "legacy Marveen ${LEGACY_MARVEEN_VERSION} has no Federation route and is implicitly disabled"
else
  fail "current Marveen Federation state cannot be proven disabled"
fi

DATA_ROOT="${XDG_DATA_HOME:-${HOME}/.local/share}/marveen-codex-bridge"
CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}/marveen-codex-bridge"
[[ -L "${DATA_ROOT}/candidate" ]] \
  || fail "standalone Bridge candidate is not installed"
[[ -f "${CONFIG_ROOT}/config.json" ]] \
  || fail "standalone Bridge configuration is missing"
[[ -f "${CONFIG_ROOT}/marveen-inbound.token" ]] \
  || fail "standalone Bridge inbound token is missing"

if systemctl --user is-active --quiet marveen-codex-bridge.service; then
  fail "new standalone Bridge is already active"
fi
if ! systemctl --user is-active --quiet bela-codex-bridge.service; then
  fail "legacy Bridge baseline is not active; reconcile service state first"
fi

LEGACY_SOCKET="/run/user/$(id -u)/bela-codex-bridge.sock"
LEGACY_TOKEN_FILE="${HOME}/.config/bela-codex-bridge/token"
if [[ -S "${LEGACY_SOCKET}" && -f "${LEGACY_TOKEN_FILE}" ]]; then
  LEGACY_TOKEN="$(<"${LEGACY_TOKEN_FILE}")"
  APPROVALS="$(
    curl --silent --show-error --fail \
      --unix-socket "${LEGACY_SOCKET}" \
      -H "Authorization: Bearer ${LEGACY_TOKEN}" \
      http://localhost/v1/approvals
  )" || fail "legacy Bridge approval inventory is unavailable"
  printf '%s' "${APPROVALS}" | "${NODE_REAL}" -e '
    let text = ""
    process.stdin.on("data", (chunk) => { text += chunk })
    process.stdin.on("end", () => {
      const rows = JSON.parse(text).data
      if (!Array.isArray(rows) || rows.length !== 0) process.exit(1)
    })
  ' || fail "pending legacy Bridge approvals block cutover"
  pass "legacy Bridge has no pending approval"
fi

if [[ "${EXECUTE}" -eq 0 ]]; then
  echo "RESULT: PHASE 7 CUTOVER PREFLIGHT PASS (NO MUTATION)"
  exit 0
fi

STATE_ROOT="${XDG_STATE_HOME:-${HOME}/.local/state}/marveen-codex-bridge"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RECORD="${STATE_ROOT}/cutover/${STAMP}"
install -d -m 0700 "${RECORD}"
OLD_HEAD="$(git -C "${MARVEEN_ROOT}" rev-parse HEAD)"
OLD_BRANCH="$(git -C "${MARVEEN_ROOT}" symbolic-ref --quiet --short HEAD)" \
  || fail "production Marveen must be on a named branch"
NEW_BRANCH="local/marveen-v${EXPECTED_MARVEEN_VERSION}-production-${STAMP}"
OLD_NODE_MODULES="${RECORD}/node_modules-before-cutover"
NEW_NODE_MODULES="${RECORD}/node_modules-failed-candidate"
OLD_DIST="${RECORD}/dist-before-cutover"
NEW_DIST="${RECORD}/dist-failed-candidate"
PAIRING_RESULT="${RECORD}/pairing-result.json"
BRIDGE_CONFIG="${CONFIG_ROOT}/config.json"
BRIDGE_CONFIG_BACKUP="${RECORD}/bridge-config-before-peer-reconcile.json"
BRIDGE_RECONCILE_RESULT="${RECORD}/bridge-peer-reconcile.json"
STASH_COMMIT=""
MARVEEN_SWITCHED=0
NODE_MODULES_MOVED=0
DIST_MOVED=0
PAIRING_CREATED=0
BRIDGE_CONFIG_RECONCILED=0
BRIDGE_CONFIG_CHANGED=0
LEGACY_STOPPED=0
FEDERATION_ENABLED=0
CUTOVER_OK=0

{
  printf 'version=%s\n' "${VERSION}"
  printf 'created_at=%s\n' "$(date -u +%FT%TZ)"
  printf 'marveen_root=%s\n' "${MARVEEN_ROOT}"
  printf 'old_branch=%s\n' "${OLD_BRANCH}"
  printf 'old_head=%s\n' "${OLD_HEAD}"
  printf 'candidate_commit=%s\n' "${CANDIDATE_COMMIT}"
  printf 'new_branch=%s\n' "${NEW_BRANCH}"
  printf 'routing_mode=%s\n' "${ROUTING_MODE}"
} > "${RECORD}/state.env"
chmod 0600 "${RECORD}/state.env"
git -C "${MARVEEN_ROOT}" status --porcelain=v1 -z \
  --untracked-files=all > "${RECORD}/status-before.z"
chmod 0600 "${RECORD}/status-before.z"

rollback() {
  local exit_code=$?
  local rollback_failed=0
  trap - ERR INT TERM
  [[ "${CUTOVER_OK}" -eq 0 ]] || return 0
  set +e
  if [[ "${MARVEEN_SWITCHED}" -eq 1 ]]; then
    echo "ROLLBACK: disabling Federation first" >&2
    "${NODE_REAL}" "${SOURCE_ROOT}/scripts/federation-cutover-api.mjs" \
      disable --token-file "${DASHBOARD_TOKEN}" >/dev/null 2>&1 \
      || rollback_failed=1
  fi
  if [[ "${MARVEEN_SWITCHED}" -eq 1 && "${PAIRING_CREATED}" -eq 1 ]]; then
    "${NODE_REAL}" "${SOURCE_ROOT}/scripts/pair-marveen-phase6.2.mjs" \
      --dashboard-token-file "${DASHBOARD_TOKEN}" \
      --rollback >/dev/null 2>&1 \
      || rollback_failed=1
  fi
  systemctl --user disable --now marveen-codex-bridge.service >/dev/null 2>&1
  if [[ "${BRIDGE_CONFIG_RECONCILED}" -eq 1 ]]; then
    install -m 0600 "${BRIDGE_CONFIG_BACKUP}" "${BRIDGE_CONFIG}" \
      || rollback_failed=1
  fi
  if [[ "${MARVEEN_SWITCHED}" -eq 1 ]]; then
    systemctl --user stop bela-dashboard.service >/dev/null 2>&1
    if [[ -d "${MARVEEN_ROOT}/dist" && "${DIST_MOVED}" -eq 1 ]]; then
      mv -- "${MARVEEN_ROOT}/dist" "${NEW_DIST}" \
        || rollback_failed=1
    fi
    if [[ -d "${MARVEEN_ROOT}/node_modules" && "${NODE_MODULES_MOVED}" -eq 1 ]]; then
      mv -- "${MARVEEN_ROOT}/node_modules" "${NEW_NODE_MODULES}" \
        || rollback_failed=1
    fi
    git -C "${MARVEEN_ROOT}" switch "${OLD_BRANCH}" >/dev/null 2>&1 \
      || rollback_failed=1
    if [[ -n "${STASH_COMMIT}" ]]; then
      git -C "${MARVEEN_ROOT}" stash apply "${STASH_COMMIT}" >/dev/null 2>&1 \
        || rollback_failed=1
    fi
    if [[ "${NODE_MODULES_MOVED}" -eq 1 && -d "${OLD_NODE_MODULES}" ]]; then
      mv -- "${OLD_NODE_MODULES}" "${MARVEEN_ROOT}/node_modules" \
        || rollback_failed=1
    fi
    if [[ "${DIST_MOVED}" -eq 1 && -d "${OLD_DIST}" ]]; then
      mv -- "${OLD_DIST}" "${MARVEEN_ROOT}/dist" \
        || rollback_failed=1
    fi
    systemctl --user restart bela-dashboard.service >/dev/null 2>&1 \
      || rollback_failed=1
    local dashboard_restored=0
    for _ in {1..45}; do
      if curl --silent --fail \
        -H "Authorization: Bearer $(<"${DASHBOARD_TOKEN}")" \
        http://127.0.0.1:3420/api/agents >/dev/null 2>&1
      then
        dashboard_restored=1
        break
      fi
      sleep 2
    done
    [[ "${dashboard_restored}" -eq 1 ]] || rollback_failed=1
  fi
  if [[ "${LEGACY_STOPPED}" -eq 1 ]]; then
    systemctl --user enable --now bela-codex-bridge.service >/dev/null 2>&1 \
      || rollback_failed=1
    local legacy_restored=0
    for _ in {1..45}; do
      if curl --silent --fail \
        --unix-socket "${LEGACY_SOCKET}" \
        http://localhost/readyz 2>/dev/null \
        | grep -q '"status":"ready"'
      then
        legacy_restored=1
        break
      fi
      sleep 2
    done
    [[ "${legacy_restored}" -eq 1 ]] || rollback_failed=1
  fi
  {
    printf 'rolled_back_at=%s\n' "$(date -u +%FT%TZ)"
    printf 'trigger_exit_code=%s\n' "${exit_code}"
    printf 'rollback_verified=%s\n' "$((rollback_failed == 0 ? 1 : 0))"
  } >> "${RECORD}/state.env"
  if [[ "${rollback_failed}" -eq 0 ]]; then
    echo "RESULT: CUTOVER FAILED; PRE-CUTOVER SERVICES AND MARVEEN FILES RESTORED" >&2
  else
    echo "RESULT: CUTOVER FAILED; ROLLBACK REQUIRES MANUAL RECOVERY" >&2
  fi
  echo "Recovery record: ${RECORD}" >&2
  exit "${exit_code}"
}
trap rollback ERR INT TERM

# Prove that the candidate works under the real systemd sandbox before the
# production Marveen checkout, dependencies or dist directory are touched.
# The two Bridge services are never active at the same time.
LEGACY_STOPPED=1
systemctl --user disable --now bela-codex-bridge.service
"${SOURCE_ROOT}/scripts/install-phase7.sh" \
  --node-bin "${NODE_REAL}" \
  --codex-bin "${CODEX_REAL}" \
  --activate \
  --skip-tests
curl --silent --show-error --fail http://127.0.0.1:3431/readyz \
  | grep -q '"status":"ready"' \
  || fail "standalone Bridge readiness failed before Marveen mutation"
pass "standalone Bridge passed the real systemd sandbox before Marveen mutation"

git -C "${MARVEEN_ROOT}" stash push --include-untracked \
  -m "phase7-production-cutover-${STAMP}" >/dev/null
STASH_COMMIT="$(git -C "${MARVEEN_ROOT}" rev-parse refs/stash)"
printf 'stash_commit=%s\n' "${STASH_COMMIT}" >> "${RECORD}/state.env"
[[ -z "$(git -C "${MARVEEN_ROOT}" status --porcelain=v1 --untracked-files=all)" ]] \
  || fail "Marveen working tree did not become clean after checkpoint stash"

git -C "${MARVEEN_ROOT}" switch -c "${NEW_BRANCH}" "${CANDIDATE_COMMIT}"
MARVEEN_SWITCHED=1
pass "production Marveen source switched to the tested candidate commit"

if [[ -d "${MARVEEN_ROOT}/node_modules" ]]; then
  mv -- "${MARVEEN_ROOT}/node_modules" "${OLD_NODE_MODULES}"
  NODE_MODULES_MOVED=1
fi
NPM_CLI="$(readlink -f -- "$(dirname -- "${NODE_REAL}")/../lib/node_modules/npm/bin/npm-cli.js")"
[[ -f "${NPM_CLI}" ]] || fail "Node 22 npm CLI is missing"
(
  cd "${MARVEEN_ROOT}"
  PATH="$(dirname -- "${NODE_REAL}"):/usr/local/bin:/usr/bin:/bin" \
    "${NODE_REAL}" "${NPM_CLI}" ci --no-audit --no-fund
  PATH="$(dirname -- "${NODE_REAL}"):/usr/local/bin:/usr/bin:/bin" \
    "${NODE_REAL}" "${NPM_CLI}" run typecheck
  "${NODE_REAL}" --check web/app.js
  "${NODE_REAL}" --check web/sw.js
)
pass "Marveen dependencies, typecheck and syntax passed under Node 22"

systemctl --user stop bela-dashboard.service
[[ -d "${MARVEEN_ROOT}/dist" ]] \
  || fail "pre-cutover Marveen dist directory is missing"
mv -- "${MARVEEN_ROOT}/dist" "${OLD_DIST}"
DIST_MOVED=1
(
  cd "${MARVEEN_ROOT}"
  PATH="$(dirname -- "${NODE_REAL}"):/usr/local/bin:/usr/bin:/bin" \
    "${NODE_REAL}" "${NPM_CLI}" run build
)
[[ -d "${MARVEEN_ROOT}/dist" ]] \
  || fail "candidate Marveen build did not create dist"
pass "Marveen candidate was built into a clean dist directory"

systemctl --user start bela-dashboard.service
for _ in {1..45}; do
  if curl --silent --fail \
    -H "Authorization: Bearer $(<"${DASHBOARD_TOKEN}")" \
    http://127.0.0.1:3420/api/agents >/dev/null
  then
    DASHBOARD_READY=1
    break
  fi
  sleep 2
done
[[ "${DASHBOARD_READY:-0}" -eq 1 ]] \
  || fail "Marveen ${EXPECTED_MARVEEN_VERSION} dashboard did not become healthy"
pass "Marveen ${EXPECTED_MARVEEN_VERSION} dashboard is healthy; Federation remains disabled"

"${NODE_REAL}" "${SOURCE_ROOT}/scripts/pair-marveen-phase6.2.mjs" \
  --dashboard-token-file "${DASHBOARD_TOKEN}" \
  --result-file "${PAIRING_RESULT}" \
  --execute
PAIRING_CREATED="$(
  "${NODE_REAL}" -p \
    "JSON.parse(require('fs').readFileSync(process.argv[1])).createdNow ? 1 : 0" \
    "${PAIRING_RESULT}"
)"
"${NODE_REAL}" "${SOURCE_ROOT}/scripts/federation-cutover-api.mjs" \
  preflight-paired --token-file "${DASHBOARD_TOKEN}" >/dev/null
pass "standalone Bridge peer is paired while Federation is disabled"

install -m 0600 "${BRIDGE_CONFIG}" "${BRIDGE_CONFIG_BACKUP}"
BRIDGE_CONFIG_RECONCILED=1
"${NODE_REAL}" "${SOURCE_ROOT}/scripts/reconcile-bridge-peer.mjs" \
  --config "${BRIDGE_CONFIG}" \
  --pairing-result "${PAIRING_RESULT}" \
  --expected-bridge-system-id codex \
  --execute > "${BRIDGE_RECONCILE_RESULT}"
chmod 0600 "${BRIDGE_RECONCILE_RESULT}"
BRIDGE_CONFIG_CHANGED="$(
  "${NODE_REAL}" -p \
    "JSON.parse(require('fs').readFileSync(process.argv[1])).changed ? 1 : 0" \
    "${BRIDGE_RECONCILE_RESULT}"
)"
if [[ "${BRIDGE_CONFIG_CHANGED}" -eq 1 ]]; then
  systemctl --user restart marveen-codex-bridge.service
  BRIDGE_READY=0
  for _ in {1..45}; do
    if curl --silent --fail http://127.0.0.1:3431/readyz \
      | grep -q '"status":"ready"'
    then
      BRIDGE_READY=1
      break
    fi
    sleep 2
  done
  [[ "${BRIDGE_READY}" -eq 1 ]] \
    || fail "standalone Bridge did not recover after peer identity reconciliation"
fi
pass "Bridge peer identity matches the Marveen Federation systemId"

curl --silent --show-error --fail http://127.0.0.1:3431/readyz \
  | grep -q '"status":"ready"' \
  || fail "standalone Bridge readiness was lost before Federation enable"
pass "legacy Bridge remains stopped and standalone Bridge remains ready"

"${NODE_REAL}" "${SOURCE_ROOT}/scripts/federation-cutover-api.mjs" \
  enable \
  --token-file "${DASHBOARD_TOKEN}" \
  --routing-mode "${ROUTING_MODE}" >/dev/null
FEDERATION_ENABLED=1
pass "Marveen Federation is enabled in ${ROUTING_MODE} mode"

MARKER="PHASE7_FEDERATION_$(date -u +%Y%m%dT%H%M%SZ)_OK"
"${NODE_REAL}" "${SOURCE_ROOT}/scripts/federation-cutover-api.mjs" \
  canary \
  --token-file "${DASHBOARD_TOKEN}" \
  --main-agent-id "${MAIN_AGENT_ID}" \
  --marker "${MARKER}" > "${RECORD}/canary.json"
chmod 0600 "${RECORD}/canary.json"
pass "live Marveen -> Codex -> Marveen exactly-once canary passed"

{
  printf 'completed_at=%s\n' "$(date -u +%FT%TZ)"
  printf 'federation_enabled=1\n'
  printf 'canary_marker=%s\n' "${MARKER}"
} >> "${RECORD}/state.env"
CUTOVER_OK=1
trap - ERR INT TERM

echo "Recovery record: ${RECORD}"
echo "Old Node modules retained for soak rollback: ${OLD_NODE_MODULES}"
echo "Legacy adapter quarantine remains untouched and recoverable."
echo "RESULT: PHASE 7 PRODUCTION CUTOVER PASS"
