import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadServiceConfig, publicConfig } from '../src/config.mjs'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-phase3-config-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = {
    root,
    config: join(root, 'config.json'),
    admin: join(root, 'admin.token'),
    inbound: join(root, 'inbound.token'),
    outbound: join(root, 'outbound.token'),
    runtime: join(root, 'runtime'),
    workspace: join(root, 'workspace'),
  }
  mkdirSync(paths.runtime)
  mkdirSync(paths.workspace)
  const token = (path, value) => {
    writeFileSync(path, `${value}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
  }
  token(paths.admin, 'admin-token-000000000000000000000001')
  token(paths.inbound, 'inbound-token-0000000000000000000001')
  token(paths.outbound, 'outbound-token-00000000000000000001')
  const input = {
    version: 1,
    systemId: 'codex',
    listen: { host: '127.0.0.1', port: 0 },
    storage: { database: './state/federation.sqlite3' },
    codex: {
      binary: process.execPath,
      expectedVersion: '0.164.0',
      runtimeRoot: paths.runtime,
    },
    admin: { tokenFile: './admin.token' },
    agents: [{
      id: 'programozo',
      displayName: 'Programozó',
      model: 'gpt-5.6-terra',
      workspacePath: paths.workspace,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      reasoningEffort: 'high',
    }],
    peers: [{
      id: 'marveen',
      baseUrl: 'http://127.0.0.1:3420',
      inboundTokenFile: './inbound.token',
      outboundTokenFile: './outbound.token',
    }],
  }
  const save = (override = input) => {
    writeFileSync(paths.config, JSON.stringify(override, null, 2), { mode: 0o600 })
    chmodSync(paths.config, 0o600)
  }
  save()
  return { paths, input, save, token }
}

test('private file-based configuration loads without exposing tokens', (t) => {
  const env = setup(t)
  const config = loadServiceConfig(env.paths.config)
  assert.equal(config.systemId, 'codex')
  assert.equal(config.admin.token.startsWith('admin-token'), true)
  assert.equal(config.peers[0].inboundToken.startsWith('inbound-token'), true)
  assert.equal(config.storage.database, join(env.paths.root, 'state', 'federation.sqlite3'))
  assert.equal(config.codex.expectedVersion, '0.164.0')
  assert.deepEqual(config.codex.allowedModels, ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"])
  assert.equal(config.agents[0].sandboxMode, 'read-only')
  const publicView = JSON.stringify(publicConfig(config))
  assert.doesNotMatch(publicView, /admin-token|inbound-token|outbound-token/)
  assert.match(publicView, /hasInboundToken/)
  assert.doesNotMatch(publicView, new RegExp(env.paths.workspace.replaceAll('\\', '\\\\')))
})

test('group-readable secret file is rejected', (t) => {
  const env = setup(t)
  chmodSync(env.paths.inbound, 0o640)
  assert.throws(() => loadServiceConfig(env.paths.config), /permissions/)
})

test('symbolic-link token file is rejected', (t) => {
  const env = setup(t)
  const linked = join(env.paths.root, 'linked.token')
  symlinkSync(env.paths.inbound, linked)
  env.save({
    ...env.input,
    peers: [{
      ...env.input.peers[0],
      inboundTokenFile: './linked.token',
    }],
  })
  assert.throws(() => loadServiceConfig(env.paths.config), /symbolic link/)
})

test('reused admin/Federation token is rejected', (t) => {
  const env = setup(t)
  env.token(env.paths.inbound, 'admin-token-000000000000000000000001')
  assert.throws(() => loadServiceConfig(env.paths.config), /distinct/)
})

test('non-loopback listener and non-HTTPS remote peer are rejected', (t) => {
  const env = setup(t)
  env.save({
    ...env.input,
    listen: { host: '0.0.0.0', port: 3431 },
  })
  assert.throws(() => loadServiceConfig(env.paths.config), /loopback/)
  env.save({
    ...env.input,
    peers: [{
      ...env.input.peers[0],
      baseUrl: 'http://example.com',
    }],
  })
  assert.throws(() => loadServiceConfig(env.paths.config), /HTTPS/)
})

test('duplicate agents and duplicate peers fail closed', (t) => {
  const env = setup(t)
  env.save({
    ...env.input,
    agents: [...env.input.agents, { ...env.input.agents[0] }],
  })
  assert.throws(() => loadServiceConfig(env.paths.config), /duplicate agent/)
  env.save({
    ...env.input,
    peers: [...env.input.peers, { ...env.input.peers[0] }],
  })
  assert.throws(() => loadServiceConfig(env.paths.config), /duplicate peer/)
})

test('model allowlist is explicit, unique and contains every configured agent model', (t) => {
  const env = setup(t)
  env.save({
    ...env.input,
    codex: { ...env.input.codex, allowedModels: ['gpt-5.6-terra', 'gpt-5.6-terra'] },
  })
  assert.throws(() => loadServiceConfig(env.paths.config), /must not contain duplicates/)
  env.save({
    ...env.input,
    codex: { ...env.input.codex, allowedModels: ['gpt-5.6-sol'] },
  })
  assert.throws(() => loadServiceConfig(env.paths.config), /not present in codex\.allowedModels/)
  env.save({
    ...env.input,
    codex: { ...env.input.codex, allowedModels: ['../../unsafe'] },
  })
  assert.throws(() => loadServiceConfig(env.paths.config), /invalid model name/)
})

test('workspace path must be absolute, real and free of symlink traversal', (t) => {
  const env = setup(t)
  env.save({
    ...env.input,
    agents: [{
      ...env.input.agents[0],
      workspacePath: './workspace',
    }],
  })
  assert.throws(() => loadServiceConfig(env.paths.config), /absolute directory/)

  const linked = join(env.paths.root, 'linked-workspace')
  symlinkSync(env.paths.workspace, linked, 'dir')
  env.save({
    ...env.input,
    agents: [{
      ...env.input.agents[0],
      workspacePath: linked,
    }],
  })
  assert.throws(() => loadServiceConfig(env.paths.config), /symbolic-link traversal/)
})

test('Phase 5 rejects unsafe sandbox, approval and reasoning settings', (t) => {
  const env = setup(t)
  env.save({
    ...env.input,
    agents: [{
      ...env.input.agents[0],
      sandboxMode: 'danger-full-access',
    }],
  })
  assert.throws(() => loadServiceConfig(env.paths.config), /sandboxMode/)
  env.save({
    ...env.input,
    agents: [{
      ...env.input.agents[0],
      approvalPolicy: 'on-request',
    }],
  })
  assert.throws(() => loadServiceConfig(env.paths.config), /approvalPolicy is invalid/)
  env.save({
    ...env.input,
    agents: [{
      ...env.input.agents[0],
      reasoningEffort: 'unlimited',
    }],
  })
  assert.throws(() => loadServiceConfig(env.paths.config), /reasoningEffort/)
})

test('GPT-6 model-specific reasoning efforts are validated before runtime startup', (t) => {
  const env = setup(t)
  const updated = (model, reasoningEffort) => ({
    ...env.input,
    agents: [{ ...env.input.agents[0], model, reasoningEffort }],
  })
  env.save(updated('gpt-6.1-sol', 'medium'))
  assert.equal(loadServiceConfig(env.paths.config).agents[0].model, 'gpt-6.1-sol')
  env.save(updated('gpt-6-astra', 'max'))
  assert.equal(loadServiceConfig(env.paths.config).agents[0].reasoningEffort, 'max')
  env.save(updated('gpt-6-luna', 'none'))
  assert.equal(loadServiceConfig(env.paths.config).agents[0].reasoningEffort, 'none')
  env.save(updated('gpt-6-sol', 'none'))
  assert.equal(loadServiceConfig(env.paths.config).agents[0].reasoningEffort, 'none')
  for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-terra']) {
    env.save(updated(model, 'none'))
    assert.throws(() => loadServiceConfig(env.paths.config), /reasoningEffort is unsupported/)
  }
  env.save(updated('gpt-5.6-terra', 'ultra'))
  assert.equal(loadServiceConfig(env.paths.config).agents[0].reasoningEffort, 'ultra')
})
