import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FederationDurabilityStore } from '../src/durability-store.mjs'

const betterSqlite3Path = process.env.MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH

if (!betterSqlite3Path) {
  throw new Error(
    'MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH is required; '
    + 'production driver tests must never be skipped',
  )
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-phase3-driver-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function scenario(path, driver) {
  let now = 1_000
  const store = new FederationDurabilityStore(path, {
    driver,
    betterSqlite3Path,
    clock: () => now,
  })
  store.migrate()
  const accepted = store.acceptInbox({
    peerId: 'marveen',
    from: 'marveen/bela',
    to: 'programozo',
    content: 'Driver parity request',
    ref: 'driver-parity-1',
  })
  const duplicate = store.acceptInbox({
    peerId: 'marveen',
    from: 'marveen/bela',
    to: 'programozo',
    content: 'Driver parity request',
    ref: 'driver-parity-1',
  })
  const [claimed] = store.claimInbox({
    workerId: 'runtime-driver-test',
    leaseMs: 5_000,
    maxAttempts: 3,
  })
  now = 1_100
  const completed = store.completeClaimedInboxWithReply({
    inboxId: claimed.inboxId,
    workerId: 'runtime-driver-test',
    systemId: 'codex',
    response: 'DRIVER_PARITY_OK',
    runId: 'runtime-run-1',
  })
  const [outbox] = store.claimOutbox({
    workerId: 'delivery-driver-test',
    leaseMs: 5_000,
    maxAttempts: 3,
  })
  now = 1_200
  store.markOutboxDelivered({
    outboxId: outbox.outboxId,
    workerId: 'delivery-driver-test',
    httpStatus: 202,
    acknowledgement: { id: 88, ref: outbox.ref },
  })
  const result = {
    acceptedDuplicate: accepted.duplicate,
    duplicateDuplicate: duplicate.duplicate,
    inbox: store.getInbox(accepted.record.inboxId),
    outbox: store.getOutbox(completed.outbox.outboxId),
    events: store.listEvents(completed.outbox.outboxId),
    integrity: store.integrityCheck(),
  }
  store.checkpoint()
  store.close()
  return result
}

function normalize(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (key.endsWith('AtMs') || key === 'availableAtMs' || key === 'leaseExpiresAtMs') {
      return item === null ? null : '<timestamp>'
    }
    return item
  }))
}

test('builtin oracle and production better-sqlite3 driver have identical semantics', (t) => {
  const root = temporaryRoot(t)
  const builtin = scenario(join(root, 'builtin.sqlite3'), 'builtin')
  const production = scenario(join(root, 'production.sqlite3'), 'better-sqlite3')
  assert.deepEqual(normalize(production), normalize(builtin))
})

test('production better-sqlite3 database reopens with durable terminal state', (t) => {
  const root = temporaryRoot(t)
  const path = join(root, 'restart.sqlite3')
  scenario(path, 'better-sqlite3')

  const reopened = new FederationDurabilityStore(path, {
    driver: 'better-sqlite3',
    betterSqlite3Path,
  })
  reopened.migrate()
  assert.equal(reopened.listInbox()[0].state, 'completed')
  assert.equal(reopened.listOutbox()[0].state, 'delivered')
  const integrity = reopened.integrityCheck()
  assert.equal(integrity.ok, true)
  assert.equal(integrity.integrity, 'ok')
  assert.deepEqual(integrity.foreignKeyErrors, [])
  reopened.close()
})
