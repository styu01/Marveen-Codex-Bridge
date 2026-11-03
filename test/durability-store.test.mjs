import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  computeBackoffMs,
  DurabilityError,
  FederationDurabilityStore,
  isRetryableDeliveryFailure,
} from '../src/durability-store.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLAIM_AND_CRASH = join(ROOT, 'test', 'helpers', 'claim-and-crash.mjs')
const CONCURRENT_ENQUEUE = join(ROOT, 'test', 'helpers', 'concurrent-enqueue.mjs')

function workspace(t, initialTime = 1_000_000) {
  const root = mkdtempSync(join(tmpdir(), 'codex-fed-durability-'))
  const databasePath = join(root, 'state', 'federation.sqlite3')
  const time = { value: initialTime }
  const open = (options = {}) => {
    const store = new FederationDurabilityStore(databasePath, {
      clock: () => time.value,
      ...options,
    })
    store.migrate()
    return store
  }
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
  })
  return { root, databasePath, time, open }
}

function inbox(overrides = {}) {
  return {
    peerId: 'marveen',
    from: 'marveen/bela',
    to: 'programozo',
    content: 'Tartós feladat',
    ref: '187',
    ...overrides,
  }
}

function outbox(overrides = {}) {
  return {
    peerId: 'marveen',
    messageKey: 'run:abc:reply:v1',
    from: 'codex/programozo',
    to: 'bela',
    content: 'Tartós válasz',
    ref: 'run:abc:reply:v1',
    ...overrides,
  }
}

function expectCode(run, code) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof DurabilityError)
    assert.equal(error.code, code)
    return true
  })
}

function runChild(argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argumentsList, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(
        `child failed code=${code} signal=${signal}: `
        + Buffer.concat(stderr).toString('utf8')
        + Buffer.concat(stdout).toString('utf8'),
      ))
    })
  })
}

test('migration is idempotent, private and SQLite integrity is clean', (t) => {
  const env = workspace(t)
  const store = env.open()
  store.migrate()
  assert.equal(statSync(env.databasePath).mode & 0o777, 0o600)
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2)
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  assert.deepEqual(store.integrityCheck(), {
    ok: true,
    integrity: 'ok',
    foreignKeyErrors: [],
  })
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,
    5,
  )
  store.close()
})

test('database path rejects symbolic-link redirection', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codex-fed-symlink-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const real = join(root, 'real')
  const linked = join(root, 'linked')
  mkdirSync(real)
  symlinkSync(real, linked, 'dir')
  expectCode(
    () => new FederationDurabilityStore(join(linked, 'state.sqlite3')),
    'unsafe_database_path',
  )
})

test('an applied migration cannot silently change', (t) => {
  const env = workspace(t)
  const migrationRoot = join(env.root, 'migrations')
  cpSync(join(ROOT, 'migrations'), migrationRoot, { recursive: true })
  const first = new FederationDurabilityStore(env.databasePath, {
    clock: () => env.time.value,
    migrationRoot,
  })
  first.migrate()
  first.close()
  appendFileSync(join(migrationRoot, '001_federation_durability.sql'), '\n-- tampered\n')
  const second = new FederationDurabilityStore(env.databasePath, {
    clock: () => env.time.value,
    migrationRoot,
  })
  expectCode(() => second.migrate(), 'migration_checksum_mismatch')
  second.close()
})

test('inbox message and lifecycle survive database reopen', (t) => {
  const env = workspace(t)
  let store = env.open()
  const accepted = store.acceptInbox(inbox())
  assert.equal(accepted.duplicate, false)
  const id = accepted.record.inboxId
  store.markInboxDispatched(id, 'run-1')
  env.time.value += 10
  store.completeInbox(id, { response: 'OK' })
  store.checkpoint()
  store.close()

  store = env.open()
  assert.deepEqual(store.getInbox(id), {
    ...accepted.record,
    state: 'completed',
    runId: 'run-1',
    result: { response: 'OK' },
    updatedAtMs: env.time.value,
    completedAtMs: env.time.value,
  })
  store.close()
})

test('persistent inbox dedup returns the original record after restart', (t) => {
  const env = workspace(t)
  let store = env.open()
  const first = store.acceptInbox(inbox())
  store.close()
  store = env.open()
  const duplicate = store.acceptInbox(inbox())
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.record.inboxId, first.record.inboxId)
  store.close()
})

