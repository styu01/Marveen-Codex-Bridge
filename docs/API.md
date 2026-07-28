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
  "bridgeVersion": "0.1.8",
  "toolContract": {
    "revision": 1,
    "exposure": ["dynamicTools", "mcpInventory"],
    "tools": [
      "bela_agent_message_send",
      "bela_agent_message_status",
      "bela_memory_search",
      "bela_memory_get"
    ]
  }
}
```

Az `mcpInventory` a threadhez indított, agent-scoped MCP szervert jelenti. A
`dynamicTools` ugyanennek a négy capabilitynek a közvetlen modelloldali
kivetítése. Az App Server `item/tool/call` szerverkéréseit a Bridge belsőleg
kezeli; ez nem nyilvános HTTP végpont.

## Agent

`PUT /v1/agents/:id`

```json
{
  "displayName": "Codex Dev",
  "model": "gpt-5.6-terra",
  "workspacePath": "/home/kisss/marveen/agents/codex-dev",
  "workspaceMode": "directory",
  "sandboxMode": "workspace-write",
  "approvalPolicy": "bela",
  "networkEnabled": false,
  "instructions": "..."
}
```

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
- `GET /v1/runs/:runId/events?after=0&limit=500`
- `POST /v1/runs/:runId/interrupt`

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

A payload a teljes tartós run rekordot tartalmazza. Marveen a
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
- `mcp_token_missing`.
