# Phase 6.1 – önálló telepítés és dashboard

## Határ

A Phase 6.1 kizárólag a Bridge saját könyvtárait kezeli:

- `~/.config/marveen-codex-bridge`;
- `~/.local/state/marveen-codex-bridge`;
- `~/.local/share/marveen-codex-bridge`;
- `~/.config/systemd/user/marveen-codex-bridge.service`.

A telepítőben nincs Marveen-forrásútvonal, nem olvas Marveen-adatbázist, nem
futtat `bela-start.sh`-t, nem állít le tmux sessiont és nem patch-el fájlt.

## Release-modell

- `releases/<version>`: változtathatatlan telepített kiadás;
- `candidate`: előkészített, de nem aktív kiadás;
- `current`: a systemd service által használt aktív kiadás;
- `previous`: az utolsó aktív kiadás automatikus rollbackhez.

Az alapértelmezett `prepare-only` telepítés nem módosítja a `current` pointert.
Az `--activate` csak akkor engedélyezett, ha a régi
`bela-codex-bridge.service` nem aktív. Az új service readiness hibája esetén a
telepítő visszaállítja a korábbi `current` célpontot.

## Konfiguráció és párosítás

Első telepítéskor három külön, 0600 módú token keletkezik:

- Bridge admin token;
- Marveen → Codex inbound token;
- Codex → Marveen outbound token.

A `marveen-pairing.env` kizárólag privát átadási segédlet. Nem kerül logba és
nem része a dashboard API-nak. A Marveen-oldali párosítás külön Phase 6.2
feladat; a Phase 6.1 nem írja be automatikusan.

## Dashboard

URL: `http://127.0.0.1:3431/dashboard`

A statikus HTML/CSS/JavaScript közvetlenül a Bridge release része. Nincs CDN,
külső betöltés vagy Marveen-függőség. Az admin token a böngésző
`sessionStorage` tárában marad, ezért a lap bezárásakor eltűnik.

Megjelenített adatok:

- readiness és Bridge-verzió;
- agentek és modellek;
- legutóbbi futások;
- függő approvalok és approve/decline;
- inbox/outbox hibaszámlálók;
- agentbeállítások és tartalommentes auditnapló.

Az artifact-lista és a képelőnézet a 0.3.3 termékdöntése alapján nem része a
dashboardnak. Az artifact admin API, a validáció és az immutable tárolás ettől
független backend-szerződésként változatlanul megmarad.

## Phase 6.2 előfeltétele

Phase 6.2 csak akkor indulhat, ha:

1. a Phase 6.1.1 csomag 98/98 tesztet ad;
2. a valódi Phase 4/5/5.2 preflight ismét PASS;
3. a `prepare-only` telepítés ellenőrzése PASS;
4. Marveen forrásfájljai változatlanok;
5. a legacy és az új service nem fut egyszerre.
