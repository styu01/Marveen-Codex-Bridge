# Béla Codex Bridge 0.1.4

## Működési szerződés, architektúra és tesztkézikönyv Béla számára

**Dokumentum állapota:** aktuális a 2026-07-28-án telepített rendszerhez  
**Bridge verzió:** 0.1.4  
**Marveen/Béla verzió:** 1.21.1  
**Codex CLI:** 0.145.0  
**Codex modell:** `gpt-5.6-terra`  
**Bridge Node:** 22.23.1  
**Béla alapértelmezett Node:** 24.16.0  
**Hitelesítés:** ChatGPT-előfizetésen keresztüli Codex login

---

## 1. A dokumentum célja

Ez a dokumentum a Béla főagent és a rendszert karbantartó fejlesztő számára
írja le a Codex Bridge 0.1.4 tényleges működését. Nem fejlesztési terv és nem
marketinganyag: a telepített forráskód működési szerződése.

Béla ennek alapján legyen képes:

1. megérteni, hol helyezkedik el a Bridge a rendszerben;
2. megkülönböztetni a Claude- és Codex-agentek futási modelljét;
3. végigkövetni egy Codex-agent létrehozását, indítását és egy üzenet teljes
   életciklusát;
4. helyesen értelmezni az agent-, run-, thread-, approval- és callback
   állapotokat;
5. biztonságosan diagnosztizálni a Bridge-et;
6. végrehajtani a kötelező működési teszteket;
7. felismerni azokat a helyzeteket, amelyekben nem szabad automatikusan
   újrapróbálni vagy kézzel adatbázist módosítani;
8. egy későbbi Marveen- vagy Codex-frissítés előtt felmérni, milyen
   kompatibilitási ellenőrzések szükségesek.

### 1.1 Jelenleg igazolt állapot

Az alábbiak már igazoltak a tényleges WSL gépen:

- a 0.1.4 csomag SHA-256 ellenőrzése sikerült;
- a 0.1.2 Marveen-adapterről 0.1.4-re történő inkrementális frissítés sikerült;
- a Marveen TypeScript typecheck sikerült;
- a dashboard JavaScript syntax-check sikerült;
- az adapter céltesztjei: **58/58 PASS**;
- a Marveen production build (`npm run build`, `tsc`) sikerült;
- a telepítő a lefordított `dist` Codex hookjait ellenőrizte;
- a Bridge service-verifikáció sikerült;
- a Codex CLI ChatGPT-logint a service látja;
- a `gpt-5.6-terra` modell elérhető;
- a privát Unix socket és a Codex App Server ready állapotban van;
- egy új Codex-agent létrehozási folyamata végigfutott;
- a Codex-agent létrehozása már nem indít Claude-generátort és nem akad meg a
  `CLAUDE.md generálás...` képernyőn.

**Még külön élő tesztelendő:** a teljes Béla → Codex run → callback → Béla
válaszút, az MCP-eszközök, az approval, a queue-helyreállás és a thread resume.

---

## 2. Rövid működési szerződés

A Codex Bridge nem Claude-kompatibilis API-emulátor, nem Anthropic proxy, nem
Ollama endpoint és nem tmux-agent.

A helyes működési modell:

- Béla marad a főagent és a felhasználói felület tulajdonosa.
- A Marveen adapter provider alapján választ Claude vagy Codex végrehajtót.
- A Claude-agent továbbra is a meglévő tmux + Claude Code útvonalon fut.
- A Codex-agentet a dashboard nem indítja el tmuxban.
- A Codex-agentet a külön `bela-codex-bridge.service` kezeli.
- A Bridge egyetlen felügyelt `codex app-server --stdio` folyamatot tart fenn.
- Minden Codex-agenthez külön tartós Codex thread, külön runtime-könyvtár,
  külön AGENTS.md és külön agent-scope-olt MCP-token tartozik.
- A Marveen és a Bridge privát Unix socketen, bearer tokennel kommunikál.
- Az agentüzenet Bridge runná alakul.
- A run befejezése után a Bridge tartós outboxból hitelesített callbacket küld
  Marveennek.
- Marveen a callback alapján tranzakcióban lezárja az eredeti üzenetet és
  létrehozza a Codex válaszüzenetét.

---

## 3. Rendszerarchitektúra

```mermaid
flowchart TD
  UI["Béla dashboard / főagent"] --> MA["Marveen 1.21.1 adapter"]
  MA -->|"HTTP Unix socket + master bearer"| BR["Codex Bridge 0.1.4"]
  BR -->|"JSONL RPC stdio"| AS["Codex App Server 0.145.0"]
  AS --> TH["Agentenként külön Codex thread"]
  TH -->|"agent-scope-olt MCP stdio"| MF["Béla MCP facade"]
  MF -->|"HTTP + HMAC agent token"| MA
  BR -->|"tartós outbox callback"| MA
```

### 3.1 Folyamatok

| Folyamat | Feladat | Node | Indítás |
|---|---|---:|---|
| Béla/Marveen dashboard | UI, agentkonfiguráció, üzenetrouter, callback, MCP facade | 24.16.0 | `~/marveen/scripts/bela-start.sh` |
| Bridge service | API, SQLite, queue, run engine, supervisor, outbox | 22.23.1 | systemd user service |
| Codex App Server | Codex thread/turn végrehajtás | Codex saját binárisa | Bridge child process |
| Agent MCP server | agentüzenet és memória facade | a Bridge `process.execPath` értéke, Node 22 | Codex thread kötelező MCP-je |

### 3.2 Folyamatszintű izoláció

A Bridge és Béla külön Node-verziót használ. Ez szándékos:

- Béla alapértelmezett környezete Node 24;
- a Bridge systemd unitja abszolút útvonallal Node 22.23.1-et indít;
- a Bridge nem írja át Béla `PATH`, NVM vagy Node beállításait;
- a Codex bináris abszolút útvonala
  `/home/kisss/.local/bin/codex`;
- a Bridge-frissítés nem telepít új Node-verziót Béla számára.

### 3.3 Ami nincs a rendszerben

Codex-agent esetén nem lehet:

- Claude tmux sessionre támaszkodni;
- `ANTHROPIC_BASE_URL` alapján működést megállapítani;
- Claude Code login- vagy API-kulcsot kérni;
- a Claude pane tartalmából Codex-státuszt olvasni;
- Claude auto-restartot, model fallbacket vagy context guardot futtatni rá;
- a Codex agentet közvetlenül `startAgentProcess()` útvonalon indítani.

