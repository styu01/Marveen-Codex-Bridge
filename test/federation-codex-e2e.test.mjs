import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { CodexAppServerRuntime } from '../src/codex-app-server-runtime.mjs'
import { FederationBridgeService } from '../src/service.mjs'

const betterSqlite3Path = process.env.MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH
if (!betterSqlite3Path) throw new Error('production better-sqlite3 path is required')

const ADMIN_TOKEN = 'phase4-admin-token-000000000000000000'
const INBOUND_TOKEN = 'phase4-inbound-token-000000000000000'
const OUTBOUND_TOKEN = 'phase4-outbound-token-00000000000000'

async function peer(t) {
  const received = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    received.push({ payload, authorization: request.headers.authorization })
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

function makeConfig(root, marveenPeer) {
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
    },
    admin: { tokenFile: join(root, 'admin.token'), token: ADMIN_TOKEN },
    agents: [{
      id: 'programozo',
      displayName: 'Codex programozó',
      model: 'gpt-5.6-terra',
      capabilitySummary: 'Federation E2E',
      workspacePath: join(root, 'workspace'),
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      reasoningEffort: 'high',
      networkEnabled: false,
      developerInstructions: 'Federation Phase 4 E2E.',
    }],
    peers: [{
      id: 'marveen',
      baseUrl: new URL(marveenPeer.baseUrl),
      inboundToken: INBOUND_TOKEN,
      outboundToken: OUTBOUND_TOKEN,
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

async function launch(config, environment) {
  const runtime = new CodexAppServerRuntime({
    config,
    environment,
    betterSqlite3Path,
  })
  const service = new FederationBridgeService({
    config,
    runtime,
    driver: 'better-sqlite3',
    betterSqlite3Path,
    autoWorkers: false,
  })
  await runtime.start()
  const endpoint = await service.start()
  return {
    runtime,
    service,
    endpoint,
    async stop() {
      if (service.server.listening) await service.stop()
      await runtime.stop()
    },
  }
}

async function send(baseUrl, ref, content) {
  return fetch(`${baseUrl}/api/federation/inbox`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${INBOUND_TOKEN}`,
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

test('full Federation service uses Codex App Server and resumes thread after restart', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codex-phase4-fed-e2e-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'runtime'))
  mkdirSync(join(root, 'workspace'))
  const marveenPeer = await peer(t)
  const config = makeConfig(root, marveenPeer)
  const protocolLog = join(root, 'protocol.jsonl')
  const environment = {
    ...process.env,
    NODE_OPTIONS: '--no-warnings',
    FAKE_CODEX_PROTOCOL_LOG: protocolLog,
  }

  const first = await launch(config, environment)
  assert.equal((await send(
    first.endpoint.baseUrl,
    'phase4-fed-1',
    'FEDERATION_CODEX_FIRST',
  )).status, 202)
  const firstTick = await first.service.tick()
  assert.equal(firstTick.inbox.completed, 1)
  assert.equal(firstTick.outbox.delivered, 1)
  await first.stop()

  const second = await launch(config, environment)
  t.after(() => second.stop())
  assert.equal((await send(
    second.endpoint.baseUrl,
    'phase4-fed-2',
    'FEDERATION_CODEX_SECOND',
  )).status, 202)
  const secondTick = await second.service.tick()
  assert.equal(secondTick.inbox.completed, 1)
  assert.equal(secondTick.outbox.delivered, 1)

  assert.equal(marveenPeer.received.length, 2)
  assert.equal(marveenPeer.received[0].authorization, `Bearer ${OUTBOUND_TOKEN}`)
  assert.match(marveenPeer.received[0].payload.content, /FEDERATION_CODEX_FIRST/)
  assert.match(marveenPeer.received[1].payload.content, /FEDERATION_CODEX_SECOND/)
  assert.equal(marveenPeer.received[0].payload.from, 'codex/programozo')
  assert.equal(marveenPeer.received[0].payload.to, 'bela')

  const methods = readFileSync(protocolLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).method)
  assert.equal(methods.filter((method) => method === 'thread/start').length, 1)
  assert.equal(methods.filter((method) => method === 'thread/resume').length, 1)
  assert.equal(methods.filter((method) => method === 'turn/start').length, 2)
})
