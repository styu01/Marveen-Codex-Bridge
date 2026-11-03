# Marveen Codex Bridge 0.3.4 candidate — kettős ellenőrzési jelentés

**Dátum:** 2026-11-03  
**Eredeti forrás:** felhasználói 0.3.3 candidate-r3 csomag, ellenőrzött SHA-256 értékkel.  
**Eredmény:** önálló 0.3.4 candidate. Ez nem éles üzembe helyezett kiadás.

## Funkcionális módosítások

| Terület | 0.3.3 probléma | 0.3.4 viselkedés |
|---|---|---|
| Inbox runtime lease | 120 s alapérték, megújítás nélkül | 1 800 000 ms / 30 perc; 30 s heartbeat alapértelmezéssel |
| Lease ownership | lejárat után dupla kivétel, Node crash lehet | tranzakciós, owner-fenced renew; `lease_lost` esetén nincs dupla írás és nincs téves válasz |
| Non-replayable turn | felesleges ismétlődő retry | bizonytalan / már beadott turn után terminális állapot, nem indítja újra a fájlmódosítást |
| Scheduler Promise | `void operation.finally(...)` árva rejection | kezelt resolve/reject cleanup |
| JSON-RPC async sorfeldolgozás | kezeletlen `handleLine` Promise lehet | `.catch(...)` és sanitizált protocol-error |
| Timeout | lokális reject, provider tovább dolgozhat | `turn/interrupt` + `turn/completed` megerősítés, különben runtime karantén |
| systemd stop | 90 s, rövidebb mint turn | 1900 s, a hosszú futás rendezett befejezését lehetővé teszi |
| Worker ID | kizárólag PID | PID + UUID |
| Configuration migration | 20 perces beállítás | 30 perc, többi beállítás változatlan |

## Változatlanul maradó adatok

Mind a hat korábbi/új modell engedélyezve, beleértve a 5.6 Terra és 5.6 Sol verziókat. Az agent modellje, reasoning effort szintje, jogosultságai, tokenek, workspace, peer-beállítások és a Marveen forrása változatlan. A 0.3.4 nem tartalmaz új DB migrációt.

## Első tesztkör – fejlesztési forrásból

- **108/108** elérhető független egység-, integrációs és regressziós teszt sikeres, 0 fail/skip/cancel.
- A kötelező 0.3.4 új regressziós tesztek eredménye: **13/13 PASS** (lease-renewal, lease ownership, régi worker, idempotens befejezés, scheduler, Codex interrupt, outbox lease loss, config migration, fail-closed és terminalizálás).
- Külön a korábbi infrastrukturális mock tesztek, a 0.3.3 modellmigráció és a phase7 installer is sikeres.

## Második tesztkör – a végső, újra kicsomagolt TAR.GZ-ből

- **108/108** ismét sikeres, 0 fail/skip/cancel.
- 62 `.mjs`, 11 `.sh`, 1 dashboard JavaScript: szintaktikailag ellenőrizve.
- 63 felsorolt kötelező forrásfájl jelen van, mind az új canary, konfigurációmigráció és regressziós teszt.
- `package.json` és `package-lock.json` egyezés, `better-sqlite3` pin változatlan, 6 modell változatlan.
- A teljes csomag **151** statikusan deklarált tesztet tartalmaz, a WSL-ellenőrző követelménye 151/151.
- Független, szimulált preflight-próba: aktív Codex-run esetén a külső telepítő változtatás nélkül megtagadja a telepítést, a konfiguráció és a release-pointer érintetlen marad.
- A végső archive SHA-256: `6b2f3d9e8a6670848eb16691cd60a927de3e838374b40a9873d6a33377ccb16f`.
- A telepítőbe égetett archívum-SHA és a kiadott `.sha256` megegyezik.

## Nem igazolt és továbbra is fennmaradó kockázatok

1. A `better-sqlite3` natív csomag az elkészítés környezetében offline nem érhető el. Emiatt a **151/151 teljes tesztkaput** itt nem lehetett végigfuttatni, ezt a WSL telepítőnek élesítés előtt kötelező megtennie.
2. Valódi GPT-6.1 Sol modellfuttatás, Marveen 1.34.1 Federation végpont-végpont teszt, és a production systemd stop/restart itt nem történt meg. Ezt a célgépen ellenőrizni kell.
3. A `turn/interrupt` visszaigazolása sem garantálja a független background shell processzek leállítását; a feladat munkakönyvtára bizonytalan kimenet esetén külön vizsgálandó.
4. Kényszerleállás után a 30 perces lease késleltetheti egy megszakadt inbox elem újbóli feldolgozását. A már beadott, bizonytalan Codex turn **nem kerül ellenőrizetlen újrafuttatásra**.
5. A Dashboard régebbi futásainak történeti modellcímkézése továbbra is pontatlan lehet. DB-migrációt igényel, és a stabilitási release-be szándékosan nem került be.
6. A külső telepítő rollback-felületét statikusan és a korábbi phase7-tesztek révén ellenőriztük, de valós 0.3.3→0.3.4→0.3.3 szolgáltatás-visszaállítási próba itt nem lehetséges. A telepítő nem garantál minden rendszerhiba esetén automatikus helyreállítást.

## Telepítési döntés

**Státusz: candidate, nem éles kiadás.** A csomag telepítésre előkészített, de kizárólag olyan karbantartási időablakban indítható, amikor nincs aktív Codex-feladat. A telepítőnek sikeresen végig kell vinnie a 151/151 éles környezeti tesztet, majd a bridge-et és a Marveen válaszútját külön is meg kell vizsgálni. Hiba esetén a telepítés megáll, és rollbacket próbál.
