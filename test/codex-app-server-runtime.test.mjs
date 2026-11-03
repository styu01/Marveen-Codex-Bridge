import assert from 'node:assert/strict'
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
import { CodexRuntimeState } from '../src/codex-runtime-state.mjs'
import { FederationDurabilityStore } from '../src/durability-store.mjs'

const betterSqlite3Path = process.env.MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH
if (!betterSqlite3Path) throw new Error('production better-sqlite3 path is required')

const fakeCodex = resolve('test/fixtures/fake-codex-app-server.mjs')

function setup(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-phase4-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtimeRoot = join(root, 'runtime')
  const workspacePath = join(root, 'workspace')
  mkdirSync(runtimeRoot)
  mkdirSync(workspacePath)
  const database = join(root, 'state', 'federation.sqlite3')
  const migrationStore = new FederationDurabilityStore(database, {
    driver: 'better-sqlite3',
    betterSqlite3Path,
  })
  migrationStore.migrate()
  migrationStore.close()
  const protocolLog = join(root, 'protocol.jsonl')
  const agent = {
    id: 'programozo',
    displayName: 'Programozó',
    model: 'gpt-5.6-terra',
    capabilitySummary: 'Teszt agent',
    workspacePath,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    reasoningEffort: 'high',
    networkEnabled: false,
    developerInstructions: 'Phase 4 runtime test.',
    ...overrides.agent,
  }
  const config = {
    storage: { database },
    codex: {
      binary: fakeCodex,
      expectedVersion: '0.164.0',
      runtimeRoot,
      allowedModels: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"],
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      turnTimeoutMs: 5_000,
      ...overrides.codex,
    },
    agents: [agent],
  }
  const environment = {
    ...process.env,
    NODE_OPTIONS: '--no-warnings',
    FAKE_CODEX_PROTOCOL_LOG: protocolLog,
    ...overrides.environment,
  }
  const create = (nextConfig = config, nextEnvironment = environment) => (
    new CodexAppServerRuntime({
      config: nextConfig,
      environment: nextEnvironment,
      betterSqlite3Path,
    })
  )
  return { root, database, protocolLog, config, environment, create }
}

