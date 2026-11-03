# Phase 4 – Codex App Server runtime

## Cél

A Phase 4 a Phase 3 mock runtime-ját valódi, külön processzként futó
`codex app-server --stdio` adapterre cseréli. A runtime sem Marveen-forrást,
sem Marveen-adatbázist nem importál vagy módosít.

## Protokoll-életciklus

1. `codex --version` – exact verziókapu.
2. `codex login status` – kizárólag pozitív `Logged in using ...` elfogadása.
3. App Server child process indítása.
4. `initialize` kérés, majd `initialized` notification.
5. `model/list` és minden konfigurált agent modelljének ellenőrzése.
6. Korábbi thread esetén `thread/resume`, egyébként `thread/start`.
7. `turn/start`, majd `item/completed` és `turn/completed` feldolgozás.
8. Kész válasz tartós rögzítése.

## Thread-konfiguráció

A thread érvénytelenítő hash részei:

- modell;
- workspace canonical path;
- sandbox mód;
- reasoning effort;
- hálózati engedély;
- developer instructions.

Bármelyik változása új threadet hoz létre. Normál Bridge/App Server restart
esetén a korábbi thread azonosítóval folytatódik.

## Run-idempotencia és crash-határ

Minden Federation inbox stabil runtime kulcsa:
`federation-inbox-<inboxId>`.

- kész run újrahívása a tárolt választ adja vissza modellfuttatás nélkül;
- ugyanaz a kulcs más payload-dal konfliktus;
- App Servernek még el nem küldött hiba retryolható;
- elküldött turn közbeni process-crash eredménye `interrupted_unknown`;
- az `interrupted_unknown` run automatikus újrajátszása tilos.

Az utolsó szabály szándékosan konzervatív. A Codex turn végrehajthatott
mellékhatást még azelőtt, hogy a Bridge tartósan megkapta volna a választ.
Automatikus replay ezért duplán futtathatna parancsot vagy fájlmódosítást.

## Phase 4 biztonsági profil

- `approvalPolicy`: kizárólag `never`;
- minden App Server approval request determinisztikusan `decline`;
- sandbox: `read-only` vagy explicit `workspace-write`;
- hálózat agentenként, alapértelmezetten tiltva;
- `danger-full-access` nem támogatott;
- MCP/dynamic tools még nincsenek bekapcsolva;
- image generation még nincs bekapcsolva.

## Valódi preflight

A verifier két read-only, approval nélküli turnt indít:

1. első marker;
2. teljes App Server/runtime restart;
3. második marker ugyanazon threaden;
4. azonos idempotenciakulcs ismétlése modellfuttatás nélkül.

A futás saját ideiglenes workspace-t és saját Federation SQLite-adatbázist
használ. Marveen service-t nem indítja újra és Marveen-adatot nem ír.

## Nem kész

- user approval approve/decline kezelése;
- tool/MCP hívások;
- image artifact pipeline;
- saját dashboard;
- üzemi telepítő és a legacy 0.2.1 adapter eltávolítása.

Ezek nélkül a Phase 4 még nem production release.
