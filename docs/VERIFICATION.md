# Béla Codex Bridge 0.1.8 – fejlesztési és ellenőrzési jegyzőkönyv

## Rögzített környezet

| Komponens | Érték |
|---|---|
| Elsődleges Béla / Marveen cél | 1.21.1, a felhasználó ténylegesen futó forrása |
| Telepíthető adapter | Marveen 1.21.1 |
| Béla Node | 24.16.0 |
| Bridge Node | 22.23.1 |
| Codex CLI | 0.145.0 |
| Auth | ChatGPT-előfizetés |
| Elfogadott modell | `gpt-5.6-terra` |
| Elutasított modellek | `gpt-5.6-sol`, `gpt-5.6` |

## Felhasználó gépén már bizonyított preflight

- ChatGPT login túlélte a WSL/systemd futtatást.
- `gpt-5.6-terra` systemd user unitból válaszolt.
- Egy közös Codex App Server két thread/workspace/config/MCP identitását
  elkülönítette.
- Izolációs teszt: 33/33 PASS.
- Ugyanez explicit Node 22.23.1 alatt: 33/33 PASS.
- Béla környezete a teszt után továbbra is Node 24.16.0 és Claude Code 2.1.220
  maradt.

## A 0.1.4 alapkiadáson futtatott Bridge-tesztek

- TypeScript build/typecheck Node 22.23.1 alatt: PASS.
- Teljes saját tesztsuite Node 22.23.1 alatt: **11/11 PASS**.
- A doctor elfogadja, ha a Codex CLI a login státuszt stderrre írja: PASS.
- A verifier legfeljebb 90 másodpercig vár a socketre és az App Server ready
  állapotára: shell syntax és kontrollált indulási teszt PASS.
- A systemd start-limit direktívák a helyes `[Unit]` szekcióban vannak.
- A telepítő az aktív régi service-t is explicit újraindítja, így upgrade után
  nem maradhat memóriában a korábbi Bridge-kód.
- Szigorú config validáció.
- SQLite migráció idempotencia.
- Run idempotency conflict.
- Log secret-redaction.
- Single-process lock.
- Runtime path traversal elleni védelem.
- Teljes fake App Server API run.
- Restart utáni thread/run perzisztencia.
- Esemény és final response perzisztencia.
- MCP inventory és agent-scoped token/config generálás.

## A 0.1.5 javítás ellenőrzése

- A produkciós per-thread MCP konfiguráció byte-szintű mezői összevetve a
  Codex 0.145.0 alatt 33/33 PASS eredményt adó izolációs preflighttal.
- `enabled = true`: kötelező és tesztelt.
- `default_tools_approval_mode = "auto"`: kötelező és tesztelt.
- `required = true`: megmaradt.
- Run előtti `mcpServerStatus/list` inventory gate: fake App Server
  integrációs tesztben lefedve.
- A gate mind a négy Béla-tool nevét ellenőrzi.
- MCP startup státusz journal logging: forrás- és syntax-ellenőrzés.
- TypeScript typecheck: PASS.
- Teljes Bridge-suite a rögzített Node 22.23.1 alatt: **11/11 PASS**.
- `install.sh`, `verify-install.sh`, `install-marveen-adapter.sh` shell
  syntax-check: PASS.
- A dashboard explicit restartja és a process/build frissességvizsgálat
  telepítőútba került.

## A 0.1.6 dynamic-tool javítás ellenőrzése

- Az élő 0.1.5 vizsgálat bizonyította, hogy ugyanazon run és thread alatt az
  MCP szerver `ready`, a négy tool az inventoryban jelen van, de a modell
  toolsetjéből hiányzik.
- A 0.145.0 generált `ThreadStartParams` sémában a `dynamicTools`, a
  `ServerRequest` unióban az `item/tool/call`, a válaszban pedig a
  `DynamicToolCallResponse` alakja ellenőrizve.
- A négy tool egyetlen kanonikus definícióból kerül az MCP `tools/list` és a
  modell `dynamicTools` listájába.
- A dynamic diszpécser aktív run/thread/turn/call/namespace azonosságot és
  négyelemű allowlistet ellenőriz.
- A façade hívás az agent saját HMAC tokenjével történik; a modell nem adhat
  meg küldőazonosítót vagy tokent.
- Fake App Server teljes `item/tool/call` request/response E2E: PASS.
- Mind a négy façade route és HTTP metódus unit tesztje: PASS.
- Revision 0 MCP-only thread egyszeri revision 1 cseréje: PASS.
- Revision 1 thread Bridge-restart utáni resume-ja: PASS.
- TypeScript typecheck és production build Node 22.23.1 alatt: PASS.
- Teljes Bridge-suite Node 22.23.1 alatt: **16/16 PASS**.
- Telepítő/verifier/adapter/uninstall shell syntax-check: PASS.