test('same inbox ref with changed payload is an idempotency conflict', (t) => {
  const store = workspace(t).open()
  store.acceptInbox(inbox())
  expectCode(
    () => store.acceptInbox(inbox({ content: 'Másik tartalom' })),
    'idempotency_conflict',
  )
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM federation_inbox').get().count, 1)
  store.close()
})

test('inbox dedup is peer scoped and null refs remain independent', (t) => {
  const store = workspace(t).open()
  const one = store.acceptInbox(inbox())
  const otherPeer = store.acceptInbox(inbox({
    peerId: 'another',
    from: 'another/main',
  }))
  const noRefA = store.acceptInbox(inbox({ ref: null }))
  const noRefB = store.acceptInbox(inbox({ ref: null }))
  assert.notEqual(one.record.inboxId, otherPeer.record.inboxId)
  assert.notEqual(noRefA.record.inboxId, noRefB.record.inboxId)
  store.close()
})

test('storage boundary revalidates addressing, content and ref limits', (t) => {
  const store = workspace(t).open()
  assert.throws(() => store.acceptInbox(inbox({
    from: 'other/bela',
  })), /does not match/)
  assert.throws(() => store.acceptInbox(inbox({
    to: 'codex/programozo',
  })), /local agent/)
  assert.throws(() => store.acceptInbox(inbox({
    content: 'x'.repeat(60 * 1024 + 1),
  })), /exceeds/)
  assert.throws(() => store.acceptInbox(inbox({
    ref: 'r'.repeat(129),
  })), /128/)
  assert.throws(() => store.enqueueOutbox(outbox({
    from: 'marveen/fake',
  })), /impersonate/)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM federation_inbox').get().count, 0)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM federation_outbox').get().count, 0)
  store.close()
})

test('terminal inbox state rejects a second completion without mutation', (t) => {
  const store = workspace(t).open()
  const id = store.acceptInbox(inbox()).record.inboxId
  store.completeInbox(id, { value: 1 })
  expectCode(() => store.failInbox(id, 'late_failure'), 'invalid_state')
  assert.equal(store.getInbox(id).state, 'completed')
  assert.deepEqual(store.getInbox(id).result, { value: 1 })
  store.close()
})

test('outbox enqueue is idempotent and conflicting reuse is rejected', (t) => {
  const store = workspace(t).open()
  const first = store.enqueueOutbox(outbox())
  const duplicate = store.enqueueOutbox(outbox())
  assert.equal(first.duplicate, false)
  assert.equal(duplicate.duplicate, true)
  assert.equal(first.record.outboxId, duplicate.record.outboxId)
  expectCode(
    () => store.enqueueOutbox(outbox({ content: 'Eltérő válasz' })),
    'idempotency_conflict',
  )
  assert.equal(store.listOutbox().length, 1)
  store.close()
})

test('the same outbox message key may be used independently for another peer', (t) => {
  const store = workspace(t).open()
  const first = store.enqueueOutbox(outbox())
  const second = store.enqueueOutbox(outbox({
    peerId: 'secondary',
    to: 'main',
  }))
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, false)
  assert.notEqual(first.record.outboxId, second.record.outboxId)
  store.close()
})

test('two workers cannot claim the same outbox record', (t) => {
  const env = workspace(t)
  const firstConnection = env.open()
  firstConnection.enqueueOutbox(outbox({ messageKey: 'm1', ref: 'm1' }))
  firstConnection.enqueueOutbox(outbox({ messageKey: 'm2', ref: 'm2' }))
  firstConnection.enqueueOutbox(outbox({ messageKey: 'm3', ref: 'm3' }))
  const secondConnection = env.open()

  const workerA = firstConnection.claimOutbox({ workerId: 'worker-a', limit: 2 })
  const workerB = secondConnection.claimOutbox({ workerId: 'worker-b', limit: 2 })
  assert.deepEqual(workerA.map((row) => row.messageKey), ['m1', 'm2'])
  assert.deepEqual(workerB.map((row) => row.messageKey), ['m3'])
  assert.equal(new Set([...workerA, ...workerB].map((row) => row.outboxId)).size, 3)
  secondConnection.close()
  firstConnection.close()
})

