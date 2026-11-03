import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { FederationDurabilityStore } from '../src/durability-store.mjs'
import { FederationInboxOrchestrator } from '../src/inbox-orchestrator.mjs'
import { FederationBridgeService } from '../src/service.mjs'
import { CodexAppServerRuntime } from '../src/codex-app-server-runtime.mjs'
import { FederationOutboxWorker } from '../src/outbox-delivery.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fixture(t, clock = Date.now) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-reliability-034-'))
  const store = new FederationDurabilityStore(join(root, 'federation.sqlite3'), {
    clock, driver: 'builtin',
  })
  store.migrate()
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const inbox = store.acceptInbox({
    peerId: 'marveen', from: 'marveen/bela', to: 'programozo',
    content: 'CONTINUE_AFTER_LEASE', ref: 'lease-034',
  }).record
  return { store, inbox }
}

function worker(store, runtime, leaseMs = 120, workerId = 'worker-a') {
  return new FederationInboxOrchestrator({
    store, runtime, systemId: 'codex', workerId,
    leaseMs, heartbeatIntervalMs: 25, maxAttempts: 3,
  })
}

test('0.3.4 default runtime lease is thirty minutes', () => {
  const instance = new FederationInboxOrchestrator({
    store: {}, runtime: { run() {} }, systemId: 'codex', workerId: 'w',
  })
  assert.equal(instance.leaseMs, 1_800_000)
  assert.equal(instance.heartbeatIntervalMs, 30_000)
})

test('heartbeats keep a longer-than-lease Codex turn alive and enqueue exactly one reply', async (t) => {
  const { store, inbox } = fixture(t)
  let calls = 0
  const runtime = { async run() { calls++; await sleep(280); return { response: 'ONE_REPLY', runId: 'run-034' } } }
  const result = await worker(store, runtime).tick()
  assert.equal(result.completed, 1)
  assert.equal(result.failed, 0)
  assert.equal(store.getInbox(inbox.inboxId).state, 'completed')
  assert.equal(store.listOutbox().length, 1)
  assert.equal(calls, 1)
})

test('renewal is fenced: previous worker cannot extend an expired, reclaimed lease', (t) => {
  const time = { value: 1_000_000 }
  const { store, inbox } = fixture(t, () => time.value)
  store.claimInbox({ workerId: 'old', leaseMs: 100 })
  time.value += 101
  const claimed = store.claimInbox({ workerId: 'new', leaseMs: 1_000 })
  assert.equal(claimed.length, 1)
  assert.throws(
    () => store.renewClaimedInbox({ inboxId: inbox.inboxId, workerId: 'old', leaseMs: 200 }),
    (error) => error.code === 'lease_lost',
  )
  assert.equal(store.getInbox(inbox.inboxId).leaseOwner, 'new')
  const renewed = store.renewClaimedInbox({ inboxId: inbox.inboxId, workerId: 'new', leaseMs: 1_000 })
  assert.equal(renewed.state, 'dispatched')
})

test('renewal refuses expired ownership even before another worker claims it', (t) => {
  const time = { value: 1_000_000 }
  const { store, inbox } = fixture(t, () => time.value)
  store.claimInbox({ workerId: 'old', leaseMs: 100 })
  time.value += 100
  assert.throws(
    () => store.renewClaimedInbox({ inboxId: inbox.inboxId, workerId: 'old', leaseMs: 100 }),
    (error) => error.code === 'lease_lost',
  )
})

test('lost lease never throws twice, nor sends an orphan reply', async (t) => {
  const time = { value: 1_000_000 }
  const { store, inbox } = fixture(t, () => time.value)
  const runtime = { async run() {
    await sleep(65)
    time.value += 1_000
    store.claimInbox({ workerId: 'other', leaseMs: 1_000, maxAttempts: 3 })
    await sleep(50)
    return { response: 'STALE', runId: 'stale' }
  } }
  const result = await worker(store, runtime, 100).tick()
  assert.equal(result.lost, 1)
  assert.equal(result.completed, 0)
  assert.equal(store.listOutbox().length, 0)
  assert.equal(store.getInbox(inbox.inboxId).leaseOwner, 'other')
})

test('scheduler removes rejected ticks without creating an unhandled rejection', async () => {
  const host = { tick: async () => { throw Error('injected tick failure') }, activeTicks: new Set() }
  await assert.rejects(FederationBridgeService.prototype.scheduleTick.call(host), /injected/)
  await sleep(20)
  assert.equal(host.activeTicks.size, 0)
})

function runtimeForDeadline(timeoutMs, request) {
  const runtime = new CodexAppServerRuntime({
    config: { agents: [], codex: { turnTimeoutMs: timeoutMs } },
  })
  runtime.client = { request }
  return runtime
}

test('timed-out Codex turn requests provider interruption and waits for terminal notification', async () => {
  let calls = 0
  const runtime = runtimeForDeadline(30, async (method, params) => {
    assert.equal(method, 'turn/interrupt')
    assert.deepEqual(params, { threadId: 'thread-1', turnId: 'turn-1' })
    calls++
    return {}
  })
  const active = runtime.createActiveTurn({ runId: 'run-1', agentId: 'programozo', threadId: 'thread-1' })
  active.turnId = 'turn-1'
  runtime.activeByThread.set('thread-1', active)
  runtime.startTurnDeadline(active)
  await sleep(60)
  assert.equal(calls, 1)
  assert.equal(active.done, false) // RPC acknowledgement is not the terminal event.
  runtime.handleNotification({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turnId: 'turn-1', turn: { status: 'interrupted' } },
  })
  assert.equal((await active.completion).status, 'interrupted')
  assert.equal(active.timedOut, true)
})

