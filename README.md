# Marveen Codex Bridge Federation 0.3.4

Önálló, frissítésálló Federation Bridge a Marveen/Béla és a valódi OpenAI
Codex CLI között. A Bridge a Marveenben egy föderált `programozo` agentet tesz
elérhetővé, miközben a Codex futtatása, állapota, jóváhagyásai és artifactjai
egy külön szolgáltatásban maradnak.

> **Kiemelt képesség: működő AI-képgenerálás.** A Codex-agent a beépített
> `gpt-image-2` képességgel valódi PNG-képet tud létrehozni. A Bridge a kész
> képet szerkezetileg és kriptográfiailag ellenőrzi, megváltoztathatatlan
> artifactként tárolja, az eredményhez tartós receiptet kapcsol, és külön
> hitelesített admin API-n teszi elérhetővé. A valódi GPT-image → validáció →
> immutable artifact folyamat a 0.3.1 kiadási kapuban sikeresen lefutott.

## Miért külön Bridge?

A cél nem egy Marveen-fork fenntartása. A Bridge:

- nem patch-eli és nem importálja a Marveen forráskódját;
- kizárólag a verziózott Federation v1 HTTP-szerződést használja;
- külön systemd user service-ként fut;
- külön konfigurációval, SQLite-adatbázissal és admin felülettel rendelkezik;
- a Marveentől függetlenül frissíthető és visszaállítható;
- hiba esetén nem írhatja felül a Marveen működő állapotát.

Ez csökkenti annak kockázatát, hogy egy Marveen-frissítés eltöri a Codex-
integrációt, vagy egy Bridge-frissítés módosítja a Béla rendszer forrását.

## Kiadási állapot (2026-11-03)

**Aktuális kiadás: Marveen Codex Bridge 0.3.4 candidate.**
A kiadás az üzemeltető WSL rendszerében **151/151 automatizált teszten megfelelt**,
a rendszer 0.3.4 verzióval és 30 perces lease-konfigurációval `ready` állapotot jelentett.
Ez **nem** helyettesíti a még elvégzendő, valós Marveen → Codex → Marveen hosszú futású E2E tesztet.

| Elem | Állapot |
|---|---|
| Bridge | `0.3.4-candidate`, forrás + csomag a repositoryban |
| Marveen célkörnyezet | `1.34.1`, Federation v1 |
| Node.js | `22.23.1` |
| Codex CLI | `0.164.0`, külön telepített bináris |
| Modellek | `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6-astra` |
| Runtime lease | 30 perc (`1800000` ms), alapértelmezett heartbeat 30 másodperc |
| Automatizált tesztek | **151/151 PASS** a cél WSL gépen |
| Élő hosszú Codex E2E | **Még külön ellenőrizendő** |

A kiadás és a **javított r2 telepítő** a [releases/](releases/) könyvtárban található;
a korábbi verziók elérhetők a Git-előzményekben.
Lásd: [RELEASE-0.3.4.md](RELEASE-0.3.4.md) és
[releases/TELEPITES-0.3.4-WSL.md](releases/TELEPITES-0.3.4-WSL.md).

## Fő képességek

### Federation és Codex runtime

- Marveen Federation v1 manifest és inbox végpont;
- szigorúan ellenőrzött `system/agent` címzés és peer-identitás;
- valódi Codex App Server folyamat, tartós generation-kezeléssel;
- thread indítás és biztonságos thread-folytatás;
- pontosan-egyszeri feldolgozás peer/ref deduplikációval;
- durable inbox és outbox, lease, retry és dead-letter állapot;
- dinamikus `marveen_agent_message_send` eszköz a Codex válaszaihoz;
- a modell nem választhat idegen feladóazonosítót vagy tetszőleges peert.

### Képgenerálás és artifact pipeline

A képalkotás nem szimuláció és nem külön Marveen-plugin. A folyamat:

