#!/usr/bin/env bash
set -euo pipefail

MARVEEN_ROOT="${1:-${HOME}/marveen}"
MODE="${2:-install}"
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_NODE="${BELA_CODEX_BRIDGE_NODE:-${HOME}/.nvm/versions/node/v22.23.1/bin/node}"
MARVEEN_NODE="${BELA_MARVEEN_NODE:-$(command -v node)}"

fail() {
  echo "ERROR: $*" >&2
  exit 3
}

[[ "${MODE}" == "install" || "${MODE}" == "--check-only" ]] \
  || fail "Unknown adapter mode: ${MODE}"
[[ -f "${MARVEEN_ROOT}/package.json" ]] || fail "Marveen not found: ${MARVEEN_ROOT}"
MARVEEN_ROOT="$(cd "${MARVEEN_ROOT}" && pwd)"
[[ -x "${BRIDGE_NODE}" ]] || fail "Bridge Node 22 binary not found: ${BRIDGE_NODE}"
[[ "$("${BRIDGE_NODE}" --version)" == "v22.23.1" ]] \
  || fail "Expected Bridge Node v22.23.1: ${BRIDGE_NODE}"
[[ -x "${MARVEEN_NODE}" ]] || fail "Marveen Node binary not found: ${MARVEEN_NODE}"
MARVEEN_NODE_VERSION="$("${MARVEEN_NODE}" --version)"
[[ "${MARVEEN_NODE_VERSION}" == v24.* ]] \
  || fail "Marveen 1.21.1 must be built and tested with its Béla Node 24 runtime; found ${MARVEEN_NODE_VERSION} at ${MARVEEN_NODE}"

VERSION="$("${MARVEEN_NODE}" -p \
  "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version" \
  "${MARVEEN_ROOT}/package.json")"

[[ "${VERSION}" == "1.21.1" ]] \
  || fail "Béla Codex Bridge 0.2.1 supports the validated Marveen 1.21.1 adapter only; found ${VERSION}."

TARGET_TESTS=(
  src/__tests__/codex-agent-identity.test.ts
  src/__tests__/codex-provider-callback-dedupe.test.ts
  src/__tests__/codex-reasoning-effort.test.ts
  src/__tests__/provider-service-auth.test.ts
  src/__tests__/codex-message-router.test.ts
  src/__tests__/message-router-tick-cap.test.ts
  src/__tests__/schedule-run-now.test.ts
  src/__tests__/agent-restart-policy.test.ts
)

HAS_ADAPTER=0
if rg -q "Codex Bridge callback processed" \
  "${MARVEEN_ROOT}/src/web/routes/provider-callbacks.ts" 2>/dev/null \
  && rg -q "readAgentProvider" "${MARVEEN_ROOT}/src/web/message-router.ts" 2>/dev/null
then
  HAS_ADAPTER=1
fi

SOURCE_IDENTITY_CURRENT=0
if [[ "${HAS_ADAPTER}" -eq 1 ]] \
  && rg -q "buildCodexAgentIdentityFiles" \
    "${MARVEEN_ROOT}/src/web/agent-scaffold.ts" 2>/dev/null \
  && [[ -f "${MARVEEN_ROOT}/src/__tests__/codex-agent-identity.test.ts" ]]
then
  SOURCE_IDENTITY_CURRENT=1
fi

SOURCE_018_CURRENT=0
if [[ "${SOURCE_IDENTITY_CURRENT}" -eq 1 ]] \
  && rg -q "CODEX_CALLBACK_ADAPTER_REVISION = (2|3)" \
    "${MARVEEN_ROOT}/src/web/routes/provider-callbacks.ts" 2>/dev/null \
  && [[ -f "${MARVEEN_ROOT}/src/__tests__/codex-provider-callback-dedupe.test.ts" ]]
then
  SOURCE_018_CURRENT=1
fi

SOURCE_019_CURRENT=0
if [[ "${SOURCE_018_CURRENT}" -eq 1 ]] \
  && rg -q "reasoningEffort" "${MARVEEN_ROOT}/src/providers/types.ts" 2>/dev/null \
  && rg -q "agentReasoningEffort" "${MARVEEN_ROOT}/web/app.js" 2>/dev/null \
  && [[ -f "${MARVEEN_ROOT}/src/__tests__/codex-reasoning-effort.test.ts" ]]
