import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { BRIDGE_ALLOWED_MODELS, effortsForModel, isValidModelEffort } from '../src/model-policy.mjs'

const expected = ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']

test('six model IDs: GPT-5.6 originals preserved; GPT-6 family additive', () => {
  assert.deepEqual(BRIDGE_ALLOWED_MODELS, expected)
  assert.equal(new Set(BRIDGE_ALLOWED_MODELS).size, 6)
  assert.ok(Object.isFrozen(BRIDGE_ALLOWED_MODELS))
})

test('model-specific reasoning effort matrix refuses unsupported combinations', () => {
  for (const model of expected) {
    assert.equal(isValidModelEffort(model, 'medium'), true)
    assert.equal(isValidModelEffort(model, 'high'), true)
  }
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
    assert.equal(isValidModelEffort(model, 'none'), false)
    assert.equal(isValidModelEffort(model, 'max'), true)
  }
  for (const model of ['gpt-6-luna', 'gpt-6-sol']) {
    assert.equal(isValidModelEffort(model, 'none'), true)
    assert.equal(isValidModelEffort(model, 'max'), true)
  }
  assert.equal(isValidModelEffort('gpt-5.6-terra', 'none'), false)
  assert.equal(isValidModelEffort('gpt-5.6-terra', 'ultra', { existingConfig: true }), true)
  assert.equal(isValidModelEffort('gpt-6-astra', 'ultra'), false)
  assert.deepEqual(effortsForModel('gpt-5.6-sol'), ['low', 'medium', 'high', 'xhigh'])
})

test('0.3.3 migration is additive, preserves selected legacy model and permissions', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'model-migrate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const src = join(root, 'config.json')
  const output = join(root, 'new.json')
  const input = {
    version: 1, systemId: 'codex',
    codex: { binary: '/home/old/codex', expectedVersion: '0.145.0', allowedModels: ['gpt-5.6-terra', 'gpt-5.6-sol', 'my-private-model'] },
    agents: [{ id: 'programozo', model: 'gpt-5.6-terra', reasoningEffort: 'high', developerInstructions: 'Szerep megmarad', networkEnabled: false }],
    peers: [{ id: 'marveen', inboundTokenFile: 'abc' }],
  }
  writeFileSync(src, `${JSON.stringify(input)}\n`, { mode: 0o600 })
  chmodSync(src, 0o600)
  const saved = readFileSync(src)
  const result = spawnSync(process.execPath, [resolve('scripts/migrate-models-0.3.3.mjs'), src, '/home/new/codex', output], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(src), saved)
  const after = JSON.parse(readFileSync(output, 'utf8'))
  assert.deepEqual(after.agents, input.agents)
  assert.deepEqual(after.peers, input.peers)
  assert.deepEqual(after.codex.allowedModels, [...input.codex.allowedModels, ...expected.filter((m) => !input.codex.allowedModels.includes(m))])
  assert.equal(after.codex.binary, '/home/new/codex')
  assert.equal(after.codex.expectedVersion, '0.164.0')
  assert.equal(readFileSync(output).length > 0, true)
  // A second accidental run must not overwrite its existing output or the source.
  const again = spawnSync(process.execPath, [resolve('scripts/migrate-models-0.3.3.mjs'), src, '/home/evil/codex', output], { encoding: 'utf8' })
  assert.notEqual(again.status, 0)
  assert.equal(JSON.parse(readFileSync(output)).codex.binary, '/home/new/codex')
})