## A 0.1.7 megbízhatósági javítás ellenőrzése

- A provider callback outbox csak pozitív, egész
  `context.belaMessageId` értékkel rendelkező, Béla-üzenetből indult runhoz
  jön létre. Közvetlen Bridge API run után nincs hibás callback és retry-zaj.
- Az approval tábla új migrációja megszünteti a provider request ID hibás,
  globális UNIQUE korlátozását, és külön tárolja az App Server generationt.
- Azonos provider request ID egymás utáni decline/approve döntéssel,
  adatbázis-ütközés nélkül: integrációs PASS.
- Egyazon aktív provider request ismételt beérkezése ugyanazt a függő döntést
  kapja, nem hoz létre második approval rekordot.
- A decline és approve eredménye külön `approval_result` eseményben auditálható.
- A Marveen callback adapter azonos agent, címzett, pontos tartalom és
  run-kezdési időablak alapján elnyomja a dynamic tool által már elküldött
  végválasz második példányát.
- Bridge suite Node 22.23.1 alatt: **22/22 PASS**.
- Marveen céltesztek: **7 fájl, 61/61 PASS**.
- A 0.1.6→0.1.7 adapter patch dry-runja, tényleges alkalmazása, buildje és
  referenciafával való összevetése: PASS.
- A friss és a már 0.1.7-es forrás felismerése, valamint a tiszta 1.21.1
  install preflightja: PASS.
- Telepítéskor a SQLite migráció előtt konzisztens adatbázis-backup készül.

## A 0.1.8 telepítő-runtime hotfix ellenőrzése

- A felhasználói 0.1.7 telepítés reprodukálta az ABI-hibát: a Marveen
  `better-sqlite3` modulja Node 24 `NODE_MODULE_VERSION 137` értékre készült,
  miközben az adaptertesztet a telepítő Node 22
  `NODE_MODULE_VERSION 127` alatt indította.
- A Bridge service továbbra is kizárólag a rögzített Node 22.23.1-et használja.
- A Marveen typecheck, syntax-check, Vitest és production build most külön,
  a Béla által ténylegesen használt Node 24 runtime alatt fut.
- A telepítő fail-closed módon leáll, ha a Marveen runtime nem Node 24.
- Node 24-re fordított `better-sqlite3` modullal a teljes 0.1.6→0.1.7 adapter
  upgrade, 61 célteszt és production build: PASS.
- A 0.1.7 sikertelen adaptertelepítése utáni állapot támogatott: a Bridge
  adatbázis 003 migrációja idempotens, a visszaállított 0.1.6 adaptert a
  telepítő szabályosan frissíti.

## Marveen 1.21.1 adapter ellenőrzése

A vizsgálat és a patch a feltöltött
`marveen-running-1.21.1-source.tar.gz` példányon történt. A 1.23.2 adaptert nem
kényszerítettük rá erre a verzióra; külön 1.21.1-es port készült.

Ellenőrzött tulajdonságok:

- teljes TypeScript typecheck;
- dashboard JavaScript syntax-check;
- a 12 módosítandó baseline fájl pontos SHA-256 ellenőrzése;
- patch dry-run egy érintetlen másolaton;
- patch alkalmazása egy új, tiszta 1.21.1 másolatra;
- verzióspecifikus céltesztek: **6 fájl, 58/58 PASS**;
- a telepített fájlok összevetése a fejlesztési referenciafával: egyezés;
- ismételt `--check-only`: PASS, már telepített adaptert jelez;
- ismételt install: biztonságos, idempotens no-op;
- kényszerített typecheck-hiba (`exit 91`) utáni automatikus rollback;
- rollback után mind a 12 baseline hash visszaállt;
- rollback után egyik új adapterfájl sem maradt a Marveen fában.
- a már telepített 0.1.2 adapter pontos hash-ellenőrzésű inkrementális
  frissítése: PASS;
- az inkrementális frissítés idempotenciája: PASS;
- kényszerített inkrementális frissítési hiba utáni rollback: PASS;
- Codex-agent létrehozása közben egyik Claude-generátor sem hívódik meg: PASS;
- a Codex provider determinisztikus, provider-semleges instrukciókat készít,
  amelyeket a Bridge AGENTS.md developer instructionné fordít: PASS.
- a már frissített forrás + hiányzó vagy régi `dist` állapot felismerése:
  kötelező rebuild;
- a build után a `dist/index.js`, a Codex provider, message router és
  agent-inicializáló marker ellenőrzése: PASS;
