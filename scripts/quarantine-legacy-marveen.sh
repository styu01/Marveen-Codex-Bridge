#!/usr/bin/env bash
set -euo pipefail

MARVEEN_ROOT=""
PHASE0_ROOT=""
EXECUTE=0
STATE_ROOT="${XDG_STATE_HOME:-${HOME}/.local/state}/marveen-codex-bridge/cutover"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ADAPTER_PATHS_FILE="${SCRIPT_DIR}/../contracts/legacy-marveen-adapter-paths-v0.2.1.txt"

usage() {
  cat <<'EOF'
Usage:
  quarantine-legacy-marveen.sh --marveen-root PATH --phase0-root PATH [options]

Options:
  --adapter-paths-file PATH  Override the versioned adapter path contract.
                             Intended for tests and audited migrations only.
  --state-root PATH          Override the private recovery-record directory.
  --execute                  Perform the selective quarantine.

Without --execute this performs a read-only preflight. Execute mode moves only
the versioned legacy Codex adapter paths into a named, recoverable git stash.
All other tracked, staged and untracked Marveen source changes remain exactly
as they were. Git-ignored runtime data is not included and is not modified.
The script does not pull, update, build or restart Marveen.
EOF
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --marveen-root)
      [[ $# -ge 2 ]] || fail "--marveen-root requires a path"
      MARVEEN_ROOT="$2"
      shift 2
      ;;
    --phase0-root)
      [[ $# -ge 2 ]] || fail "--phase0-root requires a path"
      PHASE0_ROOT="$2"
      shift 2
      ;;
    --state-root)
      [[ $# -ge 2 ]] || fail "--state-root requires a path"
      STATE_ROOT="$2"
      shift 2
      ;;
    --adapter-paths-file)
      [[ $# -ge 2 ]] || fail "--adapter-paths-file requires a path"
      ADAPTER_PATHS_FILE="$2"
      shift 2
      ;;
    --execute)
      EXECUTE=1
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

[[ -n "${MARVEEN_ROOT}" ]] || fail "--marveen-root is required"
[[ -n "${PHASE0_ROOT}" ]] || fail "--phase0-root is required"
MARVEEN_ROOT="$(realpath -e -- "${MARVEEN_ROOT}")"
PHASE0_ROOT="$(realpath -e -- "${PHASE0_ROOT}")"
ADAPTER_PATHS_FILE="$(realpath -e -- "${ADAPTER_PATHS_FILE}")"

[[ -d "${MARVEEN_ROOT}/.git" ]] || fail "Marveen root is not a git checkout"
[[ -f "${MARVEEN_ROOT}/package.json" ]] || fail "Marveen package.json is missing"
[[ -f "${ADAPTER_PATHS_FILE}" && ! -L "${ADAPTER_PATHS_FILE}" ]] \
  || fail "adapter path contract must be a regular non-symlink file"
[[ -f "${PHASE0_ROOT}/private/marveen-source-checkpoint.tar.gz" ]] \
  || fail "verified Phase 0 source checkpoint is missing"
[[ -f "${PHASE0_ROOT}/private/marveen-runtime-backup.tar.gz" ]] \
  || fail "verified Phase 0 runtime backup is missing"

ADAPTER_PATHS=()
declare -A SEEN_PATHS=()
while IFS= read -r path || [[ -n "${path}" ]]; do
  [[ -n "${path}" && "${path}" != \#* ]] || continue
  [[ "${path}" != /* && "${path}" != "." && "${path}" != ".." ]] \
    || fail "invalid adapter path in contract: ${path}"
  [[ "${path}" != ../* && "${path}" != */../* && "${path}" != */.. ]] \
    || fail "adapter path escapes Marveen root: ${path}"
  [[ -z "${SEEN_PATHS[${path}]+x}" ]] \
    || fail "duplicate adapter path in contract: ${path}"
  SEEN_PATHS["${path}"]=1
  ADAPTER_PATHS+=("${path}")
done < "${ADAPTER_PATHS_FILE}"
[[ "${#ADAPTER_PATHS[@]}" -gt 0 ]] || fail "adapter path contract is empty"

ADAPTER_STATUS="$(git -C "${MARVEEN_ROOT}" status --porcelain=v1 \
  --untracked-files=all -- "${ADAPTER_PATHS[@]}")"
if [[ -z "${ADAPTER_STATUS}" ]]; then
  echo "PASS: no legacy Codex adapter source changes are present"
  echo "PASS: unrelated Marveen source changes were not touched"
  echo "RESULT: LEGACY ADAPTER QUARANTINE NOT NEEDED"
  exit 0
fi

TRACKED_COUNT="$(printf '%s\n' "${ADAPTER_STATUS}" \
  | awk 'substr($0,1,2)!="??"{n++} END{print n+0}')"
UNTRACKED_COUNT="$(printf '%s\n' "${ADAPTER_STATUS}" \
  | awk 'substr($0,1,2)=="??"{n++} END{print n+0}')"
ALL_COUNT="$(git -C "${MARVEEN_ROOT}" status --porcelain=v1 --untracked-files=all \
  | awk 'NF{n++} END{print n+0}')"
PRESERVED_COUNT="$((ALL_COUNT - TRACKED_COUNT - UNTRACKED_COUNT))"
PRESERVED_PATHSPECS=(.)
for path in "${ADAPTER_PATHS[@]}"; do
  PRESERVED_PATHSPECS+=(":(exclude)${path}")
done
PRESERVED_STATUS_BEFORE="$(git -C "${MARVEEN_ROOT}" status --porcelain=v1 \
  --untracked-files=all -- "${PRESERVED_PATHSPECS[@]}")"
HEAD_BEFORE="$(git -C "${MARVEEN_ROOT}" rev-parse HEAD)"

echo "PASS: verified Phase 0 source and runtime checkpoints are present"
echo "PASS: Marveen git checkout is readable"
echo "PASS: versioned legacy adapter path contract is valid"
echo "INFO: adapter changes to quarantine: tracked=${TRACKED_COUNT}, untracked=${UNTRACKED_COUNT}"
echo "INFO: unrelated source changes to preserve in place: ${PRESERVED_COUNT}"

if [[ "${EXECUTE}" -eq 0 ]]; then
  echo "RESULT: SELECTIVE LEGACY ADAPTER QUARANTINE PREFLIGHT PASS (NO MUTATION)"
  exit 0
fi

mkdir -p -- "${STATE_ROOT}"
chmod 0700 "${STATE_ROOT}"
RUN_DIR="${STATE_ROOT}/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p -- "${RUN_DIR}"
chmod 0700 "${RUN_DIR}"

git -C "${MARVEEN_ROOT}" status --porcelain=v1 --untracked-files=all \
  > "${RUN_DIR}/status-before.txt"
printf '%s\n' "${ADAPTER_STATUS}" > "${RUN_DIR}/adapter-status-before.txt"
git -C "${MARVEEN_ROOT}" diff --binary -- "${ADAPTER_PATHS[@]}" \
  > "${RUN_DIR}/adapter-tracked-before.patch"
git -C "${MARVEEN_ROOT}" diff --cached --binary -- "${ADAPTER_PATHS[@]}" \
  > "${RUN_DIR}/adapter-staged-before.patch"
git -C "${MARVEEN_ROOT}" ls-files --others --exclude-standard \
  -- "${ADAPTER_PATHS[@]}" > "${RUN_DIR}/adapter-untracked-before.txt"
printf '%s\n' "${HEAD_BEFORE}" > "${RUN_DIR}/head-before.txt"
chmod 0600 "${RUN_DIR}"/*

STASH_NAME="marveen-codex-bridge-legacy-quarantine-$(date -u +%Y%m%dT%H%M%SZ)"
git -C "${MARVEEN_ROOT}" stash push -u -m "${STASH_NAME}" \
  -- "${ADAPTER_PATHS[@]}" >/dev/null
STASH_COMMIT="$(git -C "${MARVEEN_ROOT}" rev-parse refs/stash)"
printf '%s\n' "${STASH_NAME}" > "${RUN_DIR}/stash-name.txt"
printf '%s\n' "${STASH_COMMIT}" > "${RUN_DIR}/stash-commit.txt"
chmod 0600 "${RUN_DIR}/stash-name.txt" "${RUN_DIR}/stash-commit.txt"

ADAPTER_AFTER="$(git -C "${MARVEEN_ROOT}" status --porcelain=v1 \
  --untracked-files=all -- "${ADAPTER_PATHS[@]}")"
if [[ -n "${ADAPTER_AFTER}" ]]; then
  echo "FAIL: legacy adapter paths are still dirty after quarantine" >&2
  echo "Recovery stash: ${STASH_NAME}" >&2
  exit 1
fi
[[ "$(git -C "${MARVEEN_ROOT}" rev-parse HEAD)" == "${HEAD_BEFORE}" ]] \
  || fail "quarantine unexpectedly changed Marveen HEAD"

PRESERVED_STATUS_AFTER="$(git -C "${MARVEEN_ROOT}" status --porcelain=v1 \
  --untracked-files=all -- "${PRESERVED_PATHSPECS[@]}")"
[[ "${PRESERVED_STATUS_AFTER}" == "${PRESERVED_STATUS_BEFORE}" ]] \
  || fail "unrelated Marveen source state changed during quarantine"

echo "PASS: only the legacy adapter paths are in a recoverable git stash"
echo "PASS: ${PRESERVED_COUNT} unrelated Marveen source changes remain in place"
echo "PASS: Marveen HEAD did not change and ignored runtime data was not touched"
echo "Recovery record: ${RUN_DIR}"
echo "RESULT: LEGACY ADAPTER SELECTIVELY QUARANTINED"
