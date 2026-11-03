import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentSettingsManager } from '../src/agent-settings-manager.mjs'
import { loadServiceConfig } from '../src/config.mjs'
import { CodexAppServerRuntime } from '../src/codex-app-server-runtime.mjs'

function privateFile(path, value) {
  writeFileSync(path, value, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-agent-settings-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { mode: 0o700 })
  privateFile(join(root, 'admin.token'), 'a'.repeat(40))
  privateFile(join(root, 'inbound.token'), 'b'.repeat(40))
  privateFile(join(root, 'outbound.token'), 'c'.repeat(40))
  const configPath = join(root, 'config.json')
  privateFile(configPath, `${JSON.stringify({
    version: 1,
    systemId: 'codex',
    listen: { host: '127.0.0.1', port: 3431 },
    storage: { database: './state.sqlite3' },
    codex: {
      binary: process.execPath,
      expectedVersion: '0.164.0',
      runtimeRoot: workspace,
      imageGenerationRequired: false,
    },
    admin: { tokenFile: './admin.token' },
    agents: [{
      id: 'programozo',
      displayName: 'Codex programozó',
      model: 'gpt-5.6-terra',
      workspacePath: workspace,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'manual',
      reasoningEffort: 'high',
      developerInstructions: 'Eredeti fejlesztői szerepkör.',
      federationPeer: 'marveen',
    }],
    peers: [{
      id: 'marveen',
      baseUrl: 'http://127.0.0.1:3420',
      inboundTokenFile: './inbound.token',
      outboundTokenFile: './outbound.token',
    }],
  }, null, 2)}\n`)
  const config = loadServiceConfig(configPath)
  const calls = []
  const runtime = {
    availableModels: new Set(["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]),
    selectableModels() {
      return config.codex.allowedModels.filter((model) => this.availableModels.has(model))
    },
    assertModelSelectable(model) {
      if (!config.codex.allowedModels.includes(model)) {
        throw Object.assign(new Error('model not allowed'), { code: 'model_not_allowed', status: 400 })
      }
      if (!this.availableModels.has(model)) {
        throw Object.assign(new Error('model unavailable'), { code: 'model_unavailable', status: 409 })
      }
    },
    isReady() {
      return true
    },
    async reconfigureAgent(agent) {
      calls.push(structuredClone(agent))
    },
  }
  const manager = new AgentSettingsManager({
    configPath,
    config,
    runtime,
    clock: () => 1_785_600_000_000 + calls.length,
  })
  return { root, configPath, config, runtime, calls, manager }
}

test('settings update is atomic, private, audited and restarts with a new role', async (t) => {
  const env = fixture(t)
  const result = await env.manager.update({
    actor: 'Istvan',
    model: 'gpt-5.6-sol',
    developerInstructions: 'Marketingstratéga szerepkör, ellenőrzött utasításokkal.',
    reasoningEffort: 'xhigh',
    confirm: true,
  })
  assert.equal(result.settings.reasoningEffort, 'xhigh')
  assert.equal(result.settings.model, 'gpt-5.6-sol')
  assert.equal(result.settings.developerInstructions, 'Marketingstratéga szerepkör, ellenőrzött utasításokkal.')
  assert.equal(env.calls.length, 1)
  assert.equal(env.calls[0].reasoningEffort, 'xhigh')
  assert.equal(env.calls[0].model, 'gpt-5.6-sol')
  assert.equal(env.config.agents[0].reasoningEffort, 'xhigh')
  assert.equal(JSON.parse(readFileSync(env.configPath)).agents[0].reasoningEffort, 'xhigh')
  assert.equal(env.manager.backups().length, 1)
  const audit = env.manager.audit()
  assert.equal(audit.length, 1)
  assert.equal(audit[0].actor, 'Istvan')
  assert.equal(audit[0].authenticatedAs, 'admin-token')
  assert.deepEqual(audit[0].changes.model, {
    before: 'gpt-5.6-terra',
    after: 'gpt-5.6-sol',
  })
  assert.equal(audit[0].changes.reasoningEffort.before, 'high')
  assert.doesNotMatch(JSON.stringify(audit), /Marketingstratéga|Eredeti fejlesztői/)
})

test('empty roles, invalid efforts and missing confirmation fail without mutation', async (t) => {
  const env = fixture(t)
  const before = readFileSync(env.configPath)
  await assert.rejects(
    env.manager.update({ actor: 'Istvan', model: 'gpt-5.6-terra', developerInstructions: '  ', reasoningEffort: 'high', confirm: true }),
    { code: 'invalid_developer_instructions' },
  )
  await assert.rejects(
    env.manager.update({ actor: 'Istvan', model: 'gpt-5.6-terra', developerInstructions: 'Szerep', reasoningEffort: 'ultra', confirm: true }),
    { code: 'invalid_reasoning_effort' },
  )
  await assert.rejects(
    env.manager.update({ actor: 'Istvan', model: 'gpt-5.6-terra', developerInstructions: 'Szerep', reasoningEffort: 'low' }),
    { code: 'confirmation_required' },
  )
  await assert.rejects(
    env.manager.update({
      actor: 'Istvan',
      model: 'gpt-5.6-terra',
      developerInstructions: 'Eredeti fejlesztői szerepkör.',
      reasoningEffort: 'high',
      confirm: true,
    }),
    { code: 'no_change' },
  )
  assert.deepEqual(readFileSync(env.configPath), before)
  assert.equal(env.calls.length, 0)
  assert.deepEqual(env.manager.audit(), [])
})

test('arbitrary and unavailable models fail before backup, config write or restart', async (t) => {
  const env = fixture(t)
  const before = readFileSync(env.configPath)
  await assert.rejects(env.manager.update({
    actor: 'Istvan',
    model: '../../arbitrary',
    developerInstructions: 'Új szerep.',
    reasoningEffort: 'high',
    confirm: true,
  }), { code: 'invalid_model' })
  await assert.rejects(env.manager.update({
    actor: 'Istvan',
    model: 'gpt-5.5',
    developerInstructions: 'Új szerep.',
    reasoningEffort: 'high',
    confirm: true,
  }), { code: 'model_not_allowed' })
  env.runtime.availableModels.delete('gpt-5.6-sol')
  await assert.rejects(env.manager.update({
    actor: 'Istvan',
    model: 'gpt-5.6-sol',
    developerInstructions: 'Új szerep.',
    reasoningEffort: 'high',
    confirm: true,
  }), { code: 'model_unavailable' })
  assert.deepEqual(readFileSync(env.configPath), before)
  assert.equal(env.calls.length, 0)
  assert.equal(env.manager.backups().length, 0)
  assert.deepEqual(env.manager.audit(), [])
})

test('restore returns to the previous settings and creates an undo backup', async (t) => {
  const env = fixture(t)
  await env.manager.update({
    actor: 'Istvan',
    model: 'gpt-5.6-sol',
    developerInstructions: 'Új szerepkör.',
    reasoningEffort: 'low',
    confirm: true,
  })
  const restored = await env.manager.restore({ actor: 'Istvan', confirm: true })
  assert.equal(restored.settings.developerInstructions, 'Eredeti fejlesztői szerepkör.')
  assert.equal(restored.settings.reasoningEffort, 'high')
  assert.equal(restored.settings.model, 'gpt-5.6-terra')
  assert.equal(env.calls.length, 2)
  assert.equal(env.manager.backups().length, 2)
  assert.equal(env.manager.audit()[0].action, 'restore')
})

test('runtime restart failure restores the configuration and records failure', async (t) => {
  const env = fixture(t)
  env.runtime.reconfigureAgent = async () => {
    const error = new Error('restart failed')
    error.code = 'runtime_restart_failed'
    throw error
  }
  const before = readFileSync(env.configPath)
  await assert.rejects(env.manager.update({
    actor: 'Istvan',
    model: 'gpt-5.6-sol',
    developerInstructions: 'Nem maradhat meg.',
    reasoningEffort: 'medium',
    confirm: true,
  }), { code: 'runtime_restart_failed' })
  assert.deepEqual(readFileSync(env.configPath), before)
  assert.equal(env.config.agents[0].reasoningEffort, 'high')
  const [audit] = env.manager.audit()
  assert.equal(audit.outcome, 'failed_rolled_back')
  assert.deepEqual(audit.changes.model, {
    before: 'gpt-5.6-terra',
    after: 'gpt-5.6-sol',
  })
  assert.equal(audit.rollbackRuntimeReady, true)
})

test('runtime reconfiguration invalidates the old thread and starts a new generation', async () => {
  const original = { id: 'programozo', model: 'gpt-5.6-terra', reasoningEffort: 'high', developerInstructions: 'Régi' }
  const next = { id: 'programozo', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', developerInstructions: 'Új' }
  const runtime = new CodexAppServerRuntime({
    config: { codex: { allowedModels: ['gpt-5.6-terra', 'gpt-5.6-sol'] }, agents: [original] },
    environment: {},
  })
  const invalidated = []
  runtime.state = { invalidateThread: (agentId) => invalidated.push(agentId) }
  runtime.approvals = { list: () => [] }
  let restarts = 0
  runtime.stop = async () => {}
  runtime.assertModelSelectable = () => {}
  runtime.start = async () => { restarts += 1; runtime.generation = restarts }
  const result = await runtime.reconfigureAgent(next)
  assert.deepEqual(invalidated, ['programozo'])
  assert.equal(restarts, 1)
  assert.equal(runtime.agents.get('programozo').reasoningEffort, 'xhigh')
  assert.equal(runtime.agents.get('programozo').model, 'gpt-5.6-sol')
  assert.deepEqual(result, { agentId: 'programozo', generation: 1 })
})

test('failed runtime reconfiguration restores the previous agent without invalidating its thread', async () => {
  const original = { id: 'programozo', model: 'gpt-5.6-terra', reasoningEffort: 'high', developerInstructions: 'Régi' }
  const next = { id: 'programozo', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', developerInstructions: 'Új' }
  const runtime = new CodexAppServerRuntime({
    config: { codex: { allowedModels: ['gpt-5.6-terra', 'gpt-5.6-sol'] }, agents: [original] },
    environment: {},
  })
  const invalidated = []
  runtime.state = { invalidateThread: (agentId) => invalidated.push(agentId) }
  runtime.approvals = { list: () => [] }
  runtime.stop = async () => {}
  runtime.assertModelSelectable = () => {}
  let starts = 0
  runtime.start = async () => {
    starts += 1
    if (starts === 1) throw Object.assign(new Error('new model failed'), {
      code: 'model_unavailable',
    })
  }
  await assert.rejects(runtime.reconfigureAgent(next), { code: 'model_unavailable' })
  assert.equal(starts, 2)
  assert.deepEqual(invalidated, [])
  assert.equal(runtime.agents.get('programozo').reasoningEffort, 'high')
  assert.equal(runtime.agents.get('programozo').model, 'gpt-5.6-terra')

  const fatalRuntime = new CodexAppServerRuntime({
    config: { codex: { allowedModels: ['gpt-5.6-terra', 'gpt-5.6-sol'] }, agents: [original] },
    environment: {},
  })
  fatalRuntime.state = { invalidateThread: (agentId) => invalidated.push(agentId) }
  fatalRuntime.approvals = { list: () => [] }
  fatalRuntime.stop = async () => {}
  fatalRuntime.assertModelSelectable = () => {}
  fatalRuntime.start = async () => {
    throw Object.assign(new Error('start failed'), { code: 'app_server_start_failed' })
  }
  await assert.rejects(
    fatalRuntime.reconfigureAgent(next),
    (error) => (
      error.code === 'runtime_rollback_failed'
      && error.status === 503
      && error.rollbackError?.code === 'app_server_start_failed'
    ),
  )
  assert.equal(fatalRuntime.agents.get('programozo').model, 'gpt-5.6-terra')
  assert.deepEqual(invalidated, [])
})

test('runtime reconfiguration refuses active work and pending approval', async () => {
  const original = { id: 'programozo', model: 'gpt-5.6-terra', reasoningEffort: 'high', developerInstructions: 'Régi' }
  const runtime = new CodexAppServerRuntime({
    config: { codex: { allowedModels: ['gpt-5.6-terra'] }, agents: [original] },
    environment: {},
  })
  runtime.activeAgents.add('programozo')
  await assert.rejects(runtime.reconfigureAgent(original), { code: 'runtime_busy' })
  runtime.activeAgents.clear()
  runtime.approvals = { list: () => [{ approvalId: 'pending' }] }
  await assert.rejects(runtime.reconfigureAgent(original), { code: 'approval_pending' })
})

test('GPT-6.1 Sol medium and high are available while none is rejected atomically', async (t) => {
  const env = fixture(t)
  const first = await env.manager.update({
    actor: 'Istvan', model: 'gpt-6.1-sol', developerInstructions: 'Codex programozó',
    reasoningEffort: 'medium', confirm: true,
  })
  assert.equal(first.settings.model, 'gpt-6.1-sol')
  assert.equal(first.settings.reasoningEffort, 'medium')
  assert.deepEqual(first.settings.effortsByModel['gpt-6.1-sol'], ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(first.settings.effortsByModel['gpt-6-luna'].includes('none'), true)
  await env.manager.update({
    actor: 'Istvan', model: 'gpt-6.1-sol', developerInstructions: 'Codex programozó',
    reasoningEffort: 'high', confirm: true,
  })
  const unchanged = readFileSync(env.configPath)
  await assert.rejects(env.manager.update({
    actor: 'Istvan', model: 'gpt-6.1-sol', developerInstructions: 'Codex programozó',
    reasoningEffort: 'none', confirm: true,
  }), { code: 'unsupported_model_effort' })
  assert.deepEqual(readFileSync(env.configPath), unchanged)
  assert.equal(env.manager.backups().length, 2)
  assert.equal(env.calls.length, 2)
})
