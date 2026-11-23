# Marveen Codex Bridge 0.3.5 candidate – új GPT-6 modellek

## Kiindulási helyzet

Bridge 0.3.4.1, Node v22.23.1, Codex CLI 0.164.0, 45 perces turn timeout és runtime bérlet.
A kiválasztott `gpt-6.1-sol / medium` **nem változik meg automatikusan**.

## Új modellek

- `gpt-6.1-terra` – none, low, medium, high, xhigh, max
- `gpt-6.2-sol` – low, medium, high, xhigh, max
- `gpt-6.2-astra` – low, medium, high, xhigh, max

A meglévő 6 modell megmarad az engedélyezési listában. A Dashboard csak azokat kínálja fel, amelyeket a Codex App Server `model/list` aktuálisan visszaad a bejelentkezett fióknak. A régi modellek némelyike idővel eltűnhet a szolgáltatói listából; a helyi listától nem válnak automatikusan elérhetővé.

## Codex CLI

Külön telepítendő a **stabil 0.171.0**; a 0.164.0 binárist **kötelező megőrizni**. Visszaállításkor a korábbi konfiguráció a régi CLI-t használja.

## Megőrzött működés

- `codex.turnTimeoutMs = 2700000` (45 perc)
- `workers.runtimeLeaseMs = 2700000` (45 perc)
- Lease heartbeat legfeljebb 30 másodpercenként
- Sandbox, developer instructions, jóváhagyás, Federation, tokenek, aktív modell és reasoning változatlan
- A korábbi 0.3.4.1 release/konfiguráció mentése és visszaállítási útvonal megmarad

## Kiadhatóság és ellenőrzési korlát

A GitHub Actions futtatja a teljes automatikus tesztcsomagot. A kiadás csak akkor tekinthető éles használatra ellenőrzöttnek, ha a cél WSL-rendszerben a 0.171.0 CLI tényleges `model/list` eredményével, egy rövid read-only Codex-futással, az összes érvényes modell–effort kombináció kezelésével, és a Marveen → Bridge → Codex → Marveen próbával is megfelel.

A 45 perces időkorlát **nem garancia**: az approval külön időkorlátú, illetve a provider hibái továbbra is fennállhatnak.
