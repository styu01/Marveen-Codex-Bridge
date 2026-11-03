# Federation durability contract v1

## Garanciák

- A Bridge inbox deduplikációja tartós SQLite-adat.
- Azonos `(peer_id, peer_ref)` és azonos payload ugyanazt az inbox rekordot
  adja vissza.
- Azonos `(peer_id, peer_ref)` eltérő payloaddal `idempotency_conflict`.
- Az outbox `(peer_id, message_key)` párja tartósan egyedi.
- A kézbesítés at-least-once: sikertelen vagy megszakadt próbálkozás után
  ugyanaz a payload és `ref` újraküldhető.
- Egy outbox rekordot egy időben csak egy érvényes lease birtokolhat.
- Lejárt lease újra felvehető Bridge-összeomlás vagy workerhalál után.
- `delivered` és `dead` terminális állapot.
- Minden kézbesítési állapotváltás audit eseményt kap.

## Nem vállalt garancia

End-to-end exactly-once kézbesítés nem állítható. A Marveen 1.25.1 Federation
inbox deduplikációja process-memory alapú. Ha a Marveen a sikeres HTTP-válasz
után újraindul, miközben a Bridge még nem rögzítette a sikert, az ismételt
küldés új Marveen-üzenetet hozhat létre.

Ennek csökkentése:

- stabil `peer_ref`;
- stabil `message_key`;
- idempotens Bridge-oldali enqueue;
- rövid, de nem nulla lease;
- minden válasz és hiba auditálása.

## SQLite tartósság

- WAL journal;
- `synchronous=FULL`;
- foreign keys bekapcsolva;
- `busy_timeout=5000`;
- sémafrissítés `BEGIN IMMEDIATE` tranzakcióban;
- migrációs fájl SHA-256 lenyomata tartósan tárolva;
- már alkalmazott migráció eltérő tartalommal nem indulhat el.

## Retry osztályozás

Retry:

- hálózati/timeout hiba;
- HTTP 401, 408, 425, 429;
- HTTP 5xx.

Terminális:

- minden egyéb HTTP 4xx;
- `maxAttempts` elérése.

Backoff:

```text
min(maxDelayMs, initialDelayMs × 2^(attempt-1)) + jitter
```

A jitter injektálható, ezért a teszt determinisztikus.