function protocol(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('real App Server protocol handshake and persistent idempotent run succeed', async (t) => {
  const env = setup(t)
  const runtime = env.create()
  await runtime.start()
  t.after(() => runtime.stop())
  assert.equal(runtime.isReady(), true)
  assert.equal(runtime.manifestAgents()[0].id, 'programozo')
  assert.equal(runtime.manifestAgents()[0].model, 'gpt-5.6-terra')
  assert.equal(runtime.manifestAgents()[0].reasoningEffort, 'high')
  assert.deepEqual(runtime.selectableModels(), ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"])
  assert.equal(runtime.assertModelSelectable('gpt-5.6-sol'), 'gpt-5.6-sol')
  assert.throws(
    () => runtime.assertModelSelectable('gpt-5.5'),
    (error) => error.code === 'model_not_allowed' && error.status === 400,
  )
  const first = await runtime.run({
    agentId: 'programozo',
    prompt: 'PHASE4_RUNTIME_OK',
    context: { test: 'handshake' },
    idempotencyKey: 'phase4-run-1',
  })
  assert.match(first.response, /^FAKE_CODEX_OK:PHASE4_RUNTIME_OK/)
  assert.equal(first.duplicate, false)
  const duplicate = await runtime.run({
    agentId: 'programozo',
    prompt: 'PHASE4_RUNTIME_OK',
    context: { test: 'handshake' },
    idempotencyKey: 'phase4-run-1',
  })
  assert.equal(duplicate.runId, first.runId)
  assert.equal(duplicate.response, first.response)
  assert.equal(duplicate.duplicate, true)
  const messages = protocol(env.protocolLog)
  assert.equal(messages.filter((item) => item.method === 'turn/start').length, 1)
  assert.equal(
    messages.find((item) => item.method === 'thread/start')
      .params.config.model_reasoning_effort,
    'high',
  )
  assert.equal(
    messages.find((item) => item.method === 'turn/start')
      .params.sandboxPolicy.type,
    'readOnly',
  )
})

test('thread survives complete App Server and runtime restart', async (t) => {
  const env = setup(t)
  const firstRuntime = env.create()
  await firstRuntime.start()
  await firstRuntime.run({
    agentId: 'programozo',
    prompt: 'THREAD_BEFORE_RESTART',
    context: {},
    idempotencyKey: 'thread-before',
  })
  await firstRuntime.stop()

  const secondRuntime = env.create()
  await secondRuntime.start()
  t.after(() => secondRuntime.stop())
  await secondRuntime.run({
    agentId: 'programozo',
    prompt: 'THREAD_AFTER_RESTART',
    context: {},
    idempotencyKey: 'thread-after',
  })
  const messages = protocol(env.protocolLog)
  assert.equal(messages.filter((item) => item.method === 'thread/start').length, 1)
  assert.equal(messages.filter((item) => item.method === 'thread/resume').length, 1)
  const startedId = messages.find((item) => item.method === 'thread/start')
  const resumedId = messages.find((item) => item.method === 'thread/resume')
  assert.equal(resumedId.params.threadId.length > 0, true)
  assert.equal(startedId.params.model, resumedId.params.model)
})

test('crash after turn submission becomes indeterminate and is never replayed', async (t) => {
  const env = setup(t)
  const firstRuntime = env.create()
  await firstRuntime.start()
  await assert.rejects(
    firstRuntime.run({
      agentId: 'programozo',
      prompt: 'CRASH_AFTER_SUBMISSION',
      context: {},
      idempotencyKey: 'crash-run',
    }),
    /exited during a turn/,
  )
  await firstRuntime.stop()

  const secondRuntime = env.create()
  await secondRuntime.start()
  t.after(() => secondRuntime.stop())
  await assert.rejects(
    secondRuntime.run({
      agentId: 'programozo',
      prompt: 'CRASH_AFTER_SUBMISSION',
      context: {},
      idempotencyKey: 'crash-run',
    }),
    (error) => error.code === 'runtime_indeterminate',
  )
  assert.equal(
    protocol(env.protocolLog).filter((item) => item.method === 'turn/start').length,
    1,
  )
  const state = new CodexRuntimeState(env.database, { betterSqlite3Path })
  assert.equal(state.getRun('crash-run').state, 'interrupted_unknown')
  state.close()
})

test('agent configuration drift invalidates the old thread', async (t) => {
  const env = setup(t)
  const firstRuntime = env.create()
  await firstRuntime.start()
  await firstRuntime.run({
    agentId: 'programozo',
    prompt: 'CONFIG_HIGH',
    context: {},
    idempotencyKey: 'config-high',
  })
  await firstRuntime.stop()

  const changedConfig = {
    ...env.config,
    agents: [{
      ...env.config.agents[0],
      reasoningEffort: 'xhigh',
    }],
  }
  const secondRuntime = env.create(changedConfig)
  await secondRuntime.start()
  t.after(() => secondRuntime.stop())
  await secondRuntime.run({
    agentId: 'programozo',
    prompt: 'CONFIG_XHIGH',
    context: {},
    idempotencyKey: 'config-xhigh',
  })
  const messages = protocol(env.protocolLog)
  assert.equal(messages.filter((item) => item.method === 'thread/start').length, 2)
  assert.equal(messages.filter((item) => item.method === 'thread/resume').length, 0)
  assert.equal(
    messages.filter((item) => item.method === 'thread/start')[1]
      .params.config.model_reasoning_effort,
    'xhigh',
  )
})

test('all approval requests are deterministically declined in Phase 4', async (t) => {
  const env = setup(t)
  const runtime = env.create()
  await runtime.start()
  t.after(() => runtime.stop())
  const result = await runtime.run({
    agentId: 'programozo',
    prompt: 'APPROVAL_TEST',
    context: {},
    idempotencyKey: 'approval-decline',
  })
  assert.equal(result.response, 'FAKE_APPROVAL_RESULT:decline')
})

test('version, login and model incompatibility each fail closed', async (t) => {
  const badVersion = setup(t, {
    environment: { FAKE_CODEX_VERSION: '0.146.0' },
  })
  await assert.rejects(
    badVersion.create().start(),
    (error) => error.code === 'codex_version_mismatch',
  )

  const loggedOut = setup(t, {
    environment: { FAKE_CODEX_LOGGED_OUT: '1' },
  })
  await assert.rejects(
    loggedOut.create().start(),
    (error) => error.code === 'auth_required',
  )

  const missingModel = setup(t, {
    environment: { FAKE_CODEX_NO_TERRA: '1' },
  })
  await assert.rejects(
    missingModel.create().start(),
    (error) => error.code === 'model_unavailable',
  )
})
