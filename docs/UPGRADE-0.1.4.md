# Frissítés Béla Codex Bridge 0.1.4-re

A 0.1.4 javítja, hogy Codex-agent létrehozásakor a Marveen tévesen a Claude
workertől próbálta generáltatni a CLAUDE.md és SOUL.md fájlokat. A Codex-agent
most Claude-függőség nélkül, determinisztikus provider-semleges instrukciókkal
jön létre. Emellett kijavítja azt a kritikus telepítési hibát, amelynél a
TypeScript-forrás már tartalmazta a Codex providert, de Béla továbbra is a régi
`dist/index.js` fájlt futtatta. A 0.1.4 mindig production buildet készít, és
csak akkor tekinti sikeresnek a telepítést, ha a lefordított hookok is
ellenőrizhetők. A Bridge-token, adatbázis és konfiguráció megmarad.

## Telepítés

```bash
cd "$HOME/bela-codex-preflight"
sha256sum -c Bela-Codex-Bridge-v0.1.4.tar.gz.sha256
tar -xzf Bela-Codex-Bridge-v0.1.4.tar.gz
cd bela-codex-bridge-0.1.4

./scripts/install.sh \
  --marveen-root "$HOME/marveen" \
  --restart-bela
```

A 0.1.4 először felismeri, hogy tiszta 1.21.1, már telepített 0.1.2 adapter,
vagy már frissített forrás + régi `dist` van-e jelen. Ezután ellenőrzi az adott
állapot pontos hash-eit és – ha patch szükséges – dry-runt végez. Ha ez nem
sikerül, még nem ír új Bridge release-t és nem módosítja Marveent.

Sikeres előellenőrzés után:

1. telepíti a külön Node 22-es Bridge release-t;
2. megtartja a már létező privát tokent és állapot-adatbázist;
3. elindítja és ellenőrzi a Bridge service-t;
4. timestampelt mentést készít a Marveen fájlokról;
5. alkalmazza az 1.21.1-es adaptert;
6. typechecket, syntax-checket és 58 céltesztet futtat;
7. újraépíti a Marveen teljes `dist` könyvtárát;
8. ellenőrzi a lefordított Codex provider, router és agent-inicializáló
   hookokat;
9. hiba esetén a forrást és a teljes korábbi `dist` könyvtárat automatikusan
   visszaállítja;
10. siker esetén újraindítja Bélát, így a dashboard már az új
    `dist/index.js` fájlt tölti be.

## Telepítés utáni ellenőrzés

```bash
cd "$HOME/bela-codex-preflight/bela-codex-bridge-0.1.4"
./scripts/verify-install.sh "$HOME/marveen"
```

Minden ellenőrzés `PASS:` sort ír, a végén pedig ennek kell megjelennie:

```text
RESULT: Bridge service and Marveen adapter verification passed.
```

Ezután a Béla Agents oldalán létrehozható egy
`OpenAI Codex Bridge` / `GPT-5.6 Terra` agent. Marveen 1.21.1-en a függő Codex
jóváhagyások a Csapat oldal külön Codex approval paneljén jelennek meg.

## Ha a kompatibilitási ellenőrzés megáll

Ne használd a `patch`, `git checkout`, `git reset` vagy kézi fájlmásolás
parancsokat. Mentsd el a telepítő teljes kimenetét. Az eltérő hash azt jelenti,
hogy a futó Marveen már nem az a pontos 1.21.1 baseline, amelyre ez az adapter
készült; ilyenkor új kompatibilitási port szükséges.

## Automatikus mentés

Az adapter előtti mentés sikeres patch előtt itt készül:

```text
~/.local/state/bela-codex-bridge/adapter-backups/marveen-1.21.1/<timestamp>/
```

Itt a `before-adapter.tar.gz` mellett a `before-dist.tar.gz` is megmarad.
Az uninstall szándékosan nem törli ezeket, a Bridge tokent vagy az adatbázist.