then
  SOURCE_019_CURRENT=1
fi

SOURCE_CURRENT=0
if [[ "${SOURCE_019_CURRENT}" -eq 1 ]] \
  && rg -q "CODEX_CALLBACK_ADAPTER_REVISION = 3" \
    "${MARVEEN_ROOT}/src/web/routes/provider-callbacks.ts" 2>/dev/null \
  && [[ -f "${MARVEEN_ROOT}/src/web/routes/codex-artifacts.ts" ]] \
  && rg -q "hydrateCodexImages" "${MARVEEN_ROOT}/web/app.js" 2>/dev/null
then
  SOURCE_CURRENT=1
fi

DIST_CURRENT=0
if [[ -f "${MARVEEN_ROOT}/dist/web/agent-scaffold.js" ]] \
  && rg -q "buildCodexAgentIdentityFiles" \
    "${MARVEEN_ROOT}/dist/web/agent-scaffold.js" 2>/dev/null \
  && [[ -f "${MARVEEN_ROOT}/dist/providers/codex-provider.js" ]] \
  && rg -q "readAgentProvider" \
    "${MARVEEN_ROOT}/dist/web/message-router.js" 2>/dev/null \
  && rg -q "CODEX_CALLBACK_ADAPTER_REVISION = 3" \
    "${MARVEEN_ROOT}/dist/web/routes/provider-callbacks.js" 2>/dev/null \
  && rg -q "reasoningEffort" \
    "${MARVEEN_ROOT}/dist/providers/codex-provider.js" 2>/dev/null \
  && [[ -f "${MARVEEN_ROOT}/dist/web/routes/codex-artifacts.js" ]] \
  && rg -q "hydrateCodexImages" "${MARVEEN_ROOT}/web/app.js" 2>/dev/null
then
  DIST_CURRENT=1
fi

if [[ "${SOURCE_CURRENT}" -eq 1 && "${DIST_CURRENT}" -eq 1 ]]; then
  if [[ "${MODE}" == "--check-only" ]]; then
    echo "PASS: Marveen ${VERSION} source and dist already contain the current Codex adapter."
  else
    echo "Marveen ${VERSION} current Codex adapter source and dist are already installed."
  fi
  exit 0
fi

if [[ "${SOURCE_CURRENT}" -eq 1 ]]; then
  ADAPTER_ACTION="rebuild-current-dist"
  PATCH_FILE=""
  MANIFEST="${SOURCE_ROOT}/adapter/compatibility-1.21.1-adapter-0.2.0.sha256"
  NEW_FILES=()
elif [[ "${SOURCE_019_CURRENT}" -eq 1 ]]; then
  ADAPTER_ACTION="upgrade-0.1.9-to-current"
  PATCH_FILE="${SOURCE_ROOT}/adapter/marveen-1.21.1-adapter-0.1.9-to-0.2.0.patch"
  MANIFEST="${SOURCE_ROOT}/adapter/compatibility-1.21.1-adapter-0.1.9.sha256"
  NEW_FILES=(src/web/routes/codex-artifacts.ts)
elif [[ "${SOURCE_018_CURRENT}" -eq 1 ]]; then
  ADAPTER_ACTION="upgrade-0.1.8-to-current"
  PATCH_FILE="${SOURCE_ROOT}/adapter/marveen-1.21.1-adapter-0.1.8-to-0.2.0.patch"
  MANIFEST="${SOURCE_ROOT}/adapter/compatibility-1.21.1-adapter-0.1.8.sha256"
  NEW_FILES=(
    src/__tests__/codex-reasoning-effort.test.ts
    src/web/routes/codex-artifacts.ts
  )
elif [[ "${SOURCE_IDENTITY_CURRENT}" -eq 1 ]]; then
  ADAPTER_ACTION="upgrade-0.1.6-to-current"
  PATCH_FILE="${SOURCE_ROOT}/adapter/marveen-1.21.1-adapter-0.1.6-to-0.2.0.patch"
  MANIFEST="${SOURCE_ROOT}/adapter/compatibility-1.21.1-adapter-0.1.6.sha256"
  NEW_FILES=(
    src/__tests__/codex-provider-callback-dedupe.test.ts
    src/__tests__/codex-reasoning-effort.test.ts
    src/web/routes/codex-artifacts.ts
  )
