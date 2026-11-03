# Phase 5.2 – önálló imagegen és artifact pipeline

## Cél és határ

A Codex-agent a Codex App Server beépített képalkotó képességével hoz létre
képet. A Marveen forrása, adatbázisa és privát API-ja nem vesz részt a
folyamatban. A Bridge csak a Federation v1 üzenetet kapja, a Codex runtimenak
adja át, majd a végleges képet a saját artifact-tárolójában kezeli.

Az imagegen nem külön agent és nincs külön reasoning effortja. A Terra-agent
reasoning effortja a feladat megértését és a munkafolyamatot vezérli; a képet a
`gpt-image-2` szolgáltatás készíti.

## Folyamat

1. A runtime induláskor meghívja a
   `modelProvider/capabilities/read` App Server metódust.
2. Ha a konfiguráció kötelezővé teszi a képalkotást, de `gpt-image-2` nem
   érhető el, a runtime fail-closed módon nem lesz ready.
3. A Codex imagegen provider adhat workspace-en kívüli staging fájlt. Ez nem
   artifact és nem regisztrálható.
4. A Codex a végleges PNG-t az agent workspace-ébe menti, és ott fejezi be a
   szükséges átméretezést vagy szerkesztést.
5. A modell az aktív run/thread/turn alatt meghívja:

```text
marveen_image_artifact_register(workspaceRelativePath, expectedSha256?)
```

6. A Bridge ellenőrzi a relatív útvonalat, minden útvonalkomponenst, a
   canonical workspace-határt, a fájltípust, méretet, PNG-struktúrát, minden
   chunk CRC-jét, a dimensions/pixel limitet és az opcionális SHA-256-ot.
7. A Bridge egy egyedi artifact ID alá, `0400` móddal lemásolja a bájtokat a
   saját runtime-könyvtárába, majd tartós metaadatrekordot hoz létre.
8. Ha a prompt `$imagegen` feladat, de nincs kész artifact, a run
   `image_artifact_missing` hibával megbukik.
9. Federation inboxból indult runnál az inbox `result_json` artifact receiptet
   is kap. A Federation v1 üzenet tartalma nem változik, ezért a meglévő
   Marveen-szerződés kompatibilis marad.

## Biztonsági invariánsok

- Abszolút, `..`, redundáns és backslash útvonal tiltott.
- Symlink fájl és symlink könyvtárkomponens tiltott.
- A provider workspace-en kívüli staging fájlja soha nem lesz artifact.
- Csak hibátlan PNG fogadható el ebben a fázisban.
- A forrásfájl stabilitását nyitott file descriptor alapján ellenőrizzük.
- Alapértelmezett limit: 20 MiB és 16 777 216 pixel.
- Az immutable másolat visszaolvasáskor újra méret- és SHA-256-ellenőrzést kap.
- Az artifact API kizárólag külön admin bearer tokennel használható.
- A bináris válasz `nosniff`, `sandbox`, `no-store` fejléceket kap.

## API

```text
GET /v1/meta
GET /v1/artifacts
GET /v1/artifacts?runId=:runId
GET /v1/artifacts?agentId=:agentId
GET /v1/artifacts/:artifactId
GET /v1/artifacts/:artifactId/content
```

Az API nem adja vissza a host abszolút fájlrendszer-útvonalát. A
`storedRelativePath` csak a Bridge belső artifact-gyökéréhez viszonyított
azonosító; közvetlen fájlelérésre nem használható.

## Tudatos korlát

Ebben a fázisban nincs külön dashboard, galéria, JPEG/WebP regisztráció,
tömeges generálás vagy Marveenbe ágyazott képnézet. Ezek külön, az önálló
Bridge felületén fejlesztendők, nem Marveen patch formájában.