1. a Bridge induláskor lekéri a Codex App Server képességeit;
2. ha a kötelező `gpt-image-2` képesség hiányzik, a runtime fail-closed módon
   nem lesz ready;
3. a Codex létrehozza a végleges PNG-t az agent kijelölt workspace-ében;
4. az aktív run a `marveen_image_artifact_register` eszközzel regisztrálja;
5. a Bridge ellenőrzi a workspace-határt, symlinkeket, útvonalat, méretet,
   PNG-signature-t, chunkokat, CRC-ket, dimenziót, pixelszámot és SHA-256-ot;
6. a fájl egyedi artifact ID alatt, `0400` jogosultsággal immutable másolatként
   kerül a Bridge saját tárolójába;
7. a Federation eredmény tartós artifact receiptet kap, az admin API pedig
   hitelesítetten elérhetővé teszi a metaadatot és a validált bináris tartalmat.

Alapértelmezett korlátok:

- csak validált PNG fogadható el;
- legfeljebb 20 MiB/artifact;
- legfeljebb 16 777 216 pixel;
- abszolút útvonal, `..`, backslash és symlink tiltott;
- a provider workspace-en kívüli staging fájlja nem regisztrálható;
- `$imagegen` feladat kész artifact nélkül hibának minősül;
- artifact letöltéskor újra megtörténik a méret- és SHA-256-ellenőrzés.

Részletes szerződés:
[Képalkotás és artifactok](docs/phase5.2-imagegen-and-artifacts.md).

### Manuális jóváhagyási broker

Külső, érzékeny vagy sandboxon kívüli Codex-művelethez a Bridge tartós
approval rekordot készít. Az admin felületen a kérés jóváhagyható vagy
elutasítható.

- állapotok: `pending`, `approved`, `declined`, `expired`;
- azonos döntés ismétlése idempotens;
- ellentétes második döntés konfliktus;
- aktív waiter nélkül egy régi kérés nem hagyható jóvá;
- leállításkor a függő kérések kontrolláltan lejárnak;
- az approvalok generation- és provider-request-azonosítóhoz kötöttek.

Fontos: a kijelölt workspace-en belüli, sandbox által megengedett fájlírás nem
feltétlenül generál külön approvalt. A broker nem helyettesíti a Codex saját
sandboxát, hanem azzal együtt működik.

### Modell-, szerepkör- és effort-kezelés

A 0.3.3-ben az admin dashboardon módosítható az egyetlen `programozo` agent:

- teljes `developerInstructions` szerepköre;
- Codex modellje: mind a hat megengedett modell, amennyiben a Codex `model/list` elérhetőnek jelzi;
- reasoning effortja: a modell által támogatott érték, például Sol 6.1 esetén `medium` vagy `high`.

A dashboardon megjelenő modelllista nem statikus klienslista. A szerver az
explicit `codex.allowedModels` engedélylista és az élő Codex App Server
`model/list` válaszának metszetét adja vissza. A kliens által beküldött
tetszőleges modellnév nem menthető el.

A szerepkör minden új Codex-thread fejlesztői utasításának része, ezért ez
határozza meg az agent szakmai fókuszát és működési kereteit. Nem egyszerű
megjelenítési címke: a runtime ténylegesen átadja a Codexnek.

A beállításváltás védelmei:

- aktuális értékek megjelenítése;
- üres vagy hibás szerepkör elutasítása;
- allowlisten kívüli vagy a Codex-fiókban nem elérhető modell elutasítása még
  backup, fájlírás és runtime-leállítás előtt;
- kizárólag a kiválasztott modellhez támogatott effort fogadható el;
- kötelező vizuális megerősítés;
- kötelező admin bearer token;
- aktív run vagy függő approval alatt a módosítás tiltott;
- atomi konfigurációcsere;
- módosítás előtti privát biztonsági másolat;
- kontrollált Codex runtime-újraindítás;
- readiness ellenőrzés az új konfigurációval;
- a régi thread érvénytelenítése csak sikeres restart és readiness után, hogy
  ne maradjon kevert konfiguráció;
