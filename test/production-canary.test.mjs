import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  preflightProductionCanary,
  runProductionCanary,
} from '../src/production-canary.mjs'

function fixture() {
  const state = {
    model: 'gpt-5.6-terra',
    role: 'Eredeti szerepkör.',
    effort: 'high',
    backups: [],
    audit: [],
    canaries: [],
  }
  const bridgeRequest = async (path, options = {}) => {
    if (path === '/readyz') {
      return { status: 200, body: {
        status: 'ready', bridgeVersion: '0.3.4.1', database: true, runtime: true,
      } }
    }
    if (path === '/v1/dashboard/agent-settings' && (options.method ?? 'GET') === 'GET') {
      return { status: 200, body: { data: {
        agentId: 'programozo',
        model: state.model,
        selectableModels: ['gpt-5.6-terra', 'gpt-5.6-sol'],
        developerInstructions: state.role,
        reasoningEffort: state.effort,
      } } }
    }
    if (path === '/v1/dashboard/agent-settings' && options.method === 'PUT') {
      if (options.body.model === 'gpt-5.5') {
        assert.deepEqual(options.allowedStatuses, [400])
        return { status: 400, body: { error: 'model_not_allowed' } }
      }
      const before = state.model
      state.backups.push(`config-${state.backups.length + 1}.json`)
      state.model = options.body.model
      state.audit.unshift({
        actor: options.body.actor,
        action: 'update',
        outcome: 'succeeded',
        changes: { model: { before, after: state.model } },
      })
      return { status: 200, body: { data: {} } }
    }
    if (path.startsWith('/v1/dashboard/agent-settings/audit')) {
      return { status: 200, body: { data: structuredClone(state.audit) } }
    }
    throw new Error(`Unexpected Bridge request: ${path}`)
  }
  const marveenRequest = async (path) => {
    if (path === '/api/federation/peers') {
      return { enabled: true, peers: [{ id: 'codex' }] }
    }
    throw new Error(`Unexpected Marveen request: ${path}`)
  }
  const runFederationCanary = async ({ marker }) => {
    state.canaries.push(marker)
    return { messageId: state.canaries.length, replyId: state.canaries.length + 10, marker }
  }
  const snapshot = () => ({
    configSha256: createHash('sha256').update(`${state.model}:${state.role}:${state.effort}`).digest('hex'),
    backups: [...state.backups],
  })
  return { state, bridgeRequest, marveenRequest, runFederationCanary, snapshot }
}

test('production canary proves Terra, Sol, backups, audit and immutable rejection', async () => {
  const env = fixture()
  const result = await runProductionCanary({
    ...env,
    actor: 'v033-canary-test',
    markerTimestamp: '20260802220000',
  })
  assert.equal(env.state.model, 'gpt-5.6-terra')
  assert.equal(env.state.backups.length, 2)
  assert.equal(env.state.audit.length, 2)
  assert.deepEqual(env.state.canaries, [
    'FEDERATION_V033_SOL_20260802220000_OK',
    'FEDERATION_V033_TERRA_20260802220000_OK',
  ])
  assert.equal(result.backupCountAdded, 2)
  assert.equal(result.rejectedModel, 'gpt-5.5')
})

test('production canary restores Terra when the Sol Federation canary fails', async () => {
  const env = fixture()
  env.runFederationCanary = async () => { throw new Error('canary failed') }
  await assert.rejects(runProductionCanary({
    ...env,
    actor: 'v033-canary-test',
    markerTimestamp: '20260802220000',
  }), /canary failed/)
  assert.equal(env.state.model, 'gpt-5.6-terra')
  assert.equal(env.state.audit[0].actor, 'v033-canary-test-cleanup')
})

test('production canary preflight rejects disabled Federation', async () => {
  const env = fixture()
  env.marveenRequest = async () => ({ enabled: false, peers: [{ id: 'codex' }] })
  await assert.rejects(preflightProductionCanary(env), { code: 'federation_not_ready' })
})
