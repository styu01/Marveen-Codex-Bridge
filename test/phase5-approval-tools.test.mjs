import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { CodexAppServerRuntime } from '../src/codex-app-server-runtime.mjs'
import { FederationBridgeService } from '../src/service.mjs'

const betterSqlite3Path = process.env.MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH
if (!betterSqlite3Path) throw new Error('production better-sqlite3 path is required')

const ADMIN = 'phase5-admin-token-0000000000000000000'
const INBOUND = 'phase5-inbound-token-00000000000000000'
const OUTBOUND = 'phase5-outbound-token-000000000000000'

async function mockMarveen(t) {
  const received = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    received.push(payload)
    const body = JSON.stringify({ id: received.length, ref: payload.ref })
    response.writeHead(202, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    received,
  }
}

function config(root, peer, approvalPolicy = 'manual') {
  return {
    version: 1,
    systemId: 'codex',
    listen: { host: '127.0.0.1', port: 0 },
    storage: { database: join(root, 'state', 'federation.sqlite3') },
    codex: {
      binary: resolve('test/fixtures/fake-codex-app-server.mjs'),
      expectedVersion: '0.164.0',
      runtimeRoot: join(root, 'runtime'),
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      turnTimeoutMs: 5_000,
      approvalTimeoutMs: 5_000,
    },
    admin: { token: ADMIN },
    agents: [{
      id: 'programozo',
      displayName: 'Programozó',
      model: 'gpt-5.6-terra',
      workspacePath: join(root, 'workspace'),
      sandboxMode: 'workspace-write',
      approvalPolicy,
      reasoningEffort: 'high',
      networkEnabled: false,
      developerInstructions: 'Phase 5 test.',
      federationPeer: 'marveen',
    }],
    peers: [{
      id: 'marveen',
      baseUrl: new URL(peer.baseUrl),
      inboundToken: INBOUND,
      outboundToken: OUTBOUND,
    }],
    workers: {
      intervalMs: 100,
      runtimeLeaseMs: 10_000,
      runtimeMaxAttempts: 3,
      deliveryTimeoutMs: 1_000,
      deliveryLeaseMs: 5_000,
      deliveryMaxAttempts: 3,
    },
  }
}

async function launch(t, approvalPolicy = 'manual') {
  const root = mkdtempSync(join(tmpdir(), 'codex-phase5-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'runtime'))
  mkdirSync(join(root, 'workspace'))
  const peer = await mockMarveen(t)
  const serviceConfig = config(root, peer, approvalPolicy)
  const runtime = new CodexAppServerRuntime({
    config: serviceConfig,
    environment: { ...process.env, NODE_OPTIONS: '--no-warnings' },
    betterSqlite3Path,
  })
  const service = new FederationBridgeService({
    config: serviceConfig,
    runtime,
    driver: 'better-sqlite3',
    betterSqlite3Path,
    autoWorkers: false,
  })
  await runtime.start()
  const endpoint = await service.start()
  t.after(async () => {
    runtime.prepareStop()
    if (service.server.listening) await service.stop()
    await runtime.stop()
  })
  return { root, peer, runtime, service, endpoint }
}

async function send(endpoint, ref, content) {
  return fetch(`${endpoint.baseUrl}/api/federation/inbox`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${INBOUND}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      federationVersion: 1,
      from: 'marveen/bela',
      to: 'programozo',
      content,
      ref,
    }),
  })
}

