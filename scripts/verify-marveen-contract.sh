#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARVEEN_ROOT=""
STRICT_BASELINE=0
RUN_UPSTREAM_TESTS=0
NODE_BIN="${MARVEEN_CODEX_CONTRACT_NODE:-${HOME}/.nvm/versions/node/v22.23.1/bin/node}"

usage() {
  cat <<'EOF'
Usage:
  verify-marveen-contract.sh --marveen-root PATH [options]

Options:
  --strict-baseline
  --run-upstream-tests
  --node-bin PATH
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --marveen-root) MARVEEN_ROOT="$2"; shift 2 ;;
    --strict-baseline) STRICT_BASELINE=1; shift ;;
    --run-upstream-tests) RUN_UPSTREAM_TESTS=1; shift ;;
    --node-bin) NODE_BIN="$2"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "FAIL: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

[[ -n "${MARVEEN_ROOT}" ]] || fail "--marveen-root is required"
[[ -d "${MARVEEN_ROOT}" ]] || fail "Marveen root is missing: ${MARVEEN_ROOT}"
MARVEEN_ROOT="$(cd "${MARVEEN_ROOT}" && pwd -P)"
[[ -x "${NODE_BIN}" ]] || fail "Node binary is missing: ${NODE_BIN}"
[[ "$("${NODE_BIN}" --version)" == v22.* ]] \
  || fail "contract tests require Node 22"

MARVEEN_VERSION="$("${NODE_BIN}" -e \
  "const p=JSON.parse(require('fs').readFileSync(process.argv[1])); process.stdout.write(String(p.version||''))" \
  "${MARVEEN_ROOT}/package.json")"
[[ "${MARVEEN_VERSION}" == "1.25.1" ]] \
  || fail "Phase 1 baseline requires Marveen 1.25.1, found ${MARVEEN_VERSION}"
pass "Marveen version is 1.25.1"

required_files=(
  package.json
  src/web/federation/address.ts
  src/web/federation/bridge.ts
  src/web/federation/config.ts
  src/web/federation/poller.ts
  src/web/routes/federation.ts
)
for file in "${required_files[@]}"; do
  [[ -f "${MARVEEN_ROOT}/${file}" ]] || fail "required Federation file is missing: ${file}"
done
pass "Federation v1 source surface exists"

SOURCE_HASH_BEFORE="$(mktemp)"
SOURCE_HASH_AFTER="$(mktemp)"
cleanup() {
  rm -f "${SOURCE_HASH_BEFORE}" "${SOURCE_HASH_AFTER}"
}
trap cleanup EXIT
(
  cd "${MARVEEN_ROOT}"
  sha256sum "${required_files[@]}"
) > "${SOURCE_HASH_BEFORE}"

rg -q 'FEDERATION_VERSION = 1' "${MARVEEN_ROOT}/src/web/routes/federation.ts" \
  || fail "Federation version 1 marker is missing"
rg -q 'INBOX_MAX_BODY_BYTES = 64 \* 1024' "${MARVEEN_ROOT}/src/web/routes/federation.ts" \
  || fail "64 KiB inbox limit marker is missing"
rg -q 'MANIFEST_MAX_BODY_BYTES = 512 \* 1024' "${MARVEEN_ROOT}/src/web/federation/poller.ts" \
  || fail "512 KiB manifest limit marker is missing"
rg -q 'FEDERATION_MAX_CONTENT_BYTES = 60 \* 1024' "${MARVEEN_ROOT}/src/web/federation/bridge.ts" \
  || fail "60 KiB outbound content limit marker is missing"
rg -q 'federationVersion: 1' "${MARVEEN_ROOT}/src/web/federation/bridge.ts" \
  || fail "Marveen outbound Federation v1 payload marker is missing"
rg -q '/api/federation/manifest' "${MARVEEN_ROOT}/src/web/routes/federation.ts" \
  || fail "manifest route is missing"
rg -q '/api/federation/inbox' "${MARVEEN_ROOT}/src/web/routes/federation.ts" \
  || fail "inbox route is missing"
pass "Federation v1 wire constants and routes match"

if [[ "${STRICT_BASELINE}" -eq 1 ]]; then
  (
    cd "${MARVEEN_ROOT}"
    sha256sum -c "${SOURCE_ROOT}/contracts/marveen-1.25.1.sha256"
  ) || fail "Marveen 1.25.1 Federation baseline hashes differ"
  pass "exact Marveen 1.25.1 Federation baseline hashes match"
fi

"${NODE_BIN}" --test "${SOURCE_ROOT}/test/federation-contract.test.mjs"
pass "standalone Bridge Federation contract tests pass"

if [[ "${RUN_UPSTREAM_TESTS}" -eq 1 ]]; then
  VITEST_ENTRY="${MARVEEN_ROOT}/node_modules/vitest/vitest.mjs"
  [[ -f "${VITEST_ENTRY}" ]] \
    || fail "Marveen node_modules is absent; refusing to install dependencies automatically"
  TEST_PATH="${PATH}"
  if ! command -v tmux >/dev/null 2>&1 || ! command -v claude >/dev/null 2>&1; then
    TEST_PATH="${SOURCE_ROOT}/test/fake-bin:${TEST_PATH}"
  fi
  (
    cd "${MARVEEN_ROOT}"
    PATH="${TEST_PATH}" "${NODE_BIN}" "${VITEST_ENTRY}" run \
      src/__tests__/federation-inbox.test.ts \
      src/__tests__/federation-poller.test.ts \
      src/__tests__/federation-bridge.test.ts
  )
  pass "Marveen upstream Federation tests pass"
fi

(
  cd "${MARVEEN_ROOT}"
  sha256sum "${required_files[@]}"
) > "${SOURCE_HASH_AFTER}"
cmp -s "${SOURCE_HASH_BEFORE}" "${SOURCE_HASH_AFTER}" \
  || fail "Marveen source changed while the contract verifier was running"
pass "Marveen source remained byte-for-byte unchanged"

echo "RESULT: PHASE 1 FEDERATION CONTRACT PASS"
