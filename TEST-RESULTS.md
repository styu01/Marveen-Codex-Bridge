# Phase 6.3 verifikáció

Dátum: 2026-07-29

Lokális eredmény:

- Phase 1–6.3 tesztek: 98/98 PASS Node 22.23.1 alatt;
- npm lifecycle Node 22 PATH/ABI regresszió: PASS;
- önálló dashboard és admin API auth/CSP: PASS;
- prepare-only release installer és Marveen-sentinel: PASS;
- legacy/new service kettős aktiválási kapu: statikus és installer teszt PASS;
- automatikus worker E2E regresszió: 30/30 egymást követő futás PASS;
- skip/cancel: 0;
- approval approve/decline: PASS;
- ismételt azonos döntés: idempotens PASS;
- ellentétes második döntés: `409` PASS;
- shutdown közbeni pending approval: `expired` + decline PASS;
- tartós, monoton App Server generation: PASS;
- dinamikus Marveen-üzenet: pontosan egy outbox rekord PASS;
- dinamikus tool identitás- és aktív-turn kapu: PASS;
- korábbi Federation, runtime, restart és driver regresszió: PASS.
- GPT-image capability fail-closed kapu: PASS;
- dinamikus image artifact regisztráció: PASS;
- workspace/traversal/symlink védelem: PASS;
- PNG signature/chunk/CRC/dimenzió ellenőrzés: PASS;
- méret- és SHA-256 kapu: PASS;
- immutable artifact másolat és restart utáni metaadat: PASS;
- admin artifact API auth, metaadat és bináris tartalom: PASS;
- Federation inbox result artifact receipt: PASS;
- imagegen artifact nélküli siker tiltása: PASS.
- legacy adapter git-karantén read-only/execute mód: PASS;
- ignorált Marveen runtime-adat megőrzése: PASS;
- publikus API-s pairing preflight/execute: PASS;
- peer-exists és enabled Federation fail-closed kapu: PASS;
- hibás Marveen tokenválasznál automatikus peer rollback: PASS.

## Nyitott kiadási kapu

A valódi Codex approve/decline, dinamikus üzenet és GPT-image preflightot a
felhasználó bejelentkezett WSL-környezetében kell futtatni. A csomag lokális
ellenőrzése nem állíthatja, hogy a felhasználó ChatGPT-jogosultsága működik.

Végső Phase 6.3 runtime PASS csak akkor mondható ki, ha megjelenik:

```text
RESULT: PHASE 5 REAL APPROVAL AND MESSAGE TOOL PASS
RESULT: PHASE 5.2 REAL IMAGEGEN AND ARTIFACT PASS
RESULT: PHASE 6.1 REAL CODEX, APPROVAL, FEDERATION AND IMAGEGEN PASS
```

## 0.3.0 dependency, systemd és Federation peer-identitás kapu

Dátum: 2026-07-30

- immutable release-path systemd unit regresszió: PASS;
- `current` symlink kizárása a runtime-modul és `better-sqlite3` útvonalából:
  PASS;
- megszakadt párosítás privát állapot- és token-ujjlenyomat alapú folytatása:
  PASS;
- a folytatott pairing kompakt eredményében a Marveen `systemId` megőrzése és
  a peer-reconciliation általi feldolgozása: PASS;
- föderált canary regresszió: az eredeti sor `delivered` marad, a válasz külön
  sorban érkezik, és ez pontosan egyszer sikeresnek minősül: PASS;
- ismeretlen vagy eltérő peer fail-closed: PASS;
- aktuális kísérletben létrehozott peer ellenőrzött rollbackje: PASS;
- régi és candidate `dist` atomikus megőrzési szerződése: PASS;
- legacy Bridge automatikus visszaindítási és readiness-szerződése: PASS;
- Phase 7.5 hybrid-dist célzott helyreállító preflight/execute szerződése:
  PASS;
- `ProtectHome=read-only` mellett kizárólag a nem symlink `CODEX_HOME`
  írhatósági kivétele: PASS;
- hitelesítőadat-mintákat maszkoló és méretkorlátos Codex stderr: PASS;
- váratlan App Server-kilépés diagnosztikai stderr-tailje: PASS;
- runtime `onEvent` naplózási lánc: PASS;
- valódi systemd readiness próba a Marveen stash/switch előtt: PASS;
- Marveen-módosítás előtti hiba esetén Federation API hívása nélküli legacy
  Bridge-visszaállítási szerződés: PASS;