test('unconfirmed interrupt quarantines runtime rather than accepting new turns', async () => {
  const runtime = runtimeForDeadline(20, async () => { throw Error('connection down') })
  runtime.compatible = true
  const active = runtime.createActiveTurn({ runId: 'run-2', agentId: 'programozo', threadId: 'thread-2' })
  active.turnId = 'turn-2'
  runtime.startTurnDeadline(active)
  await assert.rejects(active.completion, (error) => error.code === 'turn_interrupt_unconfirmed')
  assert.equal(runtime.compatible, false)
})

test('0.3.4 config migration upgrades to thirty minutes without touching model, peers or source', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-config-034-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const src = join(root, 'config.json'), dst = join(root, 'migrated.json')
  const original = {
    codex: { binary: '/tmp/codex', allowedModels: ['gpt-5.6-terra', 'gpt-6.1-sol'] },
    agents: [{ id: 'programozo', model: 'gpt-6.1-sol', reasoningEffort: 'medium' }],
    peers: [{ id: 'marveen', inboundTokenFile: '/tmp/secret' }],
    storage: { database: '/tmp/federation.sqlite3' },
    workers: { runtimeLeaseMs: 1_200_000, intervalMs: 250 },
  }
  const before = `${JSON.stringify(original)}\n`
  writeFileSync(src, before, { mode: 0o600 })
  const result = spawnSync(process.execPath, ['scripts/migrate-lease-0.3.4.mjs', src, dst], {
    cwd: process.cwd(), encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(src, 'utf8'), before)
  const after = JSON.parse(readFileSync(dst, 'utf8'))
  assert.equal(after.workers.runtimeLeaseMs, 1_800_000)
  assert.equal(after.workers.intervalMs, 250)
  assert.deepEqual(after.agents, original.agents)
  assert.deepEqual(after.codex, original.codex)
  assert.deepEqual(after.peers, original.peers)
})

test('0.3.4 migration rejects symlink and unsafe source without writing output', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-config-unsafe-034-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const src = join(root, 'config.json'), link = join(root, 'symlink.json'), dst = join(root, 'output.json')
  writeFileSync(src, '{}\n', { mode: 0o600 })
  symlinkSync(src, link)
  const linked = spawnSync(process.execPath, ['scripts/migrate-lease-0.3.4.mjs', link, dst])
  assert.notEqual(linked.status, 0)
  assert.equal(readFileSync(src, 'utf8'), '{}\n')
  chmodSync(src, 0o644)
  const publicSource = spawnSync(process.execPath, ['scripts/migrate-lease-0.3.4.mjs', src, dst])
  assert.notEqual(publicSource.status, 0)
  assert.equal(readFileSync(src, 'utf8'), '{}\n')
})

test('outbox lease loss during error handling is contained without a second exception', async () => {
  let attempts = 0
  const store = {
    markOutboxFailed: () => {
      attempts++
      throw Object.assign(new Error('lost'), { code: 'lease_lost' })
    },
  }
  const worker = new FederationOutboxWorker({
    store,
    workerId: 'outbox-a',
    peerResolver: () => null,
    fetchImpl: async () => { throw Error('should not be called') },
  })
  const outcome = await worker.deliver({ outboxId: 1, peerId: 'marveen' })
  assert.equal(outcome, 'lost')
  assert.equal(attempts, 1)
})

test('provider completion before deadline prevents spurious interrupt request', async () => {
  let interrupts = 0
  const runtime = runtimeForDeadline(40, async () => { interrupts++; return {} })
  const active = runtime.createActiveTurn({ runId: 'run-fast', agentId: 'programozo', threadId: 'thread-fast' })
  active.turnId = 'turn-fast'
  runtime.activeByThread.set('thread-fast', active)
  runtime.startTurnDeadline(active)
  runtime.handleNotification({
    method: 'turn/completed',
    params: { threadId: 'thread-fast', turnId: 'turn-fast', turn: { status: 'completed' } },
  })
  assert.equal((await active.completion).status, 'completed')
  await sleep(60)
  assert.equal(interrupts, 0)
})

test('a submitted non-replayable Codex error is terminal, not retried', async (t) => {
  const { store, inbox } = fixture(t)
  let calls = 0
  const runtime = { async run() {
    calls++
    throw Object.assign(new Error('submitted turn uncertain'), { code: 'turn_interrupt_unconfirmed' })
  } }
  const instance = worker(store, runtime)
  const summary = await instance.tick()
  assert.equal(summary.failed, 1)
  assert.equal(store.getInbox(inbox.inboxId).state, 'failed')
  assert.equal(store.getInbox(inbox.inboxId).attempts, 1)
  assert.equal(store.getInbox(inbox.inboxId).errorCode, 'turn_interrupt_unconfirmed')
  assert.equal(calls, 1)
  assert.equal((await instance.tick()).claimed, 0)
})
