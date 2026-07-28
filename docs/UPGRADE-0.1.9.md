# Frissítés Béla Codex Bridge 0.1.9-re

## Mit változtat?

A 0.1.9 agentenként konfigurálható Codex reasoning effortot ad:

- `medium`: kompatibilis alapérték meglévő agentekhez;
- `high`: ajánlott fejlesztési feladatokhoz;
- `xhigh`: különösen nehéz feladatokhoz, nagyobb késleltetéssel.

Az új SQLite 004 migráció a `bridge_agents` és `codex_threads` táblákat
bővíti. A telepítő a migráció előtt konzisztens adatbázis-backupot készít.

## Telepítés

```bash
cd ~/bela-codex-preflight
sha256sum -c Bela-Codex-Bridge-v0.1.9.tar.gz.sha256
tar -xzf Bela-Codex-Bridge-v0.1.9.tar.gz
cd ~/bela-codex-preflight/bela-codex-bridge-0.1.9

./scripts/install.sh \
  --marveen-root "$HOME/marveen" \
  --restart-bela
```

## Az existing `codex` agent átállítása

A telepítés nem emeli automatikusan a meglévő agent effortját. Ez szándékos:
egy frissítés nem változtathatja meg csendben a futási költséget vagy
viselkedést.

1. Nyisd meg a Codex agent beállításait.
2. Válaszd a `High` gondolkodási szintet.
3. Mentsd a modellbeállítást.
4. A dashboard újraindítja a Codex agentet.
5. A következő run új threadben indul.

## Kötelező ellenőrzés

```bash
./scripts/verify-install.sh "$HOME/marveen"
```

Az agent API-ban ezeknek kell megjelenniük:

```json
{
  "reasoningEffort": "high",
  "thread": {
    "reasoningEffort": "high"
  }
}
```

A thread mező csak az első, új efforttal sikeresen elindított run után vált
`high` értékre.