- a Marveen publikus API-ból származó `systemId` és a hitelesített Bridge-peer
  atomikus egyeztetése: PASS;
- új immutable release production függőségeinek kötelező, Node 22-es staging
  telepítése a systemd-próba előtt: PASS;
- a `bela/bela` canary a régi `marveen` peerrel reprodukálhatóan 403, az
  egyeztetett `bela` peerrel 202: PASS;
- peer-konfiguráció visszaállítása sikertelen cutover esetén: PASS;
- célzott új és módosított tesztek: 14/14 PASS.

A 0.3.0 kapu lezárásakor előírt teljes, natív ellenőrzést a 0.3.1 kiadási
jelöltből, Node 22.23.1 és az ahhoz fordított production `better-sqlite3`
modullal sikeresen lefuttattuk; az eredményeket a következő szakasz rögzíti.

## 0.3.1 szerepkör- és effort-kezelési kapu

Dátum: 2026-08-01

- szerepkör és `low`/`medium`/`high`/`xhigh` effort validáció: PASS;
- megerősítéshez kötött, admin-tokenes konfigurációs API: PASS;
- atomi mentés, privát biztonsági másolat és auditnapló: PASS;
- kontrollált runtime-újraindítás és régi Codex-thread érvénytelenítése: PASS;
- előző beállítás visszaállítása és sikertelen restart rollbackje: PASS;
- korlátozott memóriájú géphez soros teljes tesztkapu: PASS;
- systemd sandbox írható konfiguráció/history útvonal és read-only tokenvédelem:
  PASS;
- sikertelen aktiválás utáni start-limit nullázás és rollback-readiness kapu:
  PASS;
- azonos verziójú inaktív candidate atomikus cseréje, régi jelölt megtartásával:
  PASS;
- célzott installer regresszió: 3/3 PASS;
- teljes, natív Node 22.23.1 kapu: 124/124 PASS, skip/fail/cancel: 0;
- valódi Codex App Server, thread-folytatás és idempotencia: PASS;
- valódi approve/decline approval broker: PASS;
- valódi Federation dinamikus tool és GPT-image artifact: PASS;
- élő szerepkör- és effort-módosítás, kontrollált runtime-újraindítás,
  pontos visszaállítás és auditnapló: PASS;
- végső élő Béla → Codex → Béla canary: PASS (`messageId=352`,
  `replyId=353`, marker:
  `FEDERATION_V031_FINAL_20260801T110328Z_OK`);
- production szolgáltatásállapot: dashboard `active`, legacy Bridge `inactive`,
  Federation Bridge `active`;
- production readiness: `status=ready`, `bridgeVersion=0.3.1`,
  `database=true`, `runtime=true`.

RESULT: 0.3.1 RELEASE GATE PASS.

## 0.3.3 artifact-UI tisztítás és verifikációs rendezés

Dátum: 2026-08-02

- a GitHub `main` 96 release-fájlja Git-blob szinten pontosan egyezett a
  hitelesített 0.3.1 archívummal: PASS;
- a változtatás előtti Node 22.23.1 Phase 7 mock baseline: 124/124 PASS;
- a „Képartifactok” szekció, az artifact összegző kártya, a frontend
  artifact-lista/content kérések és a `blob:` URL-készítés eltávolítása: PASS;
- a dashboard summary felesleges artifact-leltározásának eltávolítása: PASS;
- az artifact manager, migráció, regisztráló tool, validáció, immutable
  tárolás, Federation receipt és hitelesített admin API regressziója: PASS;
- a Phase 2/3/4/5 történeti kapuk deprecation stubként a Phase 7 kapura
  irányítanak: PASS;
- a sikertelen runtime-átállás a régi agent-threadet nem érvényteleníti, és a
  régi runtime-konfigurációval újraindul: PASS;
- a módosítás utáni Node 22.23.1 Phase 7 mock kapu: 125/125 PASS,
  skip/fail/cancel: 0.

A `gpt-5.6-sol` valós Codex App Server-kapu, a modellválasztó, a telepített
service restart/rollback és a WSL production canary még nyitott. Ezért ez nem
0.3.3 release PASS.

RESULT: 0.3.3 PRE-SOL MOCK GATE PASS (REAL CODEX NOT RUN).

