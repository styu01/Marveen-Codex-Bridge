# Marveen Codex Bridge 0.3.3 — modellbővítés (candidate-r3)

**Állapot:** helyi, offline ellenőrzött candidate. NINCS éles rendszerre telepítve; a valós OpenAI/Codex-account, a célgép adatbázisa, az új CLI protokollja és a Marveen Federation élő útvonala itt nem volt vizsgálható. A teljes telepítési tesztcsomag a célgépen kötelező.

## Modellek és kompatibilis effortok

| Modell | Értelmezés | Dashboard-effort |
|---|---|---|
| `gpt-5.6-terra` | eredeti, megtartva | low, medium, high, xhigh |
| `gpt-5.6-sol` | eredeti, megtartva | low, medium, high, xhigh |
| `gpt-6-sol` | új, opcionális | none, low, medium, high, xhigh, max |
| `gpt-6-luna` | új, opcionális | none, low, medium, high, xhigh, max |
| `gpt-6.1-sol` | új, ajánlott normál mód | low, medium, high, xhigh, max |
| `gpt-6-astra` | új, nehéz/kritikus munka | low, medium, high, xhigh, max |

A dashboard az `allowedModels` és az élő Codex App Server `model/list` metszetét kínálja fel. Az új modellek csak akkor választhatók, ha az adott ChatGPT-fiókban ÉS az adott Codex CLI-ben elérhetők. Az új állomány semmit sem ír át automatikusan a kiválasztott `agents[0].model`, `reasoningEffort`, szerepkör, sandbox-, approval- és hálózati beállításokon.

## Kiemelt megkötés: két külön Codex CLI

A 0.3.2 eredeti CLI-je `0.145.0`. A 0.3.3 a `0.164.0` verziót kéri, amelyet **külön, új telepítési könyvtárba** kell feltenni. Ha felülírod a régit, a 0.3.2 rollback nem tekinthető biztonságosnak.

A WSL Ubuntu shellben a Node `v22.23.1` használatával:

```bash
NODE="$HOME/.nvm/versions/node/v22.23.1/bin/node"
"$NODE" --version
mkdir -p "$HOME/.local/opt/codex-cli-0.164.0"
PATH="$(dirname "$NODE"):$PATH" "$(dirname "$NODE")/npm" install --prefix "$HOME/.local/opt/codex-cli-0.164.0" --no-audit --no-fund @openai/codex@0.164.0
# Explicit Node interpreter for the systemd user service (avoids relying on PATH).
NEW_CODEX="$HOME/.local/opt/codex-cli-0.164.0/codex-bridge"
cat > "$NEW_CODEX" <<'LAUNCHER'
#!/usr/bin/env bash
exec "$HOME/.nvm/versions/node/v22.23.1/bin/node" \
  "$HOME/.local/opt/codex-cli-0.164.0/node_modules/@openai/codex/bin/codex.js" "$@"
LAUNCHER
chmod 0700 "$NEW_CODEX"
"$NEW_CODEX" --version
"$NEW_CODEX" login status
```

A letöltött `tar.gz`, az ellenőrzőösszeg és a külön telepítő script legyen egy könyvtárban. A telepítéshez (ellenőrzés után):

```bash
cd ~/bridge-upgrade
sha256sum -c Marveen-Codex-Bridge-v0.3.3-candidate.tar.gz.sha256
bash install-Marveen-Codex-Bridge-v0.3.3-candidate.sh \
  ./Marveen-Codex-Bridge-v0.3.3-candidate.tar.gz \
  "$HOME/.local/opt/codex-cli-0.164.0/codex-bridge"
```

A telepítő preflightot, SHA-256 ellenőrzést, a régi és az új CLI kompatibilitását, az új modellek láthatóságát, a régi modellek megtartását, privát backupot, a teljes csomag mock tesztkapuját, új service readiness ellenőrzést és szükség esetén rollbacket futtat. A korábbi release-t nem törli, a Marveen forrását nem módosítja.

**Sikeres telepítés után:** `http://127.0.0.1:3431/dashboard` → modellválasztó. Kezdetben hagyd a régi modellt és effortot, ellenőrizd az előzményeket, majd csak külön döntéssel válts `gpt-6.1-sol` / `medium` értékre. A váltás előtt legyen lezárva az aktív feladat és az approval.

## Tesztelés és korlátok

- Offline tesztek: Node egységtesztek, mock Codex app-server modellkatalógus, migráció változatlansága és hibás bemenetek elutasítása, modellek és effortok mátrixa.
- Az archívum és telepítő fájlja SHA-256-tal védett.
- **Nem állítható**, hogy a GPT-6.1 Sol valóban válaszol az adott accounton, vagy hogy a Codex CLI 0.164 protokoll minden érintett pontja kompatibilis, amíg élő WSL teszt nem történt.
- A régi `production-canary-0.3.3.mjs --execute` a Terra → régi Sol → Terra legacy útra épül. Nem szabad futtatni, ha már más modell az aktív; a fő telepítő nem futtat mutáló canary-t.

## r2 javítás (2026-10-25)

Az első candidate a migrációnál hibázott, ha a 0.3.2 konfigurációban
hiányzott a `codex.allowedModels`, noha ez a 0.3.2-ben érvényes
beállítás volt (alapértelmezés: Terra + Sol). Az r2 ezt kijavítja:
hiányzó vagy `null` lista esetén az eredeti 0.3.2 alapmodellsort veszi,
egyénileg megadott lista esetén minden korábbi elemet megtart és
hozzáadja a hiányzó korábbi, valamint az új modelleket.
Hibás listát továbbra is elutasít. Az aktív modell és jogosultságok nem módosulnak.

Ez a csomag az ismert Marveen `1.34.1`-hez kötött külső telepítőt
használja, de az élő integrációt a helyi tesztek nem tudják igazolni.
A sikertelen első candidate telepítése a konfiguráció migrálása előtt
megállt, így nem igényel előzetes rollbacket.

## r3 javítás (2026-10-25)

Az r2 csomagból hiányzott a `scripts/production-canary-0.3.3.mjs`,
noha a `verify-phase7.sh` kötelezően megkövetelte. A fájl az r2-ben
`production-canary-0.3.2.mjs` néven volt benne, miközben tartalma
már a 0.3.3 Bridge-et vizsgálta. Az r3 átnevezi az elvárt névre,
és a read-only/--execute canary alapértelmezett Marveen-verzióját
`1.34.1`-re frissíti. A canary **nem fut automatikusan**,
és a `--execute` valós szolgáltatás- és modellmódosítást végezhet.

A teljes tesztcsomag 138 tesztdefiníciót tartalmaz a 0.3.3 modelltesztekkel
együtt. Az r2-ben bent maradt 130-as küszöb hibás volt, így a verifier
és az azt tesztelő regressziós állítások 138-ra frissültek.
Az r3 külső telepítő már a mutáció előtt ellenőrzi az elvárt canary
állományt, szintaxist és a tesztdefiníciók darabszámát.

**Fontos:** a már telepített 0.3.2-hez és a Marveen forrásához
a csomagépítés nem nyúlt. Éles validáció továbbra is kötelező.
