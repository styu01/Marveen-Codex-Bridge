# Phase 6.2 – tiszta Marveen és letiltott Federation-párosítás

## Cél

A Phase 6.2 két, egymástól szándékosan elválasztott műveletet ad:

1. a régi, Marveen-forrásba telepített Codex adapter változásainak
   visszaállítható git-karanténja;
2. a tiszta Marveen publikus Federation API-ján létrehozott, kétirányú,
   de még **letiltott** Codex peer-párosítás.

Egyik lépés sem aktiválja az új Bridge service-t, nem kapcsolja be a
Federationt, és nem indítja újra a Marveent.

## Miért két lépés?

A Marveen 1.21.1-ben lévő legacy adapter és a Marveen 1.25.x publikus
Federation útja nem futhat együtt. A forrásváltozásokat előbb karanténba kell
tenni, majd a Marveent a saját frissítőjével tiszta upstream verzióra kell
frissíteni. Csak ezután lehet a publikus API-n peert létrehozni.

## Legacy adapter karantén

Read-only ellenőrzés:

```bash
./scripts/quarantine-legacy-marveen.sh \
  --marveen-root "$HOME/marveen" \
  --phase0-root "$HOME/bela-codex-preflight/phase0-freeze-YYYYMMDD-HHMMSS"
```

Végrehajtás csak a preflight után:

```bash
./scripts/quarantine-legacy-marveen.sh \
  --marveen-root "$HOME/marveen" \
  --phase0-root "$HOME/bela-codex-preflight/phase0-freeze-YYYYMMDD-HHMMSS" \
  --execute
```

A művelet szelektív `git stash push -u -- <pathspec...>` alapú. Kizárólag a
`contracts/legacy-marveen-adapter-paths-v0.2.1.txt` fájlban rögzített 26
legacy adapterútvonal kerül a stashbe. Minden más staged, egyszerre
staged+unstaged, csak unstaged és untracked Marveen-változás ugyanabban az
állapotban marad a munkafában.

A git által ignorált `store/` üzemi adatokat a script nem mozgatja. A stash
neve, commitja, a korábbi HEAD, az adapterstátusz és az adapter bináris diffje
egy privát cutover rekordba kerül. Végrehajtás után a script ellenőrzi, hogy:

- egyik adapterútvonal sem maradt módosított;
- a nem adapteres Git-állapot bájtról bájtra változatlan;
- a Marveen HEAD nem változott.

A script nem futtat `git pull`-t és nem használja az updater automatikus
stash-visszaállítását.

## Párosítás publikus API-val

Előfeltétel: tiszta, Federation v1-et tartalmazó Marveen fut a 3420-as
loopback porton, és a Phase 6.2 candidate telepítve van.

Read-only ellenőrzés:

```bash
"$HOME/.nvm/versions/node/v22.23.1/bin/node" \
  ./scripts/pair-marveen-phase6.2.mjs
```

Végrehajtás:

```bash
"$HOME/.nvm/versions/node/v22.23.1/bin/node" \
  ./scripts/pair-marveen-phase6.2.mjs \
  --execute
```

A pairer:

- csak loopback Marveen és Bridge URL-t fogad el;
- csak 0600 vagy szigorúbb, nem symlink tokenfájlt olvas;
- a dashboard tokennel lekéri a publikus peer-készletet;
- már létező `codex` peer vagy bekapcsolt Federation esetén fail-closed;
- a Marveen `POST /api/federation/peers` végpontján hozza létre a peert;
- a Marveen által generált visszirányú tokent 0600 módban írja a Bridge
  konfigurációjába;
- hibás válasz vagy hiányos ellenőrzés esetén törli az általa létrehozott
  peert;
- tokent nem ír naplóba vagy állapotfájlba, csak SHA-256 ujjlenyomatot;
- a Federationt a sikeres párosítás után is kikapcsolva hagyja.

## Nem része ennek a fázisnak

- legacy service leállítása;
- új standalone service aktiválása;
- Federation bekapcsolása;
- főagent újraindítása;
- éles Marveen → Codex → Marveen canary;
- végleges legacy Bridge eltávolítás.

Ezek csak a következő, kontrollált cutover fázisban történhetnek, automatikus
Claude-only visszaállási ággal.
