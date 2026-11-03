# Marveen Codex Bridge 0.3.4 — stabilitási candidate

Kiadás dátuma: 2026-11-03. A 0.3.3 production rendszer forrása nem módosult; ez külön telepíthető candidate.

## Megoldott hibák

1. **Inbox-bérlet:** alapértelmezés szerint 1 800 000 ms (30 perc), és a futó worker tulajdonoshoz kötött, tranzakciós heartbeat-tel meghosszabbítja. Alapesetben a heartbeat 30 másodpercenként fut. A megújítás nem éleszthet újra lejárt vagy másik worker által átvett bérletet.
2. **`lease_lost` kezelése:** tulajdonjogvesztés után sem sikeres választ, sem retry/hibaírást nem kísérel meg ugyanarra a feladatra. A másodlagos `lease_lost` kivételt a hibakezelő külön fogja. Az outbox kézbesítés hasonló hibakezelést kapott.
3. **Scheduler:** a `finally()` által előállított árva, elutasított Promise megszűnt. A JSON-RPC sorfeldolgozás aszinkron kivételeit is elkapja és sanitizált eseményként jelzi.
4. **Codex timeout:** ha a `turn/start` visszaadta a turn azonosítóját, az időkeret végén a Bridge `turn/interrupt` kérést küld. Az RPC-nyugtázást **nem** tekinti a befejezés igazolásának: a `turn/completed` értesítésig foglaltnak tekinti a turnt. Ha az interrupt nem nyugtázható vagy nem jön terminal notification, a runtime `not_ready` állapotba kerül, és nem fogad új Codex munkát; a futás eredménye bizonytalan marad.
5. **Graceful stop:** a systemd `TimeoutStopSec` 1900 másodperc. A stop lehetővé teszi, hogy a 15 perces futás normál esetben befejeződjön. Kényszerleállítás vagy gépösszeomlás alatt továbbra is lehetséges bizonytalan állapot.
6. **Worker egyediség:** a PID mellett UUID is része a lease-tulajdonosnak, elkerülve a PID újrafelhasználásából eredő tulajdonos-azonosságot.

## Megőrzött szerződés

- A hat modell: `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6-astra`.
- Aktív agent model/effort, jogosultság, token, workspace, Federation peer és beállítások **nem módosulnak**.
- Natív `better-sqlite3` = `11.10.0`, Node = `v22.23.1`, Codex CLI = `0.164.0` célplatform.
- Nincs új SQLite-migráció: a 0.3.3 adatbázis-kompatibilitás változatlan.
- A 0.3.3 telepítés megmarad azonnali rollbackhez.

## Veszélyes esetek és korlátok

- 30 perces bérlettel a crash után az érvénytelen worker foglalásának újraigénylése akár 30 percet is várhat. A heartbeat ezt élő worker alatt megakadályozza.
- Hálózati szakadás, kényszerleállítás és bizonytalan provider outcome esetén nincs garantált, automatizált eredményrekonstrukció. Az idempotenciakorlát megőrzi a kétértelmű turnt, és tiltja az ellenőrizetlen újrajátszást.
- A timeouttal megszakított Codex-turn által indított, önálló háttérterminálok leállása **nem garantált** a `turn/interrupt` API által. A kritikus workspace-eket külön ellenőrizni kell.
- A történeti modellmegjelölések hibáját ez a stabilitási javítókiadás **nem** oldja meg, mert az új DB-migráció szükségtelen kockázat lenne. A régi runok a jelenlegi agenthez rendelt modellnevét örökölhetik.

## Biztonságos telepítés (Windows Letöltések -> WSL)

A felhasználónál az aktív 0.3.3 működése és a Codex bejelentkezés a kiindulási feltétel. Folyamatban lévő job esetén a telepítő **megtagadja** a cutovert.

1. Töltsd le a `.tar.gz`, `.sha256` és `.sh` fájlt `C:\\Users\\kisss\\Downloads` alá.
2. Másold őket a `~/bridge-upgrade` könyvtárba, majd futtasd a `sha256sum -c ...sha256` parancsot.
3. Futtasd `bash install-Marveen-Codex-Bridge-v0.3.4-candidate.sh ./Marveen-Codex-Bridge-v0.3.4-candidate.tar.gz` parancsot **csak akkor, ha nincs aktív Béla/Codex feladat**.
4. Az önálló telepítő mentést, modell- és konfiguráció-ellenőrzést, **a teljes 151-tesztes kaput**, majd egy új service readiness-t és admin modellkatalógus-ellenőrzést végez. Hiba esetén visszaállítja a 0.3.3 konfigot/unitot/current pointert és újraindítja a korábbi release-t.
5. A telepítő végén külön éles, kizárólag olvasási canary és egy hosszabb teszt-Codex-feladat szükséges az end-to-end igazoláshoz.

## Validálás

Helyi gépen sikeres: 108/108 SQLite builtin és független célzott teszt, továbbá a legújabb 12/12 regressziós teszt. **A teljes 151/151 natív tesztcsomag és az élő Marveen/Codex kommunikáció ebben a környezetben nem igazolható**; a WSL telepítő ezekből az összes automatizálható tesztet kikényszeríti. A package ezért candidate.
