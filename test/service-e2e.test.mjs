import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MockCodexRuntime } from '../src/mock-runtime.mjs'
import { FederationBridgeService } from '../src/service.mjs'

const ADMIN_TOKEN = 'phase3-admin-token-000000000000000000'
const INBOUND_TOKEN = 'phase3-inbound-token-000000000000000'
const OUTBOUND_TOKEN = 'phase3-outbound-token-00000000000000'

async function marveenPeer(t, handler = null) {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    })
    if (handler) {
      await handler({ request, response, body, index: requests.length - 1 })
      return
    }
    const payload = JSON.parse(body)
    const output = JSON.stringify({ id: requests.length, ref: payload.ref })
    response.writeHead(202, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(output),
    })
    response.end(output)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
  }
}

function config(root, peer) {
  return {
    version: 1,
    systemId: 'codex',
    listen: { host: '127.0.0.1', port: 0 },
    storage: { database: join(root, 'state', 'federation.sqlite3') },
    codex: {
      binary: process.execPath,
      expectedVersion: '0.164.0',
      runtimeRoot: root,
      startupTimeoutMs: 60_000,
      requestTimeoutMs: 60_000,
      turnTimeoutMs: 900_000,
    },
    admin: { tokenFile: join(root, 'admin.token'), token: ADMIN_TOKEN },
    agents: [{
      id: 'programozo',
      displayName: 'Codex programozó',
      model: 'gpt-5.6-terra',
      capabilitySummary: 'Programozás és hibakeresés.',
    }],
    peers: [{
      id: 'marveen',
      baseUrl: new URL(peer.baseUrl),
      inboundToken: INBOUND_TOKEN,
      outboundToken: OUTBOUND_TOKEN,
    }],
    workers: {
      intervalMs: 50,
      runtimeLeaseMs: 1_000,
      runtimeMaxAttempts: 3,
      deliveryTimeoutMs: 500,
      deliveryLeaseMs: 1_000,
      deliveryMaxAttempts: 3,
    },
  }
}

function runtime(responder = async () => 'FEDERATION_E2E_OK') {
  return new MockCodexRuntime({
    agents: [{
      id: 'programozo',
      displayName: 'Codex programozó',
      model: 'gpt-5.6-terra',
      capabilitySummary: 'Programozás és hibakeresés.',
    }],
    responder,
  })
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-phase3-service-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function authorization(token) {
  return { authorization: `Bearer ${token}` }
}

async function jsonRequest(baseUrl, path, {
  method = 'GET',
  token = null,
  body,
} = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined
      ? undefined
      : typeof body === 'string' ? body : JSON.stringify(body),
  })
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  }
}

async function textRequest(baseUrl, path, { token = null } = {}) {
  const headers = token ? authorization(token) : {}
  const response = await fetch(`${baseUrl}${path}`, { headers })
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  }
}

function inbound(overrides = {}) {
  return {
    federationVersion: 1,
    from: 'marveen/bela',
    to: 'programozo',
    content: 'Valós E2E feladat',
    ref: '600',
    ...overrides,
  }
}

async function startService(t, options = {}) {
  const root = options.root ?? temporaryRoot(t)
  const peer = options.peer ?? await marveenPeer(t)
  const codexRuntime = options.runtime ?? runtime()
  const service = new FederationBridgeService({
    config: config(root, peer),
    runtime: codexRuntime,
    driver: 'builtin',
    autoWorkers: options.autoWorkers ?? false,
    settingsManager: options.settingsManager ?? null,
  })
  const endpoint = await service.start()
  t.after(async () => {
    if (service.server.listening) await service.stop()
  })
  return { root, peer, runtime: codexRuntime, service, endpoint }
}

