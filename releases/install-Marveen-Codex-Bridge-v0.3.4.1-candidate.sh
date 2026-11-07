#!/usr/bin/env bash
# Marveen Codex Bridge 0.3.4.1 candidate installer: 0.3.4 -> 0.3.4.1.
# No Marveen source edits. No changes before preflight and private backups.
set -Eeuo pipefail
umask 077

EXPECTED_ARCHIVE_SHA256='ec5eeafa0a7e6de326e83af544af315e772b78f1343e19b3fad4e46f55b5b09a'
BEFORE='0.3.4'
AFTER='0.3.4.1'
EXPECTED_NODE='v22.23.1'
EXPECTED_CODEX='0.164.0'
SERVICE='marveen-codex-bridge.service'
ARCHIVE_INPUT="${1:-$(dirname "$(readlink -f -- "${BASH_SOURCE[0]}")")/Marveen-Codex-Bridge-v0.3.4.1-candidate.tar.gz}"
NODE_BIN="$HOME/.nvm/versions/node/v22.23.1/bin/node"
DATA_ROOT="$HOME/.local/share/marveen-codex-bridge"
STATE_ROOT="$HOME/.local/state/marveen-codex-bridge"
CONFIG_ROOT="$HOME/.config/marveen-codex-bridge"
CONFIG_PATH="$CONFIG_ROOT/config.json"
UNIT_PATH="$HOME/.config/systemd/user/$SERVICE"
CURRENT_LINK="$DATA_ROOT/current"
RECOVERY_ROOT="$STATE_ROOT/update-backups/0.3.4.1-$(date -u +%Y%m%dT%H%M%SZ)-$$"
WORK_ROOT=''
OLD_TARGET=''
ROLLBACK_ARMED=0

fail() { echo "FAIL: $*" >&2; return 1; }
get_version() { "$NODE_BIN" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version' "$1"; }
ready_version() {
  curl -fsS --max-time 5 http://127.0.0.1:3431/readyz | "$NODE_BIN" -e '
    let text="";process.stdin.on("data",c=>text+=c);
    process.stdin.on("end",()=>{const r=JSON.parse(text);
      if(r.status!=="ready"||r.database!==true||r.runtime!==true)process.exit(2);
      process.stdout.write(r.bridgeVersion)
    });'
}
wait_ready() {
  local target="$1" current=''
  for _ in {1..45}; do
    current="$(ready_version 2>/dev/null || true)"
    [[ "$current" == "$target" ]] && return 0
    sleep 2
  done
  return 1
}
cleanup() {
  if [[ -n "$WORK_ROOT" && -d "$WORK_ROOT" ]]; then
    case "$WORK_ROOT" in /tmp/marveen-codex-bridge-0.3.4.1.*) rm -rf -- "$WORK_ROOT";; esac
  fi
}
rollback() {
  local reason="$1" ok=1
  set +e
  trap - ERR INT TERM
  echo '===== AUTOMATIKUS ROLLBACK 0.3.4-RE =====' >&2
  systemctl --user stop "$SERVICE" || ok=0
  if [[ -n "$OLD_TARGET" && -d "$OLD_TARGET" ]]; then
    ln -sfn "$OLD_TARGET" "$CURRENT_LINK.rollback-new" || ok=0
    mv -Tf "$CURRENT_LINK.rollback-new" "$CURRENT_LINK" || ok=0
  else ok=0; fi
  if [[ -f "$RECOVERY_ROOT/config.json" ]]; then
    install -m 0600 "$RECOVERY_ROOT/config.json" "$CONFIG_PATH" || ok=0
  else ok=0; fi
  if [[ -f "$RECOVERY_ROOT/marveen-codex-bridge.service" ]]; then
    install -m 0600 "$RECOVERY_ROOT/marveen-codex-bridge.service" "$UNIT_PATH" || ok=0
  else ok=0; fi
  systemctl --user daemon-reload || ok=0
  systemctl --user reset-failed "$SERVICE" || ok=0
  systemctl --user restart "$SERVICE" || ok=0
  wait_ready "$BEFORE" || ok=0
  cleanup
  if [[ "$ok" == 1 ]]; then
    echo 'RESULT: 0.3.4.1 NEM AKTÍV; 0.3.4 ROLLBACK SIKERES' >&2
  else
    echo "KRITIKUS: ROLLBACK NEM IGAZOLT; MENTÉS: $RECOVERY_ROOT" >&2
  fi
  exit "$reason"
}
on_error() {
  local code=$?
  if [[ "$ROLLBACK_ARMED" == 1 ]]; then rollback "$code"; fi
  cleanup
  exit "$code"
}
on_signal() {
  local code="$1"
  if [[ "$ROLLBACK_ARMED" == 1 ]]; then rollback "$code"; fi
  cleanup
  exit "$code"
}
trap on_error ERR
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap cleanup EXIT

