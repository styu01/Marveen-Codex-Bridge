# Frissítés Béla Codex Bridge 0.1.7-re

## Mit javít

Ez a kiadás a 0.1.6 teljes tesztjében talált három megbízhatósági hibát
javítja:

1. Közvetlen Bridge API run után nem készül Marveennek értelmezhetetlen
   completion callback. Callback csak akkor kerül az outboxba, ha a run egy
   konkrét Béla-üzenethez tartozik, és a contextben érvényes
   `belaMessageId` található.
2. A Codex App Server approval request ID-jának későbbi újrafelhasználása nem
   ütközik többé globális SQLite UNIQUE korlátba. Az approval rekord külön
   tárolja az App Server generationt, a döntés pedig audit eseményt kap.
3. Ha a Codex ugyanazt a választ előbb `bela_agent_message_send` eszközzel
   elküldi, majd final response-ként is visszaadja, a Marveen callback adapter
   nem hoz létre második, azonos üzenetet.

A modell, effort, sandbox és dynamic tool contract ebben a kiadásban nem
változik.

## Biztonsági feltételek

- Marveen pontos verzió: `1.21.1`.
- Telepített előző adapter: a 0.1.6 aktuális adaptere, helyi drift nélkül.
- Bridge Node: `22.23.1`.
- Codex CLI: `0.145.0`.
- Ne legyen aktív Codex run vagy függő approval.

A telepítő az aktív runokat és a Marveen baseline hash-eket módosítás előtt
ellenőrzi. Az SQLite migráció előtt online, konzisztens adatbázis-backupot
készít:

```text
~/.local/state/bela-codex-bridge/database-backups/
```

## Telepítés

```bash
cd ~/bela-codex-preflight

sha256sum -c Bela-Codex-Bridge-v0.1.7.tar.gz.sha256

tar -xzf Bela-Codex-Bridge-v0.1.7.tar.gz

cd ~/bela-codex-preflight/bela-codex-bridge-0.1.7

./scripts/install.sh \
  --marveen-root "$HOME/marveen" \
  --restart-bela
```

A `--restart-bela` szükséges ahhoz, hogy a futó dashboard Node-folyamat is az
új callback adaptert töltse be. A telepítő a dashboardot külön újraindítja,
majd a szokásos Béla startup scriptet is lefuttatja.

## Kötelező telepítés utáni ellenőrzés

```bash
cd ~/bela-codex-preflight/bela-codex-bridge-0.1.7

./scripts/verify-install.sh "$HOME/marveen"
```

Az elvárt végső sor:

```text
RESULT: Bridge service and Marveen adapter verification passed.
```

A verifier külön ellenőrzi:

- `bridgeVersion = 0.1.7`;
- a callback gate lefordított markerét;
- a `003_approval_request_identity.sql` migráció jelenlétét;
- az `app_server_generation` approval oszlopot;
- a hibás provider request ID UNIQUE index hiányát;
- a Marveen callback adapter revision 2 forrás- és dist-markerét;
- hogy a futó dashboard nem régebbi a frissen épített `dist/index.js` fájlnál.

## Célzott élő regressziós teszt

1. Küldj egy normál Béla-üzenetet a Codex-agentnek, amely pontosan egy markerrel
   válaszol. Egyetlen markerüzenet érkezhet vissza.
2. Indíts közvetlen Bridge API runt `belaMessageId` nélkül. A runnak sikerülnie
   kell, és nem keletkezhet új callback retry/dead outbox rekord.
3. Indíts determinisztikus approvalt kérő műveletet, először decline, majd egy
   új runban approve döntéssel. Mindkét döntésnek a saját runjához kell
   tartoznia; SQLite UNIQUE hiba nem jelenhet meg.
4. Adj olyan feladatot, amely a végső markerét a
   `bela_agent_message_send` eszközzel is elküldi és final response-ként is
   visszaadja. A Béla inboxban pontosan egy példány maradhat.

## Megjegyzés a korábbi outbox rekordokról

A 0.1.6 alatt már `dead` állapotba került, hibás közvetlen-run callbackek
történeti auditadatok. A 0.1.7 nem törli őket automatikusan. Új közvetlen run
után azonban ilyen rekord nem keletkezhet.
