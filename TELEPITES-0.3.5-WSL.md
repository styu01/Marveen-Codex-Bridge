# Marveen Codex Bridge 0.3.5 candidate – biztonságos WSL telepítés

## 0. Mielőtt bármit módosítanál

Ellenőrizd, hogy az élő Bridge valóban **0.3.4.1 / ready**. A telepítéshez ne fusson aktív Codex-feladat és ne legyen jóváhagyásra váró művelet. A telepítő maga is ellenőrzi ezeket. Ha nincs teljes körű WSL-hozzáférésed a rendszerhez, ne próbáld meg a korlátokat kikapcsolni.

Az új Bridge-hez **külön Codex CLI 0.171.0** szükséges. A jelenlegi 0.164.0 változatot **ne töröld, ne írd felül**.

## 1. Három fájl a Windows Letöltések mappába

- `Marveen-Codex-Bridge-v0.3.5-candidate.tar.gz`
- `Marveen-Codex-Bridge-v0.3.5-candidate.tar.gz.sha256`
- `install-Marveen-Codex-Bridge-v0.3.5-candidate.sh`

## 2. Ubuntu – külön CLI

```bash
NODE="$HOME/.nvm/versions/node/v22.23.1/bin/node"
NPM="$HOME/.nvm/versions/node/v22.23.1/bin/npm"
PREFIX="$HOME/.local/opt/codex-cli-0.171.0"
mkdir -p "$PREFIX"
PATH="$(dirname "$NODE"):$PATH" "$NPM" install --prefix "$PREFIX" \
  --no-audit --no-fund @openai/codex@0.171.0
cat > "$PREFIX/codex-bridge" <<'LAUNCHER'
#!/usr/bin/env bash
exec "$HOME/.nvm/versions/node/v22.23.1/bin/node" \
  "$HOME/.local/opt/codex-cli-0.171.0/node_modules/@openai/codex/bin/codex.js" "$@"
LAUNCHER
chmod 0700 "$PREFIX/codex-bridge"
"$PREFIX/codex-bridge" --version
"$PREFIX/codex-bridge" login status
```

Ha nincs `Logged in using ChatGPT` eredmény, előbb végezd el a normál `"$PREFIX/codex-bridge" login` bejelentkezést.

## 3. Csomag átmásolása és SHA-256

```bash
mkdir -p ~/bridge-upgrade && cd ~/bridge-upgrade
cp /mnt/c/Users/kisss/Downloads/Marveen-Codex-Bridge-v0.3.5-candidate.tar.gz .
cp /mnt/c/Users/kisss/Downloads/Marveen-Codex-Bridge-v0.3.5-candidate.tar.gz.sha256 .
cp /mnt/c/Users/kisss/Downloads/install-Marveen-Codex-Bridge-v0.3.5-candidate.sh .
sha256sum -c Marveen-Codex-Bridge-v0.3.5-candidate.tar.gz.sha256
```

**Csak `OK` eredménnyel folytasd.**

## 4. Telepítés

```bash
curl -fsS http://127.0.0.1:3431/readyz; echo
bash install-Marveen-Codex-Bridge-v0.3.5-candidate.sh \
  ./Marveen-Codex-Bridge-v0.3.5-candidate.tar.gz \
  "$HOME/.local/opt/codex-cli-0.171.0/codex-bridge"
```

A telepítő előellenőrzést, modellkatalógus-lekérdezést, konfigurációmigrációt, biztonsági mentést és teljes mock tesztet végez, és csak utána aktivál. Hiba esetén a korábbi kiadást megpróbálja visszaállítani, de a rollbacket külön ellenőrizni kell.

## 5. Aktiválás után

```bash
curl -fsS http://127.0.0.1:3431/readyz; echo
systemctl --user show marveen-codex-bridge.service -p ActiveState -p SubState -p NRestarts
node - <<'JS'
const c=require(process.env.HOME+'/.config/marveen-codex-bridge/config.json')
console.log({expectedVersion:c.codex.expectedVersion, model:c.agents[0].model,
 effort:c.agents[0].reasoningEffort, turnMinutes:c.codex.turnTimeoutMs/60000,
 leaseMinutes:c.workers.runtimeLeaseMs/60000, allowedModels:c.codex.allowedModels})
JS
```

Elvárt: 0.3.5 ready, 0.171.0 CLI, a kiválasztott modell unchanged, mindkét időkeret 45 perc, kilenc engedélyezett modell. A Dashboardon csak a CLI-ben ténylegesen elérhetők látszanak. A modellváltást külön, későbbi lépésként végezd el, csak amikor nincs futó feladat.

## 6. Végponttól végpontig ellenőrzés

A `model/list` önmagában nem bizonyítja a modell tényleges futtathatóságát. Először rövid, csak olvasási feladatot küldj a Bridge-en keresztül, utána ellenőrizd a marveenes visszaigazolást. Végül teszteld `gpt-6.1-terra / high` és `gpt-6.2-sol / medium` beállítással is, de ne egyszerre; a modellváltás megszakíthat egy már futó műveletet.

**A 0.3.4.1 mentését nem szabad törölni.**
