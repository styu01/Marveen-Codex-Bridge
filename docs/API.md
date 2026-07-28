# Bridge API v1

Transport: HTTP/1.1 Unix socketen. Minden `/v1/*` kéréshez:

```http
Authorization: Bearer <bridge-token>
```

A `GET /healthz` auth nélkül is elérhető. A socket alapértelmezett helye:
`/run/user/<uid>/bela-codex-bridge.sock`.

## Meta és tool contract

`GET /v1/meta` visszaadja a Bridge/Codex állapot mellett a modellnek átadott
Béla-eszközszerződést is:

```json
{
  "bridgeVersion": "0.2.1",
  "codex": {
    "reasoningEfforts": ["medium", "high", "xhigh"],
    "defaultReasoningEffort": "medium",
    "providerCapabilities": {
      "imageGeneration": true
    },
    "imageGeneration": {
      "available": true,
      "model": "gpt-image-2",
      "effort": null,
      "transport": "codex-app-server",
      "billing": "chatgpt-subscription"
    }
  },
  "toolContract": {
    "revision": 2,
    "exposure": ["dynamicTools", "mcpInventory"],
    "tools": [
      "bela_agent_message_send",
      "bela_agent_message_status",
      "bela_memory_search",
      "bela_memory_get",
      "bela_image_artifact_register"
    ],
    "mcpTools": [
      "bela_agent_message_send",
      "bela_agent_message_status",
      "bela_memory_search",
      "bela_memory_get"
    ]
  }
}
```

Az `mcpInventory` a threadhez indított, agent-scoped MCP szervert jelenti.
Annak tooljai a `mcpTools` négyelemű listában vannak. A `dynamicTools`
ugyanezt a négy Béla-capabilityt közvetlenül a modell felé vetíti, továbbá
csak ezen az útvonalon érhető el az ötödik
`bela_image_artifact_register`. Az App Server `item/tool/call`
szerverkéréseit a Bridge belsőleg kezeli; ez nem nyilvános HTTP végpont.

## Agent

`PUT /v1/agents/:id`

```json
{
  "displayName": "Codex Dev",
  "model": "gpt-5.6-terra",
  "reasoningEffort": "high",
  "workspacePath": "/home/kisss/marveen/agents/codex-dev",
  "workspaceMode": "directory",
  "sandboxMode": "workspace-write",
  "approvalPolicy": "bela",
  "networkEnabled": false,
  "instructions": "..."
}
```

`reasoningEffort` csak `medium`, `high` vagy `xhigh` lehet. Hiányzó mezőnél
az API visszafelé kompatibilis `medium` értéket használ. Az effort változása
növeli az agent `configRevision` értékét, a korábbi threadet invalidálja, és a
következő run új threadben indul. Aktív run közben az effortváltás `409
agent_busy` hibát ad.

Lifecycle:

- `POST /v1/agents/:id/start`
- `POST /v1/agents/:id/stop`
- `POST /v1/agents/:id/restart`
- `POST /v1/agents/:id/fresh-thread`
- `GET /v1/agents/:id`
- `GET /v1/agents`

## Run

`POST /v1/agents/:id/runs`

Kötelező header:

```http
Idempotency-Key: bela-message-123
```

Body:

```json
{
  "prompt": "...",
  "context": {
    "belaMessageId": 123,
    "fromAgent": "bela",
    "toAgent": "codex-dev",
    "traceId": "..."
  },
  "priority": 0
}
```

Azonos kulcs és azonos payload ugyanazt a runt adja vissza
`"duplicate": true` jelzéssel. Azonos kulcs eltérő payload mellett `409`.

- `GET /v1/runs/:runId`
- `GET /v1/runs/:runId/artifacts`
- `GET /v1/runs/:runId/events?after=0&limit=500`
- `POST /v1/runs/:runId/interrupt`

Az App Server `imageGeneration.savedPath` mezője lehet workspace-en kívüli
provider-staging fájl; ez önmagában nem végleges artifact. A Codexnek a
másolás, átméretezés és minden szerkesztés után a végleges
workspace-relatív útvonalat át kell adnia a
`bela_image_artifact_register` toolnak. Imagegen run regisztrált kép nélkül
`image_artifact_missing` hibával zárul.

Sikeres képgenerálásnál a run `artifacts` tömbje tartalmazza a képet. A fájl
csak akkor lesz `ready`, ha canonical útvonala a megfelelő agent workspace-én
belül van, normál és nem symlink fájl, mérete a konfigurált limit alatt marad,
és a magic bytes alapján PNG, JPEG vagy WebP. Ismételt regisztráció ugyanarra
a run+végleges útvonalra ugyanazt az artifactot frissíti, nem duplikál.

## Képartifact

- `GET /v1/artifacts/:artifactId`

Példa:

```json
{
  "artifactId": "76b94870-dcdd-4b21-8ea6-d6ad52e619ef",
  "runId": "...",
  "agentId": "codex-dev",
  "providerItemId": "...",
  "kind": "image",
  "status": "ready",
  "mimeType": "image/png",
  "fileName": "hero.png",
  "absolutePath": "/home/kisss/marveen/agents/codex-dev/assets/hero.png",
  "workspaceRelativePath": "assets/hero.png",
  "sha256": "...",
  "byteSize": 123456,
  "revisedPrompt": "..."
}
```

Az `absolutePath` csak a privát Unix socketen, bearer-hitelesítés után kérhető
le. A callback nem továbbítja. A Marveen dashboard a saját hitelesített
`/api/codex-artifacts/:artifactId` proxyján újraellenőrzi a pathot, méretet és
SHA-256-ot, majd `nosniff` és `no-store` fejlécekkel szolgálja ki.

## Approval

- `GET /v1/approvals`
- `GET /v1/approvals?runId=<id>`
- `POST /v1/approvals/:approvalId/decision`

```json
{ "decision": "approve" }
```

vagy:

```json
{ "decision": "decline" }
```

## Callback

A Bridge outbox a következő Marveen endpointot hívja:

```http
POST /api/provider-callbacks/codex
Authorization: Bearer <bridge-token>
Idempotency-Key: <runId>:run.completed
```

A payload a tartós run rekordot és a callbackhez szükséges, abszolút útvonal
nélküli artifact-metaadatot tartalmazza. Marveen a
`run.context.belaMessageId` alapján tranzakcióban:

1. ellenőrzi az agent/message kapcsolatot;
2. létrehozza a válaszüzenetet;
3. done/failed állapotba teszi az eredeti üzenetet;
4. duplikált callbacknél nem hoz létre második választ.

## Hibamodell

```json
{
  "error": {
    "code": "agent_not_running",
    "message": "Agent must be started before dispatch",
    "requestId": null,
    "details": null
  }
}
```

Fő státuszok:

- `400`: séma vagy azonosító hiba;
- `401`: hibás Bridge token;
- `404`: ismeretlen objektum;
- `409`: állapot- vagy idempotenciaütközés;
- `429`: agent queue megtelt;
- `503`: Codex auth/verzió/modell/App Server nem elérhető;
- `504`: provider timeout.

A belső dynamic tool diszpécser fail-closed hibakódjai:

- `dynamic_tool_run_missing`;
- `dynamic_tool_identity_mismatch`;
- `dynamic_tool_unknown`;
- `mcp_token_missing`;
- `image_artifact_arguments`;
- `image_artifact_path`;
- `image_artifact_missing`;
- `image_artifact_invalid`;
- `image_path_escape`;
- `image_artifact_type`;
- `image_artifact_size`.