test('four concurrent processes enqueue 200 durable records without loss', async (t) => {
  const env = workspace(t, 1_500_000)
  let store = env.open()
  store.close()
  await Promise.all(
    ['a', 'b', 'c', 'd'].map((prefix, index) => runChild([
      CONCURRENT_ENQUEUE,
      env.databasePath,
      prefix,
      '50',
      String(env.time.value + index),
    ])),
  )
  store = env.open()
  const records = store.listOutbox()
  assert.equal(records.length, 200)
  assert.equal(new Set(records.map((row) => row.messageKey)).size, 200)
  assert.equal(store.integrityCheck().ok, true)
  store.close()
})

test('expired lease is recovered after store restart and stale worker loses ownership', (t) => {
  const env = workspace(t)
  let store = env.open()
  const id = store.enqueueOutbox(outbox()).record.outboxId
  store.claimOutbox({ workerId: 'old-worker', leaseMs: 100 })
  store.close()
  env.time.value += 100
  store = env.open()
  const reclaimed = store.claimOutbox({ workerId: 'new-worker', leaseMs: 100 })
  assert.equal(reclaimed.length, 1)
  assert.equal(reclaimed[0].outboxId, id)
  assert.equal(reclaimed[0].attempts, 2)
  expectCode(
    () => store.markOutboxDelivered({ outboxId: id, workerId: 'old-worker' }),
    'lease_lost',
  )
  const events = store.listEvents(id).map((event) => event.type)
  assert.deepEqual(events, ['enqueued', 'claimed', 'lease_recovered', 'claimed'])
  store.close()
})

test('real child-process crash leaves a recoverable lease', (t) => {
  const env = workspace(t, 2_000_000)
  let store = env.open()
  const id = store.enqueueOutbox(outbox()).record.outboxId
  store.close()

  const child = spawnSync(process.execPath, [CLAIM_AND_CRASH, env.databasePath, String(env.time.value)], {
    encoding: 'utf8',
  })
  assert.equal(child.status, 91, child.stderr)
  env.time.value += 1_000
  store = env.open()
  const reclaimed = store.claimOutbox({
    workerId: 'recovery-worker',
    leaseMs: 1_000,
    maxAttempts: 3,
  })
  assert.equal(reclaimed.length, 1)
  assert.equal(reclaimed[0].outboxId, id)
  assert.equal(reclaimed[0].attempts, 2)
  store.close()
})

test('successful delivery is durable and never claimable again', (t) => {
  const env = workspace(t)
  let store = env.open()
  const id = store.enqueueOutbox(outbox()).record.outboxId
  store.claimOutbox({ workerId: 'worker' })
  const delivered = store.markOutboxDelivered({
    outboxId: id,
    workerId: 'worker',
    remoteId: 42,
    httpStatus: 202,
  })
  assert.equal(delivered.state, 'delivered')
  assert.equal(delivered.remoteId, '42')
  store.close()
  store = env.open()
  assert.equal(store.getOutbox(id).state, 'delivered')
  assert.deepEqual(store.claimOutbox({ workerId: 'worker-2' }), [])
  store.close()
})

test('retry classifier matches the Federation delivery policy', () => {
  assert.equal(isRetryableDeliveryFailure({ networkError: true }), true)
  for (const status of [401, 408, 425, 429, 500, 503]) {
    assert.equal(isRetryableDeliveryFailure({ httpStatus: status }), true)
  }
  for (const status of [400, 403, 404, 409, 422]) {
    assert.equal(isRetryableDeliveryFailure({ httpStatus: status }), false)
  }
})