- visszaállítás az előző konfigurációra;
- sikertelen restart esetén automatikus konfiguráció-rollback, az előző modell
  és thread megtartásával;
- ha az előző runtime sem állítható vissza, külön `runtime_rollback_failed`
  503-as hiba és auditjelzés készül; ezt nem jelenti ártalmatlan rollbackként;
- auditnapló: módosító, időpont, művelet, modell- és effort-változás, valamint
  a szerepkör előtte/utána hash-e.

Az auditnapló szándékosan nem tárolja el ismét a teljes szerepkörszöveget.

### Saját admin dashboard

Alapértelmezett cím:

```text
http://127.0.0.1:3431/dashboard
```

A dashboard megjeleníti:

- Bridge-verzió és online/ready állapot;
- inbox és dead outbox darabszám;
- függő approvalok;
- legutóbbi Codex-runok és állapotuk;
- agentnév, szerveroldalon validált modellválasztó és aktuális reasoning effort;
- aktuális developerInstructions;
- beállításváltozások auditnaplója;
- az előző agentbeállítás visszaállításának lehetősége.

Az admin token csak az adott böngészőfül memóriájában marad; a dashboard nem
írja local storage-ba. A token a telepített gépen olvasható:

```bash
cat "$HOME/.config/marveen-codex-bridge/admin.token"
```

## Architektúra

| Komponens | Felelősség |
|---|---|
| Marveen/Béla | főagent, delegálás, Federation peer-konfiguráció |
| Federation HTTP | manifest és hitelesített inbox szerződés |
| Bridge service | routing, állapotgépek, API, dashboard, worker orchestration |
| Codex App Server | modellthread, turnök, toolok és approval kérések |
| SQLite | inbox, outbox, run, approval és artifact metaadat |
| Artifact store | ellenőrzött, immutable PNG-másolatok |
| systemd user unit | sandboxolt életciklus, restart és erőforrás-korlátok |

A Marveenből érkező feladat útja:

```text
Marveen/Béla
  → POST /api/federation/inbox
  → durable Bridge inbox
  → Codex programozo run
  → durable Bridge outbox
  → Marveen Federation API
  → Béla válaszüzenet
```

## Biztonsági modell

- a service kizárólag `127.0.0.1` címen figyel;
- a Federation és admin API eltérő, nem felcserélhető tokeneket használ;
- minden Federation peer saját inbound/outbound tokenpárt kap;
- token minimumhossz és timing-safe összehasonlítás;
- a payload feladó rendszerének egyeznie kell a hitelesített peerrel;
- body-, tartalom-, ref- és manifest-méretkorlátok;
- sender impersonation és minősített helyi cél tiltott;
- az admin API minden érzékeny végpontja bearer tokent követel;
- privát konfigurációk és tokenek nem kerülhetnek Gitbe;
- systemd `ProtectHome=read-only`, célzott írható utak és read-only tokenek;
- `NoNewPrivileges`, privát temporary könyvtár és korlátozott rendszerhozzáférés;
- a Marveen belső adatbázisa és privát API-ja nem része az integrációnak;
- hálózati hozzáférés az agent konfigurációjában alapból tiltott;
- ismeretlen vagy ellentmondó pairing állapot fail-closed.

## Tartósság és hibakezelés

A Bridge a hálózati vagy processzhibát nem azonosítja sikerrel:

- az inbox és outbox rekordok SQLite-ban tartósak;
- lease védi a párhuzamos vagy félbeszakadt feldolgozást;
- retry korlátozott próbálkozásszámmal működik;
- kimerített kimenő rekord dead-letter állapotba kerül;
- peer/ref deduplikáció megakadályozza a duplikált feladatot;
- run, approval és artifact metaadat restart után is megmarad;
- leállításkor az új kérések fogadása megszűnik, az aktív tickek lezárulnak;
- váratlan App Server-kilépés diagnosztikai, maszkolt stderr-tailt hagy.