elif [[ "${HAS_ADAPTER}" -eq 1 ]]; then
  fail "A legacy, unsupported Codex adapter is installed. Restore a validated 0.1.6, 0.1.8, or 0.1.9 adapter baseline before installing 0.2.1."
else
  ADAPTER_ACTION="install-current"
  PATCH_FILE="${SOURCE_ROOT}/adapter/marveen-1.21.1.patch"
  MANIFEST="${SOURCE_ROOT}/adapter/compatibility-1.21.1.sha256"
  NEW_FILES=(
    src/providers/types.ts
    src/providers/codex-bridge-client.ts
    src/providers/codex-provider.ts
    src/web/provider-service-auth.ts
    src/web/routes/provider-callbacks.ts
    src/web/routes/codex-facade.ts
    src/web/routes/codex-approvals.ts
    src/web/routes/codex-artifacts.ts
    src/__tests__/provider-service-auth.test.ts
    src/__tests__/codex-message-router.test.ts
    src/__tests__/codex-agent-identity.test.ts
    src/__tests__/codex-provider-callback-dedupe.test.ts
    src/__tests__/codex-reasoning-effort.test.ts
  )
fi

if [[ -n "${PATCH_FILE}" ]]; then
  [[ -f "${PATCH_FILE}" ]] || fail "Adapter patch missing: ${PATCH_FILE}"
fi
[[ -f "${MANIFEST}" ]] || fail "Compatibility manifest missing: ${MANIFEST}"

mapfile -t BASELINE_FILES < <(awk '{ print $2 }' "${MANIFEST}")
[[ "${#BASELINE_FILES[@]}" -gt 0 ]] || fail "Compatibility manifest is empty"

for relative in "${BASELINE_FILES[@]}"; do
  [[ -f "${MARVEEN_ROOT}/${relative}" ]] \
    || fail "Compatibility failure: missing ${relative}"
done

while read -r expected relative; do
  [[ -n "${expected}" && -n "${relative}" ]] || continue
  actual="$(sha256sum "${MARVEEN_ROOT}/${relative}" | awk '{print $1}')"
  [[ "${actual}" == "${expected}" ]] || {
    echo "Compatibility failure: ${relative} changed." >&2
    echo "  expected: ${expected}" >&2
    echo "  actual:   ${actual}" >&2
    echo "No files were modified." >&2
    exit 3
  }
done < "${MANIFEST}"

for relative in "${NEW_FILES[@]}"; do
  [[ ! -e "${MARVEEN_ROOT}/${relative}" ]] \
    || fail "Compatibility failure: unexpected pre-existing adapter file ${relative}"
done

PATCH_LOG="$(mktemp)"
trap 'rm -f "${PATCH_LOG}"' EXIT
if [[ -n "${PATCH_FILE}" ]]; then
  if ! patch --directory "${MARVEEN_ROOT}" --strip 1 --forward --batch --dry-run \
    < "${PATCH_FILE}" >"${PATCH_LOG}" 2>&1
  then
    echo "Adapter patch dry-run failed; no files were modified:" >&2
    sed -n '1,120p' "${PATCH_LOG}" >&2
    exit 3
  fi
fi

if [[ "${MODE}" == "--check-only" ]]; then
  echo "PASS: Marveen ${VERSION} adapter action ${ADAPTER_ACTION} is compatible."
  exit 0
fi

BACKUP_BASE="${XDG_STATE_HOME:-${HOME}/.local/state}/bela-codex-bridge/adapter-backups/marveen-${VERSION}"
BACKUP_DIR="${BACKUP_BASE}/$(date +%Y%m%d%H%M%S)"
mkdir -p "${BACKUP_DIR}"
tar -C "${MARVEEN_ROOT}" -czf "${BACKUP_DIR}/before-adapter.tar.gz" \
  "${BASELINE_FILES[@]}"
if [[ -d "${MARVEEN_ROOT}/dist" ]]; then
  tar -C "${MARVEEN_ROOT}" -czf "${BACKUP_DIR}/before-dist.tar.gz" dist
fi