async function admin(endpoint, path, options = {}) {
  return fetch(`${endpoint.baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  })
}

async function waitForApproval(runtime) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = runtime.listApprovals()
    if (rows.length === 1) return rows[0]
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  throw new Error('approval did not become pending')
}

test('manual approval is durable, identity-bound and idempotently approved', async (t) => {
  const env = await launch(t)
  assert.equal((await send(env.endpoint, 'approval-approve', 'APPROVAL_TEST')).status, 202)
  const tick = env.service.tick()
  const pending = await waitForApproval(env.runtime)
  assert.equal(pending.agentId, 'programozo')
  assert.equal(pending.category, 'command')
  assert.equal(pending.appServerGeneration, 1)

  const decision = await admin(
    env.endpoint,
    `/v1/approvals/${pending.approvalId}/decision`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  )
  assert.equal(decision.status, 200)
  assert.equal((await decision.json()).data.duplicate, false)
  const completed = await tick
  assert.equal(completed.inbox.completed, 1)
  assert.equal(env.runtime.getApproval(pending.approvalId).state, 'approved')
  assert.equal(env.peer.received.at(-1).content, 'FAKE_APPROVAL_RESULT:accept')

  const duplicate = await admin(
    env.endpoint,
    `/v1/approvals/${pending.approvalId}/decision`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  )
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json()).data.duplicate, true)
  const conflict = await admin(
    env.endpoint,
    `/v1/approvals/${pending.approvalId}/decision`,
    { method: 'POST', body: JSON.stringify({ decision: 'decline' }) },
  )
  assert.equal(conflict.status, 409)
})

test('manual approval decline completes the provider turn without executing approval', async (t) => {
  const env = await launch(t)
  assert.equal((await send(env.endpoint, 'approval-decline', 'APPROVAL_TEST')).status, 202)
  const tick = env.service.tick()
  const pending = await waitForApproval(env.runtime)
  const response = await admin(
    env.endpoint,
    `/v1/approvals/${pending.approvalId}/decision`,
    { method: 'POST', body: JSON.stringify({ decision: 'decline' }) },
  )
  assert.equal(response.status, 200)
  await tick
  assert.equal(env.runtime.getApproval(pending.approvalId).state, 'declined')
  assert.equal(env.peer.received.at(-1).content, 'FAKE_APPROVAL_RESULT:decline')
})

test('App Server generations remain unique across runtime restart', async (t) => {
  const env = await launch(t)
  assert.equal(env.runtime.generation, 1)
  await env.runtime.stop()
  await env.runtime.start()
  assert.equal(env.runtime.generation, 2)
})

test('dynamic Marveen message tool queues an identity-bound durable Federation outbox item', async (t) => {
  const env = await launch(t, 'never')
  assert.equal((await send(env.endpoint, 'dynamic-message', 'DYNAMIC_TOOL_TEST')).status, 202)
  const result = await env.service.tick()
  assert.equal(result.inbox.completed, 1)
  assert.equal(result.outbox.delivered, 2)
  const dynamic = env.peer.received.find(
    (message) => message.content === 'DYNAMIC_TOOL_DELIVERY_OK',
  )
  assert.ok(dynamic)
  assert.equal(dynamic.from, 'codex/programozo')
  assert.equal(dynamic.to, 'bela')
  assert.match(dynamic.ref, /^dynamic:[0-9a-f-]+:[0-9a-f-]+$/)
  assert.equal(
    env.service.store.listOutbox().filter(
      (row) => row.content === 'DYNAMIC_TOOL_DELIVERY_OK',
    ).length,
    1,
  )
})

test('dynamic tool fails closed without an active matching turn', async (t) => {
  const env = await launch(t, 'never')
  const result = env.runtime.handleDynamicToolCall({
    params: {
      threadId: 'unknown',
      turnId: 'unknown',
      callId: 'call',
      tool: 'marveen_agent_message_send',
      arguments: { to: 'bela', content: 'must-not-send' },
    },
  })
  assert.equal(result.success, false)
  assert.equal(env.service.store.listOutbox().length, 0)
})

test('shutdown expires a pending approval and releases the active turn', async (t) => {
  const env = await launch(t)
  assert.equal((await send(env.endpoint, 'approval-shutdown', 'APPROVAL_TEST')).status, 202)
  const tick = env.service.tick()
  const pending = await waitForApproval(env.runtime)
  env.runtime.prepareStop()
  await tick
  assert.equal(env.runtime.getApproval(pending.approvalId).state, 'expired')
  assert.equal(env.peer.received.at(-1).content, 'FAKE_APPROVAL_RESULT:decline')
})
