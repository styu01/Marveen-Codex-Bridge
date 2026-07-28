# Frissítés Béla Codex Bridge 0.1.6-ra

A 0.1.6 a felhasználó gépén reprodukált Codex App Server 0.145.0 hibát kerüli
meg. Az App Server ugyanazon a threaden késznek jelezte a `bela` MCP szervert,
és az `mcpServerStatus/list` mind a négy toolt felsorolta, a modell turnje mégsem
kapta meg őket. Ez nem Bridge-konfigurációs vagy MCP-startup hiba volt, hanem az
MCP inventory és a modellnek átadott toolset közötti exposure-rés.

## Javított végrehajtási út

Az MCP szerver és a run előtti inventory gate megmarad. Emellett a Bridge a
négy Béla-funkciót a Codex App Server kísérleti, 0.145.0 sémában ellenőrzött
`dynamicTools` mezőjében is átadja a `thread/start` kérésnek:

- `bela_agent_message_send`;
- `bela_agent_message_status`;
- `bela_memory_search`;
- `bela_memory_get`.

Ha a modell használ egy ilyen eszközt, az App Server `item/tool/call`
szerverkérést küld a Bridge-nek. A Bridge csak akkor hajtja végre, ha:

- a run még aktív;
- a `threadId` és `turnId` pontosan egyezik;
- a kérés névtere üres;
- a tool a négyelemű allowlist része;
- az agent saját HMAC capability tokenje olvasható.

A Bridge ezután ugyanazt a szűk Marveen façade API-t hívja, amelyet az MCP
szerver is használ, majd `DynamicToolCallResponse` formában visszaadja az
eredményt az App Servernek. A küldő agent azonosítója továbbra sem írható felül.

## Egyszeri thread-váltás

A Codex 0.145.0 `ThreadStartParams` tartalmaz `dynamicTools` mezőt, a
`ThreadResumeParams` viszont nem. Emiatt egy 0.1.5 alatt létrehozott threadhez
nem lehet utólag biztonságosan hozzáadni a dinamikus eszközöket.

A 0.1.6 adatbázis-migráció tool-contract revisiont vezet be. Az első új run
felismeri a régi, revision 0 thread-kötést, invalidálja azt, és új threadet
indít revision 1 szerződéssel. A régi Codex rollout fájl nem törlődik. A
további Bridge-restartok már az új threadet folytatják.

## Telepítés

```bash
cd ~/bela-codex-preflight

sha256sum -c Bela-Codex-Bridge-v0.1.6.tar.gz.sha256
tar -xzf Bela-Codex-Bridge-v0.1.6.tar.gz

cd bela-codex-bridge-0.1.6

./scripts/install.sh \
  --marveen-root "$HOME/marveen" \
  --restart-bela
```

Az adapter forrása nem változik a 0.1.5-höz képest, de a telepítő továbbra is
ellenőrzi és aktiválja a megfelelő Marveen buildet. A Bridge token, agentek,
queue, run history és callback outbox megmarad.

## Kötelező élő D teszt

Az első run után a journalban ennek kell megjelennie:

```text
Codex thread tool contract changed; creating replacement thread
Required Béla MCP server ready
Béla dynamic tool completed
```

A Codex-agent kapja ezt a feladatot:

```text
Hívd meg a bela_agent_message_send eszközt pontosan egyszer. Címzett: bela.
Tartalom: CODEX_DYNAMIC_TOOL_016_OK. Ezután a visszakapott id-val hívd meg a
bela_agent_message_status eszközt, és add vissza röviden a státuszt.
```

PASS feltételek:

1. a `CODEX_DYNAMIC_TOOL_016_OK` üzenet pontosan egyszer jelenik meg Bélánál;
2. a status tool ugyanazt az üzenetet találja meg;
3. a run eseményei között két sikeres `dynamic_tool_completed` szerepel;
4. nincs `dynamic_tool_identity_mismatch`, `dynamic_tool_unknown` vagy
   `[codex-bridge-failure]`;
5. Bridge-restart után egy új normál run ugyanazt az új thread ID-t folytatja.
