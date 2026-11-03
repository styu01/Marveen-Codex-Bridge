# Phase 3 fejlesztői architektúra

## Határ

A Phase 3 egy külön Node.js folyamat. Nem importál Marveen belső modulokat,
nem olvassa vagy módosítja a Marveen SQLite-adatbázisát, nem indít Claude/tmux
agentet, és nem patch-el Marveen-forrást.

Marveen kizárólag a publikus Federation v1 HTTP-szerződésen keresztül peer:

- Marveen küld: `POST /api/federation/inbox`;
- a Bridge hirdeti az agenteket: `GET /api/federation/manifest`;
- a Bridge válaszol Marveen saját Federation inbox végpontjára.

## Adatút

1. A peer bearer token azonosítja Marveent.
2. A Bridge validálja a Federation címezést és tartósan beszúrja az inbox
   rekordot.
3. A runtime worker lease-t szerez az inbox rekordra.
4. A runtime adapter stabil `federation-inbox-<id>` idempotenciakulccsal indít
   Codex-futást.
5. A kész válasz és az outbox-rekord egyetlen SQLite-tranzakcióban rögzül.
6. A delivery worker lease-t szerez, majd a peer saját bearer tokenjével elküldi
   a választ.
7. Átmeneti hiba retry/backoff, terminális hiba dead-letter állapot.

## Folyamat- és adatizoláció

| Elem | Tulajdonos | Marveen-hozzáférés |
|---|---|---|
| Federation Bridge folyamat | külön systemd user service | csak HTTP |
| Federation SQLite | Bridge saját state könyvtára | nincs |
| Admin token | Bridge saját config könyvtára | nincs |
| Peer tokenek | külön, 0600 fájlok | Federation HTTP |
| Runtime modul | Bridge release | nincs Marveen import |
| Marveen forrás és adatbázis | Marveen | Bridge nem írja |

## Tartóssági modell

- Inbox deduplikáció: `(peer_id, peer_ref)`.
- Outbox deduplikáció: `(peer_id, message_key)`.
- Stabil válaszkulcs: `inbox:<inboxId>:reply:v1`.
- SQLite: WAL, `synchronous=FULL`, foreign keys, migrációs checksum.
- Worker crash: a lejárt lease újra felvehető.
- Runtime crash/commit-rés: a stabil runtime idempotenciakulcs akadályozza meg a
  második modellfuttatást.
- Külső HTTP kézbesítés: tartós at-least-once. A fogadó peernek a `ref` alapján
  deduplikálnia kell.

## Hitelesítési tartományok

Három külön titok szükséges:

- admin API token;
- Marveen → Bridge inbound Federation token;
- Bridge → Marveen outbound Federation token.

Ezek nem lehetnek azonosak. A konfiguráció és minden tokenfájl csak a service
user számára olvasható, nem lehet symlink. A listener csak loopback címre
köthető. Nem-loopback peer kizárólag HTTPS lehet.

## Runtime adapter szerződés

A `MARVEEN_CODEX_BRIDGE_RUNTIME_MODULE` abszolút, symlinkmentes modulútvonal.
A modulnak `createRuntime(context)` függvényt kell exportálnia, amely az alábbi
interfészt adja:

```js
{
  isReady(): boolean,
  manifestAgents(): AgentManifest[],
  run({
    agentId,
    prompt,
    context,
    idempotencyKey
  }): Promise<{ runId: string, response: string }>
}
```

Opcionális életciklus: `start()` és `stop()`.

A Phase 3 mock adapterrel bizonyítja az orchestrationt. A valódi Codex App
Server adapter külön Phase 4 feladat; a Phase 3 csomagot ezért még nem szabad
éles szolgáltatásként aktiválni.

## Admin végpontok

| Végpont | Cél |
|---|---|
| `GET /healthz` | process él |
| `GET /readyz` | adatbázis és runtime ready |
| `GET /v1/meta` | verzió, agentek, titokmentes config |
| `GET /v1/inbox[?state=]` | inbox állapot |
| `GET /v1/outbox[?state=]` | outbox állapot |
| `GET /v1/outbox/:id/events` | kézbesítési audit |
| `POST /v1/workers/tick` | kontrollált admin worker tick |

Az admin végpontok bearer tokent igényelnek. A health/readiness nem ad vissza
titkot vagy üzenettartalmat.

## Következő kapu

Phase 4 csak akkor kezdhető, ha a Phase 3 WSL-verifier 65/65 PASS eredményt ad.
Phase 4-ben kell a valódi `codex app-server --stdio` runtime adapter, thread/run
perzisztencia, approval és image artifact pipeline. A saját dashboard és az
üzemi migráció későbbi fázis; a Phase 3 systemd fájl csak előkészítő sablon.