test('retry uses deterministic exponential backoff and preserves payload/ref', (t) => {
  const env = workspace(t)
  const store = env.open()
  const original = store.enqueueOutbox(outbox()).record
  store.claimOutbox({ workerId: 'worker', leaseMs: 100 })
  const retry = store.markOutboxFailed({
    outboxId: original.outboxId,
    workerId: 'worker',
    error: 'HTTP 503',
    httpStatus: 503,
    initialDelayMs: 1_000,
    maxDelayMs: 10_000,
    jitterRatio: 0.2,
    random: () => 0.5,
  })
  assert.equal(retry.state, 'pending')
  assert.equal(retry.attempts, 1)
  assert.equal(retry.availableAtMs, env.time.value + 1_100)
  assert.equal(retry.content, original.content)
  assert.equal(retry.ref, original.ref)
  env.time.value += 1_099
  assert.deepEqual(store.claimOutbox({ workerId: 'early' }), [])
  env.time.value += 1
  assert.equal(store.claimOutbox({ workerId: 'retry-worker' }).length, 1)
  store.close()
})

test('non-retryable HTTP response becomes dead immediately', (t) => {
  const store = workspace(t).open()
  const id = store.enqueueOutbox(outbox()).record.outboxId
  store.claimOutbox({ workerId: 'worker' })
  const dead = store.markOutboxFailed({
    outboxId: id,
    workerId: 'worker',
    error: 'HTTP 403',
    httpStatus: 403,
  })
  assert.equal(dead.state, 'dead')
  assert.equal(dead.deadAtMs, dead.updatedAtMs)
  assert.deepEqual(store.claimOutbox({ workerId: 'other' }), [])
  store.close()
})

test('retryable failures become dead exactly at maxAttempts', (t) => {
  const env = workspace(t)
  const store = env.open()
  const id = store.enqueueOutbox(outbox()).record.outboxId
  store.claimOutbox({ workerId: 'first' })
  const retry = store.markOutboxFailed({
    outboxId: id,
    workerId: 'first',
    error: 'network down',
    networkError: true,
    maxAttempts: 2,
    initialDelayMs: 10,
    maxDelayMs: 10,
    jitterRatio: 0,
  })
  assert.equal(retry.state, 'pending')
  env.time.value += 10
  store.claimOutbox({ workerId: 'second' })
  const dead = store.markOutboxFailed({
    outboxId: id,
    workerId: 'second',
    error: 'network still down',
    networkError: true,
    maxAttempts: 2,
  })
  assert.equal(dead.state, 'dead')
  assert.equal(dead.attempts, 2)
  store.close()
})

test('lease expiry at maxAttempts moves the record to dead', (t) => {
  const env = workspace(t)
  const store = env.open()
  const id = store.enqueueOutbox(outbox()).record.outboxId
  store.claimOutbox({ workerId: 'crasher', leaseMs: 50, maxAttempts: 1 })
  env.time.value += 50
  assert.deepEqual(
    store.claimOutbox({ workerId: 'recovery', leaseMs: 50, maxAttempts: 1 }),
    [],
  )
  assert.equal(store.getOutbox(id).state, 'dead')
  assert.equal(store.listEvents(id).at(-1).detail.reason, 'lease_expired_max_attempts')
  store.close()
})

test('delivery event history is ordered, durable and complete', (t) => {
  const env = workspace(t)
  let store = env.open()
  const id = store.enqueueOutbox(outbox()).record.outboxId
  store.claimOutbox({ workerId: 'worker-1' })
  store.markOutboxFailed({
    outboxId: id,
    workerId: 'worker-1',
    error: 'timeout',
    networkError: true,
    initialDelayMs: 10,
    maxDelayMs: 10,
    jitterRatio: 0,
  })
  env.time.value += 10
  store.claimOutbox({ workerId: 'worker-2' })
  store.markOutboxDelivered({ outboxId: id, workerId: 'worker-2', remoteId: '99' })
  store.close()
  store = env.open()
  assert.deepEqual(
    store.listEvents(id).map((event) => event.type),
    ['enqueued', 'claimed', 'retry_scheduled', 'claimed', 'delivered'],
  )
  assert.deepEqual(
    store.listEvents(id).map((event) => event.attempt),
    [0, 1, 1, 2, 2],
  )
  store.close()
})

test('backoff is capped and validates its injected random source', () => {
  assert.equal(computeBackoffMs({
    attempt: 20,
    initialDelayMs: 1_000,
    maxDelayMs: 5_000,
    jitterRatio: 0,
  }), 5_000)
  assert.throws(() => computeBackoffMs({
    attempt: 1,
    initialDelayMs: 1_000,
    maxDelayMs: 5_000,
    random: () => 1,
  }), /random/)
})