## Követelmények

- Linux vagy WSL2;
- működő systemd user service;
- **pontosan Node.js 22** a Bridge futtatásához;
- Codex CLI `0.164.0`;
- aktív ChatGPT/Codex bejelentkezés;
- Marveen Federation v1;
- validált production baseline esetén Marveen `1.25.1`;
- a natív `better-sqlite3` modulnak ugyanahhoz a Node 22 ABI-hoz kell készülnie.

A Marveen és a Bridge használhat eltérő Node-verziót, de a Bridge systemd
unitja mindig a telepítéskor megadott Node 22 binárisra van rögzítve.

## Csomag ellenőrzése

```bash
sha256sum -c Marveen-Codex-Bridge-v0.3.3.tar.gz.sha256
tar -xzf Marveen-Codex-Bridge-v0.3.3.tar.gz
cd marveen-codex-bridge-0.3.3
```

Forrásellenőrzés:

```bash
npm ci --no-audit --no-fund
export MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH="$PWD/node_modules/better-sqlite3"
npm run check
npm test
```

Teljes WSL-verifikáció:

```bash
./scripts/verify-phase7.sh \
  --node-bin "$HOME/.nvm/versions/node/v22.23.1/bin/node" \
  --codex-bin "$HOME/.local/bin/codex" \
  --clean-marveen-root "$HOME/bela-codex-preflight/marveen-upgrade-v1.25.1"
```

A teljes kiadási kapu a mock teszteken túl valódi Codex-, approval-,
Federation- és GPT-image ellenőrzést is tartalmaz. A részletes eredmény:
[TEST-RESULTS.md](TEST-RESULTS.md).

## Telepítés

### 1. Előkészítés szolgáltatásindítás nélkül

```bash
./scripts/install-phase7.sh \
  --node-bin "$HOME/.nvm/versions/node/v22.23.1/bin/node" \
  --codex-bin "$HOME/.local/bin/codex" \
  --prepare-only
```

Ez immutable candidate release-t készít, telepíti a production függőségeket,
de nem kapcsolja át az aktív service-t.

### 2. Aktiválás

```bash
./scripts/install-phase7.sh \
  --node-bin "$HOME/.nvm/versions/node/v22.23.1/bin/node" \
  --codex-bin "$HOME/.local/bin/codex" \
  --activate
```

Az installer új telepítésnél:

- létrehozza a privát konfiguráció- és tokenfájlokat;
- telepíti a verziózott alapértelmezett
  [`programozo` szerepkört](config/programozo-developer-instructions.hu.md);
- létrehozza az immutable release-könyvtárat;
- telepíti és újratölti a systemd user unitot;
- readiness ellenőrzés után állítja át a pointereket.

Meglévő privát konfigurációt nem ír felül. Azonos verziójú, de inaktív hibás
candidate biztonságosan lecserélhető; a régi jelölt külön superseded
könyvtárban megmarad.

## Konfiguráció és privát adatok

Alapértelmezett konfiguráció:

```text
~/.config/marveen-codex-bridge/config.json
```

Állapotadatbázis:

```text
~/.local/state/marveen-codex-bridge/federation.sqlite3
```

Release-ek és runtime:

```text
~/.local/share/marveen-codex-bridge/
```

Agentbeállítás-backup és audit:

```text
~/.config/marveen-codex-bridge/agent-settings-history/
```

Konfigurációs példa: [config/config.example.json](config/config.example.json).
Valódi token, pairing state, thread ID vagy felhasználói adat nem tehető a
repositoryba és nem tölthető fel hibajelentéshez.

## Állapotellenőrzés

```bash
systemctl --user is-active marveen-codex-bridge.service

curl --silent --show-error --fail \
  http://127.0.0.1:3431/readyz |
python3 -m json.tool
```

Elvárt válasz:

```json
{
  "status": "ready",
  "bridgeVersion": "0.3.3",
  "database": true,
  "runtime": true
}
```