Ha Codex-agenthez `agent-<név>` tmux session jön létre, az regresszió.

---

## 4. Telepítési és futási fájlrendszer

### 4.1 Bridge release

```text
~/.local/share/bela-codex-bridge/
├── current -> releases/0.1.4
├── releases/
│   └── 0.1.4/
│       ├── dist/
│       ├── migrations/
│       ├── node_modules/
│       ├── config/
│       ├── package.json
│       └── bridge-lock.json
└── agents/
    └── <agent-id>/
        ├── AGENTS.md
        ├── runtime.json
        ├── .codex/config.toml
        └── secrets/mcp-token
```

Jogosultsági elv:

- Bridge configkönyvtár: `0700`;
- master token: `0600`;
- Unix socket: `0600`;
- agent runtime és secret könyvtár: `0700`;
- agent runtime fájlok és MCP-token: `0600`;
- systemd unit `UMask=0077`.

### 4.2 Konfiguráció és állapot

| Elem | Útvonal |
|---|---|
| Gépre szabott Bridge config | `~/.config/bela-codex-bridge/config.json` |
| Master bearer token | `~/.config/bela-codex-bridge/token` |
| SQLite adatbázis | `~/.local/state/bela-codex-bridge/bridge.sqlite3` |
| Process lock | `/run/user/<uid>/bela-codex-bridge.lock` |
| Unix socket | `/run/user/<uid>/bela-codex-bridge.sock` |
| systemd unit | `~/.config/systemd/user/bela-codex-bridge.service` |
| Adaptermentések | `~/.local/state/bela-codex-bridge/adapter-backups/` |

### 4.3 Marveen oldali agentfájlok

Egy Codex-agent Marveen oldali gyökere ugyanott van, ahol a többi agenté:

```text
~/marveen/agents/<agent-id>/
├── agent-config.json
├── CLAUDE.md
├── SOUL.md
├── .mcp.json
└── ...
```

A `CLAUDE.md` fájlnév Codex-agentnél történeti Marveen-kompatibilitás. Nem azt
jelenti, hogy az agentet Claude futtatja.

A tényleges út:

1. Marveen determinisztikusan létrehozza a provider-semleges `CLAUDE.md` és
   `SOUL.md` fájlokat.
2. `syncCodexAgent()` beolvassa ezek tartalmát.
3. A Bridge `RuntimeManager.compile()` ezekből és a Bridge saját biztonsági
   szabályaiból agentenként `AGENTS.md` developer instructiont készít.
4. A Codex thread ezt az `AGENTS.md` tartalmat kapja.

Codex-agent létrehozásakor nincs Claude modellhívás.

---

## 5. Providerkonfiguráció Marveenben

A provider az agent saját `agent-config.json` fájljában tárolódik.

Példa:

```json
{
  "model": "gpt-5.6-terra",
  "provider": "codex",
  "providerConfig": {
    "model": "gpt-5.6-terra",
    "sandboxMode": "workspace-write",
    "approvalPolicy": "bela",
    "networkEnabled": false
  }
}
```

### 5.1 Visszafelé kompatibilis alapérték

Ha a `provider` hiányzik, ismeretlen vagy a config nem olvasható, Marveen
`claude` providert feltételez. Ez megakadályozza, hogy egy régi agent
véletlenül Codexként induljon.

### 5.2 Codex alapértékek

| Beállítás | Alapérték | Jelentés |
|---|---|---|
| `model` | `gpt-5.6-terra` | ChatGPT-előfizetéssel igazolt modell |
| `sandboxMode` | `workspace-write` | csak az agent workspace írható |
| `approvalPolicy` | `bela` | command/file approval Béla felületére kerül |
| `networkEnabled` | `false` | hálózat alapból tiltott |

### 5.3 Provider-váltás

Claude → Codex vagy Codex → Claude váltáskor Marveen előbb megállítja a régi
providert, törli a desired-running szándékot, és csak utána írja át a
providerbeállítást. Ennek célja, hogy ugyanazon agentazonosító alatt ne maradjon
egyszerre élő Claude tmux és Codex thread.

---

## 6. Bridge indulási sorrend

```mermaid
sequenceDiagram
  participant SD as systemd
  participant B as Bridge
  participant DB as SQLite
  participant API as Unix socket API
  participant C as Codex App Server

  SD->>B: Node 22 dist/src/main.js
  B->>B: config + token validálása
  B->>B: single-process lock
  B->>DB: WAL + migrációk
  B->>DB: aktív runok recovery
  B->>API: socket listen 0600
  B->>C: codex app-server --stdio
  B->>C: initialize
  B->>C: initialized
  B->>C: model/list
  C-->>B: gpt-5.6-terra elérhető
  B-->>SD: ready
```

### 6.1 Indulási gate-ek

A Bridge nem tekinti kompatibilisnek az App Servert, ha:

- a Codex bináris nem futtatható;
- a `codex --version` nem tartalmazza a lockolt `0.145.0` verziót;
- a `codex login status` nem jelez aktív logint;
- az `initialize` vagy a kompatibilitási RPC hibázik;
- a `model/list` nem tartalmazza a `gpt-5.6-terra` modellt.

### 6.2 Health és readiness különbsége

- `GET /healthz`: a Bridge HTTP folyamat él.
- `GET /readyz`: a Codex App Server online **és** kompatibilis.

Az agent tényleges futtathatóságához a `/readyz` az irányadó. A `healthz=ok`
önmagában nem bizonyít működő Codex kapcsolatot.

### 6.3 App Server generation

Minden sikeres App Server indulás növeli a Bridge memóriájában lévő
`generation` számlálót. A threadrekord tárolja, melyik generation alatt volt
utoljára használva, de a tartós Codex `threadId` a generation váltása után is
resume-olható.

---

## 7. Codex-agent létrehozása

### 7.1 Dashboard → Marveen

A dashboard a következőt küldi:

```http
POST /api/agents
```

Logikai payload:

```json
{
  "name": "codex-dev",
  "description": "Programozási feladatok végrehajtása",
  "provider": "codex",
  "model": "gpt-5.6-terra",
  "providerConfig": {
    "model": "gpt-5.6-terra",
    "sandboxMode": "workspace-write",
    "approvalPolicy": "bela",
    "networkEnabled": false
  }
}
```

