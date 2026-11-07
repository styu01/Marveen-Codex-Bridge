# Marveen Codex Bridge 0.3.4.1 – 45 perces időkeretek

## Javítás

A 0.3.4-ben a Codex-turn alapértelmezett időkorlátja még 900 000 ms (15 perc) volt, miközben a runtime lease 1 800 000 ms (30 perc). A 0.3.4.1 mindkét értéket 2 700 000 ms-ra (45 perc) módosítja a forrásban, mintakonfigurációban és az éles telepítési migrációban.

A heartbeat továbbra is 30 másodpercenként újítja meg a bérletet, amíg a worker aktív.

## Fontos határok

- A 45 perc **nem** végtelen futásidő. Ezen túl a Bridge `turn/interrupt` üzenetet küldhet.
- A jóváhagyásra várakozás a Codex-turn 45 perces idejébe beleszámít. A `codex.approvalTimeoutMs` külön, változatlanul 5 perc alapértelmezett érték.
- A 45 perces bérlet nem véd az összeomlás, hálózati kapcsolatvesztés, model-limit vagy elhúzódó szolgáltatásleállás ellen.
- A kiadás candidate: a valós, hosszú Marveen → Bridge → Codex → Marveen E2E teszt külön szükséges.

## Telepítési biztonság

- Előfeltétel: aktív Bridge 0.3.4, Node v22.23.1, Codex CLI 0.164.0 és működő Marveen Federation kapcsolat.
- Aktív feladat, függő jóváhagyás vagy lefoglalt üzenet mellett a telepítő leáll.
- Mentés készül a régi konfigurációról, systemd unitról, release-symlinkről; hibánál automatikus rollback-próba.
- Az élesítés kizárólag a csomag ellenőrzése, migrációja és **157/157** automatizált teszt után történik.
- A már működő 0.3.4 és a rollback-mentés megmarad.

## Ellenőrzés az élesítés után

```bash
curl -fsS http://127.0.0.1:3431/readyz
node -e 'const c=require(process.env.HOME+"/.config/marveen-codex-bridge/config.json"); console.log(c.codex.turnTimeoutMs,c.workers.runtimeLeaseMs)'
systemctl --user is-active marveen-codex-bridge.service
```

Elvárt: `0.3.4.1`, `ready`, `2700000 2700000`, `active`. Utána kontrollált, nem kritikus Codex-feladat és visszajelzés-ellenőrzés szükséges.
