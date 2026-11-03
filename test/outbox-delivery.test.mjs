import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FederationDurabilityStore } from '../src/durability-store.mjs'
import { FederationOutboxWorker } from '../src/outbox-delivery.mjs'
import { requiredPeerConfiguration } from '../src/peer-config.mjs'

const TOKEN = 'federation-outbound-test-token-000000000'

function environment(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-fed-worker-'))
  const time = { value: 3_000_000 }
  const store = new FederationDurabilityStore(join(root, 'state.sqlite3'), {
    clock: () => time.value,
  })
  store.migrate()
  t.after(() => store.close())
  return { store, time }
}

function enqueue(store, overrides = {}) {
  return store.enqueueOutbox({
    peerId: 'marveen',
    messageKey: 'run:one:reply:v1',
    from: 'codex/programozo',
    to: 'bela',
    content: 'HTTP kézbesítés',
    ref: 'run:one:reply:v1',
    ...overrides,
  }).record
}

async function startPeer(t, handler) {
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
    await handler({ request, response, body, index: requests.length - 1 })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
  }
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function worker(store, peer, overrides = {}) {
  return new FederationOutboxWorker({
    store,
    workerId: 'http-worker',
    peerResolver: () => ({
      id: 'marveen',
      baseUrl: peer.baseUrl,
      outboundToken: TOKEN,
    }),
    timeoutMs: 100,
    leaseMs: 1_000,
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 1_000,
    jitterRatio: 0,
    ...overrides,
  })
}