test('0.3.3 migration accepts omitted/default, null and customized 0.3.2 allowlists without changing agents or secrets', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'model-optional-migrate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const base = {
    version: 1, systemId: 'codex',
    codex: { expectedVersion: '0.145.0', binary: '/original/codex' },
    agents: [{ id: 'programozo', model: 'gpt-5.6-terra', reasoningEffort: 'high',
      developerInstructions: 'Sensitive instructions are retained verbatim',
      sandboxMode: 'workspace-write', approvalPolicy: 'manual', networkEnabled: false }],
    peers: [{ id: 'marveen', inboundTokenFile: '/private/secret.token' }],
    workers: { intervalMs: 250 },
  }
  const cases = [
    { name: 'omitted', allowed: undefined, expectedStart: ['gpt-5.6-terra', 'gpt-5.6-sol'] },
    { name: 'null-default', allowed: null, expectedStart: ['gpt-5.6-terra', 'gpt-5.6-sol'] },
    { name: 'only-terra', allowed: ['gpt-5.6-terra'], expectedStart: ['gpt-5.6-terra'] },
    { name: 'only-sol', allowed: ['gpt-5.6-sol'], expectedStart: ['gpt-5.6-sol'] },
    { name: 'custom-order', allowed: ['my-private-model', 'gpt-5.6-terra'], expectedStart: ['my-private-model', 'gpt-5.6-terra'] },
  ]
  for (const { name, allowed, expectedStart } of cases) {
    const input = structuredClone(base)
    if (allowed !== undefined) input.codex.allowedModels = allowed
    const src = join(root, `${name}-src.json`)
    const output = join(root, `${name}-new.json`)
    writeFileSync(src, `${JSON.stringify(input)}\n`, { mode: 0o600 })
    const originalBytes = readFileSync(src)
    const r = spawnSync(process.execPath,
      [resolve('scripts/migrate-models-0.3.3.mjs'), src, '/new/codex', output],
      { encoding: 'utf8' })
    assert.equal(r.status, 0, `${name}: ${r.stderr}`)
    assert.deepEqual(readFileSync(src), originalBytes, `${name}: original config changed`)
    const after = JSON.parse(readFileSync(output, 'utf8'))
    assert.deepEqual(after.codex.allowedModels,
      [...new Set([...expectedStart, ...expected])], name)
    assert.deepEqual(after.agents, input.agents, `${name}: agents changed`)
    assert.deepEqual(after.peers, input.peers, `${name}: peers changed`)
    assert.deepEqual(after.workers, input.workers, `${name}: workers changed`)
    assert.equal(after.codex.expectedVersion, '0.164.0')
    assert.equal(after.codex.binary, '/new/codex')
    assert.equal(after.codex.allowedModels.includes('gpt-5.6-terra'), true)
    assert.equal(after.codex.allowedModels.includes('gpt-5.6-sol'), true)
  }
})

test('0.3.3 migration fails closed for invalid original allowlists and wrong CLI baseline', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'model-bad-migrate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const src = join(root, 'config.json'), output = join(root, 'new.json')
  for (const bad of [
    { version: 1, codex: { expectedVersion: '0.145.0', allowedModels: [] }, agents: [] },
    { version: 1, codex: { expectedVersion: '0.145.0', allowedModels: ['gpt-5.6-terra', 'gpt-5.6-terra'] }, agents: [] },
    { version: 1, codex: { expectedVersion: '0.145.0', allowedModels: ['../escape'] }, agents: [] },
    { version: 1, codex: { expectedVersion: '0.145.0', allowedModels: 'gpt-5.6-terra' }, agents: [] },
    { version: 1, codex: { expectedVersion: '0.164.0', allowedModels: expected }, agents: [] },
  ]) {
    writeFileSync(src, JSON.stringify(bad), { mode: 0o600 })
    const r = spawnSync(process.execPath, [resolve('scripts/migrate-models-0.3.3.mjs'), src, '/home/new/codex', output])
    assert.notEqual(r.status, 0)
    assert.deepEqual(JSON.parse(readFileSync(src)), bad)
    assert.equal(existsSync(output), false)
  }
})

test('Codex model/list preflight sees GPT-6.1 Sol and originals via mock app-server', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'model-probe-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fake = join(root, 'codex')
  writeFileSync(fake, `#!/usr/bin/env bash\nexec "${process.execPath}" "${resolve('test/fixtures/fake-codex-app-server.mjs')}" "$@"\n`, { mode: 0o700 })
  chmodSync(fake, 0o700)
  const result = spawnSync(process.execPath, [resolve('scripts/check-codex-models-0.3.3.mjs'), fake], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /GPT-6.1 Sol and both legacy models/)
  const unavailable = spawnSync(process.execPath, [resolve('scripts/check-codex-models-0.3.3.mjs'), fake], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, FAKE_CODEX_NO_TERRA: '1' },
  })
  assert.notEqual(unavailable.status, 0)
  assert.match(unavailable.stderr, /not exposed/)
})
