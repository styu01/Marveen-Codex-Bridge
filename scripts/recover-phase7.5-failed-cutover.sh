#!/usr/bin/env bash
set -euo pipefail

MARVEEN_ROOT="${HOME}/marveen"
RECOVERY_RECORD=""
NODE_BIN="${HOME}/.nvm/versions/node/v22.23.1/bin/node"
EXECUTE=0

usage() {
  cat <<'EOF'
Usage:
  recover-phase7.5-failed-cutover.sh --recovery-record PATH [options]

Options:
  --marveen-root PATH
  --node-bin PATH
  --execute

Without --execute this command only verifies the known Phase 7.5 hybrid-dist
failure state. Execute mode preserves the contaminated dist in the recovery
record, performs a clean Marveen 1.21.1 build, restarts the dashboard and
verifies that neither Federation nor the legacy Codex adapter remains in dist.
EOF
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --marveen-root) MARVEEN_ROOT="${2:?missing path}"; shift 2 ;;
    --recovery-record) RECOVERY_RECORD="${2:?missing path}"; shift 2 ;;
    --node-bin) NODE_BIN="${2:?missing path}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[[ "$(id -u)" -ne 0 ]] || fail "refusing root recovery"
[[ -d "${MARVEEN_ROOT}/.git" || -f "${MARVEEN_ROOT}/.git" ]] \
  || fail "Marveen root is not a Git worktree"
[[ -n "${RECOVERY_RECORD}" && -d "${RECOVERY_RECORD}" ]] \
  || fail "--recovery-record is required"
[[ -f "${RECOVERY_RECORD}/state.env" && ! -L "${RECOVERY_RECORD}/state.env" ]] \
  || fail "recovery record state.env is missing or unsafe"
grep -q '^version=0\.3\.0-phase7\.5$' "${RECOVERY_RECORD}/state.env" \
  || fail "recovery record is not the failed Phase 7.5 cutover"
grep -q '^rolled_back_at=' "${RECOVERY_RECORD}/state.env" \
  || fail "recovery record does not describe a completed rollback attempt"

NODE_REAL="$(readlink -f -- "${NODE_BIN}")"
[[ -x "${NODE_REAL}" && "$("${NODE_REAL}" --version)" == v22.* ]] \
  || fail "fixed Node 22 is required"
CURRENT_VERSION="$(
  "${NODE_REAL}" -p \
    "JSON.parse(require('fs').readFileSync(process.argv[1])).version" \
    "${MARVEEN_ROOT}/package.json"
)"
[[ "${CURRENT_VERSION}" == "1.21.1" ]] \
  || fail "recovery requires the rolled-back Marveen 1.21.1 source"
systemctl --user is-active --quiet bela-dashboard.service \
  || fail "Marveen dashboard is not active"
systemctl --user is-active --quiet bela-codex-bridge.service \
  || fail "legacy Bridge is not active"
[[ -d "${MARVEEN_ROOT}/dist" && ! -L "${MARVEEN_ROOT}/dist" ]] \
  || fail "Marveen dist is missing or unsafe"

HYBRID=0
for marker in \
  "${MARVEEN_ROOT}/dist/web/routes/federation.js" \
  "${MARVEEN_ROOT}/dist/src/web/routes/federation.js" \
  "${MARVEEN_ROOT}/dist/providers/codex-provider.js" \
  "${MARVEEN_ROOT}/dist/src/providers/codex-provider.js"
do
  [[ ! -e "${marker}" ]] || HYBRID=1
done
[[ "${HYBRID}" -eq 1 ]] \
  || fail "known Phase 7.5 hybrid-dist markers are absent; refusing mismatched recovery"
pass "known Phase 7.5 hybrid-dist state is present"

if [[ "${EXECUTE}" -eq 0 ]]; then
  echo "RESULT: PHASE 7.5 HYBRID-DIST RECOVERY PREFLIGHT PASS (NO MUTATION)"
  exit 0
fi

CONTAMINATED_DIST="${RECOVERY_RECORD}/dist-hybrid-phase7.5"
FAILED_REBUILD="${RECOVERY_RECORD}/dist-failed-recovery-build"
[[ ! -e "${CONTAMINATED_DIST}" && ! -e "${FAILED_REBUILD}" ]] \
  || fail "recovery record already contains a dist recovery artifact"

