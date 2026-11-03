import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { ArtifactManager } from '../src/artifact-manager.mjs'
import { CodexAppServerRuntime } from '../src/codex-app-server-runtime.mjs'
import { CodexRuntimeState } from '../src/codex-runtime-state.mjs'
import { FederationDurabilityStore } from '../src/durability-store.mjs'
import { FederationBridgeService } from '../src/service.mjs'

const betterSqlite3Path = process.env.MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH
if (!betterSqlite3Path) throw new Error('production better-sqlite3 path is required')

const fakeCodex = resolve('test/fixtures/fake-codex-app-server.mjs')
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function base(t) {
  const root = mkdtempSync(join(tmpdir(), 'phase52-artifacts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspacePath = join(root, 'workspace')
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(workspacePath)
  mkdirSync(runtimeRoot)
  const database = join(root, 'state', 'federation.sqlite3')
  const store = new FederationDurabilityStore(database, {
    driver: 'better-sqlite3',
    betterSqlite3Path,
  })
  store.migrate()
  store.close()
  const agent = {
    id: 'programozo',
    displayName: 'Programozó',
    model: 'gpt-5.6-terra',
    capabilitySummary: 'Image test',
    workspacePath,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    federationPeer: 'marveen',
    reasoningEffort: 'high',
    networkEnabled: false,
    developerInstructions: 'Register every final generated image.',
  }
  return { root, workspacePath, runtimeRoot, database, agent }
}

function manager(t, overrides = {}) {
  const env = base(t)
  const state = new CodexRuntimeState(env.database, { betterSqlite3Path })
  t.after(() => state.close())
  const artifacts = new ArtifactManager({
    state,
    runtimeRoot: env.runtimeRoot,
    agents: [env.agent],
    ...overrides,
  })
  return { ...env, state, artifacts }
}

function putPng(env, relativePath = 'assets/image.png', bytes = PNG) {
  const target = join(env.workspacePath, relativePath)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, bytes)
  return target
}

function runtimeConfig(env, overrides = {}) {
  return {
    systemId: 'codex',
    listen: { host: '127.0.0.1', port: 0 },
    storage: { database: env.database },
    codex: {
      binary: fakeCodex,
      expectedVersion: '0.164.0',
      runtimeRoot: env.runtimeRoot,
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      turnTimeoutMs: 5_000,
      approvalTimeoutMs: 5_000,
      imageGenerationRequired: true,
      imageModel: 'gpt-image-2',
      artifactMaxBytes: 20 * 1024 * 1024,
      imageMaxPixels: 16_777_216,
      ...overrides.codex,
    },
    admin: { token: 'phase52-admin-token-000000000000000000' },
    agents: [env.agent],
    peers: [{
      id: 'marveen',
      baseUrl: new URL('http://127.0.0.1:9'),
      inboundToken: 'phase52-inbound-token-0000000000000000',
      outboundToken: 'phase52-outbound-token-000000000000000',
    }],
    workers: {
      intervalMs: 60_000,
      runtimeLeaseMs: 5_000,
      runtimeMaxAttempts: 3,
      deliveryTimeoutMs: 100,
      deliveryLeaseMs: 1_000,
      deliveryMaxAttempts: 2,
    },
  }
}

function createRuntime(env, config, environment = {}) {
  return new CodexAppServerRuntime({
    config,
    environment: {
      ...process.env,
      NODE_OPTIONS: '--no-warnings',
      ...environment,
    },
    betterSqlite3Path,
  })
}

test('valid final PNG is copied immutably, persisted and deduplicated', (t) => {
  const env = manager(t)
  const source = putPng(env)
  const expectedSha256 = createHash('sha256').update(PNG).digest('hex')
  const first = env.artifacts.register({
    runId: 'run-valid',
    agentId: env.agent.id,
    workspaceRelativePath: 'assets/image.png',
    expectedSha256,
  })
  const duplicate = env.artifacts.register({
    runId: 'run-valid',
    agentId: env.agent.id,
    workspaceRelativePath: 'assets/image.png',
    expectedSha256,
  })
  assert.equal(first.duplicate, false)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.record.artifactId, first.record.artifactId)
  assert.equal(first.record.mimeType, 'image/png')
  assert.deepEqual([first.record.width, first.record.height], [1, 1])
  writeFileSync(source, Buffer.from('changed workspace copy'))
  assert.deepEqual(env.artifacts.read(first.record.artifactId).bytes, PNG)
})

test('absolute, traversal, redundant and backslash artifact paths fail closed', (t) => {
  const env = manager(t)
  putPng(env)
  for (const path of ['/tmp/image.png', '../image.png', 'assets/../image.png', 'assets\\image.png']) {
    assert.throws(
      () => env.artifacts.register({
        runId: `path-${path}`,
        agentId: env.agent.id,
        workspaceRelativePath: path,
      }),
      (error) => error.code === 'image_artifact_invalid_path',
    )
  }
})

test('symbolic-link traversal is rejected even when it points inside the workspace', (t) => {
  const env = manager(t)
  mkdirSync(join(env.workspacePath, 'real'))
  writeFileSync(join(env.workspacePath, 'real', 'image.png'), PNG)
  symlinkSync(join(env.workspacePath, 'real'), join(env.workspacePath, 'linked'))
  assert.throws(
    () => env.artifacts.register({
      runId: 'run-symlink',
      agentId: env.agent.id,
      workspaceRelativePath: 'linked/image.png',
    }),
    (error) => error.code === 'image_artifact_symlink_rejected',
  )
})