### 7.2 Marveen létrehozási tranzakciójának logikája

1. Agentnév tisztítása és ütközésvizsgálat.
2. Agentkönyvtár scaffold.
3. Modell és provider mentése.
4. Codex providerconfig mentése.
5. Biztonsági profil mentése.
6. Determinisztikus Codex identity fájlok generálása.
7. `CLAUDE.md` és `SOUL.md` atomi írása.
8. Csapattag-értesítések létrehozása.
9. Sikeres HTTP-válasz.

Ha a generálási lépés hibázik, Marveen törli a félkész agentkönyvtárat.

### 7.3 Mi változott a 0.1.4-ben

A korábbi hibás futó `dist` Claude-generátort hívott Codex-agenthez is. A
0.1.4 telepítő:

- patcheli a forrást;
- lefuttat 58 céltesztet;
- kötelezően futtatja a Marveen `npm run build` parancsát;
- ellenőrzi a lefordított `dist/index.js` meglétét;
- ellenőrzi a lefordított Codex providert;
- ellenőrzi a lefordított message routert;
- ellenőrzi a lefordított Codex identity generátort;
- csak ezután tekinti sikeresnek az adaptertelepítést.

Ezért a forrás és a futtatott `dist` többé nem válhat észrevétlenül szét ezen a
telepítési úton.

---

## 8. Agent szinkronizálása és indítása

A dashboard Codex-agent start kérése:

```http
POST /api/agents/<agent-id>/start
```

Marveen oldali sorrend:

1. `syncCodexAgent(agentId)`;
2. `PUT /v1/agents/<agent-id>` a Bridge felé;
3. `POST /v1/agents/<agent-id>/start`;
4. desired-agent lista frissítése;
5. státusz visszaadása a dashboardnak.

### 8.1 Bridge agent upsert

A Bridge validálja:

- agent ID: 2–63 karakter, kisbetűvel kezdődik, csak kisbetű/szám/kötőjel;
- workspace létezik és nem a fájlrendszer gyökere;
- workspace mód: `directory` vagy `worktree`;
- sandbox mód;
- approval policy;
- prompt- és instruction-méret.

Konfigurációváltozáskor nő a `configRevision`.

### 8.2 Runtime compile

Minden start és run előtt idempotensen létrejön vagy frissül:

- az agent HMAC-kötött MCP-tokenje;
- az agent `AGENTS.md` developer instructionje;
- `.codex/config.toml`;
- `runtime.json`;
- a kötelező `bela` MCP server konfigurációja.

### 8.3 Agentállapot indításkor

```mermaid
stateDiagram-v2
  [*] --> offline
  offline --> starting: start
  starting --> idle: App Server + runtime OK
  starting --> auth_required: Codex login hiba
  starting --> incompatible: verzió vagy modell hiba
  starting --> crashed: egyéb indulási hiba
  idle --> busy: run indul
  busy --> idle: run lezárult
  idle --> stopping: stop
  stopping --> offline: leállt
```

A Bridge két külön állapotot tárol:

- `desiredState`: mit akar az operator;
- `actualState`: mit lát a Bridge aktuálisan.

Az `actualState=idle` nem helyettesíti a `/readyz` ellenőrzését. App Server
hiba esetén a readiness a hitelesebb szolgáltatásszintű jel.

Az agentállapot-séma tartalmaz `waiting_approval` értéket, de a 0.1.4
ApprovalBroker jelenleg csak a **run** állapotát állítja `waiting_approval`
értékre. Az agent `actualState` a gyakorlatban `busy` marad az approval alatt.
Ezt a tesztekben nem szabad hibásan `agent=waiting_approval` eredményként
elvárni.

---

## 9. Üzenetküldés teljes életciklusa

### 9.1 A kötelező éles út

Codex-agent teljes integrációját nem közvetlen Bridge API-hívással, hanem Béla
normál agentüzenetével kell tesztelni. Csak ez ellenőrzi együtt:

- Marveen agent message adatbázisát;
- a message routert;
- a providerfelismerést;
- a Bridge idempotens run API-ját;
- a Codex thread/turn végrehajtást;
- az outbox callbacket;
- a választ visszaíró Marveen tranzakciót;
- a főagent inboxát.

### 9.2 Üzenetút

```mermaid
sequenceDiagram
  participant M as Béla küldő agent
  participant R as Marveen message router
  participant B as Bridge
  participant C as Codex thread
  participant O as Bridge outbox
  participant P as Marveen callback

  M->>R: agent message, status=pending
  R->>B: POST /v1/agents/id/runs
  Note over R,B: Idempotency-Key=bela-message-messageId
  B-->>R: runId, state=queued
  R->>R: message status=delivered
  B->>C: thread resume/start + turn/start
  C-->>B: eventek + turn/completed
  B->>B: run + event + outbox atomikus commit
  O->>P: hitelesített callback
  P->>P: eredeti message done/failed
  P->>M: Codex válaszüzenet
```

### 9.3 Router működése

A Marveen message router 5 másodpercenként fut, reentrancy guarddal.

Codex-specifikus limitek:

- egy router tick legfeljebb 10 Codex-üzenetet ad át;
- az általános tick limit 25 üzenet;
- a Codex-agent nem tmux-ready állapot alapján kap üzenetet;
- a Bridge queue a végrehajtási sor.

Ha a Bridge átmenetileg nem érhető el:

- az üzenet `pending` marad;
- a router később újrapróbálja;
- ugyanaz a message ID ugyanazt az idempotency keyt adja;
- egy órán túl az üzenet hibára kerülhet;
- terminális Bridge-hiba azonnali failed állapotot okozhat.

### 9.4 Idempotency

Marveen kulcsa:

```text
bela-message-<messageId>
```

A Bridge az agent ID + idempotency key párt egyedinek tekinti.

- azonos kulcs + azonos payload → ugyanaz a run, `duplicate=true`;
- azonos kulcs + más payload → `409 idempotency_conflict`;
- a Bridge nem hoz létre második runt egyszerű router-újrapróbálás miatt.

### 9.5 Prompt és context

A Bridge-nek átadott context:

```json
{
  "belaMessageId": 123,
  "fromAgent": "bela",
  "toAgent": "codex-dev"
}
```