HEAD_BEFORE="$(git -C "${MARVEEN_ROOT}" rev-parse HEAD)"
STATUS_BEFORE="$(
  git -C "${MARVEEN_ROOT}" status --porcelain=v1 --untracked-files=all |
    sha256sum |
    awk '{print $1}'
)"
RESTORED=0

restore_on_error() {
  local exit_code=$?
  trap - ERR INT TERM
  [[ "${RESTORED}" -eq 0 ]] || exit "${exit_code}"
  set +e
  systemctl --user stop bela-dashboard.service >/dev/null 2>&1
  if [[ -d "${MARVEEN_ROOT}/dist" ]]; then
    mv -- "${MARVEEN_ROOT}/dist" "${FAILED_REBUILD}"
  fi
  if [[ -d "${CONTAMINATED_DIST}" ]]; then
    mv -- "${CONTAMINATED_DIST}" "${MARVEEN_ROOT}/dist"
  fi
  systemctl --user start bela-dashboard.service >/dev/null 2>&1
  echo "RESULT: CLEAN DIST RECOVERY FAILED; ORIGINAL DIST RESTORED" >&2
  exit "${exit_code}"
}
trap restore_on_error ERR INT TERM

systemctl --user stop bela-dashboard.service
mv -- "${MARVEEN_ROOT}/dist" "${CONTAMINATED_DIST}"

NPM_CLI="$(readlink -f -- "$(dirname -- "${NODE_REAL}")/../lib/node_modules/npm/bin/npm-cli.js")"
[[ -f "${NPM_CLI}" ]] || fail "Node 22 npm CLI is missing"
(
  cd "${MARVEEN_ROOT}"
  PATH="$(dirname -- "${NODE_REAL}"):/usr/local/bin:/usr/bin:/bin" \
    "${NODE_REAL}" "${NPM_CLI}" run build
)

[[ -d "${MARVEEN_ROOT}/dist" ]] || fail "clean build did not create dist"
for marker in \
  "${MARVEEN_ROOT}/dist/web/routes/federation.js" \
  "${MARVEEN_ROOT}/dist/src/web/routes/federation.js" \
  "${MARVEEN_ROOT}/dist/providers/codex-provider.js" \
  "${MARVEEN_ROOT}/dist/src/providers/codex-provider.js"
do
  [[ ! -e "${marker}" ]] || fail "forbidden stale build artifact remains: ${marker}"
done

systemctl --user start bela-dashboard.service
DASHBOARD_READY=0
for _ in {1..45}; do
  if curl --silent --fail \
    -H "Authorization: Bearer $(<"${MARVEEN_ROOT}/store/.dashboard-token")" \
    http://127.0.0.1:3420/api/agents >/dev/null
  then
    DASHBOARD_READY=1
    break
  fi
  sleep 2
done
[[ "${DASHBOARD_READY}" -eq 1 ]] || fail "restored dashboard did not become healthy"

HEAD_AFTER="$(git -C "${MARVEEN_ROOT}" rev-parse HEAD)"
STATUS_AFTER="$(
  git -C "${MARVEEN_ROOT}" status --porcelain=v1 --untracked-files=all |
    sha256sum |
    awk '{print $1}'
)"
[[ "${HEAD_BEFORE}" == "${HEAD_AFTER}" && "${STATUS_BEFORE}" == "${STATUS_AFTER}" ]] \
  || fail "Marveen Git source changed during dist recovery"
systemctl --user is-active --quiet bela-codex-bridge.service \
  || fail "legacy Bridge stopped during dist recovery"

RESTORED=1
trap - ERR INT TERM
{
  printf 'clean_dist_recovered_at=%s\n' "$(date -u +%FT%TZ)"
  printf 'contaminated_dist=%s\n' "${CONTAMINATED_DIST}"
} >> "${RECOVERY_RECORD}/state.env"

pass "clean Marveen 1.21.1 dist rebuilt under Node 22"
pass "dashboard and legacy Bridge are active"
pass "Marveen Git source and local changes are unchanged"
echo "Contaminated dist retained at: ${CONTAMINATED_DIST}"
echo "RESULT: PHASE 7.5 HYBRID-DIST RECOVERY PASS"
