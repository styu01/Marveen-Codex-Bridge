# Bridge 0.3.4 telepítés – Windows Downloads + WSL

**Figyelem:** csak ha nincs folyamatban Béla/Codex feladat. A 0.3.3 és a Marveen forrása maradjon érintetlen. A 30 perces lease az aktiváláskor kerül be a Bridge konfigurációjába.

## 1. Három fájl letöltése Windowsba

A Windows **Letöltések** mappájába (például `C:\\Users\\<felhasználó>\\Downloads\\`).

- `Marveen-Codex-Bridge-v0.3.4-candidate.tar.gz`
- `Marveen-Codex-Bridge-v0.3.4-candidate.tar.gz.sha256`
- `install-Marveen-Codex-Bridge-v0.3.4-candidate-r2.sh`

Ne csomagold ki és ne nevezd át őket. A régi 0.3.3 fájlokat nem kell törölni.

## 2. Ubuntu terminál

```bash
# A saját Windows felhasználóneveddel állítsd be:
WIN_USER="<Windows-felhasználónév>"
set -e
mkdir -p ~/bridge-upgrade
cd ~/bridge-upgrade
cp /mnt/c/Users/"$WIN_USER"/Downloads/Marveen-Codex-Bridge-v0.3.4-candidate.tar.gz .
cp /mnt/c/Users/"$WIN_USER"/Downloads/Marveen-Codex-Bridge-v0.3.4-candidate.tar.gz.sha256 .
cp /mnt/c/Users/"$WIN_USER"/Downloads/install-Marveen-Codex-Bridge-v0.3.4-candidate-r2.sh .
sha256sum -c Marveen-Codex-Bridge-v0.3.4-candidate.tar.gz.sha256
```

Várt eredmény: `Marveen-Codex-Bridge-v0.3.4-candidate.tar.gz: OK`.

## 3. Állapotellenőrzés

```bash
curl -fsS http://127.0.0.1:3431/readyz; echo
systemctl --user is-active marveen-codex-bridge.service
```

Várt: `bridgeVersion: 0.3.3`, `ready`, `active`. Ha nem teljesül, ne telepíts.

## 4. Telepítés a teljes 151 tesztes kapuval

```bash
cd ~/bridge-upgrade
bash install-Marveen-Codex-Bridge-v0.3.4-candidate-r2.sh \
  ./Marveen-Codex-Bridge-v0.3.4-candidate.tar.gz
```

Ez a telepítő **automatikusan megáll**, ha `running`/`starting` Codex-run, feldolgozás alatt álló Federation üzenet vagy függő jóváhagyás van. Ilyenkor a valódi feladat állapotát kell megvizsgálni, nem a biztonsági kaput kikapcsolni.

Ha sikeresen végigmegy az npm és a **151/151 teszt**, biztonsági mentés és konfigurációmigráció után aktivál. Ellenőrzi a 0.3.4 `/readyz` értékét és az admin modellenkénti választót.

## 5. Aktiválás utáni ellenőrzés

```bash
curl -fsS http://127.0.0.1:3431/readyz; echo
systemctl --user is-active marveen-codex-bridge.service
node -e 'const c=require(process.env.HOME+"/.config/marveen-codex-bridge/config.json"); console.log("lease:",c.workers.runtimeLeaseMs,"model:",c.agents[0].model,"effort:",c.agents[0].reasoningEffort)'
```

Elvárt: Bridge `0.3.4`, `ready`, `active`, lease `1800000`, modell és effort változatlan.

## 6. Valós kompatibilitáspróba

```bash
MARVEEN_VERSION=$(node -p 'require(process.env.HOME+"/marveen/package.json").version')
node ~/.local/share/marveen-codex-bridge/current/scripts/production-canary-0.3.4.mjs \
  --expected-marveen-version "$MARVEEN_VERSION"
```

Ez *read-only*. A `--execute` opciót ne add meg automatikusan; az valós Federation műveleteket és modellváltást okozna. Ha a read-only ellenőrzés sikeres, kontrollált 3–5 perces Codex-feladattal kell igazolni a teljes Béla→Bridge→Codex→Béla munkafolyamatot és a final reply-t.

## 7. Hiba esetén

Ne indítsd újra találomra a telepítőt és ne írd kézzel át a DB-t. Őrizd meg az automatikus mentés könyvtárát, és másold ki a telepítő teljes kimenetét. A script megpróbál visszaállni a korábbi 0.3.3 konfigurációjára, unitjára és release pointerére, de a rollback sikerét `/readyz` ellenőrzéssel igazolni kell.
