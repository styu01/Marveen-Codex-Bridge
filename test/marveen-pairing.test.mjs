import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  PairingError,
  rollbackMarveenPairing,
  stageMarveenPairing,
  summarizeMarveenPairing,
} from '../src/marveen-pairing.mjs'

const servers = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

function privateToken(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${value}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

async function mockMarveen({ createdToken = 'm'.repeat(64), initiallyEnabled = false, existing = [] } = {}) {
  let enabled = initiallyEnabled
  const peers = [...existing]
  const calls = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    calls.push({ method: request.method, url: request.url, body })
    response.setHeader('Content-Type', 'application/json')
    if (request.headers.authorization !== `Bearer ${'d'.repeat(64)}`) {
      response.statusCode = 401
      response.end('{"error":"unauthorized"}')
      return
    }
    if (request.method === 'GET' && request.url === '/api/federation/peers') {
      response.end(JSON.stringify({ enabled, systemId: 'bela', peers }))
      return
    }
    if (request.method === 'POST' && request.url === '/api/federation/peers') {
      const input = JSON.parse(body)
      const peer = {
        id: input.id,
        baseUrl: input.baseUrl,
        trust: 'untrusted',
        hasInboundToken: true,
        hasOutboundToken: Boolean(input.outboundToken),
        shareCapabilitySummaries: input.shareCapabilitySummaries === true,
        abandonWindowMinutes: input.abandonWindowMinutes,
      }
      peers.push(peer)
      response.statusCode = 201
      response.end(JSON.stringify({ peer, inboundToken: createdToken }))
      return
    }
    const match = request.url?.match(/^\/api\/federation\/peers\/([^/]+)$/)
    if (request.method === 'DELETE' && match) {
      const index = peers.findIndex((peer) => peer.id === decodeURIComponent(match[1]))
      if (index >= 0) peers.splice(index, 1)
      response.end('{"ok":true}')
      return
    }
    response.statusCode = 404
    response.end('{"error":"not found"}')
  })
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { origin: `http://127.0.0.1:${port}`, calls, peers, setEnabled: (value) => { enabled = value } }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'phase62-pairing-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dashboard = join(root, 'marveen/store/.dashboard-token')
  const inbound = join(root, 'bridge/marveen-inbound.token')
  const outbound = join(root, 'bridge/marveen-outbound.token')
  const state = join(root, 'state/phase6.2.json')
  privateToken(dashboard, 'd'.repeat(64))
  privateToken(inbound, 'b'.repeat(64))
  return { root, dashboard, inbound, outbound, state }
}

test('pairing preflight is read-only and reports an available peer id', async (t) => {
  const paths = fixture(t)
  const mock = await mockMarveen()
  const result = await stageMarveenPairing({
    marveenOrigin: mock.origin,
    dashboardTokenFile: paths.dashboard,
    bridgeInboundTokenFile: paths.inbound,
    bridgeOutboundTokenFile: paths.outbound,
    stateFile: paths.state,
  })
  assert.equal(result.status, 'preflight')
  assert.equal(mock.calls.length, 1)
  assert.equal(mock.calls[0].method, 'GET')
  assert.equal(existsSync(paths.outbound), false)
  assert.equal(existsSync(paths.state), false)
})

test('execute pairs both directions but leaves Federation disabled', async (t) => {
  const paths = fixture(t)
  const mock = await mockMarveen()
  const result = await stageMarveenPairing({
    marveenOrigin: mock.origin,
    dashboardTokenFile: paths.dashboard,
    bridgeInboundTokenFile: paths.inbound,
    bridgeOutboundTokenFile: paths.outbound,
    stateFile: paths.state,
    execute: true,
  })
  assert.equal(result.status, 'paired-disabled')
  assert.equal(mock.peers.length, 1)
  assert.equal(readFileSync(paths.outbound, 'utf8').trim(), 'm'.repeat(64))
  assert.equal(lstatSync(paths.outbound).mode & 0o777, 0o600)
  assert.equal(lstatSync(paths.state).mode & 0o777, 0o600)
  const persisted = JSON.parse(readFileSync(paths.state, 'utf8'))
  assert.equal(persisted.peerCreatedByPhase62, true)
  assert.equal(persisted.federationEnabled, false)
  assert.equal(JSON.stringify(persisted).includes('m'.repeat(32)), false)
  assert.equal(JSON.stringify(persisted).includes('b'.repeat(32)), false)
  const post = mock.calls.find((call) => call.method === 'POST')
  assert.equal(JSON.parse(post.body).outboundToken, 'b'.repeat(64))
})