## Frissítés és rollback

A Bridge és a Marveen frissítése két külön művelet.

Bridge-frissítésnél:

1. ellenőrizd az archívum SHA-256 értékét;
2. futtasd az új csomag tesztjeit;
3. telepíts `--prepare-only` módban;
4. ellenőrizd a candidate-et;
5. csak ezután aktiváld;
6. readiness hiba esetén tartsd meg a bizonyított előző release-t.

A `current`, `candidate` és `previous` pointerek csak ellenőrzött immutable
release-könyvtárra mutathatnak. Aktiválási hiba esetén az installer
`reset-failed` után visszaindítja az előző release-t, és annak readiness
állapotát is ellenőrzi.

Marveen-frissítés előtt külön Federation contract teszt kötelező. Az, hogy a
Bridge ready, önmagában nem bizonyítja egy új Marveen-verzió kompatibilitását.

### 0.3.3 WSL production canary

Az aktivált `0.3.3` service és a telepített Marveen `1.34.1` végső kapuja
alapértelmezésben csak olvasási preflightot végez:

```bash
"$HOME/.nvm/versions/node/v22.23.1/bin/node" \
  scripts/production-canary-0.3.3.mjs
```

Csak sikeres preflight után futtatható a módosító kapu:

```bash
"$HOME/.nvm/versions/node/v22.23.1/bin/node" \
  scripts/production-canary-0.3.3.mjs --execute
```

A canary Terra → Sol → Terra váltást, két readiness-ellenőrzést, backupot,
auditot, mindkét modellel pontosan-egyszeri Marveen Federation választ és egy
allowlisten kívüli modell állapotváltozás nélküli elutasítását követeli. Hiba
esetén megpróbálja visszaállítani a kiinduló Terra modellt. Nem tartalmaz
production hibainjektálást és nem módosítja a Marveen forrását.

Részletes útmutató:
[Telepítés, frissítés, rollback és eltávolítás](docs/operations.md).

## Tudatos korlátok

- A 0.3.3 egyetlen konfigurált Codex-agentet kezel: `programozo`.
- Az agent megjelenített neve még nem szerkeszthető a dashboardon.
- Több föderált Codex-agent kezelése későbbi verzió feladata.
- Képartifactként ebben a verzióban csak PNG regisztrálható.
- A dashboard nem jelenít meg artifact-listát vagy képelőnézetet; az artifact
  backend, a validáció, az immutable tárolás, a receipt és az admin API megmarad.
- Az admin dashboard kizárólag loopbackről érhető el; nincs távoli admin UI.
- A Bridge nem kap közvetlen hozzáférést a Marveen memóriájához, kanbanjához
  vagy belső SQLite-adatbázisához.
- A képalkotás elérhetősége a bejelentkezett Codex-fiók aktuális
  jogosultságaitól is függ.

## További dokumentáció

- [Federation v1 wire contract](contracts/federation-v1.md)
- [Production cutover szerződés](docs/phase7-production-cutover.md)
- [Approval és dinamikus tool architektúra](docs/phase5-approval-and-tools.md)
- [Képalkotás és artifact pipeline](docs/phase5.2-imagegen-and-artifacts.md)
- [Üzemeltetés és rollback](docs/operations.md)
- [Aktuális verifikációs kapu](docs/verification.md)
- [Kiadási teszteredmények](TEST-RESULTS.md)

## Licenc

[MIT License](LICENSE)

## 0.3.4 stabilitási candidate (2026-11-03)

A 0.3.3 kiadásban megerősített `lease_lost`/Node összeomlás hibáinak javítása, 30 perces
lease és tulajdonoshoz kötött, periodikus megújítás. Új, szigorú telepítő és rollback.
Részletek, korlátok és WSL útmutató: [RELEASE-0.3.4.md](RELEASE-0.3.4.md).
Ez **nem** automatikus éles frissítés, amíg a teljes 150 teszt és a valós canary nem sikeres.
