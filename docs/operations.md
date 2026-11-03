# Federation Bridge 0.3.3 üzemeltetés

## Állapotellenőrzés

```bash
systemctl --user is-active marveen-codex-bridge.service
curl --fail --silent http://127.0.0.1:3431/readyz | python3 -m json.tool
```

Elvárt verzió: `0.3.3`, `status: ready`, `database: true`, `runtime: true`.

## Konfiguráció

Alapértelmezett hely:

```text
~/.config/marveen-codex-bridge/config.json
```

A konfiguráció, tokenek és pairing fájlok privátak; ne kerüljenek Gitbe. A
szerveroldali modellengedélylista a `codex` blokkban, az aktuális modell és
effort az `agents` bejegyzésben található:

```json
{
  "codex": {
    "allowedModels": ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]
  },
  "agents": [{
    "model": "gpt-5.6-terra",
    "reasoningEffort": "high"
  }]
}
```

A modell, a szerepkör és a modellenként támogatott effort a Bridge dashboardon
szerkeszthető. A dashboard csak az `allowedModels` és az élő App Server
`model/list` metszetét kínálja fel. A szerver mentés előtt ismét validál, ezért
tetszőleges kliensérték nem kerülhet a konfigurációba.

A mentés atomi, előtte privát backup készül, utána a Bridge kontrolláltan
újraindítja a Codex runtime-ot. A korábbi thread csak sikeres readiness után
érvénytelenedik. Ha az új modell indulása vagy readiness ellenőrzése hibázik,
a konfiguráció és a runtime automatikusan visszaáll, a régi thread pedig
megmarad. Kézi `systemctl restart` nem szükséges.

Ha az új és az előző runtime indítása is hibázik, az API
`runtime_rollback_failed` 503 választ ad, az auditban
`rollbackRuntimeReady: false` szerepel, és a Bridge nem tekinthető readynek.

A backupok és a tartalommentes auditnapló helye:

```text
~/.config/marveen-codex-bridge/agent-settings-history/
```

Az API minden beállítási végpontja ugyanazt a szigorú admin bearer tokent
követeli, mint a dashboard. Mentéshez és visszaállításhoz `confirm: true`,
valamint egy nem üres módosítónév szükséges.

## 0.3.3 production canary

Az aktivált service végső WSL-kapuja külön eszközzel fut. A parancs kizárólag
Node 22 alatt, nem root felhasználóként működik, és megköveteli:

- az aktív `marveen-codex-bridge.service` 0.3.3 verziót;
- az inaktív legacy `bela-codex-bridge.service` unitot;
- a telepített Marveen pontosan `1.34.1` verzióját;
- privát, nem symlink admin-tokeneket és Bridge-konfigurációt;
- az engedélyezett Federationt és a `codex` peert;
- Terra kiinduló modellt és az élő modelllistában elérhető Sol modellt.

Read-only preflight:

```bash
"$HOME/.nvm/versions/node/v22.23.1/bin/node" \
  scripts/production-canary-0.3.3.mjs
```

Módosító végső kapu:

```bash
"$HOME/.nvm/versions/node/v22.23.1/bin/node" \
  scripts/production-canary-0.3.3.mjs --execute
```

A módosító kapu Terra → Sol → Terra sorrendben fut, minden váltás után
readiness-, backup- és auditbizonyítékot kér, majd mindkét modellel
Marveen → Codex → Marveen exactly-once canaryt futtat. Végül allowlisten kívüli
modellt küld a szervernek, és ellenőrzi, hogy a konfiguráció hash-e, a backupok
és az audit változatlan maradtak. Ha a Sol szakasz után hiba történik, a script
megpróbálja visszaállítani Terrát; cleanup-hibánál külön, nem elhallgatott
hibával áll le.

A post-write runtime-rollback determinisztikus ellenőrzése a teljes regressziós
teszt része. Éles fault injection szándékosan nincs: a Codex bináris vagy az
App Server mesterséges megrongálása a visszaállítást is veszélyeztetné.

## Bridge-frissítés

1. Ellenőrizd az archívum SHA-256 értékét.
2. Csomagold ki külön könyvtárba.
3. Futtasd az új csomag `verify-phase7.sh --mock-only` ellenőrzését.
4. Telepítsd `install-phase7.sh --prepare-only` módban.
5. Ellenőrizd a candidate release-t.
6. Csak ezután aktiváld.

A Marveen forrását egyik lépés sem módosíthatja.

## Rollback

Az előző immutable release helye:

```bash
readlink -f "$HOME/.local/share/marveen-codex-bridge/previous"
```

Vészhelyzetben állítsd le az új service-t, állítsd a `current` pointert a
bizonyított előző release-re, majd indítsd újra a service-t. A pointer célját
mindig abszolút, ellenőrzött release-könyvtárként add meg; ismeretlen vagy
részleges könyvtárra ne válts.

Production cutover hibánál a `cutover-phase7.sh` először letiltja a
Federationt, majd automatikusan visszaállítja a korábbi Marveen- és
service-állapotot.

## Eltávolítás

1. Tiltsd le a Federationt a Marveen publikus API-ján.
2. Állítsd le és tiltsd le a `marveen-codex-bridge.service` unitot.
3. Ellenőrizd, hogy a Marveen helyi működése egészséges.
4. A konfigurációt, adatbázist és release-eket csak külön mentés után töröld.

A legacy adapter karanténját és a Phase 0 mentést ne töröld automatikusan.