- kényszerített részleges build-hiba után a teljes korábbi `dist` byte-pontosan
  visszaáll, a félkész build diagnosztikai mentésbe kerül: PASS.

Az installer a Bridge telepítése előtt futtatja a teljes kompatibilitási
előellenőrzést. Emiatt egy nem támogatott vagy helyileg módosított Marveen nem
hagyhat félkész új Bridge release-t maga után.

## Verzióspecifikus illesztések

| Terület | Marveen 1.21.1 megoldás |
|---|---|
| Dashboard auth | csak a Bridge saját, belső service pathjai kerülnek a globális auth elé; minden handler saját bearer/HMAC ellenőrzést végez |
| Üzenetmodell | a 1.21.1 adatbázissémáját használja, nem ír későbbi `origin`/`trace` mezőket |
| Approval | külön Codex approval route és Csapat-oldali panel |
| Scheduler | a 1.21.1 `ScheduledTask` alakjából tesz üzenetet a Codex queue-ba |
| Lifecycle | provider-alapú start/stop/restart/fresh-thread, tmux nélkül |
| Monitorok | Codex-agentek kizárva a Claude/tmux auto-restart, model-fallback és channel-monitor útvonalakból |

A 0.1.8 telepítő csak a ténylegesen validált 1.21.1 verziót fogadja el.
A korábbi 1.23.2 artefakt megmaradt, de automatikusan nem alkalmazható.

## Hivatalos Codex-szerződés ellenőrzése

Az aktuális Codex manual alapján külön ellenőrizve:

- az App Server stdio transport JSONL és a `--stdio` alias támogatott;
- kapcsolat után `initialize`, majd `initialized` szükséges;
- a thread/turn lifecycle `thread/start`, `thread/resume`, `turn/start`,
  `turn/interrupt` és `turn/completed` primitíveket használja;
- az MCP konfiguráció támogatja a `command`, `args`, `env`, `enabled`,
  `startup_timeout_sec`, `tool_timeout_sec`, `required` és
  `default_tools_approval_mode` mezőket;
- `required = true` esetén az MCP inicializáció hibája fail-closed.
- az `mcpServerStatus/list` threadenként visszaadja a tényleges szerver- és
  tool-inventoryt.
- a `dynamicTools` a `thread/start` kísérleti mezője, és meghíváskor az App
  Server `item/tool/call` szerverkérést küld a kliensnek;
- a `thread/resume` 0.145.0 sémája nem tartalmaz `dynamicTools` mezőt, ezért a
  0.1.6 egyszeri új threadet igényel.

A Bridge ennek ellenére 0.145.0-ra van lockolva, mert az App Server felülete
változhat. Új Codex-verzió nem léphet élesbe a schema/contract és izolációs
preflight ismétlése nélkül.

## A feltöltött Marveen 1.21.1 teljes baseline suite-jának korlátai

A teljes Marveen-suite az érintetlen, feltöltött forráson is hibákat mutatott:

- a `better-sqlite3` natív binárisa nem volt a futtatási környezethez
  lefordítva;
- a forráscsomag nem tartalmazott több, tesztek által várt `update.sh` és
  template fájlt;
- tmux nem volt elérhető.

Érintetlen baseline eredmény: 40 suite hibás, 79 sikeres; 38 teszt hibás,
1252 sikeres, 82 kihagyott. Ezek a hibák az adapter alkalmazása előtt is
fennálltak. Emiatt a release gate a teljes typecheck, syntax-check, az érintett
útvonalak 58 céltesztje, a kötelező production build, a tiszta install, az
idempotencia és a kényszerített rollback.

## Éles telepítés utáni kötelező smoke

1. `verify-install.sh` PASS.
2. Egy Codex-agent létrehozása a dashboardból.
3. Start után actual state `idle`.
4. Claude/Béla agenttől egy üzenet küldése a Codex-agentnek.
5. Egyetlen Bridge run jön létre.
6. Egyetlen válasz érkezik vissza a küldő inboxába.
7. Bridge restart után a következő feladat ugyanazt a threadet folytatja.
8. A Codex-agent `bela_agent_message_send` és
   `bela_agent_message_status` toolja élőben PASS.
9. A journalban megjelenik a `Required Béla MCP server ready` marker.
10. Egy veszélyes parancs approvalként megjelenik Béla felületén. 1.21.1-en ez
   a Csapat oldal Codex approval panelje.
11. Bridge stop alatt a Codex-címzett üzenet pending marad; restart után egyszer
   kézbesül.
12. Egy Claude-agent start/stop és normál üzenetkezelése regresszió nélkül
    működik.