echo '===== BRIDGE 0.3.4.1 SZIGORÚ ELŐELLENŐRZÉS ====='
[[ "$(id -u)" != 0 ]] || fail 'root felhasználóval tilos'
[[ -x "$NODE_BIN" && "$("$NODE_BIN" --version)" == "$EXPECTED_NODE" ]] || fail "Node $EXPECTED_NODE szükséges"
[[ -f "$ARCHIVE_INPUT" && ! -L "$ARCHIVE_INPUT" ]] || fail 'Hiányzó vagy symlink archívum'
[[ -f "$CONFIG_PATH" && ! -L "$CONFIG_PATH" ]] || fail 'Hiányzó vagy symlink konfiguráció'
[[ -f "$UNIT_PATH" && ! -L "$UNIT_PATH" ]] || fail 'Hiányzó vagy symlink systemd unit'
[[ -L "$CURRENT_LINK" ]] || fail 'Hiányzik az aktív release pointer'
OLD_TARGET="$(readlink -f -- "$CURRENT_LINK")"
case "$OLD_TARGET" in "$DATA_ROOT/releases/"*) ;; *) fail "Váratlan release útvonal: $OLD_TARGET";; esac
[[ "$(get_version "$OLD_TARGET/package.json")" == "$BEFORE" ]] || fail 'Nem 0.3.4 az aktív Bridge'
systemctl --user is-active --quiet "$SERVICE" || fail 'A Bridge szolgáltatás nem aktív'
! systemctl --user is-active --quiet bela-codex-bridge.service || fail 'Régi párhuzamos Bridge még aktív'
[[ "$(ready_version)" == "$BEFORE" ]] || fail 'A 0.3.4 jelenleg nem ready'
CODEX_BIN="$("$NODE_BIN" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).codex.binary' "$CONFIG_PATH")"
[[ "$CODEX_BIN" == /* && -x "$CODEX_BIN" ]] || fail 'Konfigurált Codex bináris hiányzik'
"$CODEX_BIN" --version | grep -Fq "$EXPECTED_CODEX" || fail "Codex CLI $EXPECTED_CODEX szükséges"
"$CODEX_BIN" login status 2>&1 | grep -q '^Logged in using' || fail 'Codex nem bejelentkezett'
[[ -f "$HOME/marveen/package.json" ]] || fail 'Marveen forrásverzió nem olvasható'
MARVEEN_VERSION="$(get_version "$HOME/marveen/package.json")"
echo "PASS: Marveen jelenlegi verzió: $MARVEEN_VERSION (nem írjuk át)"

# Refuse a cutover while a live Codex turn, inbox lease or approval may exist.
python3 - "$CONFIG_PATH" <<'PY'
import json, sqlite3, sys
from pathlib import Path
from urllib.parse import quote
config=json.loads(Path(sys.argv[1]).read_text())
p=Path(config['storage']['database'])
if not p.is_file(): raise SystemExit('FAIL: Bridge adatbázis hiányzik')
con=sqlite3.connect('file:'+quote(str(p),safe='/')+'?mode=ro', uri=True, timeout=5)
try:
    tests=[('codex_runtime_runs', "state IN ('starting','running')", 'aktív/kezdődő Codex turn'),
           ('codex_approvals', "state='pending'", 'függő jóváhagyás'),
           ('federation_inbox', "state='dispatched'", 'lefoglalt inbox üzenet'),
           ('federation_outbox', "state='leased'", 'lefoglalt outbox üzenet')]
    for table,where,label in tests:
        n=con.execute(f'SELECT COUNT(*) FROM {table} WHERE {where}').fetchone()[0]
        if n: raise SystemExit(f'FAIL: {n} {label}; telepítés megszakítva, ne kényszerítsd')
    print('PASS: nincs aktív, lefoglalt vagy jóváhagyásra váró művelet')
finally: con.close()
PY

WORK_ROOT="$(mktemp -d /tmp/marveen-codex-bridge-0.3.4.1.XXXXXX)"
chmod 0700 "$WORK_ROOT"
cp -- "$ARCHIVE_INPUT" "$WORK_ROOT/archive.tar.gz"
ARCHIVE_PATH="$WORK_ROOT/archive.tar.gz"
[[ "$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')" == "$EXPECTED_ARCHIVE_SHA256" ]] || fail 'Az archívum SHA-256 nem megfelelő'
python3 - "$ARCHIVE_PATH" <<'PY'
import tarfile,sys
with tarfile.open(sys.argv[1],'r:gz') as archive:
  for member in archive.getmembers():
    name=member.name
    if not (member.isfile() or member.isdir()): raise SystemExit('FAIL: nem támogatott archívumtag')
    if name.startswith('/') or '..' in name.split('/') or '\\' in name:
      raise SystemExit('FAIL: veszélyes archívumútvonal')
    root='Marveen-Codex-Bridge-0.3.4.1-candidate'
    if name == root:
      if not member.isdir(): raise SystemExit('FAIL: a gyökér nem könyvtár')
    elif not name.startswith(root + '/'):
      raise SystemExit('FAIL: váratlan gyökér az archívumban')
print('PASS: biztonságos csomagtagok')
PY
tar -xzf "$ARCHIVE_PATH" -C "$WORK_ROOT"
SOURCE_ROOT="$WORK_ROOT/Marveen-Codex-Bridge-0.3.4.1-candidate"
[[ "$(get_version "$SOURCE_ROOT/package.json")" == "$AFTER" ]] || fail '0.3.4.1 package verzió hiányzik'
"$NODE_BIN" --check "$SOURCE_ROOT/src/inbox-orchestrator.mjs"
"$NODE_BIN" --check "$SOURCE_ROOT/src/codex-app-server-runtime.mjs"
"$NODE_BIN" --check "$SOURCE_ROOT/scripts/migrate-timeouts-0.3.4.1.mjs"
bash -n "$SOURCE_ROOT/scripts/install-phase7.sh"
bash -n "$SOURCE_ROOT/scripts/verify-phase7.sh"

# Verifier self-consistency: shipped required files and declared tests.
"$NODE_BIN" - "$SOURCE_ROOT" <<'NODE'
const fs=require('node:fs'), path=require('node:path')
const root=process.argv[2], script=fs.readFileSync(path.join(root,'scripts/verify-phase7.sh'),'utf8')
const match=script.match(/^required_files=\(\s*\n([\s\S]*?)^\)/m)
if(!match)throw Error('Missing required file inventory')
const required=match[1].trim().split('\n').map(s=>s.trim()).filter(Boolean)
for(const name of required){
 if(!/^[a-zA-Z0-9._/-]+$/.test(name)||name.split('/').includes('..'))throw Error('Unsafe path: '+name)
 const file=path.join(root,name)
 if(!fs.existsSync(file)||!fs.lstatSync(file).isFile())throw Error('Missing file: '+name)
}
for(const critical of ['scripts/production-canary-0.3.4.1.mjs','scripts/migrate-timeouts-0.3.4.1.mjs','test/timeout-policy-0.3.4.1.test.mjs']) {
 if(!required.includes(critical))throw Error('Critical path missing from verifier: '+critical)
}
const files=fs.readdirSync(path.join(root,'test')).filter(s=>s.endsWith('.test.mjs'))
const declared=files.reduce((n,file)=>n+(fs.readFileSync(path.join(root,'test',file),'utf8').match(/^test\(/gm)||[]).length,0)
const m=script.match(/tests (\d+)\$/), n=script.match(/pass (\d+)\$/)
if(!m||!n||declared!==Number(m[1])||declared!==Number(n[1]))throw Error('Test count / verifier mismatch: '+declared)
console.log(`PASS: ${required.length} required files, ${declared} declared tests`)
NODE

install -d -m 0700 "$RECOVERY_ROOT"
install -m 0600 "$CONFIG_PATH" "$RECOVERY_ROOT/config.json"
install -m 0600 "$UNIT_PATH" "$RECOVERY_ROOT/marveen-codex-bridge.service"
printf '%s\n' "$OLD_TARGET" > "$RECOVERY_ROOT/previous-release.txt"
chmod 0600 "$RECOVERY_ROOT/previous-release.txt"
"$NODE_BIN" "$SOURCE_ROOT/scripts/migrate-timeouts-0.3.4.1.mjs" \
  "$CONFIG_PATH" "$RECOVERY_ROOT/config-v0.3.4.1.json"
# Fail before cutover if the migrated config is incompatible with production loader.
"$NODE_BIN" --input-type=module - "$SOURCE_ROOT/src/config.mjs" "$RECOVERY_ROOT/config-v0.3.4.1.json" "$CONFIG_PATH" <<'NODE'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
const { loadServiceConfig } = await import(pathToFileURL(process.argv[2]))
const loaded=loadServiceConfig(process.argv[3])
const before=JSON.parse(readFileSync(process.argv[4], 'utf8'))
const after=JSON.parse(readFileSync(process.argv[3], 'utf8'))
if(loaded.workers.runtimeLeaseMs!==2_700_000)throw Error('45 minute lease not effective')
if(loaded.codex.turnTimeoutMs!==2_700_000)throw Error('45 minute Codex turn deadline not effective')
if(JSON.stringify(before.agents)!==JSON.stringify(after.agents))throw Error('Agent settings altered by migration')
// Only the explicitly requested Codex turn timeout may change.
const beforeCodex={...before.codex}, afterCodex={...after.codex}
delete beforeCodex.turnTimeoutMs; delete afterCodex.turnTimeoutMs
if(JSON.stringify(beforeCodex)!==JSON.stringify(afterCodex))throw Error('Unrelated Codex settings altered by migration')
const beforeWorkers={...(before.workers??{})},afterWorkers={...(after.workers??{})}
delete beforeWorkers.runtimeLeaseMs;delete afterWorkers.runtimeLeaseMs
if(JSON.stringify(beforeWorkers)!==JSON.stringify(afterWorkers))throw Error('Unrelated worker settings altered by migration')
if(JSON.stringify(before.peers)!==JSON.stringify(after.peers))throw Error('Federation peer settings altered')
console.log('PASS: 45 minute turn timeout and lease; agent, model, auth and Federation settings unchanged')
NODE

# Only NOW may activation mutate service/config. Any failure triggers rollback.
ROLLBACK_ARMED=1
bash "$SOURCE_ROOT/scripts/install-phase7.sh" --node-bin "$NODE_BIN" \
  --codex-bin "$CODEX_BIN" \
  --config-source "$RECOVERY_ROOT/config-v0.3.4.1.json" --activate
[[ "$(ready_version)" == "$AFTER" ]] || fail 'Bridge 0.3.4.1 readiness hibás'
ACTIVE_TARGET="$(readlink -f -- "$CURRENT_LINK")"
[[ "$(get_version "$ACTIVE_TARGET/package.json")" == "$AFTER" ]] || fail 'Az aktív release nem 0.3.4.1'
"$NODE_BIN" "$ACTIVE_TARGET/scripts/verify-model-selection-0.3.3.mjs" \
  "$CONFIG_PATH" "$CONFIG_ROOT/admin.token"
ROLLBACK_ARMED=0
cleanup
trap - ERR INT TERM EXIT
echo 'RESULT: MARVEEN CODEX BRIDGE 0.3.4.1 CANDIDATE AKTIVÁLÁS SIKERES'
echo "Biztonsági mentés: $RECOVERY_ROOT"
echo 'A biztonsági mentést NE töröld; éles Codex+Marveen feladatteszt még szükséges.'