test('corrupt PNG CRC and a mismatched expected SHA-256 are rejected', (t) => {
  const env = manager(t)
  const corrupt = Buffer.from(PNG)
  corrupt[corrupt.length - 5] ^= 0xff
  putPng(env, 'assets/corrupt.png', corrupt)
  assert.throws(
    () => env.artifacts.register({
      runId: 'run-corrupt',
      agentId: env.agent.id,
      workspaceRelativePath: 'assets/corrupt.png',
    }),
    (error) => error.code === 'image_artifact_invalid_png',
  )
  putPng(env, 'assets/hash.png')
  assert.throws(
    () => env.artifacts.register({
      runId: 'run-hash',
      agentId: env.agent.id,
      workspaceRelativePath: 'assets/hash.png',
      expectedSha256: '0'.repeat(64),
    }),
    (error) => error.code === 'image_artifact_hash_mismatch',
  )
})

test('oversized files are rejected before image parsing', (t) => {
  const env = manager(t, { maxBytes: 1024 })
  putPng(env, 'assets/large.png', Buffer.alloc(2048, 1))
  assert.throws(
    () => env.artifacts.register({
      runId: 'run-large',
      agentId: env.agent.id,
      workspaceRelativePath: 'assets/large.png',
    }),
    (error) => error.code === 'image_artifact_size_rejected',
  )
})

test('dynamic image tool registers the final workspace image on the active run', async (t) => {
  const env = base(t)
  const config = runtimeConfig(env)
  const events = []
  const runtime = new CodexAppServerRuntime({
    config,
    environment: { ...process.env, NODE_OPTIONS: '--no-warnings' },
    betterSqlite3Path,
    onEvent: (event, details) => events.push({ event, details }),
  })
  await runtime.start()
  t.after(() => runtime.stop())
  const result = await runtime.run({
    agentId: env.agent.id,
    prompt: '$imagegen IMAGEGEN_TEST',
    context: { imageGeneration: true },
    idempotencyKey: 'image-dynamic-run',
  })
  assert.equal(result.artifacts.length, 1)
  assert.equal(result.artifacts[0].workspaceRelativePath, 'assets/fake-image.png')
  assert.equal(runtime.capabilities().imageGeneration.available, true)
  assert.equal(runtime.capabilities().toolContractRevision, 2)
  assert.equal(events.some((entry) => entry.event === 'image_provider_staging_observed'), true)
  assert.equal(events.some((entry) => entry.event === 'image_artifact_ready'), true)
})

test('an imagegen run cannot succeed without a registered final artifact', async (t) => {
  const env = base(t)
  const runtime = createRuntime(env, runtimeConfig(env))
  await runtime.start()
  t.after(() => runtime.stop())
  await assert.rejects(
    runtime.run({
      agentId: env.agent.id,
      prompt: '$imagegen DO_NOT_REGISTER_AN_IMAGE',
      context: {},
      idempotencyKey: 'missing-image-artifact',
    }),
    (error) => error.code === 'image_artifact_missing',
  )
  const state = new CodexRuntimeState(env.database, { betterSqlite3Path })
  assert.equal(state.getRun('missing-image-artifact').state, 'failed')
  state.close()
})

test('missing GPT image capability blocks runtime startup when required', async (t) => {
  const env = base(t)
  const runtime = createRuntime(
    env,
    runtimeConfig(env),
    { FAKE_CODEX_NO_IMAGE: '1' },
  )
  await assert.rejects(
    runtime.start(),
    (error) => error.code === 'image_generation_unavailable',
  )
})

test('authenticated artifact API and Federation result expose the durable receipt', async (t) => {
  const env = base(t)
  const config = runtimeConfig(env)
  const runtime = createRuntime(env, config)
  const service = new FederationBridgeService({
    config,
    runtime,
    betterSqlite3Path,
    autoWorkers: false,
  })
  await runtime.start()
  const endpoint = await service.start()
  t.after(async () => {
    await service.stop()
    await runtime.stop()
  })
  const accepted = service.store.acceptInbox({
    peerId: 'marveen',
    from: 'marveen/bela',
    to: env.agent.id,
    content: '$imagegen IMAGEGEN_TEST',
    ref: 'phase52-image',
  }).record
  assert.equal((await service.inboxWorker.tick()).completed, 1)
  const inbox = service.store.getInbox(accepted.inboxId)
  assert.equal(inbox.result.artifacts.length, 1)
  const artifact = inbox.result.artifacts[0]
  const unauthorized = await fetch(`${endpoint.baseUrl}/v1/artifacts`)
  assert.equal(unauthorized.status, 401)
  const headers = { authorization: `Bearer ${config.admin.token}` }
  const list = await fetch(`${endpoint.baseUrl}/v1/artifacts?runId=${inbox.runId}`, { headers })
  assert.equal(list.status, 200)
  assert.equal((await list.json()).data.length, 1)
  const metadata = await fetch(`${endpoint.baseUrl}/v1/artifacts/${artifact.artifactId}`, {
    headers,
  })
  assert.equal(metadata.status, 200)
  assert.equal((await metadata.json()).data.sha256, artifact.sha256)
  const content = await fetch(
    `${endpoint.baseUrl}/v1/artifacts/${artifact.artifactId}/content`,
    { headers },
  )
  assert.equal(content.status, 200)
  assert.equal(content.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), PNG)
})