test('complete Marveen -> Codex -> Marveen E2E succeeds exactly once', async (t) => {
  const env = await startService(t)
  const accepted = await jsonRequest(env.endpoint.baseUrl, '/api/federation/inbox', {
    method: 'POST',
    token: INBOUND_TOKEN,
    body: inbound(),
  })
  assert.deepEqual(accepted, {
    status: 202,
    headers: accepted.headers,
    body: { id: 1, ref: '600' },
  })
  const tick = await env.service.tick()
  assert.equal(tick.inbox.completed, 1)
  assert.equal(tick.outbox.delivered, 1)
  assert.equal(env.runtime.calls.length, 1)
  assert.equal(env.peer.requests.length, 1)
  assert.equal(env.peer.requests[0].headers.authorization, `Bearer ${OUTBOUND_TOKEN}`)
  assert.deepEqual(JSON.parse(env.peer.requests[0].body), {
    federationVersion: 1,
    from: 'codex/programozo',
    to: 'bela',
    content: 'FEDERATION_E2E_OK',
    ref: 'inbox:1:reply:v1',
  })

  const inbox = await jsonRequest(env.endpoint.baseUrl, '/v1/inbox', {
    token: ADMIN_TOKEN,
  })
  const outbox = await jsonRequest(env.endpoint.baseUrl, '/v1/outbox', {
    token: ADMIN_TOKEN,
  })
  assert.equal(inbox.body.data[0].state, 'completed')
  assert.equal(outbox.body.data[0].state, 'delivered')
  assert.doesNotMatch(
    JSON.stringify({ inbox: inbox.body, outbox: outbox.body }),
    new RegExp(`${ADMIN_TOKEN}|${INBOUND_TOKEN}|${OUTBOUND_TOKEN}`),
  )
})

test('agent settings API is admin-only and requires explicit confirmation', async (t) => {
  const calls = []
  const settingsManager = {
    current: () => ({
      agentId: 'programozo',
      displayName: 'Codex programozó',
      model: 'gpt-5.6-terra',
      selectableModels: ['gpt-5.6-terra', 'gpt-5.6-sol'],
      developerInstructions: 'Aktuális szerepkör.',
      reasoningEffort: 'high',
      canRestore: true,
    }),
    audit: () => [{ actor: 'Istvan', action: 'update', outcome: 'succeeded' }],
    async update(payload) {
      calls.push(['update', payload])
      if (payload.confirm !== true) {
        throw Object.assign(new Error('confirm must be true'), {
          code: 'confirmation_required',
          status: 409,
        })
      }
      return { settings: this.current() }
    },
    async restore(payload) {
      calls.push(['restore', payload])
      return { settings: this.current() }
    },
  }
  const env = await startService(t, { settingsManager })
  const path = '/v1/dashboard/agent-settings'
  assert.equal((await jsonRequest(env.endpoint.baseUrl, path)).status, 401)
  assert.equal((await jsonRequest(env.endpoint.baseUrl, path, {
    token: INBOUND_TOKEN,
  })).status, 401)
  const current = await jsonRequest(env.endpoint.baseUrl, path, { token: ADMIN_TOKEN })
  assert.equal(current.status, 200)
  assert.equal(current.body.data.developerInstructions, 'Aktuális szerepkör.')
  assert.deepEqual(current.body.data.selectableModels, ['gpt-5.6-terra', 'gpt-5.6-sol'])

  const unconfirmed = await jsonRequest(env.endpoint.baseUrl, path, {
    method: 'PUT',
    token: ADMIN_TOKEN,
    body: { actor: 'Istvan', model: 'gpt-5.6-sol', developerInstructions: 'Új szerep.', reasoningEffort: 'xhigh' },
  })
  assert.equal(unconfirmed.status, 409)
  assert.equal(unconfirmed.body.error, 'confirmation_required')

  const updated = await jsonRequest(env.endpoint.baseUrl, path, {
    method: 'PUT',
    token: ADMIN_TOKEN,
    body: { actor: 'Istvan', model: 'gpt-5.6-sol', developerInstructions: 'Új szerep.', reasoningEffort: 'xhigh', confirm: true },
  })
  assert.equal(updated.status, 200)
  assert.equal(calls.at(-1)[0], 'update')

  const audit = await jsonRequest(
    env.endpoint.baseUrl,
    `${path}/audit`,
    { token: ADMIN_TOKEN },
  )
  assert.equal(audit.status, 200)
  assert.equal(audit.body.data[0].actor, 'Istvan')

  const restored = await jsonRequest(env.endpoint.baseUrl, `${path}/restore`, {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: { actor: 'Istvan', confirm: true },
  })
  assert.equal(restored.status, 200)
  assert.equal(calls.at(-1)[0], 'restore')
})

