# Frissítés Béla Codex Bridge 0.1.8-ra

## Miért szükséges

A 0.1.7 Bridge-kód és adatbázis-migráció helyes, de az adaptertelepítő a
Marveen célteszteket tévesen a Bridge Node 22 runtime-jával futtatta. Béla
Marveen 1.21.1 példánya Node 24-en fut, ezért a `better-sqlite3` natív modulja
Node 24 ABI-ra van fordítva. Az új callback-deduplikációs teszt adatbázist
nyitott, így az eltérés korrekt módon hibát okozott.

A 0.1.8 szétválasztja a két futtatókörnyezetet:

- Bridge service és Bridge tesztek: Node 22.23.1;
- Marveen build és adaptertesztek: Béla Node 24.

## A sikertelen 0.1.7 telepítés utáni állapot

Ha a 0.1.7 telepítés `NODE_MODULE_VERSION 137/127` hibával állt le, és ezt
követően `Rollback completed` jelent meg, akkor:

- a Bridge 0.1.7 service és a 003 adatbázis-migráció már aktív lehet;
- a Marveen adapter forrása és `dist` könyvtára visszaállt 0.1.6 állapotra;
- nincs szükség kézi rollbackre vagy adatbázis-visszaállításra;
- a 0.1.8 közvetlenül telepíthető erre az állapotra.

## Telepítés

```bash
cd ~/bela-codex-preflight

sha256sum -c Bela-Codex-Bridge-v0.1.8.tar.gz.sha256

tar -xzf Bela-Codex-Bridge-v0.1.8.tar.gz

cd ~/bela-codex-preflight/bela-codex-bridge-0.1.8

./scripts/install.sh \
  --marveen-root "$HOME/marveen" \
  --restart-bela
```

Az elvárt adapterteszt:

```text
Test Files  7 passed (7)
Tests  61 passed (61)
```

Végső ellenőrzés:

```bash
./scripts/verify-install.sh "$HOME/marveen"
```

Elvárt utolsó sor:

```text
RESULT: Bridge service and Marveen adapter verification passed.
```
