#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${HOME}/.nvm/versions/node/v22.23.1/bin/node"
BETTER_SQLITE3_PATH=""
CLEAN_MARVEEN_ROOT=""
CODEX_BIN="${HOME}/.local/bin/codex"
CODEX_MODEL="gpt-5.6-terra"
EXPECTED_CODEX_VERSION="0.164.0"
REAL_OUTPUT_ROOT=""
MOCK_ONLY=0
TEST_LOG=""

usage() {
  cat <<'EOF'
Usage:
  verify-phase7.sh [--node-bin PATH] [--better-sqlite3-path PATH]
                   [--codex-bin PATH] [--model MODEL]
                   [--expected-codex-version VERSION]
                   [--real-output-root PATH]
                   [--clean-marveen-root PATH] [--mock-only]

Runs only temporary databases, loopback mock peers and disposable child
services. The default real preflight verifies the Codex runtime, approvals,
Federation dynamic messaging, GPT image generation and the immutable artifact
pipeline. It does not patch Marveen and does not install, stop, restart, enable
or disable any system service. Use --mock-only only for package CI.
EOF
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

cleanup() {
  [[ -z "${TEST_LOG}" ]] || rm -f "${TEST_LOG}"
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-bin)
      [[ $# -ge 2 ]] || fail "--node-bin requires a path"
      NODE_BIN="$2"
      shift 2
      ;;
    --better-sqlite3-path)
      [[ $# -ge 2 ]] || fail "--better-sqlite3-path requires a path"
      BETTER_SQLITE3_PATH="$2"
      shift 2
      ;;
    --clean-marveen-root)
      [[ $# -ge 2 ]] || fail "--clean-marveen-root requires a path"
      CLEAN_MARVEEN_ROOT="$2"
      shift 2
      ;;
    --codex-bin)
      [[ $# -ge 2 ]] || fail "--codex-bin requires a path"
      CODEX_BIN="$2"
      shift 2
      ;;
    --model)
      [[ $# -ge 2 ]] || fail "--model requires a value"
      CODEX_MODEL="$2"
      shift 2
      ;;
    --expected-codex-version)
      [[ $# -ge 2 ]] || fail "--expected-codex-version requires a value"
      EXPECTED_CODEX_VERSION="$2"
      shift 2
      ;;
    --real-output-root)
      [[ $# -ge 2 ]] || fail "--real-output-root requires a path"
      REAL_OUTPUT_ROOT="$2"
      shift 2
      ;;
    --mock-only)
      MOCK_ONLY=1
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[[ -x "${NODE_BIN}" ]] || fail "Node binary is missing: ${NODE_BIN}"
NODE_VERSION="$("${NODE_BIN}" --version)"
[[ "${NODE_VERSION}" == v22.* ]] \
  || fail "Phase 7 requires Node 22, found ${NODE_VERSION}"
pass "Node runtime is ${NODE_VERSION}"

if [[ -z "${BETTER_SQLITE3_PATH}" ]]; then
  candidates=(
    "${SOURCE_ROOT}/node_modules/better-sqlite3"
    "${HOME}/bela-codex-preflight/bela-codex-bridge-0.2.1/node_modules/better-sqlite3"
    "${HOME}/bela-codex-preflight/bela-codex-bridge-0.1.8/node_modules/better-sqlite3"
    "${HOME}/.local/share/bela-codex-bridge/current/node_modules/better-sqlite3"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -d "${candidate}" ]]; then
      BETTER_SQLITE3_PATH="${candidate}"
      break
    fi
  done
fi
[[ -n "${BETTER_SQLITE3_PATH}" && -d "${BETTER_SQLITE3_PATH}" ]] \
  || fail "Node 22 better-sqlite3 module was not found; pass --better-sqlite3-path"

NODE_OPTIONS=--no-warnings \
MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH="${BETTER_SQLITE3_PATH}" \
  "${NODE_BIN}" -e '
    const Better = require(process.env.MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH)
    const db = new Better(":memory:")
    const row = db.prepare("SELECT 1 AS ok").get()
    db.close()
    if (row.ok !== 1) process.exit(1)
  ' || fail "better-sqlite3 is not loadable by the fixed Node 22 runtime"
pass "production better-sqlite3 driver loads under Node 22"

required_files=(
  config/config.example.json
  contracts/legacy-marveen-adapter-paths-v0.2.1.txt
  docs/phase7-production-cutover.md
  migrations/001_federation_durability.sql
  migrations/002_inbox_orchestration.sql
  migrations/003_codex_runtime.sql
  migrations/004_codex_approvals.sql
  migrations/005_image_artifacts.sql
  package-lock.json
  scripts/real-codex-preflight.mjs
  scripts/real-imagegen-preflight.mjs
  scripts/real-phase5-preflight.mjs
  scripts/install-phase7.sh
  scripts/cutover-phase7.sh
  scripts/federation-cutover-api.mjs
  scripts/pair-marveen-phase6.2.mjs
  scripts/quarantine-legacy-marveen.sh
  scripts/reconcile-bridge-peer.mjs
  scripts/recover-phase7.5-failed-cutover.sh
  scripts/verify-install-phase7.sh
  scripts/verify-phase7.sh
  src/approval-broker.mjs
  src/artifact-manager.mjs
  src/bridge-peer-reconciliation.mjs
  src/agent-settings-manager.mjs
  src/codex-app-server-runtime.mjs
  src/codex-protocol-client.mjs
  src/codex-runtime-module.mjs
  src/codex-runtime-state.mjs
  src/config.mjs
  src/durability-store.mjs
  src/federation-cutover-api.mjs
  src/inbox-orchestrator.mjs
  src/main.mjs
  src/marveen-pairing.mjs
  src/production-canary.mjs
  src/runtime-loader.mjs
  src/service.mjs
  src/sqlite-driver.mjs
  systemd/marveen-codex-bridge-federation.service.in
  web/app.js
  web/index.html
  web/styles.css
  test/codex-app-server-runtime.test.mjs
  test/bridge-peer-reconciliation.test.mjs
  test/agent-settings-manager.test.mjs
  test/federation-codex-e2e.test.mjs
  test/fixtures/fake-codex-app-server.mjs
  test/image-artifact-pipeline.test.mjs
  test/main-process.test.mjs
  test/phase5-approval-tools.test.mjs
  test/phase7-installer.test.mjs
  test/production-canary.test.mjs
  test/federation-cutover-api.test.mjs
  test/service-e2e.test.mjs
  test/sqlite-driver-parity.test.mjs
  scripts/production-canary-0.3.4.mjs
  scripts/migrate-models-0.3.3.mjs
  scripts/check-codex-models-0.3.3.mjs
  scripts/verify-model-selection-0.3.3.mjs
  scripts/migrate-lease-0.3.4.mjs
  test/reliability-0.3.4.test.mjs
  src/model-policy.mjs
)
for file in "${required_files[@]}"; do
  [[ -f "${SOURCE_ROOT}/${file}" ]] \
    || fail "required Phase 7 file is missing: ${file}"
done
pass "Phase 7 standalone installer, transactional cutover and rollback surface is complete"

NODE_OPTIONS=--no-warnings "${NODE_BIN}" -e '
  const fs = require("node:fs")
  const path = require("node:path")
  const root = process.argv[1]
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")))
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json")))
  const example = JSON.parse(fs.readFileSync(path.join(root, "config/config.example.json")))
  if (pkg.version !== "0.3.4") throw new Error("wrong package version")
  if (pkg.dependencies?.["better-sqlite3"] !== "11.10.0") {
    throw new Error("better-sqlite3 must be pinned")
  }
  if (lock.packages?.[""]?.dependencies?.["better-sqlite3"] !== "11.10.0") {
    throw new Error("lockfile does not pin better-sqlite3")
  }
  if (
    example.version !== 1
    || example.systemId !== "codex"
    || example.codex?.imageGenerationRequired !== true
    || example.codex?.imageModel !== "gpt-image-2"
    || JSON.stringify(example.codex?.allowedModels) !== JSON.stringify(["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"])
  ) {
    throw new Error("invalid example config")
  }
' "${SOURCE_ROOT}" || fail "package lock or example configuration is invalid"
pass "dependency, Codex version and example configuration metadata is pinned"

while IFS= read -r file; do
  NODE_OPTIONS=--no-warnings "${NODE_BIN}" --check "${file}" >/dev/null
done < <(find "${SOURCE_ROOT}/src" "${SOURCE_ROOT}/test" -type f -name '*.mjs' -print)
NODE_OPTIONS=--no-warnings "${NODE_BIN}" --check "${SOURCE_ROOT}/web/app.js" >/dev/null
pass "all JavaScript modules and dashboard script pass Node syntax checking"

if rg -n \
  'systemctl|bela-start|tmux (kill|new)|(^|[[:space:]])patch([[:space:]]|$)' \
  "${SOURCE_ROOT}/scripts/real-codex-preflight.mjs" \
  "${SOURCE_ROOT}/scripts/real-imagegen-preflight.mjs" \
  "${SOURCE_ROOT}/scripts/real-phase5-preflight.mjs" >/dev/null; then
  fail "verification scripts contain a forbidden live-system mutation command"
fi
pass "verification scripts contain no live service or Marveen mutation"

if [[ -n "${CLEAN_MARVEEN_ROOT}" ]]; then
  "${SOURCE_ROOT}/scripts/verify-marveen-contract.sh" \
    --marveen-root "${CLEAN_MARVEEN_ROOT}" \
    --strict-baseline \
    --node-bin "${NODE_BIN}"
  pass "clean Marveen 1.25.1 Federation baseline is compatible"
fi

TEST_LOG="$(mktemp)"
(
  cd "${SOURCE_ROOT}"
  MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH="${BETTER_SQLITE3_PATH}" \
    NODE_OPTIONS=--no-warnings \
    "${NODE_BIN}" --test --test-concurrency=1 test/*.test.mjs
) | tee "${TEST_LOG}"
grep -Eq '^(#|ℹ) tests 151$' "${TEST_LOG}" \
  || fail "expected exactly 151 tests"
grep -Eq '^(#|ℹ) pass 151$' "${TEST_LOG}" \
  || fail "expected exactly 151 passing tests"
grep -Eq '^(#|ℹ) fail 0$' "${TEST_LOG}" \
  || fail "test failures were reported"
grep -Eq '^(#|ℹ) skipped 0$' "${TEST_LOG}" \
  || fail "tests were skipped"
grep -Eq '^(#|ℹ) cancelled 0$' "${TEST_LOG}" \
  || fail "tests were cancelled"
pass "all 151 Phase 1-7 mock, security, settings, installer, cutover and rollback tests pass with no skip"

if [[ "${MOCK_ONLY}" -eq 1 ]]; then
  echo "RESULT: PHASE 7 MOCK INSTALLER, CUTOVER, ROLLBACK AND FEDERATION PASS (REAL CODEX NOT RUN)"
  exit 0
fi

[[ -x "${CODEX_BIN}" ]] || fail "Codex binary is missing or not executable: ${CODEX_BIN}"
if [[ -z "${REAL_OUTPUT_ROOT}" ]]; then
  REAL_OUTPUT_ROOT="${HOME}/bela-codex-preflight/phase5-real-$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "${REAL_OUTPUT_ROOT}"
chmod 0700 "${REAL_OUTPUT_ROOT}"

MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH="${BETTER_SQLITE3_PATH}" \
NODE_OPTIONS=--no-warnings \
  "${NODE_BIN}" "${SOURCE_ROOT}/scripts/real-codex-preflight.mjs" \
    --codex-bin "${CODEX_BIN}" \
    --better-sqlite3-path "${BETTER_SQLITE3_PATH}" \
    --output-root "${REAL_OUTPUT_ROOT}/phase4" \
    --model "${CODEX_MODEL}" \
    --expected-version "${EXPECTED_CODEX_VERSION}"

MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH="${BETTER_SQLITE3_PATH}" \
NODE_OPTIONS=--no-warnings \
  "${NODE_BIN}" "${SOURCE_ROOT}/scripts/real-phase5-preflight.mjs" \
    --codex-bin "${CODEX_BIN}" \
    --better-sqlite3-path "${BETTER_SQLITE3_PATH}" \
    --output-root "${REAL_OUTPUT_ROOT}/phase5" \
    --model "${CODEX_MODEL}" \
    --expected-version "${EXPECTED_CODEX_VERSION}"

MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH="${BETTER_SQLITE3_PATH}" \
NODE_OPTIONS=--no-warnings \
  "${NODE_BIN}" "${SOURCE_ROOT}/scripts/real-imagegen-preflight.mjs" \
    --codex-bin "${CODEX_BIN}" \
    --better-sqlite3-path "${BETTER_SQLITE3_PATH}" \
    --output-root "${REAL_OUTPUT_ROOT}/phase52-imagegen" \
    --model "${CODEX_MODEL}" \
    --expected-version "${EXPECTED_CODEX_VERSION}"

echo "RESULT: PHASE 6.1 REAL CODEX, APPROVAL, FEDERATION AND IMAGEGEN PASS"