test('health is public, admin and Federation authentication are isolated', async (t) => {
  const env = await startService(t)
  assert.equal((await jsonRequest(env.endpoint.baseUrl, '/healthz')).status, 200)
  assert.equal((await jsonRequest(env.endpoint.baseUrl, '/readyz')).body.status, 'ready')
  assert.equal((await jsonRequest(env.endpoint.baseUrl, '/v1/meta')).status, 401)
  assert.equal((await jsonRequest(env.endpoint.baseUrl, '/v1/meta', {
    token: INBOUND_TOKEN,
  })).status, 401)
  assert.equal((await jsonRequest(env.endpoint.baseUrl, '/api/federation/manifest', {
    token: ADMIN_TOKEN,
  })).status, 401)
  const manifest = await jsonRequest(env.endpoint.baseUrl, '/api/federation/manifest', {
    token: INBOUND_TOKEN,
  })
  assert.equal(manifest.status, 200)
  assert.equal(manifest.body.system, 'codex')
  assert.equal(manifest.body.agents[0].id, 'programozo')
})

test('standalone dashboard is static, hardened and admin API remains authenticated', async (t) => {
  const env = await startService(t)
  const dashboard = await textRequest(env.endpoint.baseUrl, '/dashboard')
  assert.equal(dashboard.status, 200)
  assert.match(dashboard.headers.get('content-type'), /^text\/html/)
  assert.match(dashboard.headers.get('content-security-policy'), /default-src 'none'/)
  assert.equal(dashboard.headers.get('x-frame-options'), 'DENY')
  assert.match(dashboard.body, /Marveen Codex Bridge/)
  assert.doesNotMatch(dashboard.body, new RegExp(ADMIN_TOKEN))

  const script = await textRequest(env.endpoint.baseUrl, '/dashboard/app.js')
  assert.match(script.body, /reasoningEffort/)
  assert.match(dashboard.body, /id="settings-model"/)
  assert.match(script.body, /selectableModels/)
  assert.match(dashboard.body, /<th>Effort<\/th>/)
  assert.match(dashboard.body, /Developer instructions/)
  assert.match(dashboard.body, /Előző beállítás visszaállítása/)
  assert.match(script.body, /\/v1\/dashboard\/agent-settings/)
  assert.match(script.body, /window\.confirm/)
  assert.equal(script.status, 200)
  assert.match(script.headers.get('content-type'), /^text\/javascript/)
  assert.match(script.body, /sessionStorage/)
  assert.doesNotMatch(dashboard.body, /Képartifactok|id="artifacts"/)
  assert.doesNotMatch(script.body, /\/v1\/artifacts|createObjectURL|renderArtifacts/)

  assert.equal((await jsonRequest(
    env.endpoint.baseUrl,
    '/v1/dashboard/summary',
  )).status, 401)
  const summary = await jsonRequest(
    env.endpoint.baseUrl,
    '/v1/dashboard/summary',
    { token: ADMIN_TOKEN },
  )
  assert.equal(summary.status, 200)
  assert.equal(summary.body.data.bridgeVersion, '0.3.4.1')
  assert.equal(summary.body.data.readiness.ready, true)
  assert.equal(summary.body.data.agents[0].id, 'programozo')
  assert.equal(Object.hasOwn(summary.body.data.counts, 'artifacts'), false)

  const runs = await jsonRequest(env.endpoint.baseUrl, '/v1/runs', {
    token: ADMIN_TOKEN,
  })
  assert.equal(runs.status, 200)
  assert.deepEqual(runs.body.data, [])
})

test('Federation replay is deduplicated and changed replay conflicts', async (t) => {
  const env = await startService(t)
  const send = (body) => jsonRequest(env.endpoint.baseUrl, '/api/federation/inbox', {
    method: 'POST',
    token: INBOUND_TOKEN,
    body,
  })
  assert.equal((await send(inbound())).status, 202)
  const duplicate = await send(inbound())
  assert.equal(duplicate.status, 202)
  assert.deepEqual(duplicate.body, { id: 1, ref: '600', duplicate: true })
  const conflict = await send(inbound({ content: 'Megváltoztatott payload' }))
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error, 'idempotency_conflict')
  assert.equal(env.service.store.listInbox().length, 1)
})