test('worker sends the exact Federation v1 payload and records a 202 acknowledgement', async (t) => {
  const env = environment(t)
  const item = enqueue(env.store)
  const peer = await startPeer(t, ({ response, body }) => {
    json(response, 202, { id: 77, ref: JSON.parse(body).ref })
  })
  const result = await worker(env.store, peer).tick()
  assert.deepEqual(result, {
    skipped: false,
    claimed: 1,
    delivered: 1,
    retried: 0,
    dead: 0,
  })
  assert.equal(peer.requests.length, 1)
  assert.equal(peer.requests[0].method, 'POST')
  assert.equal(peer.requests[0].url, '/api/federation/inbox')
  assert.equal(peer.requests[0].headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(peer.requests[0].headers['idempotency-key'], item.messageKey)
  assert.deepEqual(JSON.parse(peer.requests[0].body), {
    federationVersion: 1,
    from: item.from,
    to: item.to,
    content: item.content,
    ref: item.ref,
  })
  assert.equal(env.store.getOutbox(item.outboxId).remoteId, '77')
})

test('duplicate acknowledgement is treated as delivered', async (t) => {
  const env = environment(t)
  const item = enqueue(env.store)
  const peer = await startPeer(t, ({ response }) => {
    json(response, 202, { id: 77, ref: item.ref, duplicate: true })
  })
  const result = await worker(env.store, peer).tick()
  assert.equal(result.delivered, 1)
  assert.equal(env.store.getOutbox(item.outboxId).state, 'delivered')
})

test('503 and 401 schedule retry instead of losing the message', async (t) => {
  const env = environment(t)
  const first = enqueue(env.store, { messageKey: 'm-503', ref: 'm-503' })
  const second = enqueue(env.store, { messageKey: 'm-401', ref: 'm-401' })
  const statuses = [503, 401]
  const peer = await startPeer(t, ({ response, index }) => {
    json(response, statuses[index], { error: `failure-${statuses[index]}` })
  })
  const result = await worker(env.store, peer).tick()
  assert.equal(result.retried, 2)
  assert.equal(env.store.getOutbox(first.outboxId).state, 'pending')
  assert.equal(env.store.getOutbox(second.outboxId).state, 'pending')
  assert.equal(env.store.getOutbox(first.outboxId).availableAtMs, env.time.value + 100)
  assert.equal(env.store.getOutbox(second.outboxId).availableAtMs, env.time.value + 100)
})

test('terminal 403 moves the message to dead-letter state', async (t) => {
  const env = environment(t)
  const item = enqueue(env.store)
  const peer = await startPeer(t, ({ response }) => {
    json(response, 403, { error: 'forbidden' })
  })
  const result = await worker(env.store, peer).tick()
  assert.equal(result.dead, 1)
  assert.equal(env.store.getOutbox(item.outboxId).state, 'dead')
  assert.equal(env.store.getOutbox(item.outboxId).lastHttpStatus, 403)
})

test('timeout aborts the request and schedules retry', async (t) => {
  const env = environment(t)
  const item = enqueue(env.store)
  const peer = await startPeer(t, async ({ response }) => {
    await new Promise((resolve) => setTimeout(resolve, 80))
    if (!response.destroyed) json(response, 202, { id: 1, ref: item.ref })
  })
  const result = await worker(env.store, peer, { timeoutMs: 20 }).tick()
  assert.equal(result.retried, 1)
  assert.match(env.store.getOutbox(item.outboxId).lastError, /timed out/)
})

test('malformed or mismatched success acknowledgement is retried', async (t) => {
  const env = environment(t)
  const malformed = enqueue(env.store, { messageKey: 'malformed', ref: 'malformed' })
  const mismatch = enqueue(env.store, { messageKey: 'mismatch', ref: 'mismatch' })
  const peer = await startPeer(t, ({ response, index }) => {
    if (index === 0) json(response, 202, { okay: true })
    else json(response, 202, { id: 2, ref: 'wrong-ref' })
  })
  const result = await worker(env.store, peer).tick()
  assert.equal(result.retried, 2)
  assert.match(env.store.getOutbox(malformed.outboxId).lastError, /invalid acknowledgement/)
  assert.match(env.store.getOutbox(mismatch.outboxId).lastError, /invalid acknowledgement/)
})

test('oversized acknowledgement is rejected without persisting its body', async (t) => {
  const env = environment(t)
  const item = enqueue(env.store)
  const peer = await startPeer(t, ({ response }) => {
    const body = JSON.stringify({
      id: 1,
      ref: item.ref,
      untrusted: 'SECRET-LIKE-REMOTE-TEXT'.repeat(4_000),
    })
    response.writeHead(202, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  })
  const result = await worker(env.store, peer).tick()
  assert.equal(result.retried, 1)
  assert.match(env.store.getOutbox(item.outboxId).lastError, /invalid acknowledgement/)
  assert.doesNotMatch(env.store.getOutbox(item.outboxId).lastError, /SECRET-LIKE/)
})

test('a multi-item batch starts all HTTP deliveries without serial timeout starvation', async (t) => {
  const env = environment(t)
  for (let index = 0; index < 5; index += 1) {
    enqueue(env.store, {
      messageKey: `parallel-${index}`,
      ref: `parallel-${index}`,
    })
  }
  let active = 0
  let maximumActive = 0
  const peer = await startPeer(t, async ({ response, body }) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active -= 1
    json(response, 202, { id: JSON.parse(body).ref, ref: JSON.parse(body).ref })
  })
  const result = await worker(env.store, peer, { timeoutMs: 200 }).tick(5)
  assert.equal(result.delivered, 5)
  assert.ok(maximumActive > 1, `expected concurrent delivery, observed ${maximumActive}`)
})

test('missing peer configuration schedules a bounded retry without exposing a token', async (t) => {
  const env = environment(t)
  const item = enqueue(env.store)
  const delivery = new FederationOutboxWorker({
    store: env.store,
    workerId: 'config-worker',
    peerResolver: () => null,
    timeoutMs: 20,
    leaseMs: 1_000,
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 1_000,
    jitterRatio: 0,
  })
  const result = await delivery.tick()
  assert.equal(result.retried, 1)
  assert.match(env.store.getOutbox(item.outboxId).lastError, /not configured/)
  assert.doesNotMatch(env.store.getOutbox(item.outboxId).lastError, /Bearer/)
})

test('re-entrant tick is skipped while the first delivery is running', async (t) => {
  const env = environment(t)
  const item = enqueue(env.store)
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  const delivery = new FederationOutboxWorker({
    store: env.store,
    workerId: 'single-flight-worker',
    peerResolver: () => ({
      id: 'marveen',
      baseUrl: 'http://127.0.0.1:9999',
      outboundToken: TOKEN,
    }),
    fetchImpl: async () => {
      await blocked
      return new Response(JSON.stringify({ id: 1, ref: item.ref }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const first = delivery.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await delivery.tick(), {
    skipped: true,
    claimed: 0,
    delivered: 0,
    retried: 0,
    dead: 0,
  })
  release()
  assert.equal((await first).delivered, 1)
})

test('peer configuration rejects credential URLs and non-loopback HTTP', () => {
  assert.throws(() => requiredPeerConfiguration({
    id: 'marveen',
    baseUrl: 'http://example.com',
    outboundToken: TOKEN,
  }, 'marveen'), /HTTPS/)
  assert.throws(() => requiredPeerConfiguration({
    id: 'marveen',
    baseUrl: 'https://user:pass@example.com',
    outboundToken: TOKEN,
  }, 'marveen'), /forbidden/)
  assert.deepEqual(requiredPeerConfiguration({
    id: 'MARVEEN',
    baseUrl: 'http://127.0.0.1:3420',
    outboundToken: TOKEN,
  }, 'marveen').id, 'marveen')
})
