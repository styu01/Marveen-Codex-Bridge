# Aktuális verifikációs kapu

A jelenlegi kiadás egyetlen támogatott, összesített kapuja:

```bash
./scripts/verify-phase7.sh [opciók]
```

A `verify-phase2.sh`, `verify-phase3.sh`, `verify-phase4.sh` és
`verify-phase5.sh` korábbi fejlesztési checkpointokhoz tartoztak. Verzió- és
tesztszám-feltételeik a későbbi release-ekre nem érvényesek, ezért a jelenlegi
ágon szándékosan hibával leálló deprecation stubok.

## Mock és valós kapu

A kizárólag lokális, mock szolgáltatásokat használó regresszió:

```bash
./scripts/verify-phase7.sh --mock-only \
  --node-bin /abszolut/ut/node \
  --better-sqlite3-path /abszolut/ut/node_modules/better-sqlite3
```

A valós Codex App Server-, approval-, Federation tool- és imagegen-kapu:

```bash
./scripts/verify-phase7.sh \
  --node-bin /abszolut/ut/node \
  --better-sqlite3-path /abszolut/ut/node_modules/better-sqlite3 \
  --codex-bin /abszolut/ut/codex \
  --expected-codex-version VERSION \
  --model MODELL \
  --real-output-root /privat/kimeneti/konyvtar
```

A valós kapu disposable adatbázisokat és loopback teszt-peert használ. Nem
helyettesíti a telepített systemd service readiness-, restart-, rollback- és
Marveen → Codex → Marveen production canary ellenőrzését.

## Telepített 0.3.3 production canary

Az aktivált Bridge és a Marveen 1.34.1 ellen először read-only preflightot,
majd explicit `--execute` kaput kell futtatni:

```bash
"$HOME/.nvm/versions/node/v22.23.1/bin/node" \
  scripts/production-canary-0.3.3.mjs

"$HOME/.nvm/versions/node/v22.23.1/bin/node" \
  scripts/production-canary-0.3.3.mjs --execute
```

Elvárt zárás:

```text
RESULT: 0.3.3 WSL SYSTEMD MODEL SELECTION AND MARVEEN 1.34.1 CANARY PASS
```