test('pending inbox survives full service restart and is then delivered', async (t) => {
  const root = temporaryRoot(t)
  const peer = await marveenPeer(t)
  const first = await startService(t, { root, peer, runtime: runtime() })
  assert.equal((await jsonRequest(first.endpoint.baseUrl, '/api/federation/inbox', {
    method: 'POST',
    token: INBOUND_TOKEN,
    body: inbound({ ref: 'restart-1' }),
  })).status, 202)
  await first.service.stop()

  const secondRuntime = runtime(async () => 'RESTART_RECOVERY_OK')
  const second = await startService(t, { root, peer, runtime: secondRuntime })
  const tick = await second.service.tick()
  assert.equal(tick.inbox.completed, 1)
  assert.equal(tick.outbox.delivered, 1)
  assert.equal(secondRuntime.calls.length, 1)
  assert.equal(peer.requests.length, 1)
  assert.equal(JSON.parse(peer.requests[0].body).content, 'RESTART_RECOVERY_OK')
})

test('runtime readiness failure returns 503 and preserves accepted inbox', async (t) => {
  const codexRuntime = runtime()
  codexRuntime.setReady(false)
  const env = await startService(t, { runtime: codexRuntime })
  const ready = await jsonRequest(env.endpoint.baseUrl, '/readyz')
  assert.equal(ready.status, 503)
  assert.equal(ready.body.runtime, false)
  assert.equal((await jsonRequest(env.endpoint.baseUrl, '/api/federation/inbox', {
    method: 'POST',
    token: INBOUND_TOKEN,
    body: inbound(),
  })).status, 202)
  const tick = await env.service.tick()
  assert.equal(tick.inbox.retried, 1)
  assert.equal(env.service.store.listInbox()[0].state, 'accepted')
  assert.equal(env.service.store.listOutbox().length, 0)
})

test('invalid sender, unknown target, malformed JSON and oversized body fail closed', async (t) => {
  const env = await startService(t)
  assert.equal((await jsonRequest(env.endpoint.baseUrl, '/api/federation/inbox', {
    method: 'POST',
    token: INBOUND_TOKEN,
    body: inbound({ from: 'other/bela' }),
  })).status, 403)
  assert.equal((await jsonRequest(env.endpoint.baseUrl, '/api/federation/inbox', {
    method: 'POST',
    token: INBOUND_TOKEN,
    body: inbound({ to: 'missing' }),
  })).status, 404)
  assert.equal((await jsonRequest(env.endpoint.baseUrl, '/api/federation/inbox', {
    method: 'POST',
    token: INBOUND_TOKEN,
    body: '{broken',
  })).status, 400)
  assert.equal((await jsonRequest(env.endpoint.baseUrl, '/api/federation/inbox', {
    method: 'POST',
    token: INBOUND_TOKEN,
    body: {
      ...inbound(),
      content: 'x'.repeat(64 * 1024),
    },
  })).status, 413)
  assert.equal(env.service.store.listInbox().length, 0)
})

test('automatic workers complete an accepted message without manual tick', async (t) => {
  const env = await startService(t, { autoWorkers: true })
  assert.equal((await jsonRequest(env.endpoint.baseUrl, '/api/federation/inbox', {
    method: 'POST',
    token: INBOUND_TOKEN,
    body: inbound({ ref: 'auto-1' }),
  })).status, 202)
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const inbox = env.service.store.listInbox()[0]
    const outbox = env.service.store.listOutbox()[0]
    if (
      env.peer.requests.length === 1
      && inbox?.state === 'completed'
      && outbox?.state === 'delivered'
    ) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(env.peer.requests.length, 1)
  assert.equal(env.service.store.listInbox()[0].state, 'completed')
  assert.equal(env.service.store.listOutbox()[0].state, 'delivered')
})
