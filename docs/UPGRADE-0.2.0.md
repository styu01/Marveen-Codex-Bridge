# Frissítés Béla Codex Bridge 0.2.0-ra

A 0.2.0 a 0.1.9 agentenkénti reasoning effort funkcióját megtartja, és
hozzáadja a Codex beépített `gpt-image-2` képgenerálását:

- ChatGPT-előfizetéses Codex auth, külön API-kulcs nélkül;
- provider capability probe;
- workspace-be zárt, SHA-256-tal ellenőrzött képartifactok;
- run/artifact API;
- callback-integráció;
- hitelesített Marveen dashboard-előnézet.

Telepítés:

```bash
cd ~/bela-codex-preflight
sha256sum -c Bela-Codex-Bridge-v0.2.0.tar.gz.sha256
tar -xzf Bela-Codex-Bridge-v0.2.0.tar.gz
cd ~/bela-codex-preflight/bela-codex-bridge-0.2.0
./scripts/install.sh \
  --marveen-root "$HOME/marveen" \
  --restart-bela
```

A telepítő aktív Codex run mellett nem frissít. Migráció előtt konzisztens
SQLite backupot készít, majd alkalmazza a `005_image_artifacts.sql` migrációt.
A 0.1.9 Marveen adaptert pontos baseline hash és patch dry-run után frissíti.
Build vagy teszthiba esetén a Marveen forrást és a teljes korábbi `dist`
könyvtárat automatikusan visszaállítja.

Sikeres telepítés után:

```bash
./scripts/verify-install.sh "$HOME/marveen"
```

A verifier csak akkor ad PASS eredményt, ha a futó App Server
`imageGeneration: true` capability-t jelent.

Első élő teszt:

```text
$imagegen Készíts egy eredeti, 1024×1024-es absztrakt kék-türkiz
szoftveres illusztrációt, szöveg és ember nélkül. Mentsd
assets/codex-image-smoke.png néven, majd válaszolj a relatív útvonallal.
```

Elfogadás:

1. a Codex run `succeeded`;
2. pontosan egy `ready` image artifact tartozik hozzá;
3. a fájl az agent workspace-én belül létezik;
4. a dashboard beszélgetésben megjelenik az előnézet;
5. nincs `image_artifact_rejected`, Claude/tmux fallback vagy duplikált válasz.
