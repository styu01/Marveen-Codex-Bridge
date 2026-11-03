# Federation v1 wire contract

## Azonosítók

Egy szegmens:

```regex
^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$
```

Federált cím:

```text
<system>/<agent>
```

Pontosan egy `/` megengedett. Pont, szóköz, Unicode, útvonalrész és további
perjel tiltott.

## Hitelesítés

```http
Authorization: Bearer <peer-specific-token>
```

- minimum 32 karakter;
- a token azonosítja a hívó peert;
- a payload `from` rendszerprefixének egyeznie kell a token peerjével;
- dashboard-, service- és Federation-token nem cserélhető fel.

## GET /api/federation/manifest

Maximális válaszméret a Marveen poller szerint: 512 KiB.

Kötelező válaszmezők:

```json
{
  "system": "codex",
  "marveenVersion": "bridge-0.3.3",
  "federationVersion": 1,
  "agents": [],
  "skills": []
}
```

Korlátok:

- maximum 100 agent;
- maximum 300 skill;
- agent ID szigorú azonosító;
- display name és model legfeljebb 120 karakteres bemenetként kezelendő;
- capability summary maximum 600 karakter;
- skill description maximum 300 karakter;
- manifestbe nem kerülhet token, workspace path, thread ID vagy approvaladat.

## POST /api/federation/inbox

Marveen által küldött payload:

```json
{
  "federationVersion": 1,
  "from": "marveen/bela",
  "to": "programozo",
  "content": "Feladat szövege",
  "ref": "187"
}
```

Korlátok:

- teljes HTTP body maximum 64 KiB;
- `from` federált cím;
- `to` helyi, minősítés nélküli agent ID;
- `content` nem lehet üres;
- `ref` opcionális, maximum 128 karakter;
- a Bridge 0.3.x megköveteli a `federationVersion: 1` értéket.

Siker:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
```

```json
{
  "id": 1,
  "ref": "187"
}
```

Ismételt `(hitelesített peer, ref)`:

```json
{
  "id": 1,
  "ref": "187",
  "duplicate": true
}
```

## Hibakódok

| HTTP | Jelentés |
|---|---|
| 400 | hibás JSON, cím, verzió, tartalom vagy ref |
| 401 | hiányzó/hibás peer token |
| 403 | sender impersonation vagy minősített célcím |
| 404 | ismeretlen Bridge-agent |
| 413 | túl nagy body |
| 500 | belső hiba |

## Kimenő Bridge-válasz a Marveennek

```json
{
  "federationVersion": 1,
  "from": "codex/programozo",
  "to": "bela",
  "content": "A feladat eredménye",
  "ref": "run:<run-id>:reply:v1"
}
```

A célagent kizárólag az eredeti hitelesített `from` agentrésze lehet. A modell
szövege nem választhat címzettet.
