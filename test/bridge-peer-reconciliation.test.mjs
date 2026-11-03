import assert from 'node:assert/strict'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  BridgePeerReconciliationError,
  marveenSystemIdFromPairingResult,
  reconcileBridgePeerIdentity,
} from '../src/bridge-peer-reconciliation.mjs'
import { validateInbox } from '../src/federation-contract.mjs'

test('compact resumed-pairing result exposes the Marveen system id', () => {
  assert.equal(
    marveenSystemIdFromPairingResult({
      status: 'already-paired-disabled',
      createdNow: false,
      peerId: 'codex',
      marveenSystemId: 'bela',
    }),
    'bela',
  )
  assert.throws(
    () => marveenSystemIdFromPairingResult({
      marveenSystemId: 'bela',
      state: { marveenSystemId: 'other' },
    }),
    /conflicting Marveen system ids/,
  )
})

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-peer-reconcile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const configPath = join(root, 'config.json')
  const config = {
    version: 1,
    systemId: 'codex',
    agents: [{
      id: 'programozo',
      federationPeer: 'marveen',
    }],
    peers: [{
      id: 'marveen',
      baseUrl: 'http://127.0.0.1:3420',
      inboundTokenFile: '/private/inbound',
      outboundTokenFile: '/private/outbound',
    }],
    ...overrides,
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  })
  chmodSync(configPath, 0o600)
  return { root, configPath }
}

test('Bridge peer identity follows the Marveen API systemId atomically', (t) => {
  const { configPath } = fixture(t)
  const before = JSON.parse(readFileSync(configPath))
  assert.deepEqual(
    validateInbox({
      federationVersion: 1,
      from: 'bela/bela',
      to: 'programozo',
      content: 'canary',
      ref: 'phase7.8-before',
    }, {
      peerId: before.peers[0].id,
      ownSystemId: before.systemId,
      agents: new Set(['programozo']),
    }),
    {
      status: 403,
      error: 'from system does not match the authenticated peer',
    },
  )
  const preview = reconcileBridgePeerIdentity({
    configPath,
    marveenSystemId: 'Bela',
  })
  assert.deepEqual(preview, {
    changed: true,
    executed: false,
    bridgeSystemId: 'codex',
    previousPeerId: 'marveen',
    marveenSystemId: 'bela',
    configDirectory: join(configPath, '..'),
  })
  assert.equal(JSON.parse(readFileSync(configPath)).peers[0].id, 'marveen')

  const applied = reconcileBridgePeerIdentity({
    configPath,
    marveenSystemId: 'Bela',
    execute: true,
  })
  assert.equal(applied.changed, true)
  assert.equal(applied.executed, true)
  const config = JSON.parse(readFileSync(configPath))
  assert.equal(config.peers[0].id, 'bela')
  assert.equal(config.agents[0].federationPeer, 'bela')
  assert.equal(lstatSync(configPath).mode & 0o777, 0o600)
  assert.equal(config.peers[0].inboundTokenFile, '/private/inbound')
  assert.equal(config.peers[0].outboundTokenFile, '/private/outbound')
  assert.deepEqual(
    validateInbox({
      federationVersion: 1,
      from: 'bela/bela',
      to: 'programozo',
      content: 'canary',
      ref: 'phase7.8-after',
    }, {
      peerId: config.peers[0].id,
      ownSystemId: config.systemId,
      agents: new Set(['programozo']),
    }),
    {
      status: 202,
      value: {
        from: 'bela/bela',
        to: 'programozo',
        content: 'canary',
        ref: 'phase7.8-after',
      },
    },
  )
})

test('already reconciled Bridge config is an idempotent no-op', (t) => {
  const { configPath } = fixture(t, {
    agents: [{ id: 'programozo', federationPeer: 'bela' }],
    peers: [{ id: 'bela' }],
  })
  const before = readFileSync(configPath, 'utf8')
  const result = reconcileBridgePeerIdentity({
    configPath,
    marveenSystemId: 'bela',
    execute: true,
  })
  assert.equal(result.changed, false)
  assert.equal(readFileSync(configPath, 'utf8'), before)
})

test('unsafe identity, inventory and config paths fail closed', (t) => {
  const collision = fixture(t)
  assert.throws(
    () => reconcileBridgePeerIdentity({
      configPath: collision.configPath,
      marveenSystemId: 'codex',
      execute: true,
    }),
    (error) => (
      error instanceof BridgePeerReconciliationError
      && error.code === 'system_id_collision'
    ),
  )

  const peers = fixture(t, {
    peers: [{ id: 'one' }, { id: 'two' }],
    agents: [{ id: 'programozo', federationPeer: 'one' }],
  })
  assert.throws(
    () => reconcileBridgePeerIdentity({
      configPath: peers.configPath,
      marveenSystemId: 'bela',
      execute: true,
    }),
    (error) => (
      error instanceof BridgePeerReconciliationError
      && error.code === 'peer_inventory_mismatch'
    ),
  )

  const link = fixture(t)
  const target = join(link.root, 'target.json')
  writeFileSync(target, readFileSync(link.configPath), { mode: 0o600 })
  rmSync(link.configPath)
  symlinkSync(target, link.configPath)
  assert.throws(
    () => reconcileBridgePeerIdentity({
      configPath: link.configPath,
      marveenSystemId: 'bela',
      execute: true,
    }),
    (error) => (
      error instanceof BridgePeerReconciliationError
      && error.code === 'unsafe_config_file'
    ),
  )
})