rollback_adapter() {
  exit_status=$?
  trap - ERR
  echo "Adapter validation failed. Restoring the pre-install files." >&2
  tar -C "${MARVEEN_ROOT}" -xzf "${BACKUP_DIR}/before-adapter.tar.gz"
  mkdir -p "${BACKUP_DIR}/partial-new-files"
  for relative in "${NEW_FILES[@]}"; do
    if [[ -f "${MARVEEN_ROOT}/${relative}" ]]; then
      mkdir -p "${BACKUP_DIR}/partial-new-files/$(dirname "${relative}")"
      mv "${MARVEEN_ROOT}/${relative}" "${BACKUP_DIR}/partial-new-files/${relative}"
    fi
  done
  if [[ -d "${MARVEEN_ROOT}/dist" ]]; then
    mv "${MARVEEN_ROOT}/dist" "${BACKUP_DIR}/partial-new-files/dist-after-failure"
  fi
  if [[ -f "${BACKUP_DIR}/before-dist.tar.gz" ]]; then
    tar -C "${MARVEEN_ROOT}" -xzf "${BACKUP_DIR}/before-dist.tar.gz"
  fi
  echo "Rollback completed. Diagnostic files: ${BACKUP_DIR}" >&2
  exit "${exit_status}"
}
trap rollback_adapter ERR

if [[ -n "${PATCH_FILE}" ]]; then
  patch --directory "${MARVEEN_ROOT}" --strip 1 --forward --batch < "${PATCH_FILE}"
fi

PATH="$(dirname "${MARVEEN_NODE}"):${PATH}" npm --prefix "${MARVEEN_ROOT}" run typecheck
PATH="$(dirname "${MARVEEN_NODE}"):${PATH}" npm --prefix "${MARVEEN_ROOT}" run syntax-check
(
  cd "${MARVEEN_ROOT}"
  PATH="$(dirname "${MARVEEN_NODE}"):${PATH}" \
    "${MARVEEN_ROOT}/node_modules/.bin/vitest" run \
      --exclude 'store/**' \
      "${TARGET_TESTS[@]}"
)
PATH="$(dirname "${MARVEEN_NODE}"):${PATH}" npm --prefix "${MARVEEN_ROOT}" run build
validate_compiled_dist() {
  [[ -f "${MARVEEN_ROOT}/dist/index.js" ]] || {
    echo "Marveen build did not produce dist/index.js" >&2
    return 1
  }
  rg -q "buildCodexAgentIdentityFiles" \
    "${MARVEEN_ROOT}/dist/web/agent-scaffold.js" || {
    echo "Compiled Codex identity generator is missing from dist" >&2
    return 1
  }
  rg -q "readAgentProvider" \
    "${MARVEEN_ROOT}/dist/web/message-router.js" || {
    echo "Compiled Codex message router is missing from dist" >&2
    return 1
  }
  [[ -f "${MARVEEN_ROOT}/dist/providers/codex-provider.js" ]] || {
    echo "Compiled Codex provider is missing from dist" >&2
    return 1
  }
  rg -q "CODEX_CALLBACK_ADAPTER_REVISION = 3" \
    "${MARVEEN_ROOT}/dist/web/routes/provider-callbacks.js" || {
    echo "Compiled Codex callback adapter revision 2 is missing from dist" >&2
    return 1
  }
  rg -q "reasoningEffort" \
    "${MARVEEN_ROOT}/dist/providers/codex-provider.js" || {
    echo "Compiled Codex reasoning effort adapter is missing from dist" >&2
    return 1
  }
  [[ -f "${MARVEEN_ROOT}/dist/web/routes/codex-artifacts.js" ]] || {
    echo "Compiled Codex artifact proxy is missing from dist" >&2
    return 1
  }
  rg -q "hydrateCodexImages" "${MARVEEN_ROOT}/web/app.js" || {
    echo "Codex image preview is missing from the dashboard" >&2
    return 1
  }
}
validate_compiled_dist

trap - ERR
rm -f "${PATCH_LOG}"
trap - EXIT
echo "PASS: Marveen ${VERSION} Codex adapter action ${ADAPTER_ACTION} completed."
echo "Backup: ${BACKUP_DIR}/before-adapter.tar.gz"