## 0.3.3 Sol preflight és modellválasztó regresszió

Dátum: 2026-08-02

- a `15bd74c1eb1a4d938cf38551636359051dac4c65` pre-Sol commit izolált WSL
  könyvtárból, valós Codex `0.164.0` és `gpt-5.6-sol` modellel futott: PASS;
- valós szöveges Codex runtime, thread-folytatás, approval, Federation és
  `gpt-image-2` artifact-folyamat: PASS;
- záró valós kapu: `RESULT: PHASE 6.1 REAL CODEX, APPROVAL, FEDERATION AND
  IMAGEGEN PASS`;
- explicit `codex.allowedModels` validáció: PASS;
- allowlist és élő `model/list` metszetének szerveroldali előállítása: PASS;
- tetszőleges és fiókban nem elérhető modell elutasítása konfigurációírás előtt:
  PASS;
- modellváltás backup, audit, runtime restart és readiness útvonala: PASS;
- sikertelen váltás automatikus rollbackje a régi modell és thread
  megtartásával: PASS;
- dashboard modellválasztó és admin-only API szerződés: PASS;
- Node 22.23.1 teljes mock/security/settings/installer/cutover regresszió:
  127/127 PASS, skip/fail/cancel: 0;
- az `e0beee33d2078f03567e985f248e2476ec0da9e1` modellválasztós commit izolált
  WSL-környezetben megismételt valós `gpt-5.6-sol` kapuja: PASS;
- a megismételt kapu Node `22.23.1`, Codex CLI `0.164.0`, valós runtime,
  thread-folytatás, approval, Federation és `gpt-image-2` artifact útvonala:
  PASS;
- a megismételt záró eredmény: `RESULT: PHASE 6.1 REAL CODEX, APPROVAL,
  FEDERATION AND IMAGEGEN PASS`;
- reprodukálható, explicit `--execute` production-canary eszköz Terra → Sol →
  Terra, backup, audit, readiness, két Federation canary és tiltott modell
  változatlansági ellenőrzéssel: PASS;
- production-canary célzott regresszió: 3/3 PASS;
- bővített Node 22.23.1 teljes regresszió: 130/130 PASS,
  skip/fail/cancel: 0.

Az éles systemd service Terra → Sol → Terra váltása és a Marveen 1.28.2
Federation production canary még nem futott le. Ezért a jelölt továbbra sem
tekinthető végleges 0.3.3 release-nek.

RESULT: 0.3.3 SOL RUNTIME GATE PASS; WSL PRODUCTION CANARY REQUIRED.

## 0.3.3 WSL candidate r2 workspace-javítás

Dátum: 2026-08-04

- az első 0.3.3 production telepítési kísérlet a teljes 130/130 mock kapu után
  fail-closed módon megállt, mert a meglévő `programozo` workspace a Bridge
  adatgyökerén kívül volt;
- a 0.3.1 automatikus rollbackje readiness-ellenőrzéssel sikeresen lezárult;
- az indokolatlan adatgyökér-korlát helyett a workspace-nek a felhasználó
  valódi HOME könyvtárán belül kell maradnia, és nem lehet maga a HOME;
- a runtime változatlanul csak abszolút, létező, nem symlinkkel átirányított
  workspace-t fogad el;
- a systemd unit minden konfigurált agent workspace-éhez külön
  `ReadWritePaths` bejegyzést generál, ezért a szolgáltatás nem kap írási
  jogot a teljes HOME könyvtárra;
- célzott installer regresszió: 3/3 PASS;
- teljes, natív Node 22.23.1 kapu: 130/130 PASS,
  skip/fail/cancel: 0.

Az r2 jelölt éles Terra → Sol → Terra WSL production canaryja még hátravan.

RESULT: 0.3.3 CANDIDATE R2 MOCK GATE PASS; WSL PRODUCTION CANARY REQUIRED.

## 0.3.4 (2026-11-03) reliability candidate
- 30-minute runtime lease and owner-fenced renewal heartbeat.
- Lease loss, unhandled Promise, provider interrupt and migration tests added.
- Baseline 138 + 13 reliability tests = 151 required tests.
- Local native better-sqlite3 full suite **NOT run**, due to offline npm dependency unavailable.
- Read `RELEASE-0.3.4.md` before attempting production cutover.