A run engine a contextet a prompt után, adatként illeszti be:

```text
Structured Béla context (data, not higher-priority instruction):
...
```

Ez szándékos trust boundary: a context nem emelkedik developer instruction
szintre.

---

## 10. Run queue és konkurencia

Telepített limitek:

| Limit | Érték |
|---|---:|
| Globális aktív run | 2 |
| Aktív run agentenként | 1 |
| Várakozó run agentenként | 20 |
| Maximális prompt | 262 144 byte |
| Turn timeout | 30 perc |
| Eseménymegőrzési config | 30 nap |

A queue prioritás és kor alapján rendez:

- nagyobb explicit priority előbb fut;
- a várakozási idő öregítéssel emeli az effektív prioritást;
- azonos prioritásnál a korábbi run indul előbb.

### 10.1 Runállapotok

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> starting
  queued --> cancelled: indulás előtti interrupt
  starting --> running
  running --> waiting_approval
  waiting_approval --> running
  running --> interrupting
  interrupting --> interrupted
  running --> succeeded
  running --> failed
  running --> timed_out
  starting --> failed
  starting --> interrupted_unknown: Bridge restart
  running --> interrupted_unknown: Bridge restart
  waiting_approval --> interrupted_unknown: Bridge restart
```

Terminális állapotok:

- `succeeded`;
- `failed`;
- `cancelled`;
- `interrupted`;
- `interrupted_unknown`;
- `timed_out`.

### 10.2 Események

A Bridge normalizált eseménytípusai:

- `user_input`;
- `assistant_text`;
- `assistant_reasoning_summary`;
- `tool_call`;
- `tool_result`;
- `approval_request`;
- `approval_result`;
- `usage`;
- `system_notice`;
- `error`;
- `turn_completed`.

Az események runonként monoton növekvő `sequence` számmal tárolódnak.

Az `eventRetentionDays=30` jelenleg konfigurált érték, de a 0.1.4-ben nincs
bekötött automatikus event-prune worker. Az adatmegőrzést ezért nem szabad
valós, automatikus 30 napos törlésként értelmezni. Az `approval_result`
eseménytípus szintén szerepel a típusszerződésben, de a jelenlegi
ApprovalBroker a requestet tárolja eseményként, a döntést elsősorban az
approval táblában és a Codex RPC-válaszban rögzíti.

---

## 11. Threadkezelés és kontextusfolytatás

Minden agenthez legfeljebb egy aktuális tartós threadrekord tartozik.

### 11.1 Első run

Ha nincs érvényes thread:

```text
thread/start
ephemeral=false
```

A Bridge eltárolja:

- `agentId`;
- `threadId`;
- App Server generation;
- modell;
- config revision.

### 11.2 Következő run

Ha van érvényes thread:

```text
thread/resume
```

A Bridge átadja az aktuális:

- modellt;
- workspace-t;
- approval policyt;
- sandboxot;
- MCP-configot;
- developer instructiont.

Ha a resume hibázik:

1. a Bridge warningot ír;
2. invalidálja a régi threadet;
3. új threadet hoz létre;
4. az új thread ID-t eltárolja.

### 11.3 Fresh thread

Dashboard `fresh=true` restart esetén:

1. Marveen `POST /fresh-thread` kérést küld;
2. a Bridge csak akkor engedi, ha az agent nem busy;
3. a thread invalidálódik;
4. a következő run új threadet kap.

### 11.4 Fontos különbség

- **Service restart idle állapotban:** a következő run megpróbálja resume-olni
  a tartós threadet.
- **Service restart aktív run közben:** a Bridge nem folytatja automatikusan az
  aktív turnt; a run `interrupted_unknown` lesz.

Ez a két eset nem keverhető össze.

---

## 12. Run befejezése és callback

### 12.1 Atomi Bridge-commit

Run befejezésekor egy SQLite tranzakció:

1. terminális állapotba teszi a runt;
2. elmenti a final response-t, errort és usage adatot;
3. hozzáad egy `turn_completed` eseményt;
4. létrehozza a tartós outbox sort.

Sikeres run:

```text
eventType=run.completed
```

Sikertelen run:

```text
eventType=run.failed
```

### 12.2 Outbox delivery

A worker másodpercenként ellenőrzi a pending outboxot.

Callback:

```http
POST http://127.0.0.1:3420/api/provider-callbacks/codex
Authorization: Bearer <master-token>
Idempotency-Key: <runId>:<eventType>
```

Retry:

- legfeljebb 12 próbálkozás;
- exponenciális késleltetés;
- 20% jitter;
- legfeljebb 5 perc késleltetés;
- végleges kudarc esetén outbox state: `dead`.

### 12.3 Marveen callback tranzakció

Marveen ellenőrzi:

- schema version = 1;
- létező eredeti `belaMessageId`;
- az eredeti címzett megegyezik a run agentjével;
- az agent providere valóban `codex`.

Siker esetén:

1. a Codex válasza új agentüzenet lesz az eredeti küldő felé;
2. az eredeti üzenet `done`;
3. duplikált callback nem hoz létre második választ.

Hiba esetén:

1. az eredeti üzenet `failed`;
2. Béla főagent rendszerüzenetet kap
   `[codex-bridge-failure]` prefixszel.

---

## 13. Approval működés

### 13.1 Támogatott approval típusok

- command execution;
- file change.

Nem kerül interaktívan Béla elé:

- általános `requestUserInput`: üres válasz;
- MCP elicitation: automatikus decline;
- ismeretlen server request: hiba/decline.

### 13.2 Approval policy

`approvalPolicy=bela`:

- Codex oldalon `on-request`;
- a Bridge eltárolja a kérést;
- a run `waiting_approval`;
- a dashboard a `/api/codex-approvals` facade-on keresztül listázza;
- approve esetén Codex `accept` választ kap;
- decline esetén Codex `decline` választ kap.

`approvalPolicy=never`:

- a Bridge nem enged operatori approvalt;
- beérkező command/file approvalt automatikusan elutasít.

### 13.3 Timeout

Approval timeout: 5 perc.

Timeout után:

- approval state: `expired`;
- a Codex `decline` választ kap;
- a run visszakerül `running` állapotba;
- a turn eldönti, tud-e folytatni vagy hibázik.

### 13.4 Restartkorlát

Pending approval nem resume-olható biztonságosan Bridge restart után, mert a
Codex felé nyitott in-memory waiter megszűnik. Aktív approval közben ne
indítsunk Bridge-frissítést vagy restartot.

---

## 14. Agent-scope-olt MCP facade

A Bridge minden agenthez külön tokent származtat:

```text
HMAC-SHA256(masterToken, "bela-codex-mcp:v1:<agentId>")
```

Formátum:

```text
bcm1.<agentId>.<signature>
```

A Marveen facade a tokenből hitelesíti az agent ID-t. A kliens nem adhat meg
tetszőleges sender identitást.

### 14.1 Elérhető eszközök

| Eszköz | Művelet |
|---|---|
| `bela_agent_message_send` | üzenet küldése a saját Codex-agent identitásával |
| `bela_agent_message_status` | csak a saját korábban küldött üzenetének státusza |
| `bela_memory_search` | saját és explicit shared memóriák keresése |
| `bela_memory_get` | keresésből kapott opaque memóriaazonosító feloldása |

### 14.2 Memóriahatár

A Codex-agent:

- saját `agent_id` memóriáit láthatja;
- `category=shared` memóriát láthat;
- más agent privát memóriáját nem kérheti le;
- nyers numerikus memória-ID helyett HMAC-kötött opaque ID-t kap.

### 14.3 MCP fail-closed működés

A `bela` MCP server:

- `required=true`;
- startup timeout 20 másodperc;
- tool timeout 60 másodperc.

Ha a kötelező MCP nem inicializálható, a thread nem tekinthető szabályosan
indult agentnek.

---

## 15. Biztonsági modell

### 15.1 Bridge API

- csak Unix socketen érhető el;
- socket mode `0600`;
- `/v1/*` endpointokhoz master bearer kell;
- tokenellenőrzés constant-time;
- a token minimum 32 byte;
- request body méretkorlátos;
- agent ID szigorúan validált;
- workspace root `/` tiltott;
- runtime path escape tiltott;
- egyidejű második Bridge process lockkal tiltott.

### 15.2 Marveen belső service endpointok

A dashboard globális auth gate-jét csak ezek a pontos belső utak kerülhetik
meg:

- `POST /api/provider-callbacks/codex`;
- `GET|POST /api/codex-facade/*`.

Ezek nem nyilvános endpointok:

- callback master Bridge bearerrel hitelesít;
- MCP facade agent-scope-olt HMAC tokennel hitelesít;
- más method/path nem kap kivételt.

### 15.3 Sandbox

`read-only`:

- írás tiltott;
- network a külön `networkEnabled` értéktől függ.

`workspace-write`:

- írható root az agent workspace;
- rendszerterületek nem írhatók;
- network külön kapcsolható.

`danger-full-access`:

- a legerősebb mód;
- csak tudatos operatori döntéssel használható;
- nem tekinthető alapbeállításnak.

### 15.4 systemd hardening

A service unit többek között:

- `NoNewPrivileges=true`;
- `PrivateTmp=true`;
- `ProtectSystem=full`;
- kernel és control group védelem;
- `RestrictSUIDSGID=true`;
- `KillMode=mixed`;
- `Restart=on-failure`.

---

## 16. Tartós adatok

SQLite WAL adatbázis fő táblái:

| Tábla | Tartalom |
|---|---|
| `bridge_agents` | Bridge agentkonfiguráció és állapot |
| `codex_threads` | agentenkénti tartós thread |
| `bridge_runs` | queue és run lifecycle |
| `bridge_events` | normalizált run események |
| `bridge_outbox` | callback delivery |
| `bridge_approvals` | approval kérések és döntések |
| `schema_migrations` | alkalmazott migrációk |

Az adatbázist kézzel szerkeszteni tilos. Diagnosztikához elsőként API-t,
journalt és read-only lekérdezést kell használni.

---

## 17. Hibakezelés és helyreállás

### 17.1 Bridge nem érhető el üzenetátadáskor

Elvárt:

- Marveen message pending marad;
- router retry;
- nem jön létre Claude tmux;
- service helyreállása után egyetlen idempotens run indul.

### 17.2 App Server child process kilép

Elvárt:

- supervisor `online=false`, `compatible=false`;
- aktív runok hibát kapnak;
- `/readyz` 503;
- következő start/run igény megkísérli újraindítani az App Servert;
- restart circuit legfeljebb 5 indítást enged 5 perces ablakban.

A konfigurációban szereplő base/max restart delay nem jelent folyamatos
háttérben futó exponenciális restart loopot. A jelenlegi újraindítás
igényvezérelt és circuit-limitált.

### 17.3 Bridge service restart idle állapotban

Elvárt:

- SQLite, agent desired state és thread ID megmarad;
- App Server új generationnel indul;
- következő run `thread/resume` kérést használ;
- resume-hiba esetén kontrollált új thread jön létre.

### 17.4 Bridge service restart aktív run közben

Jelenlegi 0.1.4 viselkedés:

- `starting`, `running`, `interrupting` vagy `waiting_approval` run
  `interrupted_unknown` állapotba kerül;
- a Bridge nem állítja, hogy a provider turn biztosan leállt vagy befejeződött;
- automatikus turnfolytatás nincs.

**Kritikus működési korlát:** a recovery jelenlegi kódja a run állapotát
helyreállítja, de nem garantál új Marveen callbacket az így lezárt
`interrupted_unknown` runhoz. Emiatt aktív run alatt tervezett Bridge/Béla
restartot kerülni kell. Az ilyen run eredeti Béla-üzenetének állapotát külön
ellenőrizni és szükség esetén operatori döntéssel újraküldeni kell.

Ezt tilos vak automatikus resubmittal „javítani”, mert nem bizonyítható, hogy a
provider oldalon nem történt külső mellékhatás.

### 17.5 Callback hiba

Elvárt:

- run és final response megmarad SQLite-ban;
- outbox retry;
- Marveen újraindítása nem veszíti el a Bridge outboxot;
- max attempt után `dead`, manuális vizsgálat szükséges.

### 17.6 Codex auth vagy modellhiba

- authhiba → agent `auth_required`, readiness 503;
- verzió/modellhiba → agent `incompatible`, readiness 503;
- nem szabad más modellt találomra beírni;
- a gépen igazolt ChatGPT modell: `gpt-5.6-terra`.

---

## 18. Megfigyelés és diagnosztika

### 18.1 Codex-agent ID azonosítása

A dashboard agentlistája mellett read-only módon a Marveen configokból is
azonosítható minden Codex-agent:

```bash
node - <<'NODE'
const { readdirSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const root = join(homedir(), 'marveen', 'agents')
for (const name of readdirSync(root)) {
  try {
    const config = JSON.parse(
      readFileSync(join(root, name, 'agent-config.json'), 'utf8'),
    )
    if (config.provider === 'codex') console.log(name)
  } catch {}
}
NODE
```

Csak a ténylegesen `provider=codex` agent használható a további Bridge
tesztekhez.

### 18.2 Service

```bash
systemctl --user status bela-codex-bridge.service \
  --no-pager \
  --full
```

Elvárt:

```text
Active: active (running)
```

### 18.3 Journal

```bash
journalctl --user \
  -u bela-codex-bridge.service \
  -n 150 \
  --no-pager
```

Fontos sikeres marker:

```text
Bridge API listening
Codex App Server ready
Bridge service ready
```

### 18.4 Readiness

```bash
SOCKET="/run/user/$(id -u)/bela-codex-bridge.sock"

curl --silent \
  --show-error \
  --unix-socket "$SOCKET" \
  http://localhost/readyz
echo
```

Elvárt:

```json
{
  "status": "ready",
  "appServerOnline": true,
  "compatible": true
}
```

### 18.5 Hitelesített meta

```bash
SOCKET="/run/user/$(id -u)/bela-codex-bridge.sock"
TOKEN_FILE="$HOME/.config/bela-codex-bridge/token"
BRIDGE_TOKEN="$(<"$TOKEN_FILE")"

curl --silent \
  --show-error \
  --fail \
  --unix-socket "$SOCKET" \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  http://localhost/v1/meta
echo

unset BRIDGE_TOKEN
```

Elvárt kulcsok:

```text
bridgeVersion=0.1.4
node=v22.23.1
expectedVersion=0.145.0
model=gpt-5.6-terra
online=true
compatible=true
```

A token tartalmát tilos naplózni vagy válaszba bemásolni.

### 18.6 Agent státusz

```bash
AGENT_ID="<codex-agent-id>"
SOCKET="/run/user/$(id -u)/bela-codex-bridge.sock"
BRIDGE_TOKEN="$(<"$HOME/.config/bela-codex-bridge/token")"

curl --silent \
  --show-error \
  --fail \
  --unix-socket "$SOCKET" \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  "http://localhost/v1/agents/$AGENT_ID"
echo

unset BRIDGE_TOKEN
```

Indított, éppen nem dolgozó agentnél:

```text
desiredState=running
actualState=idle
model=gpt-5.6-terra
runtime.compiled=true
```

### 18.7 Dist-verifikáció

```bash
cd "$HOME/marveen"

test -f dist/index.js
test -f dist/providers/codex-provider.js

rg -q "buildCodexAgentIdentityFiles" \
  dist/web/agent-scaffold.js

rg -q "readAgentProvider" \
  dist/web/message-router.js

echo "PASS: compiled Codex adapter markers are present"
```

Ha a forrásban megvan a Codex adapter, de a `dist` marker hiányzik, Béla régi
buildet futtat. Ilyenkor nem szabad kézzel csak `tsc`-t futtatni és késznek
nyilvánítani: a verzióhoz tartozó Bridge installerrel kell buildet, tesztet,
mentést és verifikációt futtatni.

### 18.8 Tmux regresszió ellenőrzése

```bash
AGENT_ID="<codex-agent-id>"

tmux list-sessions -F '#S' 2>/dev/null \
  | grep -Fx "agent-$AGENT_ID" \
  && echo "FAIL: Codex agenthez tmux session fut" \
  || echo "PASS: nincs Codex tmux session"
```

### 18.9 App Server process

```bash
pgrep -af "codex app-server --stdio"
```

Normál esetben a Bridge service alatt egy felügyelt App Server folyamat
látható. Több Bridge-példányt a process lock és a systemd unit nem engedhet.

---

## 19. Béla kötelező tesztprotokollja

### Általános szabályok

1. Először read-only ellenőrzés.
2. Egyszerre csak egy teszt.
3. Minden teszthez egyedi marker.
4. Következő teszt csak az előző terminális eredménye után.
5. Aktív run vagy pending approval közben service restart tilos.
6. Token, MCP-token és adatbázis nem kerülhet chatbe vagy logba.
7. SQLite állapotot kézzel módosítani tilos.
8. Hiba esetén a journal, a Bridge API és a Marveen message state legyen az
   elsődleges bizonyíték, ne a dashboard vizuális becslése.

### 19.1 Teszt A — read-only infrastruktúra

Végrehajtandó:

1. systemd status;
2. `/readyz`;
3. hitelesített `/v1/meta`;
4. agent státusz;
5. dist marker;
6. tmux-regresszió ellenőrzése.

PASS feltétel:

- service active;
- ready true;
- Bridge 0.1.4;
- Node 22.23.1;
- Codex 0.145.0;
- Terra modell;
- agent provider Codex;
- agent runtime compiled;
- nincs Codex tmux session.

### 19.2 Teszt B — teljes Béla → Codex → Béla E2E

Béla a saját normál agentüzenet-rendszerén keresztül küldje:

```text
Ne módosíts fájlt és ne használj külső szolgáltatást.
A teljes válaszod pontosan egyetlen sor legyen:
CODEX_BRIDGE_E2E_20260728_OK
```

Tilos a Bridge `/runs` endpointját közvetlenül meghívni ehhez a teszthez.

PASS feltétel:

1. az eredeti Béla-üzenet pendingből delivered, majd done állapotba kerül;
2. pontosan egy Bridge run jön létre;
3. a run `succeeded`;
4. pontosan egy válaszüzenet érkezik;
5. a válasz pontosan:

```text
CODEX_BRIDGE_E2E_20260728_OK
```

6. nincs Claude tmux;
7. nincs `[codex-bridge-failure]` üzenet.

### 19.3 Teszt C — threadfolytatás

Első üzenet:

```text
Jegyezd meg ehhez a beszélgetéshez ezt a tesztértéket:
BRIDGE_THREAD_NONCE_7F31A9.
Válaszolj: NONCE_STORED
```

Második üzenet ugyanahhoz az agenthez, restart nélkül:

```text
Mi volt az előző üzenetben megadott BRIDGE_THREAD_NONCE érték?
Csak az értékkel válaszolj.
```

PASS:

```text
BRIDGE_THREAD_NONCE_7F31A9
```

Ezután, csak idle állapotban:

1. Bridge service restart;
2. `/readyz` megvárása;
3. harmadik kérdés ugyanarról a nonce-ról.

PASS:

- ugyanaz a thread ID marad;
- a nonce helyes;
- nincs aktív run elvesztése, mert restart csak idle állapotban történt.

Ha warning mellett új thread jön létre, az kontrollált fallback, de a
threadfolytatási teszt minősítése `RÉSZLEGES`, nem teljes PASS.

### 19.4 Teszt D — Codex → Béla MCP üzenet

Üzenet a Codex-agentnek:

```text
Használd a bela_agent_message_send eszközt. A `to` mező pontosan `bela`
legyen, és küldj pontosan egy üzenetet ezzel a tartalommal:
CODEX_MCP_TO_BELA_20260728_OK

Ezután a bela_agent_message_status eszközzel ellenőrizd az elküldött üzenet
állapotát, és röviden jelentsd az eredményt.
```

PASS:

- az üzenet feladója a tényleges Codex-agent ID;
- az agent nem tud más feladót megadni;
- Béla pontosan egy markerüzenetet kap;
- status tool csak a saját üzenetet olvassa.

### 19.5 Teszt E — memória scope

Csak akkor futtatható, ha van az agent számára saját vagy shared tesztmemória.

Kérés:

```text
Keresd meg a bela_memory_search eszközzel a kijelölt tesztmemóriát, majd a
kapott opaque azonosítóval olvasd be a bela_memory_get eszközzel.
Ne próbálj numerikus adatbázis-azonosítót kitalálni.
```

PASS:

- saját/shared memória elérhető;
- más agent privát memóriája nem jelenik meg;
- a visszakapott ID opaque és scope-olt.

### 19.6 Teszt F — approval

Ez kontrollált teszt. Veszélyes vagy külső művelet nem engedélyezhető.

1. agent `approvalPolicy=bela`;
2. olyan ártalmatlan művelet kérése, amelyhez Codex valóban approvalt kér;
3. approval megjelenik a Béla Codex approval paneljén;
4. először decline teszt;
5. külön runban approve teszt, csak dedikált tesztfájllal az agent
   workspace-ben.

PASS:

- run `waiting_approval`;
- agent a jelenlegi implementációban `busy` maradhat;
- request kategória és paraméterek láthatók;
- döntés után run folytatódik;
- timeout esetén decline;
- nincs approval a másik agenthez kötve.

### 19.7 Teszt G — Bridge-kiesés alatti queue

Csak akkor, ha nincs aktív run és nincs pending approval.

1. Bridge service stop.
2. Egy egyedi markerüzenet küldése a Codex-agentnek.
3. Ellenőrizni, hogy az üzenet pending marad.
4. Bridge service start.
5. `/readyz` megvárása.
6. Megvárni a router retryt és a callbacket.

PASS:

- stop alatt nem jön létre Claude tmux;
- az üzenet nem vész el;
- indulás után pontosan egy run;
- pontosan egy válasz;
- az eredeti üzenet done.

### 19.8 Nem végrehajtandó automatikus teszt — aktív run alatti restart

Ezt Béla önállóan ne futtassa éles agenten.

Indok:

- a run `interrupted_unknown` lehet;
- a provider mellékhatása nem bizonyítható;
- a recovery callback jelenlegi korlátja miatt az eredeti Marveen message
  kézi felülvizsgálatot igényelhet.

Ehhez külön izolált tesztagent, mellékhatásmentes prompt és előre elfogadott
helyreállítási terv kell.

---

## 20. Elfogadási mátrix

| Terület | Kötelező eredmény |
|---|---|
| Telepítés | Bridge és Marveen verifier PASS |
| Build | forrás és `dist` Codex markerek jelen |
| Service | active/running |
| Readiness | online + compatible |
| Modell | `gpt-5.6-terra` |
| Agent létrehozás | Claude-hívás nélkül befejeződik |
| Agent runtime | nincs tmux, runtime compiled |
| E2E | egy üzenet → egy run → egy válasz |
| Callback | eredeti message done/failed, duplikáció nélkül |
| Thread | következő turn resume |
| MCP | sender scope és memória scope érvényes |
| Approval | Béla panel, helyes agent/run kötés |
| Queue | Bridge-kiesés alatt pending, utána egyszeri feldolgozás |
| Titokvédelem | token nem kerül logba vagy chatbe |

Az integráció csak akkor tekinthető működésileg elfogadottnak, ha legalább az
A, B, C és D teszt PASS. Az F és G teszt a teljes üzemeltetési elfogadáshoz
szükséges.

---

## 21. Frissítési és fejlesztési szabályok

### 21.1 Marveen-frissítés

A Bridge core külön service és külön release, de a Marveen adapter nem
verziófüggetlen. A jelenlegi adapter kizárólag a validált Marveen 1.21.1
forrásra telepíthető.

Marveen-frissítéskor kötelező:

1. új forrás baseline;
2. érintett fájlok SHA-256 manifestje;
3. adapter port;
4. patch dry-run;
5. typecheck;
6. syntax-check;
7. céltesztek;
8. production build;
9. lefordított `dist` markerellenőrzés;
10. teljes Bridge E2E;
11. rollbackteszt.

Régi patch vak alkalmazása tilos.

### 21.2 Codex CLI frissítés

A Bridge 0.145.0-ra lockolt. Frissítés előtt:

1. App Server protocol contract ellenőrzés;
2. `initialize/initialized`;
3. `model/list`;
4. thread start/resume;
5. turn start/interrupt/completed;
6. approval server requestek;
7. MCP config;
8. kétagent-es izolációs preflight;
9. ChatGPT-login és Terra modell;
10. Bridge lock és config együtt frissítése.

### 21.3 Bridge-frissítés

Megőrzendő:

- master token;
- SQLite adatbázis;
- agent runtime root;
- systemd user service;
- Marveen adapter előtti mentések.

Nem szabad aktív run vagy pending approval közben frissíteni.

---

## 22. Ismert korlátok a 0.1.4-ben

1. Aktív run service restart utáni automatikus, bizonyított folytatása nincs.
2. Az `interrupted_unknown` recovery callbackje nem garantált.
3. Pending approval restart után nem resume-olható.
4. Codex-agenthez nincs tmux terminal tail; a dashboard állapotot mutat, nem
   Claude-szerű pane streamet.
5. Közvetlen Telegram/Slack channel plugin nincs a Codex processen; Béla
   koordinálja a kommunikációt.
6. A Bridge közös App Servert használ. A thread, workspace, config és MCP
   logikailag izolált, de ez nem külön Linux-felhasználós biztonsági határ.
7. Egy agenten belül egyszerre egy run fut.
8. Kanban MCP és általános write-capability nincs ebben a kiadásban.
9. A network alapból tiltott.
10. Csak a `gpt-5.6-terra` modell validált ChatGPT-előfizetéssel.
11. A Codex CLI 0.145.0-tól eltérő verzió fail-closed.
12. A Marveen adapter 1.21.1-től eltérő verzióra nem telepíthető automatikusan.
13. Az `eventRetentionDays` értékhez még nincs automatikus prune worker.
14. Több állapotérték elő van készítve a sémában, de nincs teljesen bekötve:
    az agent `waiting_approval`/`degraded`, illetve a desired
    `draining`/`disabled` nem mind érhető el a jelenlegi dashboard lifecycle
    útvonalakon.

---

## 23. Forráskód-térkép

### Bridge core

| Fájl | Felelősség |
|---|---|
| `src/main.ts` | config, process lock, signalkezelés |
| `src/service.ts` | komponensek összekötése, start/stop |
| `src/config.ts` | szigorú config schema és token |
| `src/api/server.ts` | Unix socket API |
| `src/codex/protocol-client.ts` | JSONL RPC és App Server process |
| `src/codex/supervisor.ts` | verzió/login/modell probe, generation, circuit |
| `src/codex/event-normalizer.ts` | Codex notification → Bridge event |
| `src/runs/run-engine.ts` | queue, thread, turn, completion |
| `src/runs/approval-broker.ts` | approval persistence és döntés |
| `src/runtime/runtime-manager.ts` | workspace, AGENTS.md, MCP-token/config |
| `src/callbacks/outbox-worker.ts` | tartós callback retry |
| `src/mcp/server.ts` | agent-scope-olt Béla MCP facade |
| `src/db/repositories.ts` | agent/thread/run/event/outbox repository |
| `migrations/001_initial.sql` | SQLite schema |

### Marveen adapter

| Fájl | Felelősség |
|---|---|
| `src/providers/codex-bridge-client.ts` | Unix socket Bridge kliens |
| `src/providers/codex-provider.ts` | sync/start/stop/restart/run dispatch |
| `src/providers/types.ts` | provider contract |
| `src/web/agent-config.ts` | provider és providerConfig persistence |
| `src/web/agent-scaffold.ts` | determinisztikus Codex identity |
| `src/web/routes/agents.ts` | dashboard lifecycle és provider-váltás |
| `src/web/message-router.ts` | Béla message → idempotens Codex run |
| `src/web/routes/provider-callbacks.ts` | run completion → Béla message |
| `src/web/routes/codex-facade.ts` | agent-scope-olt message/memory HTTP facade |
| `src/web/routes/codex-approvals.ts` | dashboard approval facade |
| `src/web/provider-service-auth.ts` | belső service endpoint auth-kivétel |
| `src/web/schedule-runner.ts` | scheduled task → agent message → Bridge |
| `src/web/auto-restart-runner.ts` | Codex kizárása Claude restartból |
| `src/web/model-fallback-runner.ts` | Codex kizárása Claude fallbackből |
| `src/web/channel-monitor.ts` | Codex kizárása tmux/channel monitorból |
| `src/web.ts` | callback/facade/approval route bekötése |

---

## 24. Béla számára átadandó végrehajtási utasítás

Miután ezt a dokumentumot beolvastad:

1. ne módosíts kódot;
2. ne indíts automatikus aktív-run restarttesztet;
3. azonosítsd a létrehozott Codex-agent ID-jét;
4. hajtsd végre a 19.1 Teszt A read-only ellenőrzést;
5. jelentsd külön minden ellenőrzés PASS/FAIL eredményét és bizonyítékát;
6. csak sikeres Teszt A után hajtsd végre a 19.2 Teszt B E2E tesztet;
7. utána sorban a C és D tesztet;
8. az F és G teszt előtt kérj operatori jóváhagyást;
9. hiba esetén állj meg, mentsd a releváns journalt és állapotot, de tokent,
   MCP-tokent vagy teljes privát promptot ne közölj;
10. ne állítsd, hogy a Bridge teljesen működik, amíg az A–D teszt nem PASS.

### Elvárt jelentésformátum

```text
Codex Bridge 0.1.4 tesztjelentés

Agent ID:
Teszt időpontja:

A — infrastruktúra:
- service:
- readiness:
- meta/verzió:
- agent state:
- dist:
- tmux izoláció:

B — teljes E2E:
- Béla message ID:
- Bridge run ID:
- run state:
- callback eredmény:
- válaszok száma:
- válasz marker:

C — thread:
- első thread ID:
- második thread ID:
- service restart idle állapotban:
- resume eredmény:

D — MCP:
- send tool:
- sender scope:
- status tool:

Nyitott hibák vagy kockázatok:
Végső minősítés: PASS / FAIL / RÉSZLEGES
```

---

## 25. Végső értelmezés

A Bridge akkor működik helyesen, ha a Codex-agent Béla rendszerében ugyanolyan
magas szintű lifecycle- és üzenetkezelési objektumként jelenik meg, mint egy
Claude-agent, de a végrehajtása provider-specifikusan, tmux és Anthropic
kapcsolat nélkül történik.

Az „ugyanolyan agent” nem jelent azonos belső technológiát:

- azonos: létrehozás, start/stop/restart, üzenet, válasz, státusz, schedule,
  approval felület;
- eltérő: processmodell, thread, események, sandbox, MCP, terminálkép és
  helyreállítási szemantika.

A rendszer erőssége a providerhatár, a tartós queue/outbox, az idempotencia és
az agent-scope-olt képességek. A legfontosabb jelenlegi kockázat az aktív run
alatti service restart. Üzemeltetéskor ezt korlátozásként kell kezelni, nem
feltételezett automatikus helyreállásként.
