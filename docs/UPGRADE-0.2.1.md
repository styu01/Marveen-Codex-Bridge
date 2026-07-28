# Frissítés Béla Codex Bridge 0.2.1-re

## Miért szükséges?

A 0.2.0 helyesen ellenőrizte, hogy csak az agent workspace-én belüli kép
lehessen artifact, de túl korán véglegesnek tekintette az App Server
`imageGeneration.savedPath` eseményét. A Codex beépített imagegenje először
egy provider-staging fájlt hozhat létre a `~/.codex/generated_images`
könyvtárban, majd a Codex ezt bemásolja, átméretezi vagy szerkeszti a kért
workspace-fájlba. Emiatt egy ténylegesen elkészült kép mellett is
`image_artifact_invalid` hibával zárulhatott a Bridge run.

## A 0.2.1 megoldása

- A workspace-en kívüli provider-staging esemény nem artifact és nem okoz
  azonnali futáshibát.
- Az új `bela_image_artifact_register` dynamic tool az aktív
  run/thread/turn/agent identitásához kötve fogadja a végleges fájl relatív
  útvonalát.
- Abszolút, üres, túl hosszú, NUL-karakteres, feloldhatatlan, workspace-en
  kívüli, symlink, nem normál, túl nagy vagy nem valódi PNG/JPEG/WebP fájl
  elutasításra kerül.
- A Bridge a végleges fájlból számítja a SHA-256-ot és a byte-méretet.
- Ugyanazon run és canonical végleges útvonal ismételt regisztrációja
  idempotens.
- Imagegen eseményt tartalmazó vagy `$imagegen`-t kérő run nem lehet sikeres
  legalább egy regisztrált végleges artifact nélkül.
- A négy meglévő Béla MCP-tool változatlan. A képartifact-regisztráló tool
  csak az App Server dinamikus toolsetjében jelenik meg.

Ez a dynamic tool contract revision 2. A 0.2.0-ról történő első agent-run
egyszer új Codex threadet hoz létre, mert a Codex 0.145.0 `thread/resume`
hívásába nem adható utólag új dynamic tool. Az adatbázis, a régi thread
rolloutja és az agent konfigurációja nem törlődik.

## Telepítés

```bash
cd ~/bela-codex-preflight

sha256sum -c Bela-Codex-Bridge-v0.2.1.tar.gz.sha256
tar -xzf Bela-Codex-Bridge-v0.2.1.tar.gz

cd ~/bela-codex-preflight/bela-codex-bridge-0.2.1

./scripts/install.sh \
  --marveen-root "$HOME/marveen" \
  --restart-bela
```

A Marveen adapter forrása a 0.2.0-val azonos revision 4 marad. A telepítő
hash-ekkel ellenőrzi, hogy ez már telepítve van; szükségtelenül nem patcheli
újra.

## Kötelező telepítés utáni ellenőrzés

```bash
./scripts/verify-install.sh "$HOME/marveen"
```

Az elvárt metaadat:

- `bridgeVersion === "0.2.1"`;
- `toolContract.revision === 2`;
- öt dynamic tool, köztük `bela_image_artifact_register`;
- négy `mcpTools`, a regisztráló tool nélkül;
- `codex.imageGeneration.available === true`.

## Éles képteszt Bélának

Küldendő feladat a Codex-agentnek:

```text
$imagegen Készíts egy eredeti, négyzetes, sötétkék és türkiz technológiai
illusztrációt felirat nélkül. A végleges kép pontosan 1024×1024 PNG legyen.
Mentsd az assets/bridge-image-021-smoke.png fájlba. A generálás és minden
átméretezés után regisztráld a végleges workspace-fájlt, majd add vissza a
relatív útvonalát, méretét és SHA-256 értékét. Ne állíts sikert, ha az
artifact-regisztráció nem sikerült.
```

Elfogadási feltételek:

1. a Bridge run `succeeded`;
2. pontosan egy `ready` artifact tartozik hozzá;
3. `workspaceRelativePath === "assets/bridge-image-021-smoke.png"`;
4. az API MIME-ja `image/png`;
5. a fájl valóban 1024×1024;
6. az API és a fájl SHA-256 értéke egyezik;
7. van `image_provider_staging_observed` esemény, ha a provider külső staging
   fájlt használt;
8. van sikeres `dynamic_tool_completed` esemény
   `bela_image_artifact_register` toolnévvel;
9. nincs `image_artifact_rejected`, Claude/tmux fallback vagy duplikált
   artifact.