test('unowned existing peer or enabled Federation fails closed without mutation', async (t) => {
  const paths = fixture(t)
  const existing = await mockMarveen({ existing: [{ id: 'codex' }] })
  await assert.rejects(
    stageMarveenPairing({
      marveenOrigin: existing.origin,
      dashboardTokenFile: paths.dashboard,
      bridgeInboundTokenFile: paths.inbound,
      bridgeOutboundTokenFile: paths.outbound,
      stateFile: paths.state,
      execute: true,
    }),
    (error) => error instanceof PairingError && error.code === 'pairing_state_missing',
  )
  assert.equal(existing.calls.length, 1)

  const enabled = await mockMarveen({ initiallyEnabled: true })
  await assert.rejects(
    stageMarveenPairing({
      marveenOrigin: enabled.origin,
      dashboardTokenFile: paths.dashboard,
      bridgeInboundTokenFile: paths.inbound,
      bridgeOutboundTokenFile: paths.outbound,
      stateFile: paths.state,
      execute: true,
    }),
    (error) => error instanceof PairingError && error.code === 'federation_already_enabled',
  )
  assert.equal(enabled.calls.length, 1)
})

test('a matching disabled peer is safely resumed after a failed cutover', async (t) => {
  const paths = fixture(t)
  const mock = await mockMarveen()
  const first = await stageMarveenPairing({
    marveenOrigin: mock.origin,
    dashboardTokenFile: paths.dashboard,
    bridgeInboundTokenFile: paths.inbound,
    bridgeOutboundTokenFile: paths.outbound,
    stateFile: paths.state,
    execute: true,
  })
  assert.equal(first.createdNow, true)
  const resumed = await stageMarveenPairing({
    marveenOrigin: mock.origin,
    dashboardTokenFile: paths.dashboard,
    bridgeInboundTokenFile: paths.inbound,
    bridgeOutboundTokenFile: paths.outbound,
    stateFile: paths.state,
    execute: true,
  })
  assert.equal(resumed.status, 'already-paired-disabled')
  assert.equal(resumed.createdNow, false)
  assert.deepEqual(summarizeMarveenPairing(resumed), {
    status: 'already-paired-disabled',
    createdNow: false,
    peerId: 'codex',
    marveenSystemId: 'bela',
  })
  assert.equal(mock.calls.filter((call) => call.method === 'POST').length, 1)
  assert.equal(mock.peers.length, 1)
})

test('rollback removes only a peer proven by the private pairing state', async (t) => {
  const paths = fixture(t)
  const mock = await mockMarveen()
  await stageMarveenPairing({
    marveenOrigin: mock.origin,
    dashboardTokenFile: paths.dashboard,
    bridgeInboundTokenFile: paths.inbound,
    bridgeOutboundTokenFile: paths.outbound,
    stateFile: paths.state,
    execute: true,
  })
  const result = await rollbackMarveenPairing({
    marveenOrigin: mock.origin,
    dashboardTokenFile: paths.dashboard,
    bridgeInboundTokenFile: paths.inbound,
    bridgeOutboundTokenFile: paths.outbound,
    stateFile: paths.state,
  })
  assert.equal(result.status, 'pairing-rolled-back')
  assert.equal(mock.peers.length, 0)
  assert.equal(existsSync(paths.state), false)
  assert.equal(mock.calls.filter((call) => call.method === 'DELETE').length, 1)
})

test('rollback refuses a pairing state or peer mismatch', async (t) => {
  const paths = fixture(t)
  const mock = await mockMarveen()
  await stageMarveenPairing({
    marveenOrigin: mock.origin,
    dashboardTokenFile: paths.dashboard,
    bridgeInboundTokenFile: paths.inbound,
    bridgeOutboundTokenFile: paths.outbound,
    stateFile: paths.state,
    execute: true,
  })
  const state = JSON.parse(readFileSync(paths.state, 'utf8'))
  state.bridgeOrigin = 'http://127.0.0.1:3999'
  writeFileSync(paths.state, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await assert.rejects(
    rollbackMarveenPairing({
      marveenOrigin: mock.origin,
      dashboardTokenFile: paths.dashboard,
      bridgeInboundTokenFile: paths.inbound,
      bridgeOutboundTokenFile: paths.outbound,
      stateFile: paths.state,
    }),
    (error) => error instanceof PairingError && error.code === 'pairing_state_mismatch',
  )
  assert.equal(mock.peers.length, 1)
  assert.equal(mock.calls.filter((call) => call.method === 'DELETE').length, 0)
})

test('invalid token returned by Marveen triggers peer rollback', async (t) => {
  const paths = fixture(t)
  const mock = await mockMarveen({ createdToken: 'short' })
  await assert.rejects(
    stageMarveenPairing({
      marveenOrigin: mock.origin,
      dashboardTokenFile: paths.dashboard,
      bridgeInboundTokenFile: paths.inbound,
      bridgeOutboundTokenFile: paths.outbound,
      stateFile: paths.state,
      execute: true,
    }),
    (error) => error instanceof PairingError && error.code === 'invalid_created_token',
  )
  assert.equal(mock.peers.length, 0)
  assert.equal(mock.calls.some((call) => call.method === 'DELETE'), true)
  assert.equal(existsSync(paths.outbound), false)
  assert.equal(existsSync(paths.state), false)
})
