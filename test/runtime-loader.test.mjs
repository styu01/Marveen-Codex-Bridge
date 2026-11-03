import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { loadRuntimeModule } from '../src/runtime-loader.mjs'

const fixture = resolve('test/fixtures/mock-runtime-module.mjs')

test('runtime module loads only through the explicit contract', async () => {
  const runtime = await loadRuntimeModule(fixture, {
    config: {
      agents: [{
        id: 'programozo',
        displayName: 'Programozó',
        model: 'gpt-5.6-terra',
      }],
    },
  })
  assert.equal(runtime.isReady(), true)
  assert.equal(runtime.manifestAgents()[0].id, 'programozo')
  assert.equal((await runtime.run({
    agentId: 'programozo',
    prompt: 'test',
    context: {},
    idempotencyKey: 'runtime-loader-1',
  })).response, 'MAIN_PROCESS_E2E_OK')
})

test('relative, symbolic-link and invalid runtime modules fail closed', async (t) => {
  await assert.rejects(
    loadRuntimeModule('./test/fixtures/mock-runtime-module.mjs', {}),
    /must be absolute/,
  )
  const root = mkdtempSync(join(tmpdir(), 'codex-runtime-loader-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const linked = join(root, 'linked-runtime.mjs')
  symlinkSync(fixture, linked)
  await assert.rejects(loadRuntimeModule(linked, {}), /symbolic link/)
  const invalid = join(root, 'invalid-runtime.mjs')
  writeFileSync(invalid, 'export const notARuntime = true\n')
  await assert.rejects(loadRuntimeModule(invalid, {}), /createRuntime/)
})
