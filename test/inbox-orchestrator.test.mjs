import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FederationDurabilityStore } from '../src/durability-store.mjs'
import { FederationInboxOrchestrator } from '../src/inbox-orchestrator.mjs'
import { MockCodexRuntime } from '../src/mock-runtime.mjs'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-orchestration-'))
  const time = { value: 4_000_000 }
  const store = new FederationDurabilityStore(join(root, 'state.sqlite3'), {
    clock: () => time.value,
  })
  store.migrate()
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const agents = [{
    id: 'programozo',
    displayName: 'Programozó',
    model: 'gpt-5.6-terra',
  }]
  return { root, time, store, agents }
}

function accept(store, overrides = {}) {
  return store.acceptInbox({
    peerId: 'marveen',
    from: 'marveen/bela',
    to: 'programozo',
    content: 'Válaszolj: ORCHESTRATION_OK',
    ref: '500',
    ...overrides,
  }).record
}

function orchestrator(store, runtime, overrides = {}) {
  return new FederationInboxOrchestrator({
    store,
    runtime,
    systemId: 'codex',
    workerId: 'runtime-worker',
    leaseMs: 1_000,
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 1_000,
    jitterRatio: 0,
    ...overrides,
  })
}

test('inbox execution and reply enqueue commit as one durable result', async (t) => {
  const env = setup(t)
  const item = accept(env.store)
  const runtime = new MockCodexRuntime({
    agents: env.agents,
    responder: async () => 'ORCHESTRATION_OK',
  })
  const result = await orchestrator(env.store, runtime).tick()
  assert.deepEqual(result, {
    skipped: false,
    claimed: 1,
    completed: 1,
    retried: 0,
    failed: 0,
  })
  const inbox = env.store.getInbox(item.inboxId)
  assert.equal(inbox.state, 'completed')
  assert.equal(inbox.result.response, 'ORCHESTRATION_OK')
  assert.equal(runtime.calls.length, 1)
  const [reply] = env.store.listOutbox()
  assert.equal(reply.peerId, 'marveen')
  assert.equal(reply.from, 'codex/programozo')
  assert.equal(reply.to, 'bela')
  assert.equal(reply.content, 'ORCHESTRATION_OK')
  assert.equal(reply.messageKey, `inbox:${item.inboxId}:reply:v1`)
})

test('runtime failure is retried with backoff and later completes', async (t) => {
  const env = setup(t)
  const item = accept(env.store)
  let calls = 0
  const runtime = new MockCodexRuntime({
    agents: env.agents,
    responder: async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('temporary'), {
        code: 'runtime_temporary',
      })
      return 'RECOVERED'
    },
  })
  const worker = orchestrator(env.store, runtime)
  assert.equal((await worker.tick()).retried, 1)
  assert.equal(env.store.getInbox(item.inboxId).state, 'accepted')
  assert.equal(env.store.getInbox(item.inboxId).availableAtMs, env.time.value + 100)
  env.time.value += 100
  assert.equal((await worker.tick()).completed, 1)
  assert.equal(env.store.getInbox(item.inboxId).state, 'completed')
  assert.equal(env.store.listOutbox().length, 1)
})

test('runtime idempotency prevents a second model run after commit-path failure', async (t) => {
  const env = setup(t)
  const item = accept(env.store)
  const runtime = new MockCodexRuntime({
    agents: env.agents,
    responder: async () => 'STABLE_RESULT',
  })
  const original = env.store.completeClaimedInboxWithReply.bind(env.store)
  let failOnce = true
  env.store.completeClaimedInboxWithReply = (input) => {
    if (failOnce) {
      failOnce = false
      throw Object.assign(new Error('injected commit-path failure'), {
        code: 'commit_path_failed',
      })
    }
    return original(input)
  }
  const worker = orchestrator(env.store, runtime)
  assert.equal((await worker.tick()).retried, 1)
  assert.equal(runtime.calls.length, 1)
  env.time.value += 100
  assert.equal((await worker.tick()).completed, 1)
  assert.equal(runtime.calls.length, 1)
  assert.equal(env.store.getInbox(item.inboxId).state, 'completed')
  assert.equal(env.store.listOutbox().length, 1)
})

test('runtime failure becomes terminal at maxAttempts', async (t) => {
  const env = setup(t)
  const item = accept(env.store)
  const runtime = new MockCodexRuntime({
    agents: env.agents,
    responder: async () => {
      throw Object.assign(new Error('always fails'), { code: 'runtime_down' })
    },
  })
  const worker = orchestrator(env.store, runtime, { maxAttempts: 2 })
  assert.equal((await worker.tick()).retried, 1)
  env.time.value += 100
  assert.equal((await worker.tick()).failed, 1)
  assert.equal(env.store.getInbox(item.inboxId).state, 'failed')
  assert.equal(env.store.getInbox(item.inboxId).attempts, 2)
  assert.equal(env.store.listOutbox().length, 0)
})

test('expired runtime lease is recovered after restart', (t) => {
  const env = setup(t)
  const item = accept(env.store)
  env.store.claimInbox({
    workerId: 'crashed-runtime',
    leaseMs: 100,
    maxAttempts: 3,
  })
  env.time.value += 100
  const reclaimed = env.store.claimInbox({
    workerId: 'replacement-runtime',
    leaseMs: 100,
    maxAttempts: 3,
  })
  assert.equal(reclaimed.length, 1)
  assert.equal(reclaimed[0].inboxId, item.inboxId)
  assert.equal(reclaimed[0].attempts, 2)
})
